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
                         '0xe0725a669b066ce98e459BeFf51d884c207c3F34',
                         { taskPrice: 5, cpu: 1, memory: 1, storage: 20, bandwidth: 1, duration: 1, validators: 1 });
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