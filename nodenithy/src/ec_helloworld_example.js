import './App.css';
import EthernityCloudRunner from "@ethernity-cloud/runner";
import { ECStatus } from "@ethernity-cloud/runner/enums";

// Filled in from the project's .env by src/preStart.mjs on `npm start`: the
// securelock this dApp is published as, the trustedzone it was built against,
// the network's token address and chain id, the -unsafe network when the dApp
// runs without a CAS (null otherwise), and the IPFS endpoint.
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
            // display the result in page below the buttons
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
