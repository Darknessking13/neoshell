// neoshell/src/cli/utils/logger.js
const chalk = require('chalk');

const log = (...args) => console.log(chalk.green('[NSI]'), ...args);
const info = (...args) => console.info(chalk.blue('[NSI INFO]'), ...args);
const warn = (...args) => console.warn(chalk.yellow('[NSI WARN]'), ...args);
const error = (...args) => console.error(chalk.red('[NSI ERROR]'), ...args);

module.exports = { log, info, warn, error };