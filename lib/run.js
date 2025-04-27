// lib/run.js
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const { readNsiImage, extractNsiPayload } = require('./image');
const chalk = require('chalk'); // v4

const CPP_HELPER_PATH = path.resolve(__dirname, '../bin/container_launcher');

async function runContainer(imagePath, options) {
    console.log(chalk.blue(`Attempting to run container from image: ${imagePath}`));
    if (!await fs.exists(CPP_HELPER_PATH)) {
         console.error(chalk.red('Error: C++ helper binary not found!'));
         console.error(chalk.yellow(`Expected path: ${CPP_HELPER_PATH}`));
         console.error(chalk.yellow('Did you run "npm install" or "npm run build:cpp"?'));
         process.exit(1);
    }
     // Check if running as root
    // if (process.geteuid && process.geteuid() !== 0) {
    //     console.error(chalk.red('Error: This command requires root privileges (sudo) to create namespaces.'));
    //     console.log(`Please try running: ${chalk.green(`sudo nsi run ${imagePath} ...`)}`);
    //     process.exit(1);
    // }

    let rootfsPath = null; // Store path for cleanup

    try {
        // 1. Read Image Header
        const imageInfo = await readNsiImage(imagePath);
        const header = imageInfo.header;
        console.log(chalk.green(`Image "${header.imageName}" loaded (Version ${imageInfo.version})`));
        console.log(chalk.cyan(` Runtime Cmd: ${header.runtime.cmd.join(' ')}`));
        if (header.runtime.env && Object.keys(header.runtime.env).length > 0) {
            console.log(chalk.cyan(' Runtime Env:'), header.runtime.env);
        }


        // 2. Prepare Root Filesystem (`rootfs`)
        const runId = uuidv4().substring(0, 8);
        rootfsPath = path.resolve(process.cwd(), `.nsi-run-${runId}`); // Use current dir for visibility
        await fs.ensureDir(rootfsPath);
        console.log(`Preparing temporary rootfs: ${rootfsPath}`);

        // Create standard directories needed inside the container
        const appPath = path.join(rootfsPath, 'app'); // Filesystem location of /app inside container
        const procPath = path.join(rootfsPath, 'proc'); // Mount point for procfs
        const binPath = path.join(rootfsPath, 'usr', 'bin'); // Location for node binary
        const tmpPath = path.join(rootfsPath, 'tmp'); // Often needed /tmp dir

        await fs.ensureDir(appPath);
        await fs.ensureDir(procPath);
        await fs.ensureDir(binPath);
        await fs.ensureDir(tmpPath);

        // 3. Extract Payload into rootfs/app
        // The image tarball contains the contents for '/app'
        await extractNsiPayload(imageInfo.getPayloadStream(), appPath);


        // 4. Copy Node.js binary from Host into rootfs
        const hostNodePath = process.execPath; // Path to the currently running node executable
        const containerNodePath = path.join(binPath, 'node');
         console.log(`Copying host Node.js (${hostNodePath}) to ${containerNodePath}`);
        await fs.copyFile(hostNodePath, containerNodePath);
        await fs.chmod(containerNodePath, 0o755); // Ensure it's executable


        // 5. Prepare arguments for C++ Helper
        const cppArgs = [];
        cppArgs.push(rootfsPath);

        // Memory limit (convert MB from options to string for argv)
        const memoryLimitMB = options.memory || 0; // Default 0 (no limit)
        cppArgs.push(memoryLimitMB.toString());

        // Container Command and Arguments (must resolve paths *inside* container)
        const containerCmd = header.runtime.cmd[0].startsWith('/')
             ? header.runtime.cmd[0]
             : path.join(header.runtime.workDir || '/app', header.runtime.cmd[0]); // Assuming relative paths start from workDir
         if (containerCmd !== '/usr/bin/node') {
              console.warn(chalk.yellow(`Warning: Command '${containerCmd}' does not seem to be the standard Node.js binary '/usr/bin/node'. Ensure this executable exists in the image or is copied correctly.`));
              // Ideally, we'd check if the cmd exists *within* the rootfs before proceeding.
              const targetCmdPath = path.join(rootfsPath, containerCmd.startsWith('/') ? containerCmd.substring(1) : containerCmd);
              if (!await fs.exists(targetCmdPath)) {
                   throw new Error(`Command executable '${containerCmd}' not found inside prepared rootfs at '${targetCmdPath}'`);
              }
         }


        cppArgs.push(containerCmd); // e.g., /usr/bin/node

        // Add remaining command arguments
        const containerArgs = header.runtime.cmd.slice(1).map(arg => {
            // Very basic: Assume args starting with '/' are absolute within container, others relative to workDir
            // This might need more robust path handling for complex cases
            if (arg.startsWith('/')) {
                 return arg;
            }
            // This simple logic might break if args look like paths but aren't
             if (arg.includes('/') && !path.isAbsolute(arg) && header.runtime.workDir) {
                 return path.join(header.runtime.workDir, arg);
             }
            return arg; // Pass other args as is
        });

        cppArgs.push(...containerArgs); // e.g., /app/app.js

         console.log(chalk.blue('\n--- Launching Container ---'));
         console.log(chalk.dim(` Running C++ Helper: ${CPP_HELPER_PATH}`));
         console.log(chalk.dim(` Arguments: ${cppArgs.join(' ')}`));
         console.log(chalk.dim('--- Container Output Start ---'));

        // 6. Spawn C++ Helper (needs root/sudo already checked)
        const containerProcess = spawn(CPP_HELPER_PATH, cppArgs, {
            stdio: 'inherit', // Pass through stdin, stdout, stderr
            // Pass environment variables from image + potentially host
             env: {
                 ...process.env, // Inherit host env by default (consider clearing this for better isolation)
                 ...(header.runtime.env || {}), // Override/add env vars from image config
                  // Could add specific container env vars like NSI_CONTAINER=true
                 // Clear potentially problematic host vars? e.g. delete process.env.LD_PRELOAD
             },
             // We are already root, so uid/gid options aren't needed here
             // but could be used if C++ helper dropped privileges after setup
        });

        // 7. Wait for C++ Helper (Parent) to Exit
        const exitCode = await new Promise((resolve, reject) => {
            containerProcess.on('error', (err) => {
                console.error(chalk.red(`\nFailed to start container process: ${err.message}`));
                reject(err); // Reject the promise on spawn error
            });

            containerProcess.on('close', (code) => {
                console.log(chalk.dim('--- Container Output End ---'));
                 if (code !== 0) {
                     console.warn(chalk.yellow(`Container process exited with non-zero code: ${code}`));
                } else {
                     console.log(chalk.green('Container process exited successfully (Code 0).'));
                 }
                resolve(code); // Resolve the promise with the exit code
            });
        });

        // Return exit code from Node.js script
        process.exitCode = exitCode; // Set exit code for the nsi command itself

    } catch (error) {
        console.error(chalk.red(`\n--- Container Run Failed ---`));
        console.error(chalk.red(error.message));
        console.error(chalk.red(error.stack || ''));
        process.exitCode = 1; // Indicate failure

    } finally {
        // 8. Cleanup Root Filesystem
        if (rootfsPath && await fs.exists(rootfsPath)) {
             console.log(`Cleaning up rootfs: ${rootfsPath}`);
            try {
                await fs.remove(rootfsPath);
            } catch (cleanupErr) {
                 console.warn(chalk.yellow(`Warning: Failed to fully clean up rootfs ${rootfsPath}: ${cleanupErr.message}`));
                 console.warn(chalk.yellow("Manual cleanup might be required."));
            }
        } else if (rootfsPath) {
            // This might happen if cleanup ran after an error before rootfsPath was set
            // console.log(`Rootfs path was set to ${rootfsPath} but directory doesn't exist.`);
        }
    }
}

module.exports = { runContainer };