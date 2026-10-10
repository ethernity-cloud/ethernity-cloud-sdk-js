// The publish's own Kubo: when a publish runs one, how it is registered on
// chain, and when it is stopped. No docker and no network: the Kubo's API and
// `docker rm` are replaced.
const test = require('node:test');
const assert = require('node:assert/strict');

const { LocalKubo, ownEndpoint } = require('../localKubo.js');

const PEER = '12D3KooWB8qpxeHqcdb6xTNu3FXjrWE4zTFPverw8XMpms2Qm4pJ';

function kubo(addresses) {
    const k = new LocalKubo('accept m3');
    k.api = async () => ({ ID: PEER, Addresses: addresses });
    return k;
}

test('an empty setting and the public API mean a Kubo of the publish\'s own', () => {
    assert.equal(ownEndpoint(''), false);
    assert.equal(ownEndpoint(undefined), false);
    assert.equal(ownEndpoint('https://ipfs.ethernity.cloud'), false);
    assert.equal(ownEndpoint('https://ipfs.ethernity.cloud:443/api/v0'), false);
    assert.equal(ownEndpoint('not a url'), false);
});

test('another endpoint is the application\'s own', () => {
    assert.equal(ownEndpoint('http://172.18.0.30:5001'), true);
    assert.equal(ownEndpoint('https://ipfs.example.org/api/v0'), true);
});

test('the container is named after the project', () => {
    assert.equal(kubo([]).container, 'ecld-kubo-accept-m3');
});

test('the first public address is registered', async () => {
    const k = kubo([
        `/ip4/127.0.0.1/tcp/4001/p2p/${PEER}`,
        `/ip4/172.17.0.2/tcp/4001/p2p/${PEER}`,
        `/ip4/80.255.2.15/tcp/4001/p2p/QmRBc1eBt4hpJQUqHqn6eA8ixQPD3LFcUDsn6coKBQtia5/p2p-circuit/p2p/${PEER}`,
        `/ip4/93.255.3.60/tcp/4001/p2p/${PEER}`,
        `/ip4/93.255.3.60/udp/4001/quic-v1/p2p/${PEER}`,
    ]);
    assert.equal(await k.peerMultiaddr(), `/ip4/93.255.3.60/tcp/4001/p2p/${PEER}`);
});

test('behind NAT the bare peer id is registered', async () => {
    const k = kubo([`/ip4/127.0.0.1/tcp/4001/p2p/${PEER}`, `/ip4/192.168.1.20/udp/4001/quic-v1/p2p/${PEER}`]);
    assert.equal(await k.peerMultiaddr(), `/p2p/${PEER}`);
});

function releasing(k) {
    const stopped = [];
    const printed = [];
    k.stop = () => stopped.push(k.container);
    const log = console.log;
    console.log = (line) => printed.push(line);
    try {
        k.release();
    } finally {
        console.log = log;
    }
    return { stopped, printed };
}

test('a Kubo serving no registered image is stopped on release', () => {
    const k = kubo([]);
    const { stopped, printed } = releasing(k);
    assert.deepEqual(stopped, [k.container]);
    assert.deepEqual(printed, []);
});

test('a Kubo serving a registered image is kept on release', () => {
    const k = kubo([]);
    k.serving = true;
    const { stopped, printed } = releasing(k);
    assert.deepEqual(stopped, []);
    assert.ok(printed.some((line) => line.includes(k.container)));
});
