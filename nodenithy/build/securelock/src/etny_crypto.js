const fs = require("fs");
const elliptic = require('elliptic');
const crypto = require('crypto');
const rs = require('jsrsasign');
const ECKey = require('ec-key');
const curve = new elliptic.ec('p384');
const ascii85 = require('ascii85');
const ethSigUtil = require('@metamask/eth-sig-util');
const {createHash} = require('crypto');

function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}

function fileChecksum(file) {
    const fileContent = fs.readFileSync(file, 'utf8');
    return sha256(fileContent);
}

async function fileChecksumFromSwiftStream(swiftStreamClient, bucketName, fileName) {
    const fileContent = await swiftStreamClient.getFileContent(bucketName, fileName);
    //console.log(fileContent);
    return sha256(fileContent);
}

const getPEMFromPublicFile = (publicKeyPath) => {
    const publicKey = fs.readFileSync(publicKeyPath, 'utf8');
    return crypto.createPublicKey(publicKey).export({type: 'spki', format: 'pem'});
}

const getPEMFromPublic = (publicKey) => {
    return crypto.createPublicKey(publicKey).export({type: 'spki', format: 'pem'});
}

const loadCertificate = (certificate) => {
    //console.log(certificate)
    const publicKeyPEM = getPEMFromPublic(certificate);
    const key = new ECKey(publicKeyPEM, 'pem');
    //console.log(key);
    return key;
}

function getPrivatePointFromPrivateKey(privateKeyFile) {
    let privateKey = fs.readFileSync(privateKeyFile, 'utf8');
    //console.log(privateKey);
    let privateKeyHex = rs.KEYUTIL.getKey(privateKey).prvKeyHex;
    const privateKeyObject = curve.keyFromPrivate(privateKeyHex, 'hex');
    return privateKeyObject.getPrivate();
}

const generatePublicKey = (x, y) => {
    const pub = {x: x, y};
    return curve.keyFromPublic(pub, 'hex');
}

function getPublicPointFromCoords(x, y) {
    const publicKey = generatePublicKey(x, y);
    return publicKey.getPublic();
}

function ecc_point_to_256_bit_key(point) {
    const value = point.getX().toString() + point.getY().toString();
    const hash = crypto.createHash('sha256');
    hash.update(value);
    return hash.digest();
}

function encryptedDataToBase64Json(encryptedMsg) {
    const key = curve.keyFromPublic(encryptedMsg.cipherTextPublicKey, 'hex');
    const jsonObj = {
        ciphertext: encryptedMsg.ciphertext.toString('hex'),
        nonce: encryptedMsg.nonce.toString('hex'),
        authTag: encryptedMsg.authTag.toString('hex'),
        x: key.getPublic().getX(),
        y: key.getPublic().getY()
    };
    const jsonString = JSON.stringify(jsonObj);
    const binaryData = Buffer.from(jsonString, 'utf8');
    return binaryData.toString('base64');
}

function encryptedDataFromBase64Json(base64Data) {
    // decode the base64-encoded string back to a JSON string
    const decodedJsonData = Buffer.from(base64Data, 'base64').toString('utf8');
    return JSON.parse(decodedJsonData);
}


function encrypt(certificate, message) {
    const key = loadCertificate(certificate);
    return encrypt_ecc(message, generatePublicKey(key.x, key.y));
}

