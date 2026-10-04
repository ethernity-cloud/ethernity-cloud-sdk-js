
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
      `ecld-publish` registers the securelock session on-chain in the
      SessionRegistry (`0xcb1F389b...`, see `cas/config.js`), resolves a CAS
      from the ValidatorRegistry (`0x0014aB10...`, or `ECLD_CAS_ADDR=host:port`)
      for the compose and the certificate harvest, takes the trustedzone
      session name from the ImageRegistry (ECImageRegistryV2,
      `0x99A84C62...`), and links the session to the published image. `ecld-build` signs the securelock `--production`.
      Harvesting the certificate needs SGX.
    - Testnet Unsafe - the unsafe network beside the testnet (see below).
    - Mainnet - to be provided during the following updates
- LitVM:
    - LiteForge - CAS-attested the same way, by LitVM's own ethernity-cas
      validator set (SessionRegistry `0x8ad24b3F...`, ValidatorRegistry
      `0xbE3759f3...`).
    - LiteForge Unsafe - the unsafe network beside LiteForge (see below).
- Polyhon:
    - Amoy Testnet - to be provided during the following updates
    - Mainnet - to be provided during the following updates

The remaining testnets (Amoy, IoTeX, Sepolia) have no ethernity-cas
deployment: their enclaves are debug-signed and sign their own certificates
from their measurement, and `ecld-publish` registers no CAS session for them.

### The testnets and their unsafe networks
`Bloxberg Testnet` and `LitVM LiteForge` run your securelock in an enclave
attested through that chain's ethernity-cas validator set, on nodes whose
platform the CAS can attest (DCAP). Each has an unsafe network beside it,
`Bloxberg Testnet Unsafe` (`Bloxberg_Testnet_Unsafe`) and `LitVM LiteForge
Unsafe` (`LitVM_LiteForge_Unsafe`): the same chain and contracts, for hardware
SGX platforms the CAS cannot attest (EPID-only, SGX1). No CAS and no LAS: the
enclaves are debug-signed and sign their own certificates from their
measurement, so a result proves which image ran but not that an enclave ran
it. You choose an unsafe network by name in `ecld-init`, and the runner runs an
`-unsafe` trustedzone on nothing else, so a dApp that runs without a CAS
always says so in the network it names. A dApp publishes one securelock per
network from two project directories with the same project name: the unsafe
one is registered as `<project>-unsafe` and runs on the
`etny-<nodenithy|pynithy>-testnet-unsafe`
(`ecld-<nodenithy|pynithy>-litvm-testnet-unsafe`) trustedzone. Both dApp types
build for both networks. Mainnet has no unsafe network.

### Pynithy dApps
The Pynithy securelock is built exactly as `ethernity-cloud-sdk-py` builds it
(`pynithy/build/securelock` is its copy): a SCONE 6.0.7 Python 3.14 enclave
your backend is frozen into. `src/serverless/requirements.txt` lists the
Python packages your backend imports, and `src/serverless/Dockerfile.serverless`
adds system packages to the securelock base image. `ECLD_MEMORY_TO_ALLOCATE`
sets the enclave heap (default `1024M`).

### Scripts

- **Initialize**: To initialize the project, run:
  ```sh
  npm run ecld-init
  ```
  at this step, all the initial configurations will be set up and the project will be ready to be built, published and run.

- **Build**: To build the project, run:
  ```sh
  npm run ecld-build
  ```
    the project will be built and the docker repository output will be stored in the `registry/` directory. This is the stage where the backend functions are added to the secure images.

- **Publish**: To publish the project, run:
  ```sh
  npm run ecld-publish
  ```
  Required after build, to build and integrate the secure certificates that will be used during executions and to register the project to the Ethernity Cloud Image Register.

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
  it drives the runner end to end — encrypt → IPFS → on-chain request → wait for
  a node → download and decrypt the result. It **costs gas and needs a funded
  key**. Network and enclaves come from `.env` (`BLOCKCHAIN_NETWORK`,
  `PROJECT_NAME`, `TRUSTED_ZONE_IMAGE`), overridable with
  `--network`/`--securelock`/`--trustedzone`; the signing key is `PRIVATE_KEY`
  (or `ECLD_PRIVATE_KEY`) — a funded `0x` key that pays for the order. Resources
  are tunable with `--task-price`/`--cpu`/`--memory`/`--storage`/`--bandwidth`/`--duration`/`--validators`.
  Exit code 0 on a `SUCCESS` task result, 1 otherwise. `--unsafe` runs the
  network's unsafe variant; on an unsafe network the securelock and
  trustedzone default to their `-unsafe` names.

- **Inspect (read-only)**: To read enclave and on-chain diagnostics — network,
  trustedzone/securelock registration, and ESR state — without spending gas, run:
  ```sh
  npx ecld-info
  npx ecld-info esr state <key>
  ```

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
From your frontend application, using the ethernity cloud runner library (`@ethernity-cloud/runner`, installed by `ecld-init` at the version this SDK depends on), you will be calling the function as seen in the below example, where we pass `hello("World");` to be executed on the backend which will run in the Blockchain. `npm start` runs `src/preStart.mjs` first, which fills the constants at the top from the project's `.env`: the securelock name the dApp is published as, the trustedzone it was built against, the network's token address and chain id, the `-unsafe` network when the dApp runs without a CAS, and the IPFS endpoint.
```js
import './App.css';
import EthernityCloudRunner from "@ethernity-cloud/runner";
import { ECStatus } from "@ethernity-cloud/runner/enums";

// Filled in from the project's .env by src/preStart.mjs on `npm start`.
const PROJECT_NAME = "";
const TRUSTED_ZONE_IMAGE = "";
const NETWORK_ADDRESS = "";
const CHAIN_ID = null;
const UNSAFE_NETWORK = null;
const IPFS_ENDPOINT = "";

// A call into src/serverless/backend.js; its return value is the task result.
const code = `hello("World");`;

function App() {
    const executeTask = async () => {
        // The browser wallet (MetaMask) signs and pays for the order.
        const runner = new EthernityCloudRunner(NETWORK_ADDRESS, {}, CHAIN_ID || undefined);
        if (UNSAFE_NETWORK) {
            await runner.setNetwork(...UNSAFE_NETWORK);
        }
        runner.initializeStorage(IPFS_ENDPOINT);

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
            const line = document.createElement("p");
            line.textContent = `Task Result: ${result}`;
            document.body.appendChild(line);
        });

        const resources = { taskPrice: 10, cpu: 1, memory: 1, storage: 10, bandwidth: 1, duration: 1, validators: 1 };
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
