const ethers = require('ethers');
const {sha256} = require('./etny_crypto');

function getWalletAddress(clientChallenge, enclaveChallenge) {
    const encoded = clientChallenge + enclaveChallenge;
    //console.log(encoded);
    const walletPrivate = sha256(sha256(encoded));
    //console.log(`0x${walletPrivate}`);
    const wallet = new ethers.Wallet(walletPrivate);
    //console.log(wallet);
    console.log('Enclave wallet address:', wallet.address);
    return [wallet.address, walletPrivate];
}

function generateWalletFromPrivate(hash) {
    return new ethers.Wallet(hash);
}

// const firstString = 'test';
// const secondString = 'test';
// const [addr, private] = getWalletAddress(firstString, secondString);
// console.log('account address =', addr); // 0xf63106856F7007A30025f0fFD5A534EA880878C3
// console.log('private =', private);

module.exports = {
    getWalletAddress,
    generateWalletFromPrivate
}
