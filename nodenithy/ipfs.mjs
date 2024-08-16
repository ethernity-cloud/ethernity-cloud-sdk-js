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

const uploadFolderToIPFS2 = async (path) => {
  try {
    console.log(`Uploading folder to IPFS: ${path}`);
    const response = await ipfs.add(path, { pin: true , recursive: true }).catch((e) => console.log(e));
    // console.log(JSON.stringify(response, null, 2));
    const { cid } = response;
    // while (true) {
    //   const { cid } = response;
    //   if (response.path) {
    //     break;
    //   }
    //   // console.log(`Added file: ${cid}`);
    //   delay(50000);
    // }
    // console.log(`response: ${response}`);
    return cid;
  } catch (e) {
    console.log(e);
    return null;
  }
};

const MAX_BATCH_SIZE = 20 * 1024 * 1024; // 100MB

const uploadFolderToIPFSBatch = async (folderPath) => {
  try {
    const files = [];
    const readDirectory = (dir) => {
      fs.readdirSync(dir).forEach((file) => {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          readDirectory(fullPath);
        } else {
          files.push({
            path: path.relative(folderPath, fullPath),
            content: fs.readFileSync(fullPath),
            size: fs.statSync(fullPath).size
          });
        }
      });
    };

    readDirectory(folderPath);
    console.log(`Uploading folder to IPFS: ${folderPath}`);
    console.log(`Number of files: ${files.length}`);

    const ipfsOptions = {
      wrapWithDirectory: false,
      pin: true,
      progress: (prog) => console.log(`Added ${prog / 1024 / 1024} MB`),
      timeout: '2m'
    };

    const allCids = [];
    let currentBatch = [];
    let currentBatchSize = 0;

    for (const file of files) {
      if (file.size > MAX_BATCH_SIZE) {
        // Upload large files individually
        console.log(`Uploading large file individually: ${file.path}, size: ${file.size / 1024 / 1024} MB`);
        for await (const result of ipfs.addAll([file], ipfsOptions)) {
          allCids.push(result.cid);
        }
      } else {
        // Add file to current batch
        if (currentBatchSize + file.size > MAX_BATCH_SIZE) {
          // await delay(30000);
          // Upload current batch, display in mb
          console.log(`Uploading batch of size ${currentBatchSize / 1024 / 1024} MB`);
          for await (const result of ipfs.addAll(currentBatch, ipfsOptions)) {
            allCids.push(result.cid);
          }
          // Reset batch
          currentBatch = [];
          currentBatchSize = 0;
        }
        currentBatch.push(file);
        currentBatchSize += file.size;
      }
    }

    // Upload any remaining files in the last batch
    if (currentBatch.length > 0) {
      console.log(`Uploading final batch of size ${currentBatchSize / 1024 / 1024} MB`);
      for await (const result of ipfs.addAll(currentBatch, ipfsOptions)) {
        allCids.push(result.cid);
      }
    }

    // Wrap all files into a single directory
    const directory = await ipfs.addAll(allCids.map(cid => ({ path: cid.toString(), content: ipfs.cat(cid) })), {
      wrapWithDirectory: true,
      pin: true,
      timeout: '2m'
    });

    console.log(`response: ${JSON.stringify(directory, null, 2)}`);
    return directory.cid;
  } catch (e) {
    console.error(e);
    return "error";
  }
};

const uploadFolderToIPFS3 = async (folderPath) => {
  try {
    const files = [];

    const readDirectory = (dir) => {
      const items = fs.readdirSync(dir);
      items.forEach((item) => {
        const fullPath = path.join(dir, item);
        const stats = fs.statSync(fullPath);
        if (stats.isDirectory()) {
          readDirectory(fullPath);
        } else {
          files.push({
            path: path.relative(folderPath, fullPath),
            content: fs.readFileSync(fullPath)
          });
        }
      });
    };

    readDirectory(folderPath);
    console.log(`Uploading folder to IPFS: ${folderPath}`);
    // console.log(`Files: ${JSON.stringify(files[0], null, 2)}`);
    console.log(`number of files: ${files.length}`);
    // const response = await ipfs.addAll(files, { wrapWithDirectory: true, pin: true, timeout: 600000, progress: (prog) => console.log(`Added ${prog} bytes`)});
    // const response = await ipfs.addAll(files);
    for await (const file of ipfs.addAll(files, { wrapWithDirectory: true, pin: true, timeout: 600000, progress: (prog) => console.log(`Added ${prog} bytes`)})) {
      console.log(file)
    }
    console.log(`response: ${JSON.stringify(response, null, 2)}`);
    return response.cid;
  } catch (e) {
    console.log(e);
    return "error";
  }
};

// const uploadFolderToIPFS = async (folderPath) => {
//   try {
//     const addedFiles = [nume, continut];
//     const ipfsOptions = {
//       wrapWithDirectory: true,
//       pin: true,
//       progress: (prog) => console.log(`Added ${prog / 1024 / 1024} MB`),
//       timeout: '5m'
//     };
//     console.log(`Uploading folder to IPFS: ${folderPath}`);
//     for await (const file of ipfs.addAll(globSource(folderPath, '**/*'),{ ...ipfsOptions })) {
//       addedFiles.push({
//         cid: file.cid.toString(),
//         path: file.path,
//         size: file.size,
//       });
//     }

