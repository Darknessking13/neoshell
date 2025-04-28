#!/usr/bin/env node
// neoshell/src/cli/index.js
const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');

yargs(hideBin(process.argv))
  .command(require('./commands/build'))
  .command(require('./commands/run'))
  // Add other commands here (e.g., list, inspect, rm)
  .demandCommand(1, 'You need to specify a command (e.g., build, run).')
  .help()
  .alias('h', 'help')
  .strict() // Show help if unknown command/option is used
  .parse();

// Basic signal handling (important for cleanup)
process.on('SIGINT', () => {
    console.log('\nNeoshell interrupted. Cleaning up...');
    // Add any necessary global cleanup logic here
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('Neoshell terminated. Cleaning up...');
    // Add any necessary global cleanup logic here
    process.exit(0);
});