'use strict';
// The publishing wallet's private key: its encrypted form in the project's
// .env and the order in which ecld-publish and ecld-run find the key.
//
// ENC_PRIVATE_KEY is the form PrivateKeyManager of ethernity-cloud-sdk-py
// writes and reads: base64(salt || iv || ciphertext), where salt and iv are
// 16 random bytes each and the ciphertext is the key as entered, in UTF-8,
// encrypted with AES-256-CBC and PKCS#7 padding under the 32-byte key
// PBKDF2-HMAC-SHA256(password, salt, 100000 iterations). WALLET_ADDRESS is
// the address of that key. ecld-publish writes both to .env and writes no
// PRIVATE_KEY there.

const crypto = require('crypto');
const fs = require('fs');
const { StringDecoder } = require('string_decoder');
const dotenv = require('dotenv');
const { utils: { computeAddress } } = require('ethers');

const SALT_LENGTH = 16;
const IV_LENGTH = 16;
const BLOCK_LENGTH = 16;
const ITERATIONS = 100000;
const KEY_LENGTH = 32;

// The order of secp256k1's group: a private key is an integer in [1, N).
const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

// A key that cannot be had: the command prints the message, when it has one,
// and exits with exitCode.
class KeyError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'KeyError';
    this.exitCode = exitCode;
  }
}

const deriveKey = (password, salt) =>
  crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, ITERATIONS, KEY_LENGTH, 'sha256');

// ENC_PRIVATE_KEY for `privateKey` under `password`, with a fresh salt and IV.
function encryptPrivateKey(privateKey, password) {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', deriveKey(password, salt), iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey, 'utf8')), cipher.final()]);
  return Buffer.concat([salt, iv, ciphertext]).toString('base64');
}

// The parts of an ENC_PRIVATE_KEY, or null when it holds no whole block of
// ciphertext after its salt and IV.
function encryptedParts(encrypted) {
  const data = Buffer.from(String(encrypted), 'base64');
  const ciphertext = data.subarray(SALT_LENGTH + IV_LENGTH);
  if (ciphertext.length === 0 || ciphertext.length % BLOCK_LENGTH !== 0) return null;
  return { salt: data.subarray(0, SALT_LENGTH), iv: data.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH), ciphertext };
}

// The key ENC_PRIVATE_KEY `encrypted` holds under `password`. Throws when it is
// not of that form, and when the password gives a padding that is not PKCS#7
// or a plaintext that is not UTF-8, as PrivateKeyManager.decrypt_private_key
// does.
function decryptPrivateKey(encrypted, password) {
  const parts = encryptedParts(encrypted);
  if (!parts) throw new Error('ENC_PRIVATE_KEY is not an encrypted key');
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', deriveKey(password, parts.salt), parts.iv);
    const plaintext = Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]);
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(plaintext);
  } catch (e) {
    throw new Error('the password does not decrypt ENC_PRIVATE_KEY');
  }
}

