// The registry a publish serves its own build's image tree from.
//
// ecld-build pushes the securelock, the trustedzone and the LAS to the
// localhost:5000 registry of the machine and snapshots that registry's data
// as <project>/registry, the image tree the publish uploads and registers.
// Every build on the machine replaces what localhost:5000 serves, so the
// publish measures the enclave from the project's own tree instead: it runs a
// registry:2 container of the project's own with the tree mounted read-only,
// published on the loopback interface at a port free there, and renders the
// local compose against that address. The shipped compose keeps
// localhost:5000, the address the registry answers at on a node. The
// container is removed when the publish ends, on success and on failure
// alike. ecld-build records the securelock it pushed in .env
// (SECURELOCK_IMAGE_DIGEST, MRENCLAVE_SECURELOCK_SIGNED), and the publish
// refuses a tree whose securelock is another one (buildGateRefusal).
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { freePort } = require('./localKubo.js');

const REGISTRY_IMAGE = 'registry:2';
const READY_MS = 30000;
// The repositories ecld-build pushes, as the tree and the composes name them.
const REPOSITORIES = ['etny-las', 'etny-securelock', 'etny-trustedzone'];
// The securelock as a build pushes it to the machine's registry.
const SECURELOCK_IMAGE = 'localhost:5000/etny-securelock';
// `docker inspect <image> --format`: one RepoDigest (`<repository>@sha256:...`) per line.
const REPO_DIGESTS_FORMAT = '{{range .RepoDigests}}{{println .}}{{end}}';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The digest `image` was pushed or pulled by (`sha256:...`), out of the
// RepoDigests docker prints for it with REPO_DIGESTS_FORMAT; '' when docker
// records none for that repository. An image pushed or pulled under several
// repositories lists each, so the line is matched by repository, not taken
// first.
function repoDigestIn(output, image) {
    const prefix = `${image}@`;
    const line = String(output || '').split('\n').map((l) => l.trim()).find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length) : '';
}

// The first 64-hex token of `text` (a MRENCLAVE), or ''.
function mrenclaveIn(text) {
    const match = String(text || '').match(/\b[a-fA-F0-9]{64}\b/);
    return match ? match[0] : '';
}

// The securelock a build pushed, for .env: the digest of the pushed manifest
// (docker's RepoDigest of the local registry's tag) and the MRENCLAVE the
// Dockerfile wrote from the signature into the image's /signed_mrenclave.txt.
// `run(command)` runs a shell command and returns its stdout. Throws, with the
// message the build prints, when either cannot be read.
function pushedSecurelock(run) {
    const digests = run(`docker inspect ${SECURELOCK_IMAGE} --format "${REPO_DIGESTS_FORMAT}"`) || '';
    const digest = repoDigestIn(digests, SECURELOCK_IMAGE);
    if (!/^sha256:[0-9a-f]{64}$/.test(digest)) {
        throw new Error(`docker records no digest of ${SECURELOCK_IMAGE} after the push (got '${digests.trim()}').`);
    }
    const signed = run('docker run --rm --entrypoint cat etny-securelock:latest /signed_mrenclave.txt') || '';
    const mrenclave = mrenclaveIn(signed);
    if (!mrenclave) {
        throw new Error(`the securelock image holds no signed MRENCLAVE in /signed_mrenclave.txt (got '${signed.trim()}').`);
    }
    return { digest, signed: mrenclave };
}

// The securelock ecld-build recorded in `env` (.env): the digest of the
// manifest it pushed and the MRENCLAVE it signed. Throws, with the message
// the publish prints, when either is missing: a build by an SDK older than
// these records.
function recordedSecurelockBuild(env) {
    const digest = String(env.SECURELOCK_IMAGE_DIGEST || '').trim();
    const signed = String(env.MRENCLAVE_SECURELOCK_SIGNED || '').trim();
    if (!digest || !signed) {
        throw new Error('this build records no SECURELOCK_IMAGE_DIGEST and MRENCLAVE_SECURELOCK_SIGNED.\n'
            + '       The securelock was built by an SDK older than these records; run ecld-build with the current SDK, then publish again.');
    }
    return { digest, signed };
}

// The digest `image` (`127.0.0.1:<port>/etny-securelock`) was pulled by,
// '' when docker records none or does not know the image. `run(command)`
// runs a shell command and returns its stdout, or throws.
function servedDigest(image, run) {
    try {
        return repoDigestIn(run(`docker inspect ${image} --format "${REPO_DIGESTS_FORMAT}"`), image);
    } catch (e) {
        return '';
    }
}

