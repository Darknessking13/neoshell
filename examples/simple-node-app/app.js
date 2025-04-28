// examples/simple-node-app/app.js
const express = require('express');
const os = require('os');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

console.log(`[SimpleApp] Started at ${new Date().toISOString()}`);
console.log(`[SimpleApp] Hostname: ${os.hostname()}`);
console.log(`[SimpleApp] PID: ${process.pid}`);
console.log(`[SimpleApp] UID: ${process.getuid()}, GID: ${process.getgid()}`);
console.log(`[SimpleApp] Environment PORT: ${process.env.PORT}`);
console.log(`[SimpleApp] Environment NODE_ENV: ${process.env.NODE_ENV}`);

// Try reading a cgroup value (will likely fail if path is wrong/permissions denied)
try {
    const memUsage = fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8');
    console.log(`[SimpleApp] Cgroup Memory Usage: ${memUsage.trim()}`);
} catch (err) {
    console.warn(`[SimpleApp] Could not read cgroup memory: ${err.message}`);
}


app.get('/', (req, res) => {
    res.send(`Hello from Neoshell Container!\nHostname: ${os.hostname()}\nPID: ${process.pid}\n`);
});

app.listen(PORT, () => {
    console.log(`[SimpleApp] Server listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n[SimpleApp] SIGINT received, shutting down...');
    process.exit(0);
 });
process.on('SIGTERM', () => {
    console.log('\n[SimpleApp] SIGTERM received, shutting down...');
    process.exit(0);
 });