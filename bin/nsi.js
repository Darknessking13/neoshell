#!/usr/bin/env node
// bin/nsi

// Ensure errors in async handlers are caught
process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    process.exit(1);
});


const { Command } = require('commander');
const chalk = require('chalk'); // v4
const path = require('path');
const { buildImage } = require('../lib/build');
const { runContainer } = require('../lib/run');
const { version } = require('../package.json'); // Get version from package.json


const program = new Command();

program
    .name('nsi')
    .version(version)
    .description(chalk.blue('NSI - A Node+C++ Experimental Low-Level Container Tool'));


program
    .command('build')
    .description('Build an .nsi image from a .nsi_.yaml config file')
    .argument('[yaml_file]', 'Path to the .nsi_.yaml config file', '.nsi_.yaml')
    .option('-o, --output-dir <dir>', 'Directory to save the .nsi image file', '.')
    .action(async (yamlFile, options) => {
        try {
            console.log(chalk.yellow(`Starting build using config: ${yamlFile}`));
            const imagePath = await buildImage(yamlFile, options.outputDir);
            console.log(chalk.green(`\nImage successfully built: ${imagePath}`));
        } catch (err) {
            console.error(chalk.red('\n--- Build Failed ---'));
            console.error(chalk.red(err.message));
            // console.error(err.stack); // Optional: full stack trace
            process.exit(1);
        }
    });

program
    .command('run')
    .description('Run a command in a new container from an .nsi image')
    .argument('<image_file>', 'Path to the .nsi image file')
    // .argument('[command...]', 'Optional command to override the image CMD') // Add later if needed
    .option('-m, --memory <limit_mb>', 'Set memory limit in Megabytes (basic, uses setrlimit)', parseInt)
    .option('--env <key=value>', 'Set environment variables (overrides image env)', (val, memo) => {
        const [key, value] = val.split('=');
        if (key && value) {
             memo[key.trim()] = value.trim();
        }
        return memo;
     }, {})
    .action(async (imageFile, options) => {
        console.log(chalk.yellow(`Requesting to run image: ${imageFile}`));
         if (options.memory) {
             console.log(chalk.yellow(` Applying memory limit: ${options.memory} MB`));
         }
        // Note: 'runContainer' handles root check and error logging internally now
         await runContainer(path.resolve(imageFile), options);
         // runContainer sets process.exitCode based on container exit
    });

// --- Future command ideas ---
// program.command('list').description('List available .nsi images (e.g., in a specific dir)').action(() => {/*...*/});
// program.command('inspect').description('Show metadata of an .nsi image').argument('<image_file>').action(() => {/*...*/});
// program.command('rm').description('Remove an .nsi image file').argument('<image_file>').action(() => {/*...*/});

// Make bin/nsi executable: chmod +x bin/nsi

program.parse(process.argv);

// If no command was given, display help
if (!process.argv.slice(2).length) {
    program.outputHelp();
}