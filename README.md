
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
    - Testnet - tested and working
    - Mainnet - to be provided during the following updates
- Polyhon:
    - Amoy Testnet - to be provided during the following updates
    - Mainnet - to be provided during the following updates

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

- **Run**: To run the project, run:
  ```sh
  npm run start
  ```
  command to start the demo application and test the integration.

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
From your frontend application, using the ethernity cloud runner library, you will be calling the function as seen in the below example, where we pass `hello("World");` to be executed on the backend which will run in the Blockchain:
```js
const AppCss = require('./App.css');
import EthernityCloudRunner from "@ethernity-cloud/runner";
import {ECEvent, ECRunner, ECStatus} from "@ethernity-cloud/runner/enums";
import Web3 from 'web3';

const PROJECT_NAME = "";
const IPFS_ENDPOINT = "";

const code = `hello("World");`;

function App() {
    const executeTask = async () => {
        const runner = new EthernityCloudRunner();
        // this is a server provided by Ethernity CLOUD, please bear in mind that you can use your own Decentralized Storage server
        const ipfsAddress = IPFS_ENDPOINT;
        runner.initializeStorage(ipfsAddress);
        console.log(PROJECT_NAME)
        const onTaskProgress = (e) => {
            if (e.detail.status === ECStatus.ERROR) {
                console.error(e.detail.message);
            } else {
                console.log(e.detail.message);
            }
        };

        const onTaskCompleted = (e) => {
            console.log(`Task Result: ${e.detail.message.result}`);
            // display the result in page below the buttons
            const result = document.createElement("p");
            result.innerHTML = `Task Result: ${e.detail.message.result}`;
            document.body.appendChild(result);
        }

        runner.addEventListener(ECEvent.TASK_PROGRESS, onTaskProgress);
        runner.addEventListener(ECEvent.TASK_COMPLETED, onTaskCompleted);

        await runner.run(PROJECT_NAME,
                        code,
                         '',
                         { taskPrice: 10, cpu: 1, memory: 1, storage: 10, bandwidth: 1, duration: 1, validators: 1 });
    };
    const connectWallet = async () => {
      if (window.ethereum) {
          window.web3 = new Web3(window.ethereum);
          try {
              // Request account access
              await window.ethereum.request({ method: 'eth_requestAccounts' });
              console.log("Wallet connected");
          } catch (error) {
              console.error("User denied account access");
          }
      } else {
          console.log('Please install MetaMask!');
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
