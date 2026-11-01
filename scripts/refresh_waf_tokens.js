#!/usr/bin/env node
/**
 * Automatically refresh the aws-waf-token for every account file — no login required.
 *
 * For each account:
 *   1. Launch Chrome (Helium when installed) under a virtual display with a brand-new
 *      throwaway profile (unique per account)
 *   2. Visit chat.deepseek.com — AWS WAF's JS challenge runs and issues a fresh
 *      unique aws-waf-token automatically
 *   3. Extract the new token and patch ONLY aws-waf-token in the account file
 *      (bearer token, ds_session_id, and all other fields are untouched)
 *   4. Delete the throwaway profile
 *
 * The stored ds_session_id is deliberately NOT pre-injected: with a session cookie the
 * CDN answers 200 and never serves the challenge, so no token is ever issued.
 *
 * Fully automated — no prompts, no manual steps. Run whenever accounts start 401-ing on PoW.
 *
 * Usage:
 *   node scripts/refresh_waf_tokens.js                          # refresh all accounts
 *   node scripts/refresh_waf_tokens.js accounts/foo.json        # single file
 *   DEEPSEEK_WAF_HEADLESS=0 node scripts/refresh_waf_tokens.js  # visible Chrome (debug)
 *   DEEPSEEK_WAF_CONCURRENCY=1 node scripts/refresh_waf_tokens.js  # one at a time
 */
'use strict';
const { spawn } = require('child_process');
const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { locateChrome } = require('./lib/chrome-setup');

const repoRoot    = path.resolve(__dirname, '..');
const accountsDir = path.join(repoRoot, 'accounts');
const BASE_PORT   = Number(process.env.DEEPSEEK_WAF_PORT || 9400);
// On Linux, use xvfb-run so Chrome runs as a real (non-headless) browser,
// bypassing AWS WAF's headless detection. Set DEEPSEEK_WAF_HEADLESS=1 to
// force headless anyway (e.g. if Xvfb is unavailable).
const USE_XVFB = process.platform === 'linux'
    && process.env.DEEPSEEK_WAF_HEADLESS !== '1'
    && Boolean((() => { try { require('child_process').execSync('which xvfb-run', { stdio: 'ignore' }); return true; } catch { return false; } })());
const HEADLESS    = !USE_XVFB && process.env.DEEPSEEK_WAF_HEADLESS !== '0';
// A windowed browser under Xvfb costs more RAM than headless, so default lower there.
const CONCURRENCY = Math.max(1, Number(process.env.DEEPSEEK_WAF_CONCURRENCY || (USE_XVFB ? 2 : 3)));

// ── locate Chrome (same search as deepseek_chrome_auth.js) ────────────────────
function puppeteerExecutables() {
    const found = [];
    for (const base of [repoRoot, path.resolve(repoRoot, '..', 'FreeQwenApi')]) {
        try {
            const p = require(require.resolve('puppeteer', { paths: [base] }));
            if (typeof p.executablePath === 'function') {
                const e = p.executablePath();
                if (e) found.push(e);
            }
        } catch {}
    }
    return found;
}
function findChrome() {
    const r = locateChrome({ puppeteer: puppeteerExecutables() });
    if (r.path) return r.path;
    throw new Error(
        'Chrome not found. Set CHROME_PATH=/path/to/chrome or run `npm run auth` first.'
    );
}

// ── minimal CDP client ─────────────────────────────────────────────────────────
class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        this.pending = new Map();
        this.ws.onmessage = (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject, timer } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                clearTimeout(timer);
                msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
            }
        };
    }
    ready() {
        return new Promise((res, rej) => { this.ws.onopen = res; this.ws.onerror = rej; });
    }
    send(method, params = {}, timeoutMs = 15000) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`CDP timeout: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
    }
    close() {
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error('CDP closed'));
        }
        this.pending.clear();
        try { this.ws.close(); } catch {}
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpGetJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return r.json();
}

async function waitForDevtools(port, timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try { return await httpGetJson(`http://127.0.0.1:${port}/json/version`); } catch {}
        await sleep(300);
    }
    throw new Error(`Chrome DevTools on port ${port} did not start within ${timeoutMs}ms`);
}

