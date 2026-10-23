// A CAS-provisioned securelock takes its environment from its session, not
// from the image's ENV, so the ESR registry address the build bakes must also
// reach the session's `environment`. Both securelock session templates are
// rendered here the way run.js renders them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { esrSessionEnvironment } = require('../cas/config.js');

const ESR = '0x0Ea1728EAE108FD3B9340ae91451348E2Cc6b4E4';
const TEMPLATES = ['../nodenithy/run/etny-securelock-test.yaml.tpl', '../pynithy/run/etny-securelock-test.yaml.tpl'];

const render = (template, env) => fs.readFileSync(path.join(__dirname, template), 'utf8')
  .replace(/__ESR_ENVIRONMENT__/g, esrSessionEnvironment(env));

// The lines of the `application` service's `environment` block.
const environmentOf = (yaml) => {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => /^\s+environment:\s*$/.test(l));
  assert.ok(start >= 0, 'no environment block');
  const indent = lines[start].search(/\S/);
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() === '') continue;
    if (l.search(/\S/) <= indent) break;
    out.push(l.trim());
  }
  return out;
};

test('an enabled ESR with a valid address sets ESR_CONTRACT_ADDRESS', () => {
  assert.equal(esrSessionEnvironment({ ESR_ENABLED: 'true', ESR_CONTRACT_ADDRESS: ESR }), `ESR_CONTRACT_ADDRESS: "${ESR}"`);
});

test('a disabled ESR, or one without a valid address, sets nothing', () => {
  assert.equal(esrSessionEnvironment({}), '# ESR not enabled');
  assert.equal(esrSessionEnvironment({ ESR_ENABLED: 'false', ESR_CONTRACT_ADDRESS: ESR }), '# ESR not enabled');
  assert.equal(esrSessionEnvironment({ ESR_ENABLED: 'true', ESR_CONTRACT_ADDRESS: '' }), '# ESR not enabled');
  assert.equal(esrSessionEnvironment({ ESR_ENABLED: 'yes', ESR_CONTRACT_ADDRESS: '0x1234' }), '# ESR not enabled');
});

for (const template of TEMPLATES) {
  test(`${template}: the rendered session puts the address in the service environment`, () => {
    const yaml = render(template, { ESR_ENABLED: 'true', ESR_CONTRACT_ADDRESS: ESR });
    assert.ok(!/__ESR_ENVIRONMENT__/.test(yaml));
    assert.ok(environmentOf(yaml).includes(`ESR_CONTRACT_ADDRESS: "${ESR}"`));
  });

  test(`${template}: without ESR the session has no address and no placeholder`, () => {
    const yaml = render(template, {});
    assert.ok(!/__ESR_ENVIRONMENT__/.test(yaml));
    assert.ok(!/ESR_CONTRACT_ADDRESS/.test(yaml));
  });
}
