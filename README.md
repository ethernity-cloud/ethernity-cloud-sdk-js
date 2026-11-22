
# Ethernity Cloud SDK JS

This project provides a set of tools and scripts to work with the Ethernity Cloud SDK in a JavaScript environment.

## Table of Contents

- [Installation](#installation)
- [Usage](#usage)
  - [Scripts](#scripts)
- [Project Structure](#project-structure)
- [Contributing](#contributing)
- [License](#license)

## Installation

To install the package and its dependencies, run:

```sh
npm install ethernity-cloud-sdk-js
```

## Usage

After installation, you can use the provided scripts to build, publish, and initialize your project.

## Pre-requisites
The sdk requires the following to be installed on your system:
- Node.js v20.04 or higher
- npm
- docker (daemon running in the background for build and publish scripts)


## Operating System compatibility
The sdk has been tested on the following operating systems:
- MacOS
- Ubuntu 20.04
- Windows 10

## Blockchain compatibility
- Bloxberg:
    - Testnet - tested and working. CAS-attested: the securelock is
      provisioned by the ethernity-cas validator set exactly as on mainnet.
      `ecld-publish` registers the image in the ImageRegistry
      (ECImageRegistryV3, `0xa372a6e1...`) before anything discloses its
      name, which makes the name the publishing wallet's; then registers the
      securelock session on-chain in the SessionRegistry (`0x78f0c5E9...`, see
      `cas/config.js`), which takes it only from that wallet, resolves a CAS
      from the ValidatorRegistry (`0xc346BfFC...`, or `ECLD_CAS_ADDR=host:port`)
      for the compose and the certificate harvest, takes the trustedzone
      session name from the ImageRegistry, and links the session to the
      published image. `ecld-build` signs the securelock `--production`.
      The certificate is harvested on an SGX host or, without one, extracted
      by publickey.ethernity.cloud (see "How the image reaches the network").
    - Testnet Unsafe - the unsafe network beside the testnet (see below).
    - Testnet Pox10 - the PoX 1.0 network of the testnet (see "The PoX 1.0
      testnet networks").
    - Mainnet - to be provided during the following updates
- LitVM:
    - LiteForge - CAS-attested the same way, by LitVM's own ethernity-cas
      validator set (SessionRegistry `0xfA70B5Df...`, ValidatorRegistry
      `0xbE3759f3...`).
    - LiteForge Unsafe - the unsafe network beside LiteForge (see below).
- Ethereum:
    - Sepolia - CAS-attested the same way, by Sepolia's own ethernity-cas
      validator set (SessionRegistry `0xDbB249E1...`, ValidatorRegistry
      `0x8ad24b3F...`), on the PoX family of 2026-10-14.
    - Sepolia Unsafe - the unsafe network beside Sepolia (see below).
- Polyhon:
    - Amoy Testnet - to be provided during the following updates
    - Amoy Pox10 - the PoX 1.0 network of Amoy (see "The PoX 1.0 testnet
      networks").
    - Mainnet - to be provided during the following updates

The remaining testnets (Amoy, IoTeX) have no ethernity-cas
deployment: their enclaves are debug-signed and sign their own certificates
from their measurement, and `ecld-publish` registers no CAS session for them.

### The testnets and their unsafe networks
`Bloxberg Testnet`, `LitVM LiteForge` and `Ethereum Sepolia` run your securelock in an enclave
attested through that chain's ethernity-cas validator set, on nodes whose
platform the CAS can attest (DCAP). Each has an unsafe network beside it,
`Bloxberg Testnet Unsafe` (`Bloxberg_Testnet_Unsafe`), `LitVM LiteForge
Unsafe` (`LitVM_LiteForge_Unsafe`) and `Ethereum Sepolia Unsafe`
(`Ethereum_Sepolia_Unsafe`): the same chain and contracts, for hardware
SGX platforms the CAS cannot attest (EPID-only, SGX1). No CAS and no LAS: the
enclaves are debug-signed and sign their own certificates from their
measurement, so a result proves which image ran but not that an enclave ran
it. You choose an unsafe network by name in `ecld-init`, and the runner runs an
`-unsafe` trustedzone on nothing else, so a dApp that runs without a CAS
always says so in the network it names. A dApp publishes one securelock per
network from two project directories with the same project name: the unsafe
one is registered as `<project>-unsafe` and runs on the
`etny-<nodenithy|pynithy>-testnet-unsafe`
(`ecld-<nodenithy|pynithy>-litvm-testnet-unsafe`,
`ecld-<nodenithy|pynithy>-ethereum-sepolia-unsafe`) trustedzone. Both dApp types
build for both networks. Mainnet has no unsafe network.

### The PoX 1.0 testnet networks
`Bloxberg Testnet Pox10` (`Bloxberg_Testnet_Pox10`) and `Polygon Amoy Pox10`
(`Polygon_Amoy_Pox10`) are the PoX 1.0 networks of the bloxberg testnet and of
Polygon Amoy: copies of the mainnets' PoX 1.0 contracts on those chains,
beside their PoX 2.0 networks (`Bloxberg Testnet`, `Polygon Amoy Testnet`). A
dApp is built, published and run on one as on the mainnet it copies.

| | `Bloxberg_Testnet_Pox10` | `Polygon_Amoy_Pox10` |
|---|---|---|
| Chain id, RPC | 8995, `https://bloxberg.ethernity.cloud` | 80002, `https://polygon-amoy-bor-rpc.publicnode.com` |
| PoX | `0x69A7bEB5Da2d3dA711d52E491D71e51296b08745` | `0x9Aad82557c84c11C4031382d8Bf2cacF8f256a02` |
| Token | tE10, the PoX itself | the Amoy tECLD `0x9927809B61122B2af3f3b3A3303875e0687b8eE3` |
| Image registry (V1) | `0x7dBC1b591cc3b7136D863bc7430C6Db50E929665` | `0xa2EE2a9118d0011AF05a6196c862D37d8c29F8eC` |
| Trustedzone | `etny-<nodenithy\|pynithy>-testnet-pox10` | `ecld-<nodenithy\|pynithy>-amoy-pox10` |
| SDK registry tag, session tag | `bloxberg_testnet_pox10` | `polygon_amoy_pox10` |

- `ecld-build` signs the securelock `--production`, with the enclave network
  type `mainnet`, and bundles the trustedzone of the table.
- `ecld-publish` posts the securelock session to the Scontain CAS under the
  production attestation rules, names in the compose the trustedzone session
  the network's image registry records, and registers the image with its
  certificate in one call: the registry records an image only with its
  certificate, so a publish that runs its own IPFS node pins the image on the
  public API before the certificate is extracted, pins the tree it registers,
  which carries the certificate files, before the registration, and needs
  `IPFS_TOKEN`, a writer token of that API. A pin is asked with progress and
  read as it arrives; an answer that stays silent for 120 s, breaks off or
  ends without the pin is settled by `pin/ls`, and a pin the API does not list
  is asked again 10 s later, five times at most within an hour; a 401 or 403
  ends it at once. A pin the public API does not make
  ends the publish with nothing registered. Without an SGX host the publish
  asks publickey.ethernity.cloud for the certificate and names the network by
  its tag of the table.
- `ecld-run` and the Hello World template construct the runner with the
  network's token address and name the network on it
  (`setNetwork('BLOXBERG', 'TESTNET_POX10')`, `setNetwork('POLYGON',
  'AMOY_POX10')`): Polygon Amoy's two networks are paid in the same token,
  and the name is what puts the runner on the PoX 1.0 one. This needs
  `@ethernity-cloud/runner` 1.9.0 or later.
- tE10 has no faucet: a wallet receives it by a transfer from the owner of the
  network's contracts. On Polygon Amoy the runner draws the tECLD faucet (1000
  tECLD) for a wallet that is short of a request's escrow and holds less than
  100 tECLD.
- Neither network has a payload intake route: set `IPFS_ENDPOINT` for the
  Hello World template and pass `--ipfs <url>` to `ecld-run`.
- `ecld-info --network BLOXBERG_TESTNET_POX10` and `--network
  POLYGON_AMOY_POX10` read the networks' contracts.

### Pynithy dApps
The Pynithy securelock is built exactly as `ethernity-cloud-sdk-py` builds it
(`pynithy/build/securelock` is its copy): a SCONE 6.0.7 Python 3.14 enclave
your backend is frozen into. `src/serverless/requirements.txt` lists the
Python packages your backend imports, and `src/serverless/Dockerfile.serverless`
adds system packages to the securelock base image. `ECLD_MEMORY_TO_ALLOCATE`
sets the enclave heap (default `1024M`). A Nodenithy securelock built with a
heap under `1024M` (`ECLD_MEMORY_TO_ALLOCATE=256M`, for nodes with little
memory) runs node with `--jitless`, since V8's JIT reserves a 512 MB code
range that fits no smaller heap; the backend's JavaScript then runs
interpreted, about ten times slower in its crypto. The default `1024M` keeps
the JIT. `ECLD_NODE_JITLESS=0` or `1` overrides the choice.

### Scripts

- **Initialize**: To initialize the project, run:
  ```sh
  npm run ecld-init
  ```
  at this step, all the initial configurations will be set up and the project will be ready to be built, published and run.
  Its last step is the order's execution object (see "The order's execution
  object" below): a yes/no question, "no" writing the defaults, "yes" asking
  each key; every key is written to `.env` as `EXEC_*`, and every other `.env`
  line that sets an `EXEC_*` variable is removed. For an unattended run
  set the same keys with the `ECLD_` prefix (`ECLD_EXEC_MODE`,
  `ECLD_EXEC_DURATION_HOURS`, ...): any one set skips the questions, the set
  keys are taken and the rest default; an `ECLD_EXEC_*` variable that is not
  one of them ends the init with its name and the list of the keys.

- **Build**: To build the project, run:
  ```sh
  npm run ecld-build
  ```
    the project will be built and the docker repository output will be stored in the `registry/` directory. This is the stage where the backend functions are added to the secure images.
  The build also records in `.env` the securelock it pushed:
  `SECURELOCK_IMAGE_DIGEST`, the digest of the pushed image manifest, and
  `MRENCLAVE_SECURELOCK_SIGNED`, the enclave measurement it was signed with.
  `ecld-publish` checks the `registry/` tree against both.

  For a Nodenithy dApp the build runs the payload safety lint
  (`payloadLint.mjs`, in the installed package from 1.9.0 on) on
  `src/serverless/backend.js` before the securelock image is built. The lint
  parses the file as an ES module, else as a script, the sloppy-mode
  CommonJS the build loads it as (`with`, legacy octal literals such as
  `0755`, a `return` at the top level):
  - `eval(...)`, `Function(...)` or `new Function(...)` with an argument that
    names the task input, `___etny_data_set___`, is an error: the build
    prints its line and exits with code 1.
  - A file that parses neither as a module nor as a script is an error: the
    lint cannot check it, and the build prints both parsers' messages with
    the line of the script parse's failure and exits with code 1.
  - Any other `eval(...)` or `Function` constructor call, and a property
    selected by a key that names the task input (`obj[___etny_data_set___]`),
    is a warning: the build prints its line and goes on.
  - `// ecld: allow-eval` on the line an `eval`, `Function` or property
    finding is reported on silences that finding; `// ecld: allow-eval-file`
    anywhere in the file turns the lint off for the file, a file that does
    not parse included.
  - The lint finds the calls by the names `eval` and `Function`: a call
    through another name (`const f = eval; f(x)`) is not reported. When the
    lint itself cannot be loaded, the build prints `payload safety lint
    skipped` and goes on.

- **Publish**: To publish the project, run:
  ```sh
  npm run ecld-publish
  ```
  Required after build, to build and integrate the secure certificates that will be used during executions and to register the project to the Ethernity Cloud Image Register.
  The publish measures the securelock out of the project's own `registry/`
  tree, served by a registry container of its own (`ecld-registry-<project>`,
  on a loopback port chosen free) and not out of the machine's
  `localhost:5000` registry, which holds whatever was built last on the
  machine. It refuses to publish when the tree's securelock is not the one
  the build recorded, and when `.env` carries no record (a build by an older
  SDK): run `ecld-build` again. The published compose keeps `localhost:5000`.
  This registry container is removed when the publish ends, however it ends;
  so is the IPFS node below, unless the publish ends with the image registered
  and its certificate not yet on chain, when the node is kept running.
  `DEVELOPER_FEE` in `.env` is your fee as the image's publisher, in percent of
  each task's base price (the node's price): the network adds it to what the
  dApp user pays and pays it to the image's reward address when the task is
  validated. Default 0; the registry accepts up to 15, and the fee is fixed
  once the image is registered. The reward address is the publishing wallet
  unless `REWARD_ADDRESS` names another one; the image's owner can change it
  later with the registry's `changeImageRewardAddress`.

  How the image reaches the network: leave `IPFS_ENDPOINT` in `.env` empty
  unless it names an IPFS API of your own (`IPFS_TOKEN` is the Authorization
  header value that API takes, when it takes one); the public API
  `ipfs.ethernity.cloud` takes no adds or pins without a writer token. With
  no API of your own the publish runs its own IPFS node in docker
  (`ipfs/kubo`), adds the image and its compose there and peers it with the
  network's bootnode, which pins every registered image. On a network whose
  image registry records images
  before their certificate (the bloxberg testnet), the publish registers the
  image from your wallet first (`registerImage`, with your node's address),
  has the certificate extracted (on your SGX host, or by
  publickey.ethernity.cloud, which fetches the image from your node or the
  bootnode and reports its progress) and writes it from the same wallet
  (`setImageCert`). Keep the publish running until it prints the registration:
  your node is the image's first source, and the registration names its peer
  id. A publish that ends between the registration and the certificate (an
  extraction that failed, a bootnode pin that timed out, Ctrl+C) leaves its
  IPFS node running, the docker container `ecld-kubo-<project>`, so the
  registered image stays fetchable from the peer id on chain; the next publish
  of the project takes that node over (starting it again when a restart of
  docker stopped it), finds the image registered and goes on to the
  certificate, and keeps the node in turn should it end before the
  certificate. `docker rm -f ecld-kubo-<project>` stops it; a new node has a
  new peer id, which matches nothing on chain, so the image then needs a new
  build. `ECLD_KUBO_SWARM_PORT` (default 4001) is the port your node
  listens on when it is free; when another container holds it published, the
  node runs without it and is reached over the connection it opens to the
  bootnode. `ECLD_ASSUME_YES=1`
  accepts the extraction-service prompt without asking, for a publish run
  from a script. On a two-step registry the publish waits up to three
  minutes for the service to queue the image from the chain event before
  posting the hash itself.

- **Test (local, no chain)**: To run your backend locally with the enclave's own
  executor — no SGX, no gas, instant — run:
  ```sh
  npx ecld-test 'hello("World")'
  npx ecld-test --file payload.js
  npx ecld-test --input data.json 'processData(___etny_data_set___)'
  ```
  This validates the *call* (function names, arguments, result wiring) before a
  single on-chain request is paid for. If your dApp uses ESR (Enclave State
  Registry), state is emulated locally and **on by default**: `require('../ecld_state').StateRegistry`
  get/commit, ownership/ACL, and `taskCaller()` all work in-process against an
  in-memory registry, and persist between runs in `.ecld-esr-local.*.json`. The
  task caller defaults to your developer address; override it with `--caller`.
  `npx ecld-test serve` starts a local API so the runner's LOCAL mode drives your
  real integration end to end. Exit code 0 on `SUCCESS`, 1 otherwise.

- **Run (on the network)**: To submit a payload to the network and print the
  decrypted result, run:
  ```sh
  npx ecld-run 'hello("World")'
  npx ecld-run --file payload.js
  npx ecld-run --input data.json 'processData(___etny_data_set___)'
  npx ecld-run --json 'esrIncrement()'
  npx ecld-run --unsafe 'hello("World")'
  ```
  This is the network-side sibling of `ecld-test`: instead of executing locally
  it drives the runner end to end — encrypt → on-chain request → payload intake
  (or the IPFS API named with `--ipfs <url>`) → wait for a node → download and
  decrypt the result. It **costs gas and needs a funded key**. Network and
  enclaves come from `.env` (`BLOCKCHAIN_NETWORK`, `PROJECT_NAME`,
  `TRUSTED_ZONE_IMAGE`), overridable with
  `--network`/`--securelock`/`--trustedzone`; the signing key is `PRIVATE_KEY`
  (or `ECLD_PRIVATE_KEY`) — a funded `0x` key that pays for the order. Resources
  are tunable with `--task-price`/`--cpu`/`--memory`/`--storage`/`--bandwidth`/`--validators`;
  `--task-price` is in ECLD and may be fractional (`--task-price 2.5`), and a
  value that is not a non-negative number is a usage error (exit 2). The
  order's execution object comes from the `EXEC_*` keys of `.env` and each
  execution flag overrides its key: `--mode task|session`, `--duration-hours`
  (alias `--duration`), `--parallelism`, `--max-gflops`, `--headroom`,
  `--expected-inputs`, `--keep-open`/`--no-keep-open`, `--renew`/`--no-renew`,
  `--max-renewals`, `--expected-commits`; it is validated before the runner is
  constructed and printed with the relays-per-hour default (`--relays-per-hour`
  names another value). See "The order's execution object" below. An option
  `ecld-run` does not know (an argument that starts with `-`, holds no
  whitespace and is not a number) is a usage error (exit 2).
  `--input <file>` / `--input-text <string>` send the task's input dataset, read
  as `___etny_data_set___`; it travels encrypted, and the trustedzone checks it
  against the sha256 the request carries. Exit code 0 on a `SUCCESS` task result,
  1 otherwise; a task that raised in the enclave prints its task code (e.g.
  `4 (BASE_EXCEPTION)`) and the enclave's error report as its result.
  `--ipfs intake` (the default) delivers the payload to the bootnode's payload
  intake once the request is on chain; `--ipfs <url>` writes and reads through
  that IPFS RPC API instead, with `ECLD_IPFS_TOKEN` (or `IPFS_TOKEN`) as its
  Authorization header, and a URL naming the public API is refused without one.
  The chain calls of a run go through the network's own RPC (publicnode's Sepolia
  endpoint, LitVM's Zeeve endpoint, IoTeX's babel API); the runner's defaults
  cover the other networks.
  The intake serves the networks the bootnode's agent runs, today the bloxberg
  testnet, Polygon Amoy, LitVM LiteForge and Ethereum Sepolia, each with its
  unsafe twin: a dApp on any other network (Bloxberg mainnet, Polygon mainnet,
  IoTeX, the PoX 1.0 testnet networks) needs an IPFS API of its own
  (`IPFS_ENDPOINT` for the Hello World template, `--ipfs <url>` for `ecld-run`).
  Exit code 0 on a `SUCCESS` task result, 1 otherwise. `--unsafe` runs the
  network's unsafe variant; on an unsafe network the securelock and
  trustedzone default to their `-unsafe` names.

- **Inspect (read-only)**: To read enclave and on-chain diagnostics — network,
  trustedzone/securelock registration, and ESR state — without spending gas, run:
  ```sh
  npx ecld-info
  npx ecld-info esr state <key>
  npx ecld-info execution
  ```
  The EXECUTION section is the order's execution object read from the `EXEC_*`
  keys of `.env` (the defaults where `.env` has none, an invalid key reported
  with its message) and the relays-per-hour default it gives with
  `ESR_ENABLED`.

### The order's execution object
`execution.js` (`require('@ethernity-cloud/sdk-js/execution.js')`, CJS, also
loaded with `createRequire` from the template's `src/preStart.mjs`) is the
runner-side execution object of `test/fixtures/execution-spec.json`, the copy
of `pox-smart-contract-litvm/spec/execution-spec.json` both SDKs and both
runners follow:

| key | type | default | `.env` key | meaning |
|---|---|---|---|---|
| `mode` | `task` or `session` | `task` | `EXEC_MODE` | one payload run per order, or the order stays open for inputs |
| `durationHours` | integer 1-65535 | 1 | `EXEC_DURATION_HOURS` | the order duration (the DO request's `_duration`) and the escrow hours |
| `parallelism` | integer >= 1 | 1 | `EXEC_PARALLELISM` | orders opened at once, each a DO request with its own enclave |
| `maxGflops` | integer >= 0 | 0 | `EXEC_MAX_GFLOPS` | the largest node paid for, in GFLOPS (one CU is 100 GFLOPS); 0 = any node |
| `headroomPercent` | integer 0-100 | 25 | `EXEC_HEADROOM_PERCENT` | margin over the quoted price when the runner sizes the price per CU-hour |
| `session.expectedInputs` | integer 1-256 | 1 | `EXEC_SESSION_EXPECTED_INPUTS` | inputs the dApp expects to send; sizes the relay cap as 1 + expectedInputs rows |
| `session.keepOpen` | boolean | false | `EXEC_SESSION_KEEP_OPEN` | keep the session open until the dApp closes it |
| `session.renew` | boolean | false | `EXEC_SESSION_RENEW` | open a new order on another node when the session expires with inputs pending |
| `session.maxRenewals` | integer >= 0 | 0 | `EXEC_SESSION_MAX_RENEWALS` | renewals allowed; >= 1 when `renew` is true |
| `esr.expectedCommits` | integer 0-100 | 0 | `EXEC_ESR_EXPECTED_COMMITS` | state commits the dApp expects to relay per order |

The module exports `DEFAULTS`, `SCHEMA`, `ENV_KEYS` (the ten `.env` keys in
schema order), `validate(execution)` (the complete object, every missing key
at its default; the first failing check in schema order throws the fixture's
message; an unknown key at any level is an error; the session block is
accepted in both modes and applied in mode `session`; `null` is not a value),
`normalize(resources)` (a flat `resources` with the legacy `duration` becomes
`{ resources, execution }` with `duration` as `execution.durationHours`, and
`execution.durationHours` wins when both are given), `ENV_PREFIX` (`EXEC_`),
`fromEnv(env, prefix)` (the `EXEC_*` strings parsed to numbers and booleans,
not validated; a `<prefix>EXEC_*` variable that is not one of `ENV_KEYS`
throws a message naming it and listing the execution variables),
`toEnv(execution)` (the ten strings `ecld-init` writes), `esrEnabled(env)` and
`relaysPerHour(execution, withEsr)`.

`relaysPerHour` is the relays an order needs per hour of `durationHours`:
`1 + session.expectedInputs` rows (the `etny-sw` row plus one `etny-so` row
per input) plus `ESR_COMMITS_PER_HOUR` = 10 commits when the Enclave State
Registry is enabled; `ecld-run --relays-per-hour <n>` wins over it.

`ecld-run` passes the object nested in `resources` (`resources.execution`)
beside the flat `duration` (= `durationHours`) that the runner this SDK
depends on reads, and the task price as given. That runner (`@ethernity-cloud/runner`
0.6.x) reads `duration` and `taskPrice` only and places the DO request with
an integer price, so the execution object, the relays per hour and a
fractional price take effect with the runner that accepts them.

### The securelock at run time
This section describes the securelock of the Phase D release, sdk-js 1.8.0:
what a securelock built by `ecld-build` from that version or later writes to
the order's bucket beside the result, and what it does on the trustedzone's
controls (the fixtures under `test/fixtures/`: `heartbeat.json`,
`session-commits.json`, `session-fence.json`; every object the JS securelock
writes carries the `.securelock` suffix). A securelock built by an earlier
version writes none of these objects: the trustedzone serves it as before, and
the validators probe its node after the result only. A dApp takes them up by
rebuilding and republishing on 1.8.0.

- **Ready and heartbeat.** At boot the securelock writes
  `securelock.ready.securelock` (and its signature) with the per-order key the
  heartbeat is encrypted under, then overwrites `securelock.heartbeat.securelock`
  every second: a fixed-width AES-256-GCM record whose nonce is derived from the
  sequence number and whose AAD binds the beat to the order, with a `busy` flag
  set while the payload or a session step runs. The tick runs on the event
  loop, so a payload that blocks the event loop reads as busy until it returns.
  On every exit path, including a reported failure, the securelock writes an
  idle tail of beats with `busy=0` before it stops.
- **Step commits and the output envelope.** In a session, the `commit` calls of
  a step are held until the step's output: they are then staged as
  `session.commit.<n>.<key16>.<relayNonce>.json` (never `esr.commit.*.json`) and
  the step's signed output envelope names them (`commits`) and carries the
  signed authorization records with the securelock's ESR wallet (`esr`); the
  trustedzone stages the names beside the row's proof as
  `session.output.<seq>.commits`, and the node relays a named commit once that
  `etny-so` row's receipt is in. A plain task's commits and the fence's are
  `esr.commit.<key16>.<relayNonce>.json`, relayed as they appear.
- **The `transfer` stop.** In the last two minutes of a reserved order's
  window the trustedzone may write the signed `transfer` control on
  `session.control` (beside `close`): the securelock stops the step in hand and
  exits without a result, discarding the step's held commits. The step is
  replayed by the successor order as one of its first inputs, so a step may
  run twice; a commit is applied once, by its per-key nonce.
- **The fence.** On a reserved order (the task caller resolved to a
  reservation holder) the trustedzone writes `session.fence.securelock` before
  `session.input.0`, carrying the bound (the window's `toBlock`, the
  predecessor's result block, or kind `none`): the state module re-commits every
  key the holder may write at its state as of the bound before the first input
  is read. An unreserved order has no fence object and no wait.
- **ESR instances.** `ecld-info network` prints the Enclave State Registry of
  each network (`info.js`); on Polygon Amoy the securelocks commit to
  `0x1DC58496ed1cA66FD1E0b51fA28A9E7451970843`. The registry with
  `commitForBatch` enters the tables when the networks switch to it.
- **The pynithy mirror.** `pynithy/build/securelock` is a byte-for-byte copy
  of the Python SDK's securelock tree (`ethernity-cloud-sdk-py`,
  `ethernity_cloud_sdk_py/commands/pynithy/build/securelock`), never edited
  here: `node scripts/sync-pynithy.mjs [--check] [<path>]` copies it
  (`ETHERNITY_CLOUD_SDK_PY` names the checkout) and `test/pynithyMirror.test.js`
  fails when the mirror differs.

## Project Structure

```
.gitignore
build.js
build.sh
demo/
init.js
nodenithy/
package.json
postinstall.js
publish.js
pynithy/
```

### Notable Directories and Files

- **[`build.js`](command:_github.copilot.openRelativePath?%5B%7B%22scheme%22%3A%22file%22%2C%22authority%22%3A%22%22%2C%22path%22%3A%22%2FUsers%2Fbullet%2Fethernity%2Fethernity-cloud-sdk-js%2Fbuild.js%22%2C%22query%22%3A%22%22%2C%22fragment%22%3A%22%22%7D%5D "/Users/bullet/ethernity/ethernity-cloud-sdk-js/build.js")**: Script to build the project.
- **[`init.js`](command:_github.copilot.openRelativePath?%5B%7B%22scheme%22%3A%22file%22%2C%22authority%22%3A%22%22%2C%22path%22%3A%22%2FUsers%2Fbullet%2Fethernity%2Fethernity-cloud-sdk-js%2Finit.js%22%2C%22query%22%3A%22%22%2C%22fragment%22%3A%22%22%7D%5D "/Users/bullet/ethernity/ethernity-cloud-sdk-js/init.js")**: Script to initialize the project.
- **[`publish.js`](command:_github.copilot.openRelativePath?%5B%7B%22scheme%22%3A%22file%22%2C%22authority%22%3A%22%22%2C%22path%22%3A%22%2FUsers%2Fbullet%2Fethernity%2Fethernity-cloud-sdk-js%2Fpublish.js%22%2C%22query%22%3A%22%22%2C%22fragment%22%3A%22%22%7D%5D "/Users/bullet/ethernity/ethernity-cloud-sdk-js/publish.js")**: Script to publish the project.
- **[`postinstall.js`](command:_github.copilot.openRelativePath?%5B%7B%22scheme%22%3A%22file%22%2C%22authority%22%3A%22%22%2C%22path%22%3A%22%2FUsers%2Fbullet%2Fethernity%2Fethernity-cloud-sdk-js%2Fpostinstall.js%22%2C%22query%22%3A%22%22%2C%22fragment%22%3A%22%22%7D%5D "/Users/bullet/ethernity/ethernity-cloud-sdk-js/postinstall.js")**: Script that runs after the package is installed.
- **[`nodenithy/`](command:_github.copilot.openRelativePath?%5B%7B%22scheme%22%3A%22file%22%2C%22authority%22%3A%22%22%2C%22path%22%3A%22%2FUsers%2Fbullet%2Fethernity%2Fethernity-cloud-sdk-js%2Fnodenithy%2F%22%2C%22query%22%3A%22%22%2C%22fragment%22%3A%22%22%7D%5D "/Users/bullet/ethernity/ethernity-cloud-sdk-js/nodenithy/")**: Contains various scripts and modules for the project.
- **[`pynithy/`](command:_github.copilot.openRelativePath?%5B%7B%22scheme%22%3A%22file%22%2C%22authority%22%3A%22%22%2C%22path%22%3A%22%2FUsers%2Fbullet%2Fethernity%2Fethernity-cloud-sdk-js%2Fpynithy%2F%22%2C%22query%22%3A%22%22%2C%22fragment%22%3A%22%22%7D%5D "/Users/bullet/ethernity/ethernity-cloud-sdk-js/pynithy/")**: Contains Python-related scripts and configurations.

## Usage

To use the SDK:
- after installation, run `npm run ecld-init` to initialize the project
- in you workspace, you will find the `scr/serverless` directory, this contains a `backend.js` file. This file will be imported in the dApp images to provide the backend functions for calling from the frontend of your application, eg.:
```js
function hello(msg='World') {
    return "Hello "+msg;
}

module.exports = { hello };
```
From your frontend application, using the ethernity cloud runner library (`@ethernity-cloud/runner`, installed by `ecld-init` at the version this SDK depends on), you will be calling the function as seen in the below example, where we pass `hello("World");` to be executed on the backend which will run in the Blockchain. `npm start` runs `src/preStart.mjs` first, which fills the constants at the top from the project's `.env`: the securelock name the dApp is published as, the trustedzone it was built against, the network's token address and chain id, the `-unsafe` network when the dApp runs without a CAS, the IPFS API of the dApp's own (empty when the task's artefacts go through the bootnode's payload intake), and the order's execution object from the `EXEC_*` keys.
```js
import './App.css';
import EthernityCloudRunner from "@ethernity-cloud/runner";
import { ECStatus } from "@ethernity-cloud/runner/enums";

// Filled in from the project's .env by src/preStart.mjs on `npm start`: the
// securelock this dApp is published as, the trustedzone it was built against,
// the network's token address and chain id, the -unsafe network when the dApp
// runs without a CAS (null otherwise), the IPFS API of the dApp's own ('' when
// the task's artefacts go through the bootnode's payload intake), and the
// order's execution object from the EXEC_* keys ecld-init wrote (the defaults
// below where .env has none).
const PROJECT_NAME = "";
const TRUSTED_ZONE_IMAGE = "";
const NETWORK_ADDRESS = "";
const CHAIN_ID = null;
const UNSAFE_NETWORK = null;
const IPFS_ENDPOINT = "";
const EXECUTION = {"mode":"task","durationHours":1,"parallelism":1,"maxGflops":0,"headroomPercent":25,"session":{"expectedInputs":1,"keepOpen":false,"renew":false,"maxRenewals":0},"esr":{"expectedCommits":0}};

// A call into src/serverless/backend.js; its return value is the task result.
const code = `hello("World");`;

function App() {
    const executeTask = async () => {
        // The browser wallet (MetaMask) signs and pays for the order.
        const runner = new EthernityCloudRunner(NETWORK_ADDRESS, {}, CHAIN_ID || undefined);
        if (UNSAFE_NETWORK) {
            await runner.setNetwork(...UNSAFE_NETWORK);
        }
        // An IPFS API of the dApp's own (IPFS_ENDPOINT) carries the task's
        // artefacts; without one they go through the bootnode's payload intake.
        if (IPFS_ENDPOINT) runner.initializeStorage(IPFS_ENDPOINT);
        else runner.initializePublicIntake();

        // Events are named by task status; detail is { message, status, progress }.
        runner.addEventListener(ECStatus.DEFAULT, (e) => {
            console.log(`[${e.detail.progress}] ${e.detail.message}`);
        });
        runner.addEventListener(ECStatus.ERROR, (e) => {
            console.error(e.detail.message);
        });
        runner.addEventListener(ECStatus.SUCCESS, async () => {
            const result = await runner.getResult();
            console.log(`Task Result: ${result}`);
            // display the result in page below the buttons
            const line = document.createElement("p");
            line.textContent = `Task Result: ${result}`;
            document.body.appendChild(line);
        });

        // taskPrice is in ECLD and may be fractional (2.5); the flat duration is
        // what a 1.1 runner reads, the nested execution is the order's execution
        // object for the runner that takes it.
        const resources = {
            taskPrice: 10, cpu: 1, memory: 1, storage: 10, bandwidth: 1, validators: 1,
            duration: EXECUTION.durationHours, execution: EXECUTION,
        };
        await runner.run(resources, PROJECT_NAME, code, '', TRUSTED_ZONE_IMAGE);
    };

    const connectWallet = async () => {
        if (!window.ethereum) {
            console.log('Please install MetaMask!');
            return;
        }
        try {
            await window.ethereum.request({ method: 'eth_requestAccounts' });
            console.log("Wallet connected");
        } catch (error) {
            console.error("User denied account access");
        }
    };

    return (
        <div className="container">
            <button className="centeredButton" onClick={executeTask}>Execute Task</button>
            <button className="centeredButton" onClick={connectWallet}>Connect Wallet</button>
        </div>
    );
}
export default App;
```
- you are able to define the functions needed to be used in the backend, while making sure that the function that is script is compilable and that it exports the function that will be called from the frontend, in the above example, the `hello` function.

## Contributing

Contributions are welcome! Please open an issue or submit a pull request.

## License

This project is licensed under the AGPL-3.0 License. See the LICENSE file for details.