// The checksummed address of a private key given with or without its 0x
// prefix. Throws, without quoting the key, for anything else.
function walletAddress(privateKey) {
  const text = String(privateKey);
  const hex = text.startsWith('0x') ? text : `0x${text}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex) || BigInt(hex) === 0n || BigInt(hex) >= SECP256K1_N) {
    throw new Error('not a secp256k1 private key');
  }
  return computeAddress(hex);
}

const usable = (privateKey) => {
  try {
    walletAddress(privateKey);
    return true;
  } catch (e) {
    return false;
  }
};

// The variables the .env file `file` sets, as dotenv reads them; none when
// there is no such file.
function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return dotenv.parse(fs.readFileSync(file));
}

// One line read from the terminal `input` without echo: `question` is written
// to `output` and the terminal is put in raw mode until Enter (CR or LF).
// Backspace (DEL or BS) removes the last character, an escape sequence (an
// arrow or function key) and every other control character is dropped, and
// Ctrl-C rejects with KeyError(130). The terminal's mode is restored and the
// input paused when the line ends.
function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const wasRaw = Boolean(input.isRaw);
    const chars = [];
    // null, 'start' after ESC, 'sequence' after ESC [ or ESC O.
    let escape = null;
    const end = () => {
      input.removeListener('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of decoder.write(chunk)) {
        if (escape === 'start') {
          escape = ch === '[' || ch === 'O' ? 'sequence' : null;
        } else if (escape === 'sequence') {
          if (ch >= '@' && ch <= '~') escape = null;
        } else if (ch === '\r' || ch === '\n') {
          end();
          resolve(chars.join(''));
          return;
        } else if (ch === '\u0003') {
          end();
          reject(new KeyError(130, ''));
          return;
        } else if (ch === '\u007f' || ch === '\b') {
          chars.pop();
        } else if (ch === '\u001b') {
          escape = 'start';
        } else if (ch >= ' ') {
          chars.push(ch);
        }
      }
    };
    output.write(question);
    input.setRawMode(true);
    input.on('data', onData);
    input.resume();
  });
}

const PLAINTEXT_NOTICE = 'PRIVATE_KEY is read from .env, which holds it in plain text; '
  + 'remove that line and publish again to store the key encrypted under a password.';

const NO_WALLET = 'Without a wallet, you will not be able to publish.\n'
  + 'Please refer to Blockchain Wallets Documentation '
  + '(https://docs.ethernity.cloud/ethernity-node/prerequisites-ethernity-node/blockchain-wallets).';

// Writes ENC_PRIVATE_KEY and WALLET_ADDRESS for `privateKey` under `password`.
function storeKey({ writeEnv, log }, privateKey, password, address) {
  writeEnv('ENC_PRIVATE_KEY', encryptPrivateKey(privateKey, password));
  writeEnv('WALLET_ADDRESS', address);
  log(`The private key of ${address} is stored encrypted in .env (ENC_PRIVATE_KEY).`);
}

// The key ENC_PRIVATE_KEY `encrypted` holds, decrypted with ECLD_KEY_PASSWORD
// of the environment, else with a password asked on the terminal until one
// decrypts it to a private key.
async function unlockStoredKey(command, encrypted, { env, isTTY, promptHidden: askHidden, log }) {
  if (!encryptedParts(encrypted)) throw new KeyError(2, 'ENC_PRIVATE_KEY in .env is not an encrypted key.');
  const opened = (password) => {
    try {
      const privateKey = decryptPrivateKey(encrypted, password);
      return usable(privateKey) ? privateKey : null;
    } catch (e) {
      return null;
    }
  };
  const password = env.ECLD_KEY_PASSWORD || '';
  if (password) {
    const privateKey = opened(password);
    if (privateKey === null) {
      throw new KeyError(2, 'ECLD_KEY_PASSWORD does not decrypt the stored key (ENC_PRIVATE_KEY in .env).');
    }
    return privateKey;
  }
  if (!isTTY) {
    throw new KeyError(2, 'The stored key (ENC_PRIVATE_KEY in .env) is encrypted and there is no terminal '
      + `to ask for its password: set ECLD_KEY_PASSWORD, or ECLD_PRIVATE_KEY, for an unattended ${command}.`);
  }
  for (;;) {
    const privateKey = opened(await askHidden('Enter your private key password: '));
    if (privateKey !== null) return privateKey;
    log('Incorrect password. Please try again.');
  }
}

// A password asked on the terminal twice, until it is not empty and both
// answers are the same.
async function newPassword({ promptHidden: askHidden, log }) {
  for (;;) {
    const password = await askHidden('Set a password for your private key: ');
    if (!password) {
      log('The password is empty.');
    } else if ((await askHidden('Repeat the password: ')) === password) {
      return password;
    } else {
      log('The passwords differ.');
    }
  }
}

// The key entered on the terminal for a project with none, stored encrypted.
async function enterKey(deps) {
  const { isTTY, prompt, log } = deps;
  if (!isTTY) {
    throw new KeyError(2, 'No wallet is configured and there is no terminal to ask for one: set ECLD_PRIVATE_KEY, '
      + 'and ECLD_KEY_PASSWORD to store it encrypted in .env, for an unattended publish.');
  }
  const hasWallet = (await prompt('Do you have an existing wallet? (yes/no) (default value: no) ')) || 'no';
  log('');
  if (hasWallet.toLowerCase() !== 'yes') throw new KeyError(1, NO_WALLET);
  let privateKey = String(await prompt('Enter your private key: ')).trim();
  while (!usable(privateKey)) {
    privateKey = String(await prompt('Invalid private key. Please enter a valid private key: ')).trim();
  }
  log('Inputted Private key is valid.');
  storeKey(deps, privateKey, await newPassword(deps), walletAddress(privateKey));
  return privateKey;
}

// The private key `command` ('publish' or 'run') signs with.
//
// deps: env, the environment the command was started with (before dotenv);
// file, the variables of the project's .env; isTTY, whether stdin is a
// terminal; prompt(question) and promptHidden(question), which answer a
// question, the second without echo; writeEnv(name, value), which sets a
// variable in .env; log(line), which prints a line.
//
// A variable the environment sets is read from it, else from the file, as
// dotenv gives the environment precedence. ECLD_KEY_PASSWORD is read from the
// environment only, and so is ECLD_PRIVATE_KEY for 'publish'.
//
// 'publish': ECLD_PRIVATE_KEY, which with ECLD_KEY_PASSWORD is also stored as
// ENC_PRIVATE_KEY and WALLET_ADDRESS; else PRIVATE_KEY as given, with
// PLAINTEXT_NOTICE when it comes from the file; else ENC_PRIVATE_KEY,
// decrypted; else, on a terminal, the key entered and a password set for it,
// stored as ENC_PRIVATE_KEY and WALLET_ADDRESS.
// 'run': PRIVATE_KEY, else ECLD_PRIVATE_KEY; else ENC_PRIVATE_KEY, decrypted.
//
// Nothing is written but ENC_PRIVATE_KEY and WALLET_ADDRESS, and no line
// printed, question asked or error thrown holds the key.
async function resolvePrivateKey(command, deps) {
  if (command !== 'publish' && command !== 'run') throw new TypeError(`unknown command ${command}`);
  const { env = {}, file = {}, log = () => {} } = deps;
  const all = { isTTY: false, prompt: null, promptHidden, writeEnv: null, ...deps, env, file, log };
  const fromEnv = (name) => Object.prototype.hasOwnProperty.call(env, name);
  const value = (name) => String((fromEnv(name) ? env[name] : file[name]) || '').trim();

  if (command === 'publish') {
    const given = String(env.ECLD_PRIVATE_KEY || '').trim();
    if (given) {
      if (!usable(given)) throw new KeyError(2, 'ECLD_PRIVATE_KEY is not a usable private key.');
      if (env.ECLD_KEY_PASSWORD) storeKey(all, given, env.ECLD_KEY_PASSWORD, walletAddress(given));
      return given;
    }
    const plain = value('PRIVATE_KEY');
    if (plain) {
      if (!fromEnv('PRIVATE_KEY')) log(PLAINTEXT_NOTICE);
      return plain;
    }
  } else {
    const plain = value('PRIVATE_KEY') || value('ECLD_PRIVATE_KEY');
    if (plain) return plain;
  }

  const encrypted = value('ENC_PRIVATE_KEY');
  if (encrypted) return unlockStoredKey(command, encrypted, all);
  if (command === 'run') {
    throw new KeyError(1, 'no signing key. Set ECLD_PRIVATE_KEY (a funded 0x key), or keep the key encrypted '
      + 'in .env as ENC_PRIVATE_KEY, which ecld-publish writes, and set ECLD_KEY_PASSWORD to its password '
      + 'or enter the password when asked.');
  }
  return enterKey(all);
}

module.exports = {
  ITERATIONS,
  KeyError,
  PLAINTEXT_NOTICE,
  decryptPrivateKey,
  encryptPrivateKey,
  promptHidden,
  readEnvFile,
  resolvePrivateKey,
  walletAddress,
};
