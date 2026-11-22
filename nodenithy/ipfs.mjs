// ipfs.mjs
//
// IPFS client of the publish (nodenithy/run.js, pynithy/run.js): adds, hashes
// and reads through the IPFS API named with --host, the publish's own Kubo
// (http://127.0.0.1:<port>) or an IPFS API of the dApp's own; --token, or
// IPFS_TOKEN in the environment when the flag is absent, is the Authorization
// header value that API takes, when it takes one.
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
// The DOWNLOAD path uses kubo-rpc-client, with the same Authorization header.
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
//   apiUrl     : the API's base URL, e.g. "http://127.0.0.1:5001"; adds go to
//                `${apiUrl}/api/v0/add`
//   authHeader : the Authorization header value (--token), or null
let apiUrl = null;
let authHeader = null;

// kubo-rpc-client instance, used only for the download helpers below.
let ipfs = null;

const initialize = (host, protocol, port, token) => {
  authHeader = token && token !== '' ? token : null;
  // Normalise the endpoint to a base URL string, matching how the Python client
  // treats `ipfs_endpoint` (it just prepends it to `/api/v0/add`).
  let opts;
  if (host && host.search('http') !== -1) {
    // The API's base URL: a trailing /api/v0 is dropped, since addUrl appends it.
    apiUrl = host.replace(/\/+$/, '').replace(/\/api\/v0$/, '');
    opts = { url: apiUrl };
  } else {
    const proto = protocol || 'http';
    const p = port ? `:${port}` : '';
    apiUrl = `${proto}://${host}${p}`.replace(/\/+$/, '');
    opts = { host, protocol: proto, port };
  }
  // The reads send the same Authorization header as the adds.
  if (authHeader) opts.headers = { authorization: authHeader };
  ipfs = create(opts);
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

// Upload a single file: POST it to /api/v0/add and return its hash. With
// onlyHash the node computes the same hash and stores nothing.
const uploadFileToIPFSOnce = async (filePath, onlyHash = false) => {
  const files = [filePath];
  const dir = path.dirname(filePath);
  const { body, boundary, length } = buildMultipartBody(files, dir);
  const { statusCode, text } = await postAdd(onlyHash ? '?only-hash=true' : '', body, boundary, length, null);
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
// directory hash -- the exact behaviour of Python's upload_dir. With onlyHash
// the node computes the same root hash and stores nothing.
const uploadDirOnce = async (dirPath, onlyHash = false) => {
  const abs = path.resolve(dirPath);
  const files = gatherFiles(abs);
  const totalSize = files.reduce((acc, f) => acc + fs.statSync(f).size, 0);
  const totalMb = Math.floor(totalSize / (1024 * 1024));
  const { body, boundary, length } = buildMultipartBody(files, abs);
  const step = onlyHash ? 'Hashing enclave for IPFS' : 'Uploading and pinning enclave to IPFS';

  let lastShownMb = -1;
  let frame = 0;
  const onProgress = (sent) => {
    const mb = Math.floor(sent / (1024 * 1024));
    if (mb > lastShownMb) {
      frame = (frame + 1) % SPINNER_FRAMES.length;
      lastShownMb = mb;
      process.stdout.write(
        `\r\t${SPINNER_FRAMES[frame]}  ${step}... ${mb}MB/${totalMb}MB`
      );
    }
  };

  const query =
    '?quieter=true&stream-channels=true&wrap-with-directory=true&progress=false&timeout=5m' +
    (onlyHash ? '&only-hash=true' : '');
  const { statusCode, text } = await postAdd(query, body, boundary, length, onProgress);

  if (statusCode !== 200) {
    process.stdout.write(`\r\t${FAIL}${step}\n`);
    console.log(`Failed to upload to IPFS. Status code: ${statusCode}`);
    return false;
  }
  const rootHash = parseRootHash(text);
  if (!rootHash) {
    process.stdout.write(`\r\t${FAIL}${step}\n`);
    console.log('Failed to upload to IPFS. Could not determine root hash.');
    return false;
  }
  process.stdout.write(`\r\t${CHECK}${step}\n`);
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

// The hash `upload(p)` gives, from the same add call with only-hash: the IPFS
// node neither stores nor announces anything.
const hashForIPFS = async (p) => {
  const stat = fs.statSync(p);
  if (stat.isFile()) return retryOnFailure(() => uploadFileToIPFSOnce(p, true), 'hash_file');
  if (stat.isDirectory()) return retryOnFailure(() => uploadDirOnce(p, true), 'hash_dir');
  console.log(`Path ${p} is neither a file nor a directory.`);
  return null;
};

// The bounds of pinOnIPFS, the values of IPFSClient.pin in the Python SDK
// (ethernity_cloud_sdk_py/commands/pynithy/ipfs_client.py): how many times
// `pin/add` is asked for one CID, how long the client waits before it asks
// again, how long a `pin/ls` may stay silent, the longest silence in an
// answer of `pin/add` (asked with progress=true, the API writes a line every
// half second while it fetches the blocks), and the time of the whole pin.
const PIN_ATTEMPTS = 5;
const PIN_RETRY_MS = 10000;
const PIN_REQUEST_MS = 30000;
const PIN_SILENCE_MS = 120000;
const PIN_TIMEOUT_MS = 3600000;
const PIN_OUT_OF_TIME = 'the pin was not complete when its time ran out';

const monotonicNow = () => performance.now();

// The JSON object `text` holds, or {} when it holds anything else.
const jsonObject = (text) => {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

// What ended a request: the error's code, when it has one, and its message.
const errorText = (e) => (e.code ? `${e.code}: ${e.message}` : e.message);

// A POST without a body of `pathQuery` (from /api/v0/) to the API, with the
// Authorization header and `headers`, on a connection of its own. The request
// is destroyed when no byte moves on its connection for `silenceMs`, from its
// start on. `onResponse` is called with the answer, `onError` with the error
// that ends the request.
const postToApi = (pathQuery, headers, silenceMs, onResponse, onError) => {
  const url = new URL(`${apiUrl}/api/v0/${pathQuery}`);
  const mod = url.protocol === 'https:' ? https : http;
  const all = { 'Content-Length': '0', ...headers };
  if (authHeader) all.Authorization = authHeader;
  const req = mod.request(
    {
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: all,
      agent: false,
      timeout: silenceMs
    },
    onResponse
  );
  req.on('timeout', () => req.destroy(new Error(`no byte of the answer for ${Math.round(silenceMs)} ms`)));
  req.on('error', onError);
  req.end();
  return req;
};

// One `pin/add` of `cid` with progress=true, asked without compression and
// read as it arrives, until the line that reports the pin or an error (in an
// answer that is no 200, until its first 1200 bytes), the answer's end, a
// silence of `silenceMs` or the first piece that arrives after `deadline`.
// Resolves { failure, refused }: failure is null when a line names the CID
// among its Pins and says what the attempt ended with otherwise; refused is
// true when that is a 401 or 403.
const pinAdd = (cid, deadline, silenceMs) =>
  new Promise((resolve) => {
    const left = deadline - monotonicNow();
    if (left <= 0) {
      resolve({ failure: PIN_OUT_OF_TIME, refused: false });
      return;
    }
    let req = null;
    const settle = (failure, refused = false) => {
      resolve({ failure, refused });
      if (req) req.destroy();
    };
    req = postToApi(
      `pin/add?arg=${encodeURIComponent(cid)}&recursive=true&progress=true`,
      { 'Accept-Encoding': 'identity' },
      Math.min(silenceMs, left),
      (res) => {
        if (res.statusCode !== 200) {
          const chunks = [];
          let length = 0;
          const status = () => settle(
            `status ${res.statusCode}\n\t${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`,
            res.statusCode === 401 || res.statusCode === 403
          );
          res.on('data', (chunk) => {
            chunks.push(chunk);
            length += chunk.length;
            if (length >= 1200 || monotonicNow() >= deadline) status();
          });
          res.on('end', status);
          res.on('error', status);
          res.on('close', status);
          return;
        }
        res.setEncoding('utf8');
        let pending = '';
        // Reads the lines `text` completes; true when one of them settles the
        // attempt.
        const read = (text) => {
          const lines = (pending + text).split('\n');
          pending = lines.pop();
          for (const line of lines) {
            const answer = jsonObject(line);
            if (Array.isArray(answer.Pins) && answer.Pins.includes(cid)) {
              settle(null);
              return true;
            }
            if (answer.Type === 'error') {
              settle(String(answer.Message));
              return true;
            }
          }
          return false;
        };
        res.on('data', (chunk) => {
          if (!read(chunk) && monotonicNow() >= deadline) settle(PIN_OUT_OF_TIME);
        });
        // The line feed after the answer's end makes a line of what the
        // answer left without one.
        res.on('end', () => {
          if (!read('\n')) settle('the answer ended without the pin');
        });
        res.on('error', (e) => settle(errorText(e)));
        res.on('close', () => settle('the answer broke off'));
      },
      (e) => settle(errorText(e))
    );
  });

// Whether `pin/ls` lists `cid` among the recursive pins of the API. False also
// when the API does not answer the question, and when no time is left before
// `deadline` to ask it.
const pinListed = (cid, deadline) =>
  new Promise((resolve) => {
    const left = deadline - monotonicNow();
    if (left <= 0) {
      resolve(false);
      return;
    }
    const req = postToApi(
      `pin/ls?arg=${encodeURIComponent(cid)}&type=recursive`,
      {},
      Math.min(PIN_REQUEST_MS, left),
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          const keys = jsonObject(text).Keys;
          resolve(res.statusCode === 200 && keys !== null && typeof keys === 'object' && !Array.isArray(keys)
            && Object.prototype.hasOwnProperty.call(keys, cid));
          req.destroy();
        });
        res.on('error', () => resolve(false));
        res.on('close', () => resolve(false));
      },
      () => resolve(false)
    );
  });

// Pin `cid` on the API (`pin/add`), which fetches the blocks it does not hold
// from the peers that provide them, as IPFSClient.pin of the Python SDK does.
// The pin is asked with progress=true: the API answers with a stream of lines,
// one every half second while it fetches and one that names the CID among its
// Pins once the pin is complete. An attempt that reads no such line (the
// answer ends, breaks off, stays silent for `silenceMs`, or is an error) is
// followed by `pin/ls` under the same Authorization header, which tells
// whether the API holds the pin; when it does not, `pin/add` is asked again
// after `retryMs`, PIN_ATTEMPTS times at most, and no request starts once
// `timeoutMs` have passed. A 401 or 403, the API refusing the token, ends the
// pin at once. Resolves true when the pin is complete, having printed the
// number of attempts when there was more than one; otherwise prints what the
// last attempt ended with and resolves false.
const pinOnIPFS = async (cid, { timeoutMs = PIN_TIMEOUT_MS, silenceMs = PIN_SILENCE_MS, retryMs = PIN_RETRY_MS } = {}) => {
  const deadline = monotonicNow() + timeoutMs;
  let attempt = 0;
  let failure = null;
  while (attempt < PIN_ATTEMPTS) {
    attempt += 1;
    const ended = await pinAdd(cid, deadline, silenceMs);
    failure = ended.failure;
    if (failure === null || (!ended.refused && (await pinListed(cid, deadline)))) {
      if (attempt > 1) console.log(`\tthe pin took ${attempt} attempts`);
      return true;
    }
    if (ended.refused || attempt === PIN_ATTEMPTS || deadline - monotonicNow() <= retryMs) break;
    await delay(retryMs);
  }
  const tried = attempt > 1 ? ` in ${attempt} attempts` : '';
  console.log(`\tFailed to pin ${cid} on ${apiUrl}${tried}: ${failure}`);
  return false;
};

// ---------------------------------------------------------------------------
// Download helpers (kubo-rpc-client, with the Authorization header of initialize())
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
  hashForIPFS,
  pinOnIPFS,
  PIN_ATTEMPTS,
  PIN_RETRY_MS,
  PIN_REQUEST_MS,
  PIN_SILENCE_MS,
  PIN_TIMEOUT_MS,
  uploadFileToIPFS,
  uploadFolderToIPFS,
  getFromIPFS,
  downloadFolderFromIPFS,
  getContentFromIPFS
};

