// ipfs.mjs
//
// IPFS client for the Ethernity Cloud JS SDK.
//
// The UPLOAD path is a faithful port of the Python SDK's IPFSClient
// (ethernity_cloud_sdk_py/commands/pynithy/ipfs_client.py): it posts directly
// to the IPFS HTTP API `/api/v0/add` with a raw multipart body,
// `wrap-with-directory=true`, `Expect: 100-continue`, an explicit
// `Content-Length`, and parses the newline-delimited JSON response to find the
// wrapping-directory root hash (the entry whose `Name` is empty). A 10-attempt
// exponential-backoff retry wraps both file and directory uploads. This matches
// the Python pipeline step-for-step so both SDKs upload identically (e.g. for
// the certex / public-key extraction flow).
//
// The DOWNLOAD path keeps the existing kubo-rpc-client based helpers.
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { promisify } from 'util';
import fs from 'fs';
import { Command } from 'commander';
import { promises as fss } from 'fs';
import path from 'path';
import { create } from 'kubo-rpc-client';

const program = new Command();
const writeFile = promisify(fs.writeFile);
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const getRetryDelay = (retryCount, baseDelay = 1) => baseDelay * 2 ** retryCount;

const RETRY_COUNT = 10; // mirrors Python ipfs_client.RETRY_COUNT

// Endpoint + auth, mirroring the Python IPFSClient constructor.
//   apiUrl : e.g. "https://ipfs.ethernity.cloud"
//   addUrl : `${apiUrl}/api/v0/add`
let apiUrl = null;
let authHeader = null; // Authorization header value, or null

// kubo-rpc-client instance, used only for the download helpers below.
let ipfs = null;

const initialize = (host, protocol, port, token) => {
  // Normalise the endpoint to a base URL string, matching how the Python client
  // treats `ipfs_endpoint` (it just prepends it to `/api/v0/add`).
  if (host && host.search('http') !== -1) {
    apiUrl = host.replace(/\/+$/, '');
    ipfs = create(host);
  } else {
    const proto = protocol || 'http';
    const p = port ? `:${port}` : '';
    apiUrl = `${proto}://${host}${p}`.replace(/\/+$/, '');
    const opts = { host, protocol: proto, port };
    if (token) opts.headers = { authorization: token };
    ipfs = create(opts);
  }
  authHeader = token && token !== '' ? token : null;
};

// ---------------------------------------------------------------------------
// Raw multipart upload (Python-parity)
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CHECK = '\x1b[92m✔\x1b[0m  ';
const FAIL = '\x1b[91m✘\x1b[0m  ';

// Recursively collect every file under a directory (absolute paths), like
// Python's os.walk in upload_dir.
const gatherFiles = (dirPath) => {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dirPath);
  return out;
};

// Build a multipart/form-data body identical in shape to requests_toolbelt's
// MultipartEncoder: one part per file, the field name AND filename both set to
// the POSIX relative path, Content-Type application/octet-stream. Returns the
// full body Buffer + the boundary + total byte length.
const buildMultipartBody = (files, dirPath) => {
  const boundary =
    '----EthernityCloudFormBoundary' +
    Buffer.from(`${files.length}-${dirPath}`).toString('hex').slice(0, 24);
  const parts = [];
  for (const filepath of files) {
    const rel = path.relative(dirPath, filepath).replace(/\\/g, '/');
    const header =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${rel}"; filename="${rel}"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`;
    parts.push(Buffer.from(header, 'utf8'));
    parts.push(fs.readFileSync(filepath));
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const body = Buffer.concat(parts);
  return { body, boundary, length: body.length };
};

// Low-level POST to the IPFS add endpoint using Node's http/https so we can set
// Content-Length + Expect: 100-continue exactly like the Python client and read
// the streamed NDJSON response. Resolves { statusCode, text }.
const postAdd = (query, body, boundary, contentLength, onProgress) =>
  new Promise((resolve, reject) => {
    const url = new URL(`${apiUrl}/api/v0/add${query}`);
    const mod = url.protocol === 'https:' ? https : http;
    const headers = {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': String(contentLength),
      Expect: '100-continue'
    };
    if (authHeader) headers.Authorization = authHeader;

    const req = mod.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        headers
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => resolve({ statusCode: res.statusCode, text }));
      }
    );

    req.on('error', reject);

    // Honour Expect: 100-continue -- only stream the body once the server
    // approves (mirrors requests' behaviour with Expect: 100-continue).
    let sent = 0;
    const sendBody = () => {
      // Write in MB-ish chunks so we can report progress like Python.
      const CHUNK = 1024 * 1024;
      let offset = 0;
      const writeNext = () => {
        if (offset >= body.length) {
          req.end();
          return;
        }
        const end = Math.min(offset + CHUNK, body.length);
        const ok = req.write(body.subarray(offset, end));
        sent += end - offset;
        offset = end;
        if (onProgress) onProgress(sent);
        if (ok) setImmediate(writeNext);
        else req.once('drain', writeNext);
      };
      writeNext();
    };

    let bodySent = false;
    req.on('continue', () => {
      if (bodySent) return;
      bodySent = true;
      sendBody();
    });
    // Fallback: if the server never sends 100-continue within a short grace
    // period, send the body anyway (some gateways skip it).
    setTimeout(() => {
      if (bodySent) return;
      bodySent = true;
      sendBody();
    }, 3000);
  });

