// lib/build.js
const fs = require('fs-extra'); // Use fs-extra for easier directory operations
const path = require('path');
const yaml = require('js-yaml');
const { execSync } = require('child_process');
const { createNsiImage } = require('./image');
const { v4: uuidv4 } = require('uuid');
const tar = require('tar-fs'); // For packing

async function buildImage(yamlPath = '.nsi_.yaml', outputDir = '.') {
    console.log(`Starting image build from ${yamlPath}...`);

    const configPath = path.resolve(yamlPath);
    const contextDir = path.dirname(configPath); // Directory containing the yaml file

    if (!await fs.exists(configPath)) {
        throw new Error(`Config file not found: ${configPath}`);
    }

    // 1. Read and Parse Config
    const configContent = await fs.readFile(configPath, 'utf8');
    const config = yaml.load(configContent);

    if (!config.name || !config.runtime || !config.runtime.cmd) {
        throw new Error('Invalid config: Missing required fields "name" and "runtime.cmd"');
    }
    const imageName = `${config.name}.nsi`;
    const imageOutputPath = path.resolve(outputDir, imageName);

    // 2. Create Temporary Build Directory
    const buildId = uuidv4();
    const tempBuildDir = path.join(contextDir, `.nsi-build-${buildId}`);
    const appDirInBuild = path.join(tempBuildDir, 'app'); // Container expects content in /app
    await fs.ensureDir(appDirInBuild); // Creates tempBuildDir and tempBuildDir/app

    console.log(`Created temporary build directory: ${tempBuildDir}`);

    try {
        // 3. Copy Included Files
        const include = config.include || ['app/', 'package.json', 'package-lock.json']; // Sensible defaults
        const exclude = config.exclude || ['.git/', 'node_modules/']; // Exclude node_modules by default before build step

        console.log(`Copying included files/dirs to ${appDirInBuild}:`, include);
        for (const item of include) {
            const sourcePath = path.join(contextDir, item);
            const destPath = path.join(appDirInBuild, path.basename(item)); // Place directly inside app/
             if (await fs.exists(sourcePath)) {
                 console.log(` - Copying ${sourcePath} to ${destPath}`);
                await fs.copy(sourcePath, destPath, {
                    filter: (src) => {
                        const relativePath = path.relative(contextDir, src);
                        // Basic exclusion check (improve if needed)
                        const isExcluded = exclude.some(pattern => relativePath.startsWith(pattern.replace(/\/$/, '')));
                         if (isExcluded) console.log(`   - Excluding ${relativePath}`);
                        return !isExcluded;
                    }
                });
            } else {
                console.warn(` - Warning: Source item not found, skipping: ${sourcePath}`);
            }
        }

         // Handle the node_modules special case: It MUST be included in the final tar
        // even if excluded initially, IF a build step likely generated it.
        // The build step will run *within* appDirInBuild.
        let includeNodeModulesInTar = false; // Flag


        // 4. Run Build Steps (inside the temporary app dir)
        if (config.build && Array.isArray(config.build)) {
            console.log('Running build steps...');
            for (const command of config.build) {
                console.log(` > ${command}`);
                try {
                    // Execute command within the temporary app directory
                    execSync(command, { cwd: appDirInBuild, stdio: 'inherit' });
                     // If a common install command ran, assume node_modules should be packed
                     if (command.startsWith('npm install') || command.startsWith('npm ci')) {
                         includeNodeModulesInTar = true;
                         console.log("   (Build step likely installed dependencies, will include node_modules in image)");
                     }
                } catch (err) {
                    throw new Error(`Build step failed: "${command}". Error: ${err.message}`);
                }
            }
        }


        // 5. Prepare Final Image Contents
        // The final image should contain the contents destined for the container's /app
        const imageSourceDir = appDirInBuild; // Package the whole ./app dir from build context

        // Define what gets tarred: Default is everything in imageSourceDir
        // BUT: Ensure node_modules IS included if the flag is set or it exists there now,
        // regardless of the initial 'exclude' config.
        const nodeModulesPathInBuild = path.join(imageSourceDir, 'node_modules');
        if (includeNodeModulesInTar || await fs.exists(nodeModulesPathInBuild)) {
             console.log("Ensuring node_modules is included in the final image tarball.");
             // We don't need to do anything explicit here IF we tar `imageSourceDir` entirely.
             // If we were selectively choosing files, we'd need to ensure node_modules is added back.
        }


        // 6. Create Image Header
        const headerJson = {
            imageName: config.name,
            version: config.version || 'latest',
            created: null, // Will be set by createNsiImage
            hash: null, // Will be set by createNsiImage
            size: null, // Will be set by createNsiImage (size of compressed payload)
            runtime: {
                cmd: config.runtime.cmd,
                workDir: config.runtime.workDir || '/app', // Default workdir
                env: config.runtime.env || {}
            }
            // We could store the build commands here too if desired
        };

         // Create the actual image file (.nsi)
        // Note: tar-fs packs the *contents* of the directory.
        // So tar.pack(imageSourceDir) will put app/* into the root of the tar.
        await createNsiImage(imageOutputPath, imageSourceDir, headerJson);

    } finally {
        // 7. Clean up Temporary Build Directory
        console.log(`Cleaning up temporary build directory: ${tempBuildDir}`);
        await fs.remove(tempBuildDir);
    }

    console.log(`\nImage built successfully: ${imageOutputPath}`);
    return imageOutputPath;
}

module.exports = { buildImage };