// ---------------------------------------------------------------------------
// CLI: --host --action upload/hash/download --filePath/--folderPath
// ---------------------------------------------------------------------------

program
  .requiredOption('--host <host>', "IPFS API URL: the publish's own Kubo (http://127.0.0.1:<port>) or an IPFS API of the dApp's own")
  .option('--hhash <hhash>', 'IPFS hash')
  .option('--filePath <path>', 'Path to the file')
  .option('--folderPath <path>', 'Path to the folder')
  .option('--action <action>', 'Action to perform (upload, hash, pin, download)')
  .option('--token <token>', 'Authorization header value for the API (IPFS_TOKEN in the environment when absent)')
  .option('--output <path>', 'Output path for download');

const isMain = process.argv[1] && process.argv[1].endsWith('ipfs.mjs');

if (isMain) {
  program.parse(process.argv);
  const options = program.opts();

  const main = async () => {
    initialize(options.host, undefined, undefined, options.token || process.env.IPFS_TOKEN || '');

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
    } else if (options.action === 'hash') {
      const target = options.filePath || options.folderPath;
      if (!target) {
        console.error('Please provide a filePath or folderPath to hash.');
        process.exit(1);
      }
      const hhash = await hashForIPFS(target);
      console.log(`${hhash}`);
      process.exit(hhash ? 0 : 1);
    } else if (options.action === 'pin') {
      if (!options.hhash) {
        console.error('Please provide --hhash, the CID to pin.');
        process.exit(1);
      }
      const pinned = await pinOnIPFS(options.hhash);
      if (pinned) console.log(`${options.hhash}`);
      process.exit(pinned ? 0 : 1);
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
      console.error('Please provide a valid action (upload, hash, pin, download).');
      process.exit(1);
    }
  };

  main();
}