function encrypt_ecc(msg, publicKey) {
    const cipherTextPrivateKey = crypto.randomBytes(32);
    const sharedEccKey = publicKey.getPublic().mul(cipherTextPrivateKey);
    const secretKey = ecc_point_to_256_bit_key(sharedEccKey);
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
    let encrypted = cipher.update(msg, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const cipherTextPublicKey = curve.g.mul(cipherTextPrivateKey);
    return {
        ciphertext: encrypted,
        secretKey: secretKey,
        nonce: iv,
        authTag: cipher.getAuthTag().toString("hex"),
        cipherTextPublicKey: cipherTextPublicKey.encode('hex')
    };
}

function decrypt(privateKeyFile, encryptedMsg) {
    //console.log(privateKeyFile);
    const privatePoint = getPrivatePointFromPrivateKey(privateKeyFile);
    return decrypt_ecc(encryptedMsg, privatePoint);
}

function decrypt_ecc(encryptedMsg, privatePoint) {
    try {
        const {ciphertext, nonce, authTag, x, y} = encryptedMsg;
        const publicPoint = getPublicPointFromCoords(`${x}`, `${y}`);
        const sharedEccKey = publicPoint.mul(privatePoint);
        const secretKey = ecc_point_to_256_bit_key(sharedEccKey);

        const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, Buffer.from(nonce, 'hex'));
        decipher.setAuthTag(Buffer.from(authTag, 'hex'));
        let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch (e) {
        console.log(`Error while decrypting ECC:`, e.message);
        return false;
    }
}

function hexToBytes(hexStr) {
    if (hexStr.startsWith("0x")) {
        hexStr = hexStr.slice(2);
    }
    return Buffer.from(hexStr, "hex");
}

function encryptWithPublicKey(publicKey, data) {
    // Returned object contains 4 properties: version, ephemPublicKey, nonce, ciphertext
    // Each contains data encoded using base64, version is always the same string
    const enc = ethSigUtil.encrypt({
        publicKey: hexToBytes(publicKey).toString('base64'),
        data: ascii85.encode(Buffer.from(data)).toString(),
        version: 'x25519-xsalsa20-poly1305',
    });

    // We want to store the data in smart contract, therefore we concatenate them
    // into single Buffer
    const buf = Buffer.concat([
        Buffer.from(enc.ephemPublicKey, 'base64'),
        Buffer.from(enc.nonce, 'base64'),
        Buffer.from(enc.ciphertext, 'base64'),
    ]);

    // In smart contract we are using `bytes[112]` variable (fixed size byte array)
    // you might need to use `bytes` type for dynamic sized array
    // We are also using ethers.js which requires type `number[]` when passing data
    // for argument of type `bytes` to the smart contract function
    // Next line just converts the buffer to `number[]` required by contract function
    // THIS LINE IS USED IN OUR ORIGINAL CODE:
    // return buf.toJSON().data;

    // Return just the Buffer to make the function directly compatible with decryptData function
    return buf;
}

// (async () => {
//     try {
//         const message = 'testabc1';
//         console.log('initial message:', message);
//         const publicKeyPEM = getPEMFromPublic('./app/cert1-ca1-clean.crt');
//         const ECKey = require('ec-key');
//         const key = new ECKey(publicKeyPEM, 'pem');
//         const encrypted_message = encrypt(key.x, key.y, message);
//         console.log(encrypted_message);
//         console.log(encryptedDataToBase64Json(encrypted_message));
//         //
//         // const encrypted_message = 'eyJjaXBoZXJ0ZXh0IjoiZTYzZTcyNDY0MWY4YWRmN2QyNjNmMTI0ZGYxZTdlYzZmNGM5NGU1NCIsIm5vbmNlIjoiYmE0YWU5YjMyOWFhZWRiM2ViZTM5MGU4YTY3YWFiNmMiLCJhdXRoVGFnIjoiOGU2NmI4NTVmNTE3N2E0NzZlMjkwNTE3Y2Q2ZDE3ZmUiLCJ4IjoiN2E1MjhhNGI5YzAzODM4Mjc0ZmFiYzVlM2RiOWQ2ZWFiNzBiZTFiMDA3YWJiOTcyYzI0YmFhNGE1ZmI4OGJjNTVmNDVlNGNkMjZjY2NhNTFhOTk3OGZkNDRhZmE1YjQ0IiwieSI6IjE5M2NjMWYwMzVmOGMxZjEzNGU4MTEzOGIyOTRiODBiZWQyYjkyMzdkZmIyOTMyOGRjOTg1MzlmMjhkNjIzMTJiYTQ2OTU2NDFkYjIyNjk0ZWUyNGFjZjQ4MjBiZDlhMSJ9';
//         // const messageDecrypted = decrypt('./app/cert1-ca1-clean.key', encryptedDataToBase64Json(encrypted_message));
//         // console.log('decrypted message:', messageDecrypted);
//     } catch (e) {
//         console.log(e);
//     }
//
// })();

module.exports = {
    encryptedDataFromBase64Json,
    encryptedDataToBase64Json,
    encryptWithPublicKey,
    decrypt,
    encrypt,
    sha256,
    fileChecksum,
    fileChecksumFromSwiftStream
};
