// ecld-init's IPFS setting: the default choice leaves IPFS_ENDPOINT empty (the
// publish runs its own Kubo, the dApp uses the bootnode's payload intake); an
// API of the dApp's own is written with its token. No prompt and no chain:
// the choice is given. The execution step writes every EXEC_* key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { IPFS_OPTIONS, ipfsSettings, writeEnv, writeExecution, promptExecution } = require('../init.js');
const execution = require('../execution.js');

// A scripted prompt: answers the replies in order and records every prompt
// shown and every message execution.js refused an answer with.
const scripted = async (withEsr, replies) => {
    const prompts = [];
    const refused = [];
    const log = console.log;
    console.log = (m) => refused.push(m);
    try {
        const exec = await promptExecution(withEsr, async (prompt) => {
            prompts.push(prompt);
            assert.ok(replies.length, `no reply scripted for ${prompt}`);
            return replies.shift();
        });
        assert.equal(replies.length, 0);
        return { exec, prompts, refused };
    } finally {
        console.log = log;
    }
};

test('the default choice writes an empty IPFS_ENDPOINT and IPFS_TOKEN', () => {
    assert.deepEqual(ipfsSettings(IPFS_OPTIONS[0], undefined, undefined), { IPFS_ENDPOINT: '', IPFS_TOKEN: '' });
});

test('an API of the dApp\'s own is written with its Authorization token', () => {
    assert.deepEqual(ipfsSettings(IPFS_OPTIONS[1], ' http://127.0.0.1:5001 ', ' Bearer t '),
        { IPFS_ENDPOINT: 'http://127.0.0.1:5001', IPFS_TOKEN: 'Bearer t' });
    assert.deepEqual(ipfsSettings(IPFS_OPTIONS[1], 'http://127.0.0.1:5001', ''),
        { IPFS_ENDPOINT: 'http://127.0.0.1:5001', IPFS_TOKEN: '' });
});

test('.env takes the empty setting in place of the public URL an earlier init wrote', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-init-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
        fs.writeFileSync('.env', 'PROJECT_NAME=demo\nIPFS_ENDPOINT=https://ipfs.ethernity.cloud\nIPFS_TOKEN=\n');
        const ipfs = ipfsSettings(IPFS_OPTIONS[0]);
        writeEnv('IPFS_ENDPOINT', ipfs.IPFS_ENDPOINT);
        writeEnv('IPFS_TOKEN', ipfs.IPFS_TOKEN);
        assert.equal(fs.readFileSync('.env', 'utf8'), 'PROJECT_NAME=demo\nIPFS_ENDPOINT=\nIPFS_TOKEN=\n');
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the execution step writes every EXEC_* key, replacing the ones an earlier init wrote', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecld-init-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
        fs.writeFileSync('.env', 'PROJECT_NAME=demo\nEXEC_MODE=session\nEXEC_DURATION_HOURS=7');
        writeExecution({ durationHours: 2, session: { expectedInputs: 3 } });
        assert.equal(fs.readFileSync('.env', 'utf8'), [
            'PROJECT_NAME=demo', 'EXEC_MODE=task', 'EXEC_DURATION_HOURS=2', 'EXEC_PARALLELISM=1', 'EXEC_MAX_CU=0',
            'EXEC_HEADROOM_PERCENT=25', 'EXEC_SESSION_EXPECTED_INPUTS=3', 'EXEC_SESSION_KEEP_OPEN=false',
            'EXEC_SESSION_RENEW=false', 'EXEC_SESSION_MAX_RENEWALS=0', 'EXEC_ESR_EXPECTED_COMMITS=0',
        ].join('\n'));
        const written = Object.fromEntries(fs.readFileSync('.env', 'utf8').split('\n').map((l) => l.split('=')));
        assert.deepEqual(execution.validate(execution.fromEnv(written)),
            execution.validate({ durationHours: 2, session: { expectedInputs: 3 } }));
        assert.throws(() => writeExecution({ durationHours: 0 }),
            { message: 'execution.durationHours must be an integer between 1 and 65535' });
    } finally {
        process.chdir(cwd);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the prompts: a session that renews takes one renewal as the default of the next question', async () => {
    const { exec, prompts, refused } = await scripted(false, [
        'session', '', '', '', '', '', '', 'true', '0', '',
    ]);
    assert.equal(prompts.length, 10);
    assert.match(prompts[7], /^Open a new order .* \[false\]: $/);
    assert.match(prompts[8], /^Renewals allowed .* \[1\]: $/);
    assert.equal(prompts[9], prompts[8]);
    assert.deepEqual(refused, ['execution.session.maxRenewals must be >= 1 when execution.session.renew is true']);
    assert.deepEqual(exec, execution.validate({ mode: 'session', session: { renew: true, maxRenewals: 1 } }));
});

test('the prompts: a renewal count answered stands; renew answered false keeps the count at 0', async () => {
    const renewing = await scripted(false, ['session', '', '', '', '', '', '', 'yes', '3']);
    assert.deepEqual(renewing.exec.session, { expectedInputs: 1, keepOpen: false, renew: true, maxRenewals: 3 });
    const not = await scripted(false, ['session', '', '', '', '', '', '', 'false', '']);
    assert.deepEqual(not.exec, execution.validate({ mode: 'session' }));
    assert.match(not.prompts[8], /\[0\]: $/);
});

test('the prompts: mode task skips the session keys, ESR adds its key, a refused answer is asked again', async () => {
    const { exec, prompts, refused } = await scripted(true, ['batch', 'task', '2', '', '', '', '7']);
    assert.equal(prompts.length, 7);
    assert.equal(prompts[0], prompts[1]);
    assert.deepEqual(refused, ['execution.mode must be "task" or "session"']);
    assert.match(prompts[6], /^State commits .* \[0\]: $/);
    assert.deepEqual(exec, execution.validate({ durationHours: 2, esr: { expectedCommits: 7 } }));
    const noEsr = await scripted(false, ['', '', '', '', '']);
    assert.equal(noEsr.prompts.length, 5);
    assert.deepEqual(noEsr.exec, execution.DEFAULTS);
});
