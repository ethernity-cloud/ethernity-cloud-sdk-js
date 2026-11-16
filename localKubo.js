// The Kubo a publish runs for its own upload.
//
// An image is published by adding it to IPFS and registering its CID. The
// public API of ipfs.ethernity.cloud takes no adds or pins without a writer
// token, so a publish without an IPFS endpoint of its own runs a Kubo in
// docker (the SDK already requires docker), adds the image through that Kubo's
// HTTP API with the same add call (so a build gives the same CIDs on every
// node), peers the Kubo with the bootnode, whose mirror pins every registered
// image and from which the certificate extraction service fetches, and
// releases it when the publish ends (run.js releases it from the process's
// 'exit' event; exitOnInterrupt makes an interrupted publish exit through that
// event). The release removes the Kubo, unless the publish ends with the image
// registered and its certificate not on chain: the registry entry names this
// Kubo's peer id as the image's source, so the Kubo keeps running and the next
// publish of the project takes it over (starting it again when a restart of
// the docker daemon stopped it) and keeps it in turn until the certificate is
// on chain. The Kubo listens for the API on the loopback interface only; its
// swarm port is published when free, so a publisher with a reachable address
// is also dialed directly.
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
// docker's refusal of a `-p` whose host port another container holds
// published; a port a process on the host holds is refused with another
// message, and found by portFree before the run.
const PORT_ALLOCATED = /port is already allocated/;

const PRIVATE = /^\/ip4\/(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|0\.0\.0\.0|169\.254\.)|^\/ip6\/(::1|fe80|fc|fd)/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function portFree(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)));
    });
}

// A port free on the loopback interface, for a container port published
// there: the daemon reaches it under Docker Desktop too, where the daemon runs
// in a VM and a host port the daemon assigns (`-p 127.0.0.1::<port>`) is bound
// on the host side alone.
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

// Make an interrupted publish exit through process.exit, status 130, so that
// the process's 'exit' listeners run (run.js removes the publish's registry
// and releases its Kubo from them). Node emits no 'exit' for a SIGINT,
// SIGTERM or SIGHUP nobody listens to, and `rl`, the publish's readline
// interface, holds a terminal stdin in raw mode, where Ctrl+C reaches it as a
// keypress and is emitted as its own 'SIGINT' event, with no signal to the
// process; without a listener for that event the interface closes and the
// publish goes on.
function exitOnInterrupt(rl) {
    const interrupted = () => process.exit(130);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, interrupted);
    rl.on('SIGINT', interrupted);
}

