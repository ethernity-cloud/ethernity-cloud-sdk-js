import './App.css';
import EthernityCloudRunner from "@ethernity-cloud/runner";
import {ECEvent, ECRunner, ECStatus} from "@ethernity-cloud/runner/enums";
import Web3 from 'web3';

const code = `___etny_result___("Hello, World!")`;

// example of a Node.js script
// const jsCode = `function add(a, b) {\n  return a + b;\n}\n ___etny_result___(add(1, 10).toString());`;

function App() {
    const executeTask = async () => {
        const runner = new EthernityCloudRunner();
        // this is a server provided by Ethernity CLOUD, please bear in mind that you can use your own Decentralized Storage server
        const ipfsAddress = 'https://ipfs.ethernity.cloud:5001';
        runner.initializeStorage(ipfsAddress);

        const onTaskProgress = (e) => {
            if (e.detail.status === ECStatus.ERROR) {
                console.error(e.detail.message);
            } else {
                console.log(e.detail.message);
            }
        };

        const onTaskCompleted = (e) => {
            console.log(`Task Result: ${e.detail.message.result}`);
        }

        runner.addEventListener(ECEvent.TASK_PROGRESS, onTaskProgress);
        runner.addEventListener(ECEvent.TASK_COMPLETED, onTaskCompleted);


        // there are two types of runners:
        //    - Python(ECRunner.PYNITHY_RUNNER_TESTNET)
        //    - Node.js(ECRunner.NODENITHY_RUNNER_TESTNET)
        // based on this you should use appropriate runner type
        // for this example we are using PYNITHY_RUNNER_TESTNET since we are executing a python script
        await runner.run('etny-pynithy-testnet',
                         code,
                         '');
        // in case you want to use Node.js
        //await runner.run(ECRunner.NODENITHY_RUNNER_TESTNET, code);
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