// neoshell/src/cli/commands/build.js
const fs = require('fs');             // Standard fs module for streams, etc.
const fsPromises = require('fs').promises; // Promise-based API
const path = require('path');
const YAML = require('yaml');
const tar = require('tar-fs');
const zlib = require('zlib');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { execSync } = require('child_process'); // For running build commands

const NSI_MAGIC = Buffer.from('NSI!');
const NSI_VERSION = Buffer.from([0, 0, 0, 1]); // Version 1 (Big Endian)

module.exports = {
    command: 'build <yamlPath> [outputPath]',
    describe: 'Build a Neoshell (.nsi) image from a .nsi.yaml file',
    builder: (yargs) => {
        yargs
            .positional('yamlPath', {
                describe: 'Path to the .nsi.yaml configuration file',
                type: 'string',
                demandOption: true, // Ensure yamlPath is always provided
            })
            .positional('outputPath', {
                describe: 'Path to save the built .nsi image',
                type: 'string',
                default: null, // Default name derived from yaml name/version
            })
            .option('o', {
                alias: 'output',
                describe: 'Alias for outputPath',
                type: 'string',
            });
    },
    handler: async (argv) => {
        logger.log(`Starting build process for: ${argv.yamlPath}`);
        const yamlFullPath = path.resolve(argv.yamlPath);
        const buildContextDir = path.dirname(yamlFullPath);
        let tempTarPath = null; // Keep track for cleanup

        try {
            // 1. Parse YAML
            const yamlContent = await fsPromises.readFile(yamlFullPath, 'utf8'); // Use fsPromises
            const config = YAML.parse(yamlContent);

            // Basic validation of required YAML fields
            if (!config.name || !config.version) {
                throw new Error('YAML config must include "name" and "version" fields.');
            }
            logger.info(`Parsed config for image: ${config.name} v${config.version}`);

            // Determine output path
            const outputFileName = argv.outputPath || argv.o || `${config.name}-${config.version}.nsi`;
            const outputFullPath = path.resolve(outputFileName);
            logger.info(`Output image will be: ${outputFullPath}`);

            // 2. Run build commands (if any) defined in config.build
            if (config.build && Array.isArray(config.build) && config.build.length > 0) {
                logger.log('Running build commands...');
                for (const cmd of config.build) {
                    if (typeof cmd !== 'string' || cmd.trim() === '') continue; // Skip empty/invalid commands
                    logger.info(`> ${cmd}`);
                    // WARNING: Be careful executing arbitrary commands!
                    // Consider sandboxing or running in a controlled environment if needed.
                    execSync(cmd, { cwd: buildContextDir, stdio: 'inherit', shell: true }); // Added shell: true for convenience
                }
                logger.log('Build commands finished.');
            } else {
                logger.info('No build commands specified.');
            }

            // 3. Create tarball of included files (+ node_modules if needed)
            logger.log('Creating image payload...');
            tempTarPath = path.join(require('os').tmpdir(), `neoshell-payload-${Date.now()}.tar`);

            // TODO: Implement proper file filtering based on config.include/exclude
            //       and the special handling for node_modules.
            //       This is a complex part involving walking the directory, applying
            //       rules, potentially using libraries like 'ignore'.
            // Placeholder logic: just pack the build context directory for now.
            const filesToPack = ['.']; // Simplistic: pack everything for now

            logger.info(`Packing directory: ${buildContextDir}`);
            await new Promise((resolve, reject) => {
                const packStream = tar.pack(buildContextDir, {
                    // entries: filesToPack // Use 'entries' if you have a specific list
                    // ignore: (name) => { /* Your ignore logic here based on config.exclude */ return false; } // Example ignore function
                    // filter: (name, stat) => { /* Your include logic here */ return true; }
                    // map: (header) => { /* Modify tar headers if needed */ return header; }

                    // Special handling for node_modules (conceptual):
                    // Need to ensure node_modules exists if 'npm ci' ran, and include it,
                    // potentially overriding explicit excludes. This logic needs care.
                });

                const writer = fs.createWriteStream(tempTarPath); // Use standard fs - CORRECT

                packStream.on('error', (err) => {
                    logger.error(`Tar packing error: ${err.message}`);
                    reject(err);
                });
                writer.on('error', (err) => {
                    logger.error(`File write stream error: ${err.message}`);
                    reject(err);
                });
                writer.on('finish', () => {
                    logger.info(`Temporary tarball created: ${tempTarPath}`);
                    resolve();
                });

                packStream.pipe(writer);
            });


            // 4. Calculate hash of UNCOMPRESSED payload
            const tarBuffer = await fsPromises.readFile(tempTarPath); // Use fsPromises
            if (tarBuffer.length === 0) {
                throw new Error("Temporary tarball is empty. Check build context and include/exclude rules.");
            }
            const hash = crypto.createHash('sha256').update(tarBuffer).digest('hex');
            logger.info(`Payload SHA256: ${hash}`);

            // 5. Compress payload (zlib)
            const compressedPayload = await new Promise((resolve, reject) => {
                zlib.deflate(tarBuffer, (err, buffer) => {
                    if (err) return reject(err);
                    resolve(buffer);
                });
            });
            logger.info(`Payload compressed size: ${compressedPayload.length} bytes`);

            // 6. Generate Header JSON
            const headerJson = JSON.stringify({
                imageName: config.name,
                version: config.version, // This is the application version from YAML
                schemaVersion: 1,        // Explicitly add schema version
                created: new Date().toISOString(),
                sizeKB: Math.ceil(tarBuffer.length / 1024), // Uncompressed size
                hash: hash,
                workDir: config.runtime?.workDir || '/app',
                cmd: config.runtime?.cmd || null, // Make cmd explicitly null if not set
                env: config.runtime?.env || {},
            });
            const headerBuffer = Buffer.from(headerJson, 'utf8');
            const headerLengthBuffer = Buffer.alloc(4);
            headerLengthBuffer.writeUInt32BE(headerBuffer.length, 0); // Header length (Big Endian)

            // 7. Write final .nsi file
            const fileHandle = await fsPromises.open(outputFullPath, 'w'); // Use fsPromises
            await fileHandle.write(NSI_MAGIC);
            await fileHandle.write(NSI_VERSION); // Binary format version
            await fileHandle.write(headerLengthBuffer);
            await fileHandle.write(headerBuffer);
            await fileHandle.write(compressedPayload);
            await fileHandle.close(); // Correct (uses handle from fsPromises.open)

            logger.log(`Successfully built image: ${outputFullPath}`);

        } catch (err) {
            logger.error('Build failed:');
            // Check if it's an error from execSync
            if (err.stderr) {
                logger.error('Build command output (stderr):');
                logger.error(err.stderr.toString());
            } else if (err.stdout) {
                 logger.error('Build command output (stdout):');
                 logger.error(err.stdout.toString());
            }
            logger.error(err.message); // Log the specific error message
            // console.error(err.stack); // Uncomment for full stack trace during debugging
            process.exitCode = 1; // Indicate failure

        } finally {
            // 8. Cleanup temporary tarball regardless of success/failure
            if (tempTarPath) {
                try {
                    await fsPromises.unlink(tempTarPath); // Use fsPromises
                    logger.info(`Cleaned up temporary file: ${tempTarPath}`);
                } catch (cleanupErr) {
                    logger.warn(`Failed to clean up temporary file ${tempTarPath}: ${cleanupErr.message}`);
                }
            }
        }
    },
};