// Parse the NDJSON add response and return the wrapping-directory root hash --
// the entry whose "Name" is "" (matches Python upload_dir).
const parseRootHash = (text) => {
  const rootLineHash = () => {
    let root = null;
    let last = null;
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        continue;
      }
      last = obj;
      if (obj.Name === '') root = obj.Hash;
    }
    // Some gateways don't emit an empty-Name entry; fall back to the last hash.
    return root || (last && last.Hash) || null;
  };
  return rootLineHash();
};

// Generic retry wrapper mirroring Python's retry_on_failure (10 attempts,
// 10s initial delay, x2 backoff, small jitter).
const retryOnFailure = async (fn, label) => {
  let delayMs = 10000;
  const backoff = 2;
  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    try {
      const result = await fn();
      if (result !== null && result !== false && result !== 'Upload failed.') return result;
      throw new Error('empty result');
    } catch (e) {
      process.stdout.write(
        `\n[Retry ${attempt + 1}/${RETRY_COUNT}] ${label} failed: ${e && e.message ? e.message : e}\n`
      );
      if (attempt < RETRY_COUNT - 1) {
        await delay(delayMs + Math.random() * 100);
        delayMs *= backoff;
      }
    }
  }
  console.log('Max retry attempts reached. Operation failed.');
  return null;
};

// Upload a single file: POST it to /api/v0/add and return its hash.
const uploadFileToIPFSOnce = async (filePath) => {
  const files = [filePath];
  const dir = path.dirname(filePath);
  const { body, boundary, length } = buildMultipartBody(files, dir);
  const { statusCode, text } = await postAdd('', body, boundary, length, null);
  if (statusCode !== 200) {
    console.log(`Failed to upload to IPFS. Status code: ${statusCode}`);
    return null;
  }
  // For a single file the last NDJSON line carries its hash.
  let last = null;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      last = JSON.parse(t);
    } catch {
      /* ignore */
    }
  }
  return last ? last.Hash : null;
};

const uploadFileToIPFS = async (filePath) => {
  const hash = await retryOnFailure(() => uploadFileToIPFSOnce(filePath), 'upload_file');
  if (hash) {
    try {
      await fss.writeFile(`./IPFS_DOCKER_COMPOSE_HASH.ipfs`, hash);
    } catch {
      /* best effort */
    }
  }
  return hash;
};

// Upload a whole directory with wrap-with-directory=true and return the root
// directory hash -- the exact behaviour of Python's upload_dir.
const uploadDirOnce = async (dirPath) => {
  const abs = path.resolve(dirPath);
  const files = gatherFiles(abs);
  const totalSize = files.reduce((acc, f) => acc + fs.statSync(f).size, 0);
  const totalMb = Math.floor(totalSize / (1024 * 1024));
  const { body, boundary, length } = buildMultipartBody(files, abs);

  let lastShownMb = -1;
  let frame = 0;
  const onProgress = (sent) => {
    const mb = Math.floor(sent / (1024 * 1024));
    if (mb > lastShownMb) {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      lastShownMb = mb;
      process.stdout.write(
        `\r\t${SPINNER_FRAMES[frame]}  Uploading and pinning enclave to IPFS... ${mb}MB/${totalMb}MB`
      );
    }
  };

  const query =
    '?quieter=true&stream-channels=true&wrap-with-directory=true&progress=false&timeout=5m';
  const { statusCode, text } = await postAdd(query, body, boundary, length, onProgress);

  if (statusCode !== 200) {
    process.stdout.write(`\r\t${FAIL}Uploading and pinning enclave to IPFS\n`);
    console.log(`Failed to upload to IPFS. Status code: ${statusCode}`);
    return false;
  }
  const rootHash = parseRootHash(text);
  if (!rootHash) {
    process.stdout.write(`\r\t${FAIL}Uploading and pinning enclave to IPFS\n`);
    console.log('Failed to upload to IPFS. Could not determine root hash.');
    return false;
  }
  process.stdout.write(`\r\t${CHECK}Uploading and pinning enclave to IPFS\n`);
  return rootHash;
};

const uploadFolderToIPFS = async (folderPath) => {
  const hash = await retryOnFailure(() => uploadDirOnce(folderPath), 'upload_dir');
  if (hash) {
    try {
      await fss.writeFile(`./IPFS_HASH.ipfs`, hash);
    } catch {
      /* best effort */
    }
    return hash;
  }
  return 'Upload failed.';
};

