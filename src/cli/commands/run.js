// neoshell/src/cli/commands/run.js
const fs = require('fs').promises;
const fsSync = require('fs'); // Need sync version for some cleanup scenarios
const path = require('path');
const zlib = require('zlib');
const tar = require('tar-fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const os = require('os');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

const NSI_MAGIC = Buffer.from('NSI!');

// Helper to find the bundled sandbox executable
function findSandboxExecutable() {
    // Inside pkg snapshot, __dirname points to snapshot filesystem
    const possiblePath = path.join(__dirname, '..', '..', '..', 'build', 'nsi-sandbox');
    // When running directly via node, it's relative to the script
    const possiblePathDev = path.resolve(__dirname, '..', '..', '..', 'build', 'nsi-sandbox');

    if (fsSync.existsSync(possiblePath)) {
        return possiblePath;
    }
    if (fsSync.existsSync(possiblePathDev)) {
        return possiblePathDev;
    }
    // Fallback: Check PATH (if installed system-wide)
    // You might need more robust logic here
    try {
        const pathOutput = require('child_process').execSync('which nsi-sandbox', { encoding: 'utf8' });
        return pathOutput.trim();
    } catch (e) {
        // Not found in PATH
    }

    throw new Error("Could not find the 'nsi-sandbox' executable. Build it first (npm run build:sandbox) or make sure it's in your PATH or bundled correctly.");
}

module.exports = {
    command: 'run <imagePath>',
    describe: 'Run an application from a Neoshell (.nsi) image',
    builder: (yargs) => {
        yargs
            .positional('imagePath', {
                describe: 'Path to the .nsi image file',
                type: 'string',
            })
            .option('mem', {
                describe: 'Memory limit (e.g., 100M, 1G)',
                type: 'string',
                default: '256M' // Default memory limit
            })
            .option('cpus', {
                describe: 'CPU limit (e.g., 0.5, 1.0)', // Mapping this to cgroup v2 requires calculation
                type: 'number',
                // default: 1.0 // Default CPU limit (may need complex cgroup setup)
            })
            .option('env', {
                alias: 'e',
                describe: 'Set environment variables (e.g., -e VAR=value)',
                type: 'array',
                default: []
            });
            // Add more options: volumes, ports (much later), detached mode, etc.
    },
    handler: async (argv) => {
        logger.log(`Attempting to run image: ${argv.imagePath}`);
        const imageFullPath = path.resolve(argv.imagePath);
        const containerId = uuidv4().substring(0, 8); // Short unique ID for this run
        let tempExtractPath = null; // Keep track for cleanup

        try {
            const sandboxExecutable = findSandboxExecutable();
            logger.info(`Using sandbox executable: ${sandboxExecutable}`);

            // 1. Read Header
            const fileHandle = await fs.open(imageFullPath, 'r');
            const magicBuffer = Buffer.alloc(4);
            await fileHandle.read(magicBuffer, 0, 4, 0);
            if (!magicBuffer.equals(NSI_MAGIC)) {
                throw new Error('Invalid NSI file: incorrect magic number.');
            }

            const versionBuffer = Buffer.alloc(4);
            await fileHandle.read(versionBuffer, 0, 4, 4);
            // TODO: Check version if needed

            const headerLenBuffer = Buffer.alloc(4);
            await fileHandle.read(headerLenBuffer, 0, 4, 8);
            const headerLength = headerLenBuffer.readUInt32BE(0);

            const headerBuffer = Buffer.alloc(headerLength);
            await fileHandle.read(headerBuffer, 0, headerLength, 12);
            const header = JSON.parse(headerBuffer.toString('utf8'));
            logger.info(`Image Name: ${header.imageName}, Version: ${header.version}`);
            logger.info(`Command: ${header.cmd.join(' ')}`);

            // 2. Prepare Extraction Path
            tempExtractPath = await fs.mkdtemp(path.join(os.tmpdir(), `neoshell-${containerId}-rootfs-`));
            logger.info(`Extracting payload to: ${tempExtractPath}`);

            // 3. Read, Decompress, and Extract Payload
            const stats = await fileHandle.stat();
            const payloadOffset = 12 + headerLength;
            const payloadLength = stats.size - payloadOffset;
            const compressedPayloadBuffer = Buffer.alloc(payloadLength);
            await fileHandle.read(compressedPayloadBuffer, 0, payloadLength, payloadOffset);
            await fileHandle.close(); // Close file handle now

            const payloadBuffer = await new Promise((resolve, reject) => {
                zlib.unzip(compressedPayloadBuffer, (err, buffer) => {
                    if (err) return reject(err);
                    resolve(buffer);
                });
            });

            // Verify hash (optional but recommended)
            const calculatedHash = crypto.createHash('sha256').update(payloadBuffer).digest('hex');
            if (calculatedHash !== header.hash) {
                logger.warn(`Payload hash mismatch! Expected ${header.hash}, got ${calculatedHash}`);
                // Decide whether to continue or fail
                // throw new Error('Payload integrity check failed!');
            } else {
                logger.info('Payload hash verified.');
            }

            // Extract tar stream from buffer
            await new Promise((resolve, reject) => {
                 // Create a readable stream from the buffer
                const Readable = require('stream').Readable;
                const stream = new Readable();
                stream.push(payloadBuffer);
                stream.push(null); // Signal EOF

                const extract = tar.extract(tempExtractPath);
                stream.pipe(extract);
                extract.on('finish', resolve);
                extract.on('error', reject);
            });
            logger.info('Payload extracted successfully.');


            // 4. Prepare Arguments for nsi-sandbox
            const sandboxArgs = [
                `--rootfs=${tempExtractPath}`,
                `--workdir=${header.workDir}`,
                ...Object.entries(header.env).map(([key, value]) => `--env=${key}=${value}`),
                ...argv.env.map(e => `--env=${e}`),
                `--mem=${argv.mem}`,
                `--cgroup-id=${containerId}`, 
                ...header.cmd
            ];
    
            logger.log('Spawning nsi-sandbox...');
            logger.info(`> ${sandboxExecutable} ${sandboxArgs.join(' ')}`);

            // 5. Spawn nsi-sandbox
            const child = spawn(sandboxExecutable, sandboxArgs, {
                stdio: 'inherit', // Pipe child's stdio directly to this process's stdio
                // detached: false, // Set true for detached mode later
            });

            // 6. Wait for exit and handle cleanup (simplified)
            child.on('error', (err) => {
                logger.error(`Failed to start sandbox process: ${err.message}`);
                cleanup(); // Attempt cleanup
                process.exitCode = 1;
            });

            child.on('close', (code) => {
                logger.log(`Container process exited with code ${code}`);
                cleanup(); // Attempt cleanup
                process.exitCode = code; // Propagate exit code
            });

            // Handle Ctrl+C interrupting the Node.js script
            process.on('SIGINT', () => {
                logger.log('\nSIGINT received, attempting to stop container...');
                if (child.pid) {
                    // Send SIGTERM to the child process group (more robust for cleanup)
                    try {
                        process.kill(-child.pid, 'SIGTERM'); // Kill process group
                    } catch (e) {
                        logger.warn(`Could not send SIGTERM to process group ${child.pid}: ${e.message}`);
                        try {
                            child.kill('SIGTERM'); // Fallback to killing just the child
                        } catch (e2) {
                             logger.warn(`Could not send SIGTERM to process ${child.pid}: ${e2.message}`);
                        }
                    }
                }
                // Cleanup is handled by the 'close' event handler
                // Give cleanup a moment before forceful exit
                setTimeout(() => {
                    logger.warn('Exiting after SIGINT timeout.');
                    process.exit(130); // Exit code for Ctrl+C
                }, 2000); // Wait 2s for cleanup
            });


        } catch (err) {
            logger.error('Run failed:');
            logger.error(err.message);
            // console.error(err.stack);
            cleanup(); // Attempt cleanup on error
            process.exitCode = 1;
        }

        // Cleanup function
        async function cleanup() {
            if (tempExtractPath) {
                logger.log(`Cleaning up rootfs: ${tempExtractPath}`);
                try {
                    // Recursive removal - use fs.rm for modern Node, rimraf for older
                    await fs.rm(tempExtractPath, { recursive: true, force: true });
                    tempExtractPath = null; // Prevent double cleanup
                } catch (cleanupErr) {
                    logger.warn(`Failed to cleanup temporary directory ${tempExtractPath}: ${cleanupErr.message}`);
                }
            }
             // TODO: Add Cgroup cleanup logic here if necessary
             // e.g., remove /sys/fs/cgroup/neoshell/<containerId>
             // This might require root privileges or specific delegation.
        }
    },
};