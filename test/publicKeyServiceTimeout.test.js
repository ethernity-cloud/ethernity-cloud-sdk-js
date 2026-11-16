import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const axios = require('axios');

// A poll of the certificate extraction service that does not reach it or
// stalls is given up after REQUEST_TIMEOUT_MS and answers null, so the poll
// loop asks again after POLL_SECONDS instead of the publish hanging on one
// request. The module's axios is the shared instance, stubbed here.
for (const stack of ['nodenithy', 'pynithy']) {
  const { checkIpfsHashStatus, REQUEST_TIMEOUT_MS } = require(`../${stack}/run/public_key_service.js`);

  test(`${stack}: a stalled or dropped poll answers null and carries the timeout`, async () => {
    const calls = [];
    const original = axios.get;
    axios.get = async (url, config) => {
      calls.push({ url, config });
      const error = new Error(calls.length === 1 ? 'timeout of 30000ms exceeded' : 'socket hang up');
      error.code = calls.length === 1 ? 'ECONNABORTED' : 'ECONNRESET';
      throw error;
    };
    try {
      assert.equal(await checkIpfsHashStatus('QmHash'), null);
      assert.equal(await checkIpfsHashStatus('QmHash'), null);
    } finally {
      axios.get = original;
    }
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.match(call.url, /\/api\/checkHash\/QmHash$/);
      assert.equal(call.config.timeout, REQUEST_TIMEOUT_MS);
    }
  });

  test(`${stack}: a 404 answers null and a 200 answers the body`, async () => {
    const original = axios.get;
    let answered = 0;
    axios.get = async () => {
      answered += 1;
      if (answered === 1) {
        const error = new Error('Request failed with status code 404');
        error.response = { status: 404, data: { error: 'Hash not found' } };
        throw error;
      }
      return { data: { status: 'running', percent: 40, publicKey: 0 } };
    };
    try {
      assert.equal(await checkIpfsHashStatus('QmHash'), null);
      assert.deepEqual(await checkIpfsHashStatus('QmHash'), { status: 'running', percent: 40, publicKey: 0 });
    } finally {
      axios.get = original;
    }
  });
}
