// ipfsClient.js
import { create, globSource } from 'kubo-rpc-client';
import { promisify } from 'util';
import fs from 'fs';
import { Command } from 'commander';
import { promises as fss } from 'fs';
import path from 'path';
import { MultiBar, Presets } from 'cli-progress';

const program = new Command();
const writeFile = promisify(fs.writeFile);
const delay = (ms) => new Promise((res) => setTimeout(res, ms));
const getRetryDelay = (retryCount, baseDelay = 1) => baseDelay * 2 ** retryCount;

let ipfs = null;

const initialize = (host, protocol, port, token) => {
  if (host.search('http') !== -1) {
    ipfs = create(host); //{ timeout: '4m' }
  } else if (token === '') {
    ipfs = create({
      host,
      protocol,
      port,
      // timeout: '4m'
    });
  } else {
    ipfs = create({
      host,
      protocol,
      port,
      headers: { authorization: token },
      // timeout: '4m'
    });
  }
};

const uploadFileToIPFS = async (filePath) => {
  try {
    const fileContent = await fss.readFile(filePath);
    const response = await ipfs.add({ path: filePath, content: fileContent });
    await fss.writeFile(`./IPFS_DOCKER_COMPOSE_HASH.ipfs`, response.cid.toString());
    return response.cid.toString();
  } catch (e) {
    console.error();
    return "Failed to upload file to IPFS, please try again.";
  }
};

const uploadFolderToIPFS = async (folderPath) => {
  try {
    const addedFiles = [];
    const ipfsOptions = {
      wrapWithDirectory: true,
      pin: true,
      hidden: true,
      timeout: '5m'
    };

    console.log(`Uploading folder to IPFS: ${folderPath}`);

    const multiBar = new MultiBar({
      clearOnComplete: false,
      hideCursor: true,
      format: 'Progress [{bar}] {percentage}% | {value}/{total} MB'
    }, Presets.shades_classic);

    const files = [];
    const readDirectory = (dir) => {
      fs.readdirSync(dir).forEach((file) => {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          readDirectory(fullPath);
        } else {
          files.push({
            path: path.relative(folderPath, fullPath),
            size: fs.statSync(fullPath).size
          });
        }
      });
    };

    readDirectory(folderPath);
    const totalSize = files.reduce((acc, file) => acc + file.size, 0);

    const progressBar = multiBar.create(totalSize / 1024 / 1024, 0);

    for await (const file of ipfs.addAll(files.map(file => ({
      path: file.path.replace(/\\/g, '/'),
      content: fs.createReadStream(path.join(folderPath, file.path))
    })), { ...ipfsOptions })) {
      addedFiles.push({
        cid: file.cid.toString(),
        path: file.path,
        size: file.size,
      });
      progressBar.increment(file.size / 1024 / 1024);
    }
    progressBar.update(totalSize / 1024 / 1024);
    multiBar.stop();
    const _hash = addedFiles.find(file => file.path === '').cid;
    // Return the CID of the root directory
    await fss.writeFile(`./IPFS_HASH.ipfs`, _hash);
    return _hash;
  } catch (e) {
    return "Upload failed.";
  }
};

const getFromIPFS = async (hhash,  filePath, maxRetries = process.env.REACT_APP_IPFS_RETRIES || 5) => {
  let res = '';
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      for await (const file of ipfs.cat(hhash)) {
        res += new TextDecoder().decode(file.buffer);
      }
      await writeFile(filePath, res);
      return;
    } catch (error) {
      console.error(`Error: ${error.message}`);
      retryCount += 1;

      if (retryCount < maxRetries) {
        console.log(`Retrying... (${retryCount}/${maxRetries})`);
        await delay(getRetryDelay(retryCount));
        continue;
      } else {
        throw new Error("ECError.IPFS_DOWNLOAD_ERROR");
      }
    }
  }
};


const downloadFolderFromIPFS = async (cid, outputPath) => {
  try {

    console.log(`Downloading folder from IPFS: ${cid}`);

    const multiBar = new MultiBar({
      clearOnComplete: false,
      hideCursor: true,
      format: 'Progress [{bar}] {percentage}% | {value}/{total} MB'
    }, Presets.shades_classic);

    const files = [];
    for await (const file of ipfs.get(cid)) {
      console.log(`file: ${JSON.stringify(file, null, 2)}`);
      if (!file.content) continue;

      const filePath = path.join(outputPath, file.path);
      const dir = path.dirname(filePath);

      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const writeStream = fs.createWriteStream(filePath);
      const progressBar = multiBar.create(file.size / 1024 / 1024, 0);

      for await (const chunk of file.content) {
        writeStream.write(chunk);
        progressBar.increment(chunk.length / 1024 / 1024);
      }

      writeStream.end();
      progressBar.update(file.size / 1024 / 1024);
      files.push(filePath);
    }

    multiBar.stop();
    console.log(`Downloaded ${files.length} files to ${outputPath}`);
  } catch (e) {
    console.error(e);
    return "err";
  }
};


program
  .option('--host <host>', 'IPFS host')
  .option('--hhash <hhash>', 'IPFS hash')
  .option('--filePath <path>', 'Path to the file')
  .option('--folderPath <path>', 'Path to the folder')
  .option('--action <action>', 'Action to perform (upload, download)')
  .option('--output <path>', 'Output path for download');

program.parse(process.argv);

const options = program.opts();

const main = async () => {
  const host = options.host || 'localhost';
  initialize(host);

  if (options.action === 'upload') {
    if (options.filePath) {
      const hhash = await uploadFileToIPFS(options.filePath);
      console.log(`${hhash}`);
    } else if (options.folderPath) {
      // const hhash = await uploadFolderToIPFSBatch(options.folderPath);
      let retryCount = 0;
      let hhash = null;
      try {
        hhash = await uploadFolderToIPFS(options.folderPath);
        console.log(`${hhash}`);
      } catch (e) {
        // console.log(e);
      }
      while ((!hhash || hhash === 'Upload failed.') && retryCount < 3) {
        console.log(`Retrying... (${retryCount}/3)`);
        hhash = await uploadFolderToIPFS(options.folderPath);
        console.log(`${hhash}`);
        retryCount += 1;
      }

      if (!hhash || hhash === 'Upload failed.') {
        console.log(`Failed to upload folder to IPFS, please try again.`);
      }
      process.exit(0);
    } else {
      console.error('Please provide a filePath or folderPath for upload.');
    }
  } else if (options.action === 'download') {
    if (options.filePath) {
      console.log(`Downloading file from IPFS: ${options.hhash}`);
      const content = await getFromIPFS(options.hhash, options.filePath);
      console.log(`File downloaded. ${options.hhash}`);
    } else if (options.folderPath) {
      console.log(`Downloading folder from IPFS: ${options.hhash}`);
      const content = await downloadFolderFromIPFS(options.hhash, options.folderPath);
      console.log(`Folder downloaded. ${options.hhash}`);
    } else {
      console.error('Please provide a filePath or folderPath for download.');
    }
  } else {
    console.error('Please provide a valid action (upload, download).');
  }
};

main();