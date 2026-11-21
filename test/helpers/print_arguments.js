// Preloaded (--require) into a node process: one started as the test runner
// (--test) prints the paths it was given on one line, after '--test', and
// exits without running them. Any other process goes on as it is.
'use strict';

if (process.execArgv.includes('--test')) {
  process.stdout.write(`--test ${process.argv.slice(1).join(' ')}\n`);
  process.exit(0);
}
