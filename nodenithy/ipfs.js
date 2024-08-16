import { create } from 'ipfs-http-client';
import { delay, getRetryDelay } from './utils';
import { ECError } from './enums';

let ipfs = null;
const writeFile = promisify(fs.writeFile);

export const initialize = (host, protocol, port, token) => {
  if (host.search('http') !== -1) {
    ipfs = create(host);
  } else if (token === '') {
    ipfs = create({
      host,
      protocol,
      port
    });
  } else {
    // example of authorization headers
    // headers: {
    //     authorization: 'Bearer ' + TOKEN
    //   }
    // const auth =
    //     'Basic ' + Buffer.from(INFURA_ID + ':' + INFURA_SECRET_KEY).toString('base64');
    ipfs = create({
      host,
      protocol,
      port,
      headers: { authorization: token }
    });
  }
};

export const uploadToIPFS = async (code) => {
  try {
    const response = await ipfs.add(code);
    return response.path;
  } catch (e) {
    console.log(e);
    return null;
  }
};

export const uploadFileToIPFS = async (path) => {
  try {
    const response = await ipfs.add(path);
    return response.path;
  } catch (e) {
    console.log(e);
    return null;
  }
};

export const uploadFolderToIPFS = async (path) => {
  try {
    const response = await ipfs.add(path, { recursive: true });
    return response.path;
  } catch (e) {
    console.log(e);
    return null;
  }
};

// export const getFromIPFS = async (hash) => {
//   let res = '';
//   try {
//     // eslint-disable-next-line no-restricted-syntax
//     for await (const file of ipfs.cat(hash)) {
//       res += new TextDecoder().decode(file.buffer);
//     }
//
//     return res;
//   } catch (error) {
//     console.error(error.message);
//     await delay(2000);
//     return getFromIPFS(hash);
//   }
// };

export const getFromIPFS = async (hash, filePath, maxRetries = process.env.REACT_APP_IPFS_RETRIES || 5) => {
  let res = '';
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      // eslint-disable-next-line no-restricted-syntax,no-await-in-loop
      for await (const file of ipfs.cat(hash)) {
        res += new TextDecoder().decode(file.buffer);
      }

      // Save the content to a file
      await writeFile(filePath, res);
      return res;
    } catch (error) {
      console.error(error.message);
      retryCount += 1;

      if (retryCount < maxRetries) {
        // eslint-disable-next-line no-await-in-loop
        await delay(getRetryDelay(retryCount));
        // eslint-disable-next-line no-continue
        continue;
      } else {
        throw new Error(ECError.IPFS_DOWNLOAD_ERROR);
      }
    }
  }
};

export const getContentFromIPFS = async (hash, maxRetries = process.env.REACT_APP_IPFS_RETRIES || 5) => {
  let res = '';
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      // eslint-disable-next-line no-restricted-syntax,no-await-in-loop
      for await (const file of ipfs.cat(hash)) {
        res += new TextDecoder().decode(file.buffer);
      }

      return res;
    } catch (error) {
      console.error(error.message);
      retryCount += 1;

      if (retryCount < maxRetries) {
        // eslint-disable-next-line no-await-in-loop
        await delay(getRetryDelay(retryCount));
        // eslint-disable-next-line no-continue
        continue;
      } else {
        throw new Error(ECError.IPFS_DOWNLOAD_ERROR);
      }
    }
  }
};