//     // for await (const file of ipfs.addAll(
//     //   globSource(folderPath, '**/*', { hidden: true }),
//     //   { ...ipfsOptions, fileImportConcurrency: 1 }
//     // )) {
//     //   // export each added file to a json file
//     //   await writeFile(`./files/addedFile${file.cid.toString()}.json`, JSON.stringify(file, null, 2));
//     //   console.log(`Added file: ${file.path} with CID: ${file.cid.toString()}`);
//     //   addedFiles.push({
//     //     cid: file.cid.toString(),
//     //     path: file.path,
//     //     size: file.size,
//     //   });
//     // }
//     // // export added files to a json file
//     // await writeFile('addedFiles, json', JSON.stringify(addedFiles, null, 2));

//     // console.log("addedFiles: ", JSON.stringify(addedFiles, null, 2));

//     // Return the CID of the root directory
//     return addedFiles.find(file => file.path === '').cid;
//     // return;
//   } catch (e) {
//     console.error(e);
//     return "err";
//   }
// };

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

    for await (const file of ipfs.addAll(globSource(folderPath, '**/*'), { ...ipfsOptions })) {
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
    // console.error(e);
    // if (retryCount < 3) {
    //   console.log(`Retrying... (${retryCount}/3)`);
    //   await delay(2000);
    //   return await uploadFolderToIPFS(folderPath, retryCount + 1);
    // }
    // return "Failed to upload folder to IPFS, please try again.";
    // console.error(e);
    return "Upload failed.";
  }
};

const getFromIPFS = async (hhash,  filePath, maxRetries = process.env.REACT_APP_IPFS_RETRIES || 5) => {
  let res = '';
  let retryCount = 0;
  // console.log('Downloading file from IPFS...');
  // console.log(`Hash: ${hhash}`);
  // console.log(`Max Retries: ${maxRetries}`);

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

const downloadFromIPFS = async (hash, folderPath, maxRetries = process.env.REACT_APP_IPFS_RETRIES || 5) => {
  let retryCount = 0;
  console.log(`Hash: ${hash}`);
  console.log(`Folder Path: ${folderPath}`);
  console.log(`Max Retries: ${maxRetries}`);

  while (retryCount < maxRetries) {
    try {
      for await (const file of ipfs.get(hash)) {
        console.log(`file: ${JSON.stringify(file, null, 2)}`);
        const filePathToWrite = path.join(folderPath, file.path);

        if (file.type === 'dir') {
          await fs.mkdir(filePathToWrite, { recursive: true });
        } else {
          const content = new TextDecoder().decode(file.content);
          await fs.mkdir(path.dirname(filePathToWrite), { recursive: true });
          await fs.writeFile(filePathToWrite, content);
        }
      }
      console.log(`Download complete. Files saved to ${folderPath}`);
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
    // const ipfs = create({ url: 'http://localhost:5001' }); // Adjust the IPFS API URL if necessary

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

// const downloadFolderFromIPFS = async (cid, folderPath) => {
//   try {
//     console.log(`Downloading folder from IPFS: ${cid}`);

//     // let res = await ipfs.get(cid);

//     // const buffer = res[0];

//     const utf8Decode = new TextDecoder('utf-8');
//     // const string = utf8Decode.decode(buffer);

//     // const object = JSON.parse(string);
//     // console.log(`object: ${JSON.stringify(string, null, 2)}`);
//     for await (const file of ipfs.get(cid)) {

//       // console.log(`file: ${JSON.stringify(file, null, 2)}`);
//       console.log(`file decoded: ${JSON.stringify(utf8Decode.decode(file), null, 2)}`);
//       // const buffer = file[0];
//       // console.log(`file: ${JSON.stringify(utf8Decode.decode(buffer), null, 2)}`);
//       process.exit(0);
//       // console.log(`${JSON.stringify(new TextDecoder().decode(file), null, 2)}`)
//       // console.log(`file: ${JSON.stringify(file, null, 2)}`);
//       // console.log(`file: ${JSON.stringify(file, null, 2)}`);
//       // for await (const ffile of ipfs.ls(file.path)) {
//       //   console.log(`ffile: ${JSON.stringify(ffile, null, 2)}`);
//       // }
//       // for await (const ffile of ipfs.get("QmbjQpKFbueKR6QDU2Cj4ChsyGBR2spMwKV2S3yqrjF6w7")) {
//       //   console.log(`ffile: ${JSON.stringify(ffile, null, 2)}`);
//       // }
//       // console.log(`file cid: ${JSON.stringify(await ipfs.get("QmbjQpKFbueKR6QDU2Cj4ChsyGBR2spMwKV2S3yqrjF6w7"), null, 2)}`);

//       // if (!file.path) {
//       //   // console.warn(`Skipping file with undefined path: ${JSON.stringify(file)}`);
//       //   continue;
//       // }

//       // const filePath = path.join(folderPath, file.path);
//       // console.log(`Downloading file: ${filePath}`);
//       // if (file.type === 'dir') {
//       //   fs.mkdirSync(filePath, { recursive: true });
//       // } else {
//       //   fs.mkdirSync(path.dirname(filePath), { recursive: true });
//       //   const content = [];
//       //   for await (const chunk of file.content) {
//       //     content.push(chunk);
//       //   }
//       //   fs.writeFileSync(filePath, Buffer.concat(content));
//       // }
//     }

//     console.log(`Download complete: ${folderPath}`);
//   } catch (e) {
//     console.error(e);
//     return "err";
//   }
// };

const getContentFromIPFS = async (hash, maxRetries = process.env.REACT_APP_IPFS_RETRIES || 5) => {
  let res = '';
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      for await (const file of ipfs.cat(hash)) {
        res += new TextDecoder().decode(file.buffer);
      }

      return res;
    } catch (error) {
      console.error(error.message);
      retryCount += 1;

      if (retryCount < maxRetries) {
        await delay(getRetryDelay(retryCount));
        continue;
      } else {
        throw new Error("ECIPFSDownloadError");
      }
    }
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