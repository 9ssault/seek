'use strict';
/**
 * Shared plumbing for the account-capture scripts.
 *
 * Adding a login should not involve editing JSON by hand, guessing a path, or
 * restarting anything: a capture writes one file with the right mode into the
 * shared store and asks a running gateway to reload itself.
 */
const fs = require('fs');
const path = require('path');
const accountsDir = require('../../lib/accounts-dir');

function storeDir(root, env = process.env) {
    return accountsDir.resolveAccountsDir({ root, env });
}

function slug(value, fallback = 'account') {
    const text = String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 48);
    return text || fallback;
}

// 0600 from the first byte: the temp file is created with the mode, not chmod-ed
// afterwards, so a login is never briefly world-readable.
function writeAuthFile(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
        if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
        fs.renameSync(tmp, file);
    } catch (error) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* never created */ }
        throw error;
    }
    return file;
}

function readAuthFiles(dir) {
    return accountsDir.authFileNames(dir).map(name => {
        const file = path.join(dir, name);
        try {
            return { file, name, json: JSON.parse(fs.readFileSync(file, 'utf8')) };
        } catch {
            return null;
        }
    }).filter(Boolean);
}

// Pick the file a capture should land in: the one already holding this exact login
// (a re-capture repairs it in place), otherwise the next free name.
function targetFileFor(dir, { matches, base }) {
    const existing = readAuthFiles(dir).find(entry => matches(entry.json));
    if (existing) return existing.file;
    const stem = slug(base);
    let candidate = path.join(dir, `${stem}.json`);
    let n = 2;
    while (fs.existsSync(candidate)) {
        candidate = path.join(dir, `${stem}-${n}.json`);
        n++;
    }
    return candidate;
}

function gatewayUrl(env = process.env) {
    const port = Number(env.PORT || env.FDSA_PORT || 9655);
    const host = env.PROXY_HOST && !['0.0.0.0', '::'].includes(env.PROXY_HOST) ? env.PROXY_HOST : '127.0.0.1';
    return `http://${host}:${port}`;
}

// Best effort: the capture is complete even when no gateway is running.
async function notifyGatewayReload(env = process.env) {
    const base = gatewayUrl(env);
    const headers = { 'Content-Type': 'application/json' };
    if (env.PROXY_API_KEY) headers.Authorization = `Bearer ${env.PROXY_API_KEY}`;
    try {
        const resp = await fetch(`${base}/admin/accounts/reload`, { method: 'POST', headers, signal: AbortSignal.timeout(5000) });
        if (resp.ok) {
            const body = await resp.json().catch(() => ({}));
            return { reloaded: true, added: body.added || [], url: base };
        }
        return { reloaded: false, status: resp.status, url: base };
    } catch {
        return { reloaded: false, url: base };
    }
}

module.exports = { storeDir, slug, writeAuthFile, readAuthFiles, targetFileFor, gatewayUrl, notifyGatewayReload };