// ── cookie helpers ─────────────────────────────────────────────────────────────
function parseCookies(str) {
    const map = {};
    for (const part of (str || '').split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        map[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    }
    return map;
}
function mergeCookies(original, newEntries) {
    const map = parseCookies(original);
    Object.assign(map, newEntries);
    return Object.entries(map).map(([k, v]) => `${k}=${v}`).join('; ');
}

// ── kill Chrome by pid group ───────────────────────────────────────────────────
function killChrome(proc) {
    try {
        // Kill the whole process group so child Chrome processes also die.
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL');
    } catch {}
    try { proc.kill('SIGKILL'); } catch {}
}

// ── per-account WAF refresh ────────────────────────────────────────────────────
async function refreshAccount(accountFile, port, chromePath) {
    const raw = JSON.parse(fs.readFileSync(accountFile, 'utf8'));

    const profileDir = path.join(
        os.tmpdir(),
        `ds-waf-${path.basename(accountFile, '.json')}-${port}`
    );
    // Clean up any leftover from a previous interrupted run
    try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(profileDir, { recursive: true });

    const chromeArgs = [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${port}`,
        '--use-mock-keychain',
        '--password-store=basic',
        '--disable-sync',
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        '--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter,Translate',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
    ];
    if (HEADLESS) chromeArgs.push('--headless=new', '--disable-gpu');
    chromeArgs.push('about:blank');

    // Under Xvfb Chrome is a plain windowed browser on a virtual display, so it
    // presents the fingerprint AWS WAF's challenge expects (no headless UA/hints).
    const launchBin  = USE_XVFB ? 'xvfb-run' : chromePath;
    const launchArgs = USE_XVFB
        ? ['--auto-display', '--server-args=-screen 0 1280x900x24', chromePath, ...chromeArgs]
        : chromeArgs;

    // detached so we can kill the whole group on cleanup (xvfb-run + Xvfb included)
    const chrome = spawn(launchBin, launchArgs, {
        stdio: 'ignore',
        detached: true,
    });
    // Don't unref yet — we need the pid for group kill in finally

    let cdp = null;
    try {
        await waitForDevtools(port);
        const version = await httpGetJson(`http://127.0.0.1:${port}/json/version`);
        if (!version.webSocketDebuggerUrl) throw new Error('No browser WebSocket URL');

        cdp = new CDP(version.webSocketDebuggerUrl);
        await cdp.ready();

        // Open a new tab for deepseek
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });

        // Get the tab's DevTools WS URL
        let tabWsUrl = null;
        for (let i = 0; i < 20; i++) {
            const targets = await httpGetJson(`http://127.0.0.1:${port}/json`);
            const tab = targets.find(t => t.targetId === targetId || t.id === targetId);
            if (tab?.webSocketDebuggerUrl) { tabWsUrl = tab.webSocketDebuggerUrl; break; }
            await sleep(300);
        }
        if (!tabWsUrl) throw new Error('Tab DevTools URL not found');

        const page = new CDP(tabWsUrl);
        await page.ready();

        await page.send('Network.enable');
        await page.send('Page.enable');

        // Navigate to deepseek — AWS WAF JS challenge fires automatically.
        // The profile stays anonymous on purpose; a ds_session_id cookie makes the CDN
        // skip the challenge entirely, so the token would never be issued.
        await page.send('Page.navigate', { url: 'https://chat.deepseek.com/' });

        // Poll for aws-waf-token (WAF challenge takes ~1-5s normally, longer on a
        // cold load); a real browser under Xvfb needs time to render the challenge.
        let wafToken = null;
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            const { cookies } = await page.send('Network.getAllCookies');
            const waf = (cookies || []).find(
                c => c.name === 'aws-waf-token' && /deepseek\.com/.test(c.domain)
            );
            if (waf?.value) { wafToken = waf.value; break; }
            await sleep(500);
        }

        page.close();

        if (!wafToken) {
            throw new Error(
                'aws-waf-token never appeared. ' +
                'Check that DeepSeek is reachable; if this is a WAF block, retry with ' +
                'DEEPSEEK_WAF_CONCURRENCY=1 so fewer browsers load at once.'
            );
        }

        // Patch ONLY aws-waf-token, leave everything else intact
        const newCookie = mergeCookies(raw.cookie || '', { 'aws-waf-token': wafToken });
        const updated = { ...raw, cookie: newCookie };
        const tmpPath = `${accountFile}.waf.${process.pid}.tmp`;
        fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        fs.renameSync(tmpPath, accountFile);

        return { ok: true, wafToken: `${wafToken.slice(0, 36)}...` };
    } finally {
        if (cdp) cdp.close();
        killChrome(chrome);
        await sleep(400);
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch {}
    }
}

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
    const chromePath = findChrome();
    console.log(`[waf-refresh] Chrome:      ${chromePath}`);
    console.log(`[waf-refresh] Headless:    ${HEADLESS}${USE_XVFB ? ' (xvfb-run virtual display)' : ''}`);
    console.log(`[waf-refresh] Concurrency: ${CONCURRENCY}`);

    // Collect account files (CLI args override auto-discovery)
    let files = process.argv.slice(2).filter(a => a.endsWith('.json')).map(f => path.resolve(f));
    if (!files.length) {
        const authJson = path.join(repoRoot, 'deepseek-auth.json');
        if (fs.existsSync(authJson)) files.push(authJson);
        if (fs.existsSync(accountsDir)) {
            for (const f of fs.readdirSync(accountsDir).filter(f => f.endsWith('.json')).sort()) {
                files.push(path.join(accountsDir, f));
            }
        }
    }

    if (!files.length) {
        console.error('[waf-refresh] No account files found.');
        process.exit(1);
    }
    console.log(`[waf-refresh] Refreshing ${files.length} account(s)...\n`);

    // Process in batches; each batch uses a different port range so no conflicts
    const results = [];
    for (let i = 0; i < files.length; i += CONCURRENCY) {
        const batch = files.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(
            batch.map((f, j) =>
                refreshAccount(f, BASE_PORT + i + j, chromePath)
                    .then(r => ({ file: f, ...r }))
                    .catch(e => ({ file: f, ok: false, error: e.message }))
            )
        );
        for (const s of settled) {
            const r = s.value ?? { file: '?', ok: false, error: String(s.reason) };
            results.push(r);
            const name = path.relative(repoRoot, r.file);
            if (r.ok) console.log(`  ✓  ${name}  →  ${r.wafToken}`);
            else      console.log(`  ✗  ${name}  →  ERROR: ${r.error}`);
        }
    }

    const ok   = results.filter(r => r.ok).length;
    const fail = results.filter(r => !r.ok).length;
    console.log(`\n[waf-refresh] Done: ${ok} refreshed, ${fail} failed.`);

    if (fail > 0) {
        console.log('[waf-refresh] TIP: retry with DEEPSEEK_WAF_CONCURRENCY=1 to see failures one at a time.');
        process.exitCode = 1;
    }

    // Auto-reload accounts in the running server so changes take effect immediately.
    // Tries the default local address; silently skips if server isn't running.
    if (ok > 0) {
        const serverPort = process.env.PORT || process.env.PROXY_PORT || 3000;
        const adminKey   = process.env.PROXY_API_KEY || '';
        const reloadUrl  = `http://127.0.0.1:${serverPort}/admin/accounts/reload`;
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (adminKey) headers['Authorization'] = `Bearer ${adminKey}`;
            const resp = await fetch(reloadUrl, { method: 'POST', headers });
            if (resp.ok) {
                console.log('[waf-refresh] Server accounts reloaded automatically. All done!');
            } else {
                console.log(`[waf-refresh] Server reload returned HTTP ${resp.status} — reload manually in the dashboard.`);
            }
        } catch {
            console.log('[waf-refresh] Server not reachable for auto-reload — restart or use the dashboard to apply.');
        }
    }
}

main().catch(e => { console.error('[waf-refresh] Fatal:', e.message); process.exit(1); });
