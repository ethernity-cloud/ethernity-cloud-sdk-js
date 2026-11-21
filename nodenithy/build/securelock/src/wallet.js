const ethers = require('ethers');
const {sha256} = require('./etny_crypto');

function getWalletAddress(clientChallenge, enclaveChallenge) {
    const encoded = clientChallenge + enclaveChallenge;
    const walletPrivate = sha256(sha256(encoded));

    const wallet = new ethers.Wallet(walletPrivate);
    console.log('Enclave wallet address:', wallet.address);
    return [wallet.address, walletPrivate];
}

function generateWalletFromPrivate(hash) {
    return new ethers.Wallet(hash);
}

module.exports = {
    getWalletAddress,
    generateWalletFromPrivate
}
