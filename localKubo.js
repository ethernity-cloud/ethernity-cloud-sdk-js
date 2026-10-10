// The Kubo a publish runs for its own upload.
//
// An image is published by adding it to IPFS and registering its CID. The
// public write API of ipfs.ethernity.cloud is closing, so a publish without an
// IPFS endpoint of its own runs a Kubo in docker (the SDK already requires
// docker), adds the image through that Kubo's HTTP API with the same call the
// public API received (so a build gives the same CIDs as before), peers the
// Kubo with the bootnode, whose mirror pins every registered image and from
// which the certificate extraction service fetches, and stops it once the
// certificate is on chain. The Kubo listens for the API on the loopback
// interface only; its swarm port is published when free, so a publisher with
// a reachable address is also dialed directly.
const { execFileSync } = require('child_process');
const net = require('net');
const axios = require('axios');

const KUBO_IMAGE = process.env.ECLD_KUBO_IMAGE || 'ipfs/kubo:release';
// The bootnode's IPFS node (ipfs.ethernity.cloud), as the node agents peer with it.
const BOOTNODE_MULTIADDR = '/dns4/ipfs.ethernity.cloud/tcp/4001/p2p/QmRBc1eBt4hpJQUqHqn6eA8ixQPD3LFcUDsn6coKBQtia5';
const SWARM_PORT = Number(process.env.ECLD_KUBO_SWARM_PORT || 4001);
const API_READY_MS = 90000;
// The public IPFS API: an IPFS_ENDPOINT naming it is not an endpoint of the
// application's own, so the publish runs its own Kubo instead.
const PUBLIC_IPFS_HOST = 'ipfs.ethernity.cloud';

const PRIVATE = /^\/ip4\/(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.)|^\/ip6\/(::1|fe80|fc|fd)/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portFree(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
    });
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

// Whether the configured endpoint is one of the application's own; the public
// API and an empty setting both mean "run a Kubo for this publish".
function ownEndpoint(endpoint) {
    if (!endpoint) return false;
    try {
        return new URL(endpoint).hostname !== PUBLIC_IPFS_HOST;
    } catch (e) {
        return false;
    }
}

class LocalKubo {
    constructor(name) {
        this.container = `ecld-kubo-${String(name || 'publish').replace(/[^A-Za-z0-9_.-]/g, '-')}`;
        this.peers = (process.env.ECLD_IPFS_PEERS || BOOTNODE_MULTIADDR).split(',').map((p) => p.trim()).filter(Boolean);
        this.apiUrl = null;
        // True while a registered image has this Kubo as its source: from the
        // image's registration on chain until its certificate is on chain. A
        // publish that ends in between leaves the Kubo running (release).
        this.serving = false;
    }

    async api(command, params, timeout) {
        const response = await axios.post(`${this.apiUrl}/api/v0/${command}`, null, { params, timeout: timeout || 30000 });
        return response.data;
    }

    // Start the container and wait for its API; peer it with the bootnode.
    // Throws when docker cannot run it or the API does not come up in time.
    async start() {
        const apiPort = await freePort();
        this.apiUrl = `http://127.0.0.1:${apiPort}`;
        try { execFileSync('docker', ['rm', '-f', this.container], { stdio: 'ignore' }); } catch (e) { /* not running */ }
        const args = ['run', '-d', '--name', this.container, '-p', `127.0.0.1:${apiPort}:5001`];
        if (await portFree(SWARM_PORT)) {
            args.push('-p', `${SWARM_PORT}:4001`, '-p', `${SWARM_PORT}:4001/udp`);
        }
        args.push(KUBO_IMAGE, 'daemon', '--init', '--migrate=true');
        try {
            execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) {
            throw new Error(`docker could not start ${KUBO_IMAGE}: ${String(e.stderr || e.message).trim()}`);
        }
        const deadline = Date.now() + API_READY_MS;
        for (;;) {
            try {
                await this.api('id', {}, 5000);
                break;
            } catch (e) {
                if (Date.now() > deadline) {
                    this.stop();
                    throw new Error(`the Kubo API did not come up in ${API_READY_MS / 1000}s`);
                }
                await sleep(2000);
            }
        }
        // The peering service dials each peer and keeps the connection; the
        // connect is waited for, not forced, since the service's own dial and
        // a swarm/connect of the same peer refuse each other.
        for (const peer of this.peers) {
            try {
                await this.api('swarm/peering/add', { arg: peer }, 15000);
            } catch (e) {
                console.log(`\t⚠  could not peer with ${peer}: ${e.message}`);
                continue;
            }
            const until = Date.now() + 30000;
            while (!(await this.connectedTo(peer)) && Date.now() < until) {
                await sleep(1000);
            }
            if (!(await this.connectedTo(peer))) {
                console.log(`\t⚠  not connected to ${peer} yet; the peering service keeps trying`);
            }
        }
    }

    // How this Kubo is registered on chain: its first public address with the
    // peer id, or /p2p/<id> when it has none a stranger could dial (the
    // bootnode reaches it over the connection it opened).
    async peerMultiaddr() {
        const identity = await this.api('id', {});
        const peerId = identity.ID;
        for (const address of identity.Addresses || []) {
            if (!PRIVATE.test(address) && !address.includes('/p2p-circuit') && address.includes(`/p2p/${peerId}`)) {
                return address;
            }
        }
        return `/p2p/${peerId}`;
    }

    // Announce `cid` to the DHT so a node not connected to this one can find
    // it. Best effort.
    async provide(cid) {
        try {
            await axios.post(`${this.apiUrl}/api/v0/routing/provide`, null, { params: { arg: cid }, timeout: 180000 });
        } catch (e) {
            console.log(`\t⚠  could not announce ${cid}: ${e.message}`);
        }
    }

    async connectedTo(peerMultiaddr) {
        const peerId = peerMultiaddr.split('/p2p/').pop();
        try {
            const peers = (await this.api('swarm/peers', {})).Peers || [];
            return peers.some((p) => p.Peer === peerId);
        } catch (e) {
            return false;
        }
    }

    stop() {
        try { execFileSync('docker', ['rm', '-f', this.container], { stdio: 'ignore' }); } catch (e) { /* already gone */ }
    }

    // End the publish's use of the Kubo: stop it, unless it is the source of
    // a registered image whose certificate is not on chain yet, which it keeps
    // serving to the extraction service and the bootnode's mirror; the next
    // publish of the project replaces it, `docker rm -f` stops it.
    release() {
        if (!this.serving) {
            this.stop();
            return;
        }
        console.log(`\t⚠  The registered image stays available from this publish's IPFS node, the docker`);
        console.log(`\t   container ${this.container}, for the extraction service and the bootnode.`);
        console.log(`\t   Publish again to retry; \`docker rm -f ${this.container}\` stops it.`);
    }
}

module.exports = { LocalKubo, ownEndpoint, PUBLIC_IPFS_HOST };