// Dispatcher mirroring Python's IPFSClient.upload(path).
const upload = async (p) => {
  const stat = fs.statSync(p);
  if (stat.isFile()) return uploadFileToIPFS(p);
  if (stat.isDirectory()) return uploadFolderToIPFS(p);
  console.log(`Path ${p} is neither a file nor a directory.`);
  return null;
};

// ---------------------------------------------------------------------------
// Download helpers (kubo-rpc-client based; unchanged behaviour)
// ---------------------------------------------------------------------------

const getFromIPFS = async (hhash, filePath, maxRetries = process.env.REACT_APP_IPFS_RETRIES || 5) => {
  let res = '';
  let retryCount = 0;
  while (retryCount < maxRetries) {
    try {
      for await (const file of ipfs.cat(hhash)) {
        res += new TextDecoder().decode(file.buffer || file);
      }
      await writeFile(filePath, res);
      return;
    } catch (error) {
      console.error(`Error: ${error.message}`);
      retryCount += 1;
      if (retryCount < maxRetries) {
        await delay(getRetryDelay(retryCount));
        continue;
      } else {
        throw new Error('ECError.IPFS_DOWNLOAD_ERROR');
      }
    }
  }
};

const downloadFolderFromIPFS = async (cid, outputPath) => {
  try {
    console.log(`Downloading folder from IPFS: ${cid}`);
    const files = [];
    for await (const file of ipfs.get(cid)) {
      if (!file.content) continue;
      const filePath = path.join(outputPath, file.path);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const writeStream = fs.createWriteStream(filePath);
      for await (const chunk of file.content) {
        writeStream.write(chunk);
      }
      writeStream.end();
      files.push(filePath);
    }
    console.log(`Downloaded ${files.length} files to ${outputPath}`);
  } catch (e) {
    console.error(e);
    return 'err';
  }
};

const getContentFromIPFS = async (hash, maxRetries = process.env.REACT_APP_IPFS_RETRIES || 5) => {
  let res = '';
  let retryCount = 0;
  while (retryCount < maxRetries) {
    try {
      for await (const file of ipfs.cat(hash)) {
        res += new TextDecoder().decode(file.buffer || file);
      }
      return res;
    } catch (error) {
      console.error(error.message);
      retryCount += 1;
      if (retryCount < maxRetries) {
        await delay(getRetryDelay(retryCount));
        continue;
      } else {
        throw new Error('ECIPFSDownloadError');
      }
    }
  }
};

export {
  initialize,
  upload,
  uploadFileToIPFS,
  uploadFolderToIPFS,
  getFromIPFS,
  downloadFolderFromIPFS,
  getContentFromIPFS
};

// ---------------------------------------------------------------------------
// CLI (unchanged interface: --host --action upload/download --filePath/--folderPath)
// ---------------------------------------------------------------------------

program
  .option('--host <host>', 'IPFS host')
  .option('--hhash <hhash>', 'IPFS hash')
  .option('--filePath <path>', 'Path to the file')
  .option('--folderPath <path>', 'Path to the folder')
  .option('--action <action>', 'Action to perform (upload, download)')
  .option('--token <token>', 'IPFS authorization token')
  .option('--output <path>', 'Output path for download');

const isMain = process.argv[1] && process.argv[1].endsWith('ipfs.mjs');

if (isMain) {
  program.parse(process.argv);
  const options = program.opts();

  const main = async () => {
    const host = options.host || 'localhost';
    initialize(host, undefined, undefined, options.token || '');

    if (options.action === 'upload') {
      if (options.filePath) {
        const hhash = await uploadFileToIPFS(options.filePath);
        console.log(`${hhash}`);
        process.exit(hhash ? 0 : 1);
      } else if (options.folderPath) {
        // retryOnFailure already retries 10x internally; a single call suffices.
        const hhash = await uploadFolderToIPFS(options.folderPath);
        console.log(`${hhash}`);
        if (!hhash || hhash === 'Upload failed.') {
          console.log(`Failed to upload folder to IPFS, please try again.`);
          process.exit(1);
        }
        process.exit(0);
      } else {
        console.error('Please provide a filePath or folderPath for upload.');
        process.exit(1);
      }
    } else if (options.action === 'download') {
      if (options.filePath) {
        await getFromIPFS(options.hhash, options.filePath);
        console.log(`File downloaded. ${options.hhash}`);
      } else if (options.folderPath) {
        await downloadFolderFromIPFS(options.hhash, options.folderPath);
        console.log(`Folder downloaded. ${options.hhash}`);
      } else {
        console.error('Please provide a filePath or folderPath for download.');
      }
    } else {
      console.error('Please provide a valid action (upload, download).');
      process.exit(1);
    }
  };

  main();
}
