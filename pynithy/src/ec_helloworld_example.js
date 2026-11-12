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
const EXECUTION = {"mode":"task","durationHours":1,"parallelism":1,"maxCu":0,"headroomPercent":25,"session":{"expectedInputs":1,"keepOpen":false,"renew":false,"maxRenewals":0},"esr":{"expectedCommits":0}};

// A call into src/serverless/backend.py; its return value is the task result.
const code = `hello("World")`;

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