// A rendered compose with every image named at localhost:5000 named at
// `host` (`127.0.0.1:<port>`, the registry serving the tree) instead: the
// local compose the publish measures and harvests with. The shipped compose
// is not rendered through this.
function composeAgainst(content, host) {
    return content.split('localhost:5000/').join(`${host}/`);
}

// Why the publish refuses the securelock its tree serves, as the lines it
// prints, or null when it is the one ecld-build recorded: `served` is the
// digest the tree's securelock was pulled by, `measured` its SCONE_HASH
// measurement, `recorded` the build's record (recordedSecurelockBuild).
function buildGateRefusal(recorded, served, measured) {
    if (served !== recorded.digest) {
        return [
            `Error: the securelock served by this build's image tree has digest ${served || 'none'}, not the SECURELOCK_IMAGE_DIGEST recorded at build (${recorded.digest}).`,
            '       The tree does not hold the image ecld-build recorded. Refusing to publish; run ecld-build again.',
        ];
    }
    if (measured !== recorded.signed) {
        return [
            `Error: securelock runtime MRENCLAVE (${measured}) != MRENCLAVE_SECURELOCK_SIGNED recorded at build (${recorded.signed}).`,
            '       The measured enclave is not the one ecld-build signed. Refusing to publish; run ecld-build again.',
        ];
    }
    return null;
}

class LocalRegistry {
    constructor(name, tree) {
        this.container = `ecld-registry-${String(name || 'publish').replace(/[^A-Za-z0-9_.-]/g, '-')}`;
        this.tree = tree;
        // `127.0.0.1:<port>` once the container runs.
        this.host = null;
    }

    // The docker client with `args`; its stdout, '' when `stdio` drops it.
    // Throws as execFileSync does, with the stderr on the error.
    docker(args, stdio) {
        const out = execFileSync('docker', args, { stdio: stdio || ['ignore', 'pipe', 'pipe'] });
        return out ? out.toString() : '';
    }

    // Whether the registry answers at `host`: GET /v2/ with a 2xx status.
    async answers() {
        await axios.get(`http://${this.host}/v2/`, { timeout: 5000 });
    }

    // Remove a container of this name a previous publish left, start one over
    // the tree and wait until it answers. Throws when the tree is not a
    // build's, docker cannot run the container or it does not answer in time,
    // with the container removed.
    async start() {
        if (!fs.existsSync(path.join(this.tree, 'docker', 'registry', 'v2'))) {
            throw new Error(`${this.tree} holds no image tree; run ecld-build first`);
        }
        this.stop();
        const port = await freePort();
        try {
            this.docker(['run', '-d', '--name', this.container, '-p', `127.0.0.1:${port}:5000`,
                '-v', `${this.tree}:/var/lib/registry:ro`, REGISTRY_IMAGE]);
        } catch (e) {
            // A run refused a port leaves the created container behind.
            this.stop();
            throw new Error(`docker could not start ${REGISTRY_IMAGE}: ${String(e.stderr || e.message).trim()}`);
        }
        this.host = `127.0.0.1:${port}`;
        const deadline = Date.now() + READY_MS;
        for (;;) {
            try {
                await this.answers();
                return;
            } catch (e) {
                if (Date.now() > deadline) {
                    this.stop();
                    throw new Error(`the registry ${this.container} did not answer in ${READY_MS / 1000}s`);
                }
                await sleep(1000);
            }
        }
    }

    // The reference of `repository` in this registry, as the local compose
    // names it (`127.0.0.1:<port>/etny-securelock`).
    image(repository) {
        return `${this.host}/${repository}`;
    }

    // Remove the container, and the tags the publish pulled from it, which
    // name a port no registry answers at any more.
    stop() {
        try { this.docker(['rm', '-f', this.container], 'ignore'); } catch (e) { /* already gone */ }
        if (this.host !== null) {
            try { this.docker(['rmi', ...REPOSITORIES.map((r) => this.image(r))], 'ignore'); } catch (e) { /* not pulled */ }
        }
    }
}

module.exports = {
    LocalRegistry, REPOSITORIES, SECURELOCK_IMAGE, REPO_DIGESTS_FORMAT,
    repoDigestIn, mrenclaveIn, pushedSecurelock, recordedSecurelockBuild, servedDigest, composeAgainst, buildGateRefusal,
};
