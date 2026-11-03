#!/usr/bin/env node
'use strict';

// Runs server.js and starts it again when it exits with RESTART_EXIT_CODE (after the
// dashboard installed an update). Any other exit ends the launcher with that code.
// The child shares this terminal, so Ctrl-C reaches it directly.
//
// Two things this launcher owns:
//   1. A previous gateway on the same port is stopped first. `npm start` after a restart
//      used to die with EADDRINUSE while the old process kept serving the old code, which
//      is the classic "the dashboard says files are missing / it didn't change" symptom.
//   2. The child runs with its cwd at the repository root, so the dashboard and every
//      relative path resolve the same way no matter which directory npm was invoked from.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { execFileSync } = require('child_process');
const { spawn } = require('child_process');
const { RESTART_EXIT_CODE } = require('../lib/updater');

const entry = process.env.FDSA_SERVER_ENTRY || path.join(__dirname, '..', 'server.js');
const ROOT = path.dirname(entry);
const args = process.argv.slice(2);
const QUICK_RUN_MS = 5000;
const MAX_QUICK_RESTARTS = 5;
const KILL_GRACE_MS = 4000;
let restarts = 0;
let quickRestarts = 0;
let stopping = false;
let child = null;

function portFromArgs() {
    const flag = args.findIndex(arg => arg === '--port' || arg === '-p');
    if (flag !== -1 && args[flag + 1]) return Number(args[flag + 1]);
    const inline = args.find(arg => /^--port=\d+$/.test(arg));
    if (inline) return Number(inline.split('=')[1]);
    return Number(process.env.PORT || 9655);
}

function readCmdline(pid) {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim(); }
    catch (e) { return ''; }
}

function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Only a process that is actually running this gateway is ever signalled: the pid file is
// written by our own server, and every pid found by port is matched against its command
// line, so a recycled pid cannot make this kill something unrelated.
function isOurServer(pid, port) {
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
    const cmdline = readCmdline(pid);
    if (!cmdline) return false;
    const names = [ROOT, path.basename(ROOT), 'FreeDeepseekAPI', 'free-deepseek-api', 'server.js'];
    return names.some(name => name && cmdline.includes(name));
}

function runningGateways(port) {
    const pids = new Set();
    try {
        const fromFile = Number(fs.readFileSync(path.join(os.homedir(), '.seek', 'gateway.pid'), 'utf8').trim());
        if (fromFile > 0) pids.add(fromFile);
    } catch (e) { /* no pid file: first run, or an older build */ }
    if (process.platform === 'linux') {
        try {
            const out = execFileSync('ss', ['-ltnpH', `sport = :${port}`], { encoding: 'utf8', timeout: 4000 });
            for (const match of out.matchAll(/pid=(\d+)/g)) pids.add(Number(match[1]));
        } catch (e) { /* ss absent or the port is free */ }
    }
    return [...pids].filter(pid => isOurServer(pid, port));
}

async function waitGone(pid, ms) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (!isAlive(pid)) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return !isAlive(pid);
}

function portIsFree(port) {
    return new Promise(resolve => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const done = (free) => { socket.removeAllListeners(); socket.destroy(); resolve(free); };
        socket.setTimeout(500);
        socket.once('connect', () => done(false));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(true));
    });
}

async function stopPrevious(port) {
    if (process.env.FDSA_NO_KILL === '1') return;
    const pids = runningGateways(port);
    for (const pid of pids) {
        console.log(`[launcher] Stopping the gateway already on port ${port} (pid ${pid}).`);
        try { process.kill(pid, 'SIGTERM'); } catch (e) { /* already gone */ }
        if (!(await waitGone(pid, KILL_GRACE_MS))) {
            console.warn(`[launcher] pid ${pid} ignored SIGTERM; sending SIGKILL.`);
            try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
            await waitGone(pid, 1500);
        }
    }
    if (!pids.length) return;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
        if (await portIsFree(port)) return;
        await new Promise(resolve => setTimeout(resolve, 150));
    }
    console.warn(`[launcher] Port ${port} is still held after stopping the old gateway.`);
}

function run() {
    const env = { ...process.env, FDSA_LAUNCHER: '1' };
    // A restart skips the start menu and does not open another browser tab.
    if (restarts > 0) Object.assign(env, { FDSA_RESTARTED: '1', SKIP_ACCOUNT_MENU: '1' });
    const startedAt = Date.now();
    child = spawn(process.execPath, [entry, ...args], {
        stdio: 'inherit',
        env,
        cwd: ROOT,
        windowsHide: true,
    });
    child.on('error', (err) => {
        console.error(`[launcher] Could not start ${entry}: ${err.message}`);
        process.exit(1);
    });
    child.on('exit', (code, signal) => {
        if (code === RESTART_EXIT_CODE && !stopping) {
            restarts += 1;
            quickRestarts = Date.now() - startedAt < QUICK_RUN_MS ? quickRestarts + 1 : 0;
            if (quickRestarts >= MAX_QUICK_RESTARTS) {
                console.error(`[launcher] ${entry} exited with the restart code ${quickRestarts} times in a row within ${QUICK_RUN_MS / 1000}s of starting; giving up.`);
                process.exit(1);
            }
            console.log('[launcher] Restarting with the update…');
            run();
            return;
        }
        process.exit(signal ? 1 : (code == null ? 1 : code));
    });
}

// Pass stop signals on (kill, systemd) and wait for the server to exit with its own code.
// A Ctrl-C reaches the server twice that way, which its shutdown handler tolerates.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopping = true; if (child && child.exitCode === null) child.kill(sig); });

stopPrevious(portFromArgs()).then(run, (err) => {
    console.error(`[launcher] Could not check for a running gateway: ${err.message}`);
    run();
});
