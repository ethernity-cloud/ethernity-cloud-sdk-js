// const tt = require("./etny_crypto");
//
// const p = '4c351ff11a73151f3de1fc686c8bdf63c07b28cb814797d0b1dd361d9fea4008';
//
// const b = tt.encryptWithPublicKey(p, 'hello');
// console.log(b.toString('utf8'));
//
//


const SwiftStreamService = require("./swift_stream_service");
const etny_crypto = require("./etny_crypto");
const fs = require('fs');

(async () => {
    try {
        console.log('################################');
        console.log('Initializing SwiftStream Service...');
        const swiftStreamClient = new SwiftStreamService(
            "localhost",
            9000,
            "swiftstreamadmin",
            "swiftstreamadmin");
        console.log('SwiftStream Service started.');
        console.log('################################');

        const p = '4c351ff11a73151f3de1fc686c8bdf63c07b28cb814797d0b1dd361d9fea4008';
        const message = '3';
        const encrypted = etny_crypto.encryptWithPublicKey(p, message);
        // console.log('Encrypted result:', encrypted.toString('utf8'));
        console.log('Encrypted result:', encrypted.toString('hex'));
        // console.log('Encrypted result:', Buffer.from(encrypted, 'hex'));
        // await fs.promises.writeFile('test.txt', Buffer.from(encrypted, 'hex'));
        await swiftStreamClient.putFileContent('etny-nodenithy-v2', 'result11.txt', 'test.txt', encrypted.toString('hex'));

        const t = await swiftStreamClient.getFileContent('etny-nodenithy-v2', 'result11.txt');
        console.log(t);
        // await swiftStreamClient.putFileContent('etny-nodenithy-v2', 'result1.txt', '/result', Buffer.from(message, 'utf8'));
        // await swiftStreamClient.putFileContent('etny-nodenithy-v2', 'result2.txt', '/result', Buffer.from(message, 'utf8'));
    } catch (e) {
        console.log(e);
    }
})();

