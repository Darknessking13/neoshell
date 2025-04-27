// lib/image.js
const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');
const tar = require('tar-fs');
const path = require('path');
// Use PassThrough which is both Readable and Writable, convenient for proxying
const { Writable, PassThrough } = require('stream');

const MAGIC_BYTES = Buffer.from('NSI!'); // 0x4E 53 49 21
const VERSION = 1;
const HEADER_FIXED_LEN = 12; // Magic(4) + Version(4) + HeaderLen(4)

// --- Writing .nsi File ---
// (Keep the existing createNsiImage function as is)
async function createNsiImage(imagePath, sourceDir, headerJson) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log(`Creating tarball from ${sourceDir}...`);
            const tarStream = tar.pack(sourceDir);

            const hash = crypto.createHash('sha256');
            const payloadChunks = [];

            tarStream.on('data', (chunk) => {
                hash.update(chunk);
                payloadChunks.push(chunk);
            });

            tarStream.on('error', (err) => reject(new Error(`Tar packing failed: ${err.message}`)));

            tarStream.on('end', () => {
                const rawPayload = Buffer.concat(payloadChunks);
                const payloadHash = hash.digest('hex');
                console.log(`Raw Payload Size: ${rawPayload.length} bytes, Hash: ${payloadHash}`);

                headerJson.hash = payloadHash;
                headerJson.created = new Date().toISOString();

                console.log('Compressing payload (zlib)...');
                zlib.deflate(rawPayload, { level: zlib.constants.Z_BEST_COMPRESSION }, (err, compressedPayload) => {
                    if (err) {
                        return reject(new Error(`Zlib compression failed: ${err.message}`));
                    }
                    console.log(`Compressed Payload Size: ${compressedPayload.length} bytes`);

                    headerJson.size = compressedPayload.length;
                    const finalHeaderJsonString = JSON.stringify(headerJson, null, 2);
                    const finalHeaderJsonBuffer = Buffer.from(finalHeaderJsonString, 'utf8');
                    const finalHeaderLen = finalHeaderJsonBuffer.length;

                    const versionBuffer = Buffer.alloc(4);
                    versionBuffer.writeUInt32BE(VERSION, 0);

                    const headerLenBuffer = Buffer.alloc(4);
                    headerLenBuffer.writeUInt32BE(finalHeaderLen, 0);

                    const finalBuffer = Buffer.concat([
                        MAGIC_BYTES,
                        versionBuffer,
                        headerLenBuffer,
                        finalHeaderJsonBuffer,
                        compressedPayload
                    ]);

                    console.log(`Writing image file to ${imagePath}...`);
                    fs.writeFile(imagePath, finalBuffer, (writeErr) => {
                        if (writeErr) {
                            return reject(new Error(`Failed to write image file: ${writeErr.message}`));
                        }
                        console.log(`Image file ${imagePath} created successfully.`);
                        resolve(imagePath);
                    });
                });
            });

        } catch (error) {
            reject(error);
        }
    });
}


