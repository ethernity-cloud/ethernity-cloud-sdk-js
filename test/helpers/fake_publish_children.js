// Preloaded with `node -r` into publish.js: no child process starts.
// execSync answers the image_registry.js actions publish.js runs before its
// runner as a registry would for a usable, funded key (validateAddress "OK",
// checkBalance "1 gas") and prints, on stderr, the action and the SHA-256 of
// the PRIVATE_KEY of the environment it was given; spawn prints, on stdout,
// the program it was asked to start and the SHA-256 of the PRIVATE_KEY of its
// environment, and exits 0.
'use strict';

const childProcess = require('child_process');
const crypto = require('crypto');

const digest = (value) => (value === undefined ? 'unset' : crypto.createHash('sha256').update(value).digest('hex'));

childProcess.execSync = (command, options = {}) => {
  const action = (/"(\w+)"$/.exec(command) || [])[1] || 'unknown';
  process.stderr.write(`execSync ${action} PRIVATE_KEY ${digest((options.env || process.env).PRIVATE_KEY)}\n`);
  if (action === 'validateAddress') return Buffer.from('OK\n');
  if (action === 'checkBalance') return Buffer.from('1 gas\n');
  throw new Error(`no answer for the action ${action}`);
};

childProcess.spawn = (command, args, options = {}) => {
  process.stdout.write(`spawn ${command} ${args.join(' ')} PRIVATE_KEY ${digest((options.env || {}).PRIVATE_KEY)}\n`);
  process.exit(0);
};
