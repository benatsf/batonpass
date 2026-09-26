#!/usr/bin/env node
// node:sqlite prints an ExperimentalWarning on load. Hook output must stay clean,
// so drop that one warning class and keep every other warning on stderr.
process.removeAllListeners('warning');
process.on('warning', (warning) => {
  if (warning.name !== 'ExperimentalWarning') process.stderr.write(`${warning.stack ?? warning}\n`);
});
const { main } = await import('../dist/cli.js');
process.exitCode = await main(process.argv.slice(2));