// The host port in the first line of `docker port <container> 5001/tcp`
// (`127.0.0.1:60823`), or null when there is none.
function apiPortIn(dockerPortOutput) {
    const first = String(dockerPortOutput || '').trim().split('\n')[0] || '';
    const match = /:(\d+)$/.exec(first.trim());
    return match ? Number(match[1]) : null;
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

// The IPFS_ENDPOINT a dApp's template is built with (src/preStart.mjs): the
// setting when it is an endpoint of the application's own, '' otherwise, on
// which the dApp delivers its task artefacts through the bootnode's payload
// intake.
function dappEndpoint(endpoint) {
    return ownEndpoint(endpoint) ? endpoint : '';
}

class LocalKubo {
    constructor(name) {
        this.container = `ecld-kubo-${String(name || 'publish').replace(/[^A-Za-z0-9_.-]/g, '-')}`;
        this.peers = (process.env.ECLD_IPFS_PEERS || BOOTNODE_MULTIADDR).split(',').map((p) => p.trim()).filter(Boolean);
        this.apiUrl = null;
        // True while a registered image has this Kubo as its source: from the
        // image's registration on chain, or from the takeover of the Kubo a
        // previous publish kept (start), until the certificate is on chain. A
        // publish that ends in between leaves the Kubo running (release).
        this.serving = false;
    }

    async api(command, params, timeout) {
        const response = await axios.post(`${this.apiUrl}/api/v0/${command}`, null, { params, timeout: timeout || 30000 });
        return response.data;
    }

    // The docker client with `args`; its stdout, '' when `stdio` drops it.
    // Throws as execFileSync does, with the stderr on the error.
    docker(args, stdio) {
        const out = execFileSync('docker', args, { stdio: stdio || ['ignore', 'pipe', 'pipe'] });
        return out ? out.toString() : '';
    }

    // The API port of the container a previous publish of this project left
    // running (release), or null when none runs: `docker port` fails on a
    // stopped container and on none.
    keptApiPort() {
        try {
            return apiPortIn(this.docker(['port', this.container, '5001/tcp'], ['ignore', 'pipe', 'ignore']));
        } catch (e) {
            return null;
        }
    }

    // Start the stopped container a previous publish of this project left
    // (the Kubo runs with no restart policy, so a restart of the docker
    // daemon stops it); false when there is none docker can start.
    startKept() {
        try {
            this.docker(['start', this.container], 'ignore');
            return true;
        } catch (e) {
            return false;
        }
    }

    // Whether the swarm port is free on every interface of the host.
    swarmPortFree() {
        return portFree(SWARM_PORT);
    }

    // The `docker run` of the Kubo, its API published on `apiPort` of the
    // loopback interface, its swarm port published when `swarm` is set.
    runArgs(apiPort, swarm) {
        const args = ['run', '-d', '--name', this.container, '-p', `127.0.0.1:${apiPort}:5001`];
        if (swarm) args.push('-p', `${SWARM_PORT}:4001`, '-p', `${SWARM_PORT}:4001/udp`);
        args.push(KUBO_IMAGE, 'daemon', '--init', '--migrate=true');
        return args;
    }

    // Start the container and wait for its API, or take over the one a
    // previous publish of this project left serving its registered image,
    // whose peer id that image's registry entry names, serving from the
    // takeover on; peer it with the bootnode. Throws when docker cannot run
    // it or the API does not come up in time, with a container started afresh
    // removed and a taken-over one left to the release.
    async start() {
        let kept = this.keptApiPort();
        if (kept === null && this.startKept()) kept = this.keptApiPort();
        if (kept !== null) {
            this.apiUrl = `http://127.0.0.1:${kept}`;
            this.serving = true;
            console.log(`\t✔  IPFS node of the previous publish kept: ${this.container}`);
        } else {
            this.stop();
            const apiPort = await freePort();
            this.apiUrl = `http://127.0.0.1:${apiPort}`;
            // The swarm port is published when free. A port another
            // container holds published is refused by docker as allocated
            // (PORT_ALLOCATED); the Kubo is then run without the swarm port
            // and is reached, as a publisher behind NAT is, over the
            // connection it opens to the bootnode.
            let swarm = await this.swarmPortFree();
            for (;;) {
                try {
                    this.docker(this.runArgs(apiPort, swarm));
                    break;
                } catch (e) {
                    // A run docker refuses leaves the created container behind.
                    this.stop();
                    const refusal = String(e.stderr || e.message).trim();
                    if (swarm && PORT_ALLOCATED.test(refusal)) {
                        console.log(`\t⚠  swarm port ${SWARM_PORT} is allocated to another container; the IPFS node is not dialed directly`);
                        swarm = false;
                        continue;
                    }
                    throw new Error(`docker could not start ${KUBO_IMAGE}: ${refusal}`);
                }
            }
        }
        const deadline = Date.now() + API_READY_MS;
        for (;;) {
            try {
                await this.api('id', {}, 5000);
                break;
            } catch (e) {
                if (Date.now() > deadline) {
                    if (!this.serving) this.stop();
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

    // Remove the container.
    stop() {
        try { this.docker(['rm', '-f', this.container], 'ignore'); } catch (e) { /* already gone */ }
    }

    // End the publish's use of the Kubo: stop it, unless it is the source of
    // a registered image whose certificate is not on chain yet, which it keeps
    // serving to the extraction service and the bootnode's mirror; the next
    // publish of the project takes it over, `docker rm -f` stops it.
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

module.exports = { LocalKubo, ownEndpoint, dappEndpoint, apiPortIn, freePort, exitOnInterrupt, PUBLIC_IPFS_HOST };