// --- Reading .nsi File --- // **REVISED**
async function readNsiImage(imagePath) {
    return new Promise((resolve, reject) => {
        const stream = fs.createReadStream(imagePath);
        let headerInfo = null;
        let buffer = Buffer.alloc(0);
        let resolved = false; // Flag to prevent resolving multiple times

        const handleError = (err) => {
            if (!resolved) {
                resolved = true; // Prevent further processing or multiple errors
                stream.destroy(); // Ensure stream is closed
                reject(err);
            } else {
                 console.warn("Stream error after promise resolved:", err.message);
            }
        };

        stream.on('error', (err) => handleError(new Error(`Error reading image file ${imagePath}: ${err.message}`)));

        stream.on('data', (chunk) => {
            if (resolved) return; // Stop processing if promise is already settled

            buffer = Buffer.concat([buffer, chunk]);

            // 1. Try to parse fixed header
            if (!headerInfo && buffer.length >= HEADER_FIXED_LEN) {
                if (!buffer.slice(0, 4).equals(MAGIC_BYTES)) {
                   return handleError(new Error(`Invalid magic bytes. Expected ${MAGIC_BYTES.toString('hex')}, got ${buffer.slice(0,4).toString('hex')}`));
                }

                const version = buffer.readUInt32BE(4);
                if (version !== VERSION) {
                    return handleError(new Error(`Unsupported version. Expected ${VERSION}, got ${version}`));
                }

                const headerJsonLen = buffer.readUInt32BE(8);
                 // Basic sanity check on header length
                 if (headerJsonLen > 10 * 1024 * 1024) { // e.g. > 10MB header? Unlikely.
                     return handleError(new Error(`Unusually large header length specified: ${headerJsonLen} bytes`));
                 }
                headerInfo = { version, headerJsonLen, headerOffset: HEADER_FIXED_LEN };
            }

            // 2. Try to parse JSON header
            if (headerInfo && !headerInfo.json && buffer.length >= headerInfo.headerOffset + headerInfo.headerJsonLen) {
                const payloadOffset = headerInfo.headerOffset + headerInfo.headerJsonLen;
                try {
                    const headerJsonString = buffer.slice(headerInfo.headerOffset, payloadOffset).toString('utf8');
                    headerInfo.json = JSON.parse(headerJsonString);
                } catch (e) {
                    return handleError(new Error(`Failed to parse header JSON: ${e.message}`));
                }

                 if (resolved) return; // Check again before resolving
                 resolved = true; // Mark as resolved now

                 stream.pause(); // Pause reading from the file until payload stream is consumed

                resolve({
                    header: headerInfo.json,
                    version: headerInfo.version,
                    // ** REVISED getPayloadStream **
                    getPayloadStream: () => {
                         const compressedPayloadBuffer = buffer.slice(payloadOffset);
                         buffer = null; // Release reference to potentially large buffer

                         // Create the pipeline: Inflate -> Output
                         const inflater = zlib.createInflate();
                         const outputStream = new PassThrough(); // Use PassThrough to buffer/proxy

                        // Handle errors on the inflater/output stream
                        inflater.on('error', (err) => {
                             console.error("Zlib inflation error:", err);
                             outputStream.emit('error', new Error(`Payload decompression error: ${err.message}`));
                             stream.destroy(); // Stop reading the source file on error
                         });
                         stream.on('error', (err) => {
                             // Propagate file read errors to the output stream if they happen later
                              if (!outputStream.destroyed) {
                                outputStream.emit('error', new Error(`Underlying file read error: ${err.message}`));
                              }
                         });


                         // Pipe the file stream (starting after the header) into the inflater
                         stream.pipe(inflater);
                         // Pipe the decompressed data into our output stream
                         inflater.pipe(outputStream);


                         // Write the already-buffered part of the compressed payload to the inflater *first*
                         // This is crucial because the file stream was paused after reading this part
                         if (compressedPayloadBuffer.length > 0) {
                            inflater.write(compressedPayloadBuffer);
                         }

                         // Resume the file stream AFTER setting up the pipes and writing the buffer
                         // Ensure this happens only once
                         let resumed = false;
                         const resumeStreamIfNeeded = () => {
                             if (!resumed && stream.isPaused()) {
                                 resumed = true;
                                 //console.log("Resuming file stream to read remaining payload...");
                                 stream.resume();
                             }
                         };
                         // Resume when the output stream starts being consumed
                         outputStream.on('resume', resumeStreamIfNeeded);
                          // Also ensure it resumes if data is requested directly (though pipe is standard)
                         outputStream.on('data', resumeStreamIfNeeded);
                          // Check if stream is already flowing from pipe() call
                          process.nextTick(resumeStreamIfNeeded);


                         // When the original file stream ends, signal the end of the inflater input
                         stream.on('end', () => {
                            inflater.end();
                         });

                         return outputStream; // Return the PassThrough stream which emits decompressed data
                    }
                });
            }
        });

        stream.on('end', () => {
            // This is reached if the file ends before the headers could be fully parsed
            if (!resolved) {
                 handleError(new Error('Incomplete image file or failed to parse headers.'));
            }
        });
    });
}


async function extractNsiPayload(payloadStream, destinationDir) {
    return new Promise((resolve, reject) => {
        console.log(`Extracting payload to ${destinationDir}...`);
        const extractStream = tar.extract(destinationDir);

        payloadStream.on('error', (err) => reject(new Error(`Payload decompression/read error: ${err.message}`)));
        extractStream.on('error', (err) => reject(new Error(`Tar extraction failed: ${err.message}`)));
        extractStream.on('finish', () => {
            console.log('Payload extracted successfully.');
            resolve();
        });

        payloadStream.pipe(extractStream);
    });
}


module.exports = {
    createNsiImage,
    readNsiImage,
    extractNsiPayload
};