const http = require('http');
const os = require('os');
const fs = require('fs').promises; // Use promises API

const port = process.env.PORT || 3000;
const hostname = os.hostname(); // Should be 'nsi-container' inside

// Function to read memory usage from /proc/self/statm (if /proc is mounted)
async function getMemoryUsage() {
  try {
    // statm format: size resident share text lib data dt (in pages)
    const statmContent = await fs.readFile('/proc/self/statm', 'utf8');
    const parts = statmContent.trim().split(/\s+/);
    const pageSize = 4096; // Common page size in bytes, can vary!
    const rssPages = parseInt(parts[1], 10); // Resident Set Size in pages
    const rssBytes = rssPages * pageSize;
    return { rssBytes, rssPages };
  } catch (error) {
    console.error("Could not read /proc/self/statm:", error.message);
    return { error: error.message };
  }
}

const server = http.createServer(async (req, res) => {
  console.log(`[${new Date().toISOString()}] Received request: ${req.method} ${req.url}`);
  const mem = await getMemoryUsage();

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    message: 'Hello from inside NSI container!',
    pid: process.pid, // Should be 1 inside the container
    hostname: hostname,
    nodeVersion: process.version,
    cwd: process.cwd(), // Should be '/' after chroot/chdir
    env: process.env, // Show environment variables
    memory: mem,
    platform: os.platform(),
    arch: os.arch(),
    userInfo: os.userInfo() // May show root if not using user namespaces
  }, null, 2));
});

server.listen(port, () => {
  console.log(`Server running inside container on http://${hostname}:${port}`);
  console.log(`PID: ${process.pid}`);
  // Check if /proc seems mounted
  fs.access('/proc/self/statm')
    .then(() => console.log('/proc filesystem seems available.'))
    .catch(() => console.warn('/proc filesystem not accessible. Memory reporting may fail.'));

});

process.on('SIGINT', () => {
    console.log("Received SIGINT, shutting down...");
    server.close(() => { process.exit(0); });
});
process.on('SIGTERM', () => {
    console.log("Received SIGTERM, shutting down...");
    server.close(() => { process.exit(0); });
});
