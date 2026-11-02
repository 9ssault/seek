#!/usr/bin/env node
/**
 * Capture a claude.ai login for the gateway, the same way the DeepSeek capture works:
 * a browser opens, you sign in, and the script notices, validates, stores and reloads.
 *
 *   npm run claude:auth                       # browser login, stored automatically
 *   npm run claude:auth -- --name work        # name the login in the pool
 *   npm run claude:auth -- --cookie "sessionKey=..."   # non-interactive (CI, a paste)
 *   npm run claude:auth -- --keep             # leave the browser open afterwards
 *
 * The login is a cookie jar, so what is captured is the claude.ai cookies — including
 * the Cloudflare clearance cookies the browser already earned. The organisation uuid
 * is read inside the page, with the page's own credentials, because the same request
 * from Node can trip the edge challenge.
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { locateChrome } = require('./lib/chrome-setup');
const claudeWeb = require('../lib/claude-web');
const accountsDir = require('../lib/accounts-dir');
const capture = require('./lib/auth-capture');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const value = (name, fallback = '') => {
    const index = args.indexOf(name);
    return index === -1 ? fallback : (args[index + 1] || fallback);
};

const PORT = Number(process.env.CLAUDE_CHROME_PORT || 9335);
const PROFILE = process.env.CLAUDE_CHROME_PROFILE || path.join(ROOT, '.chrome-for-testing-profile-claude');
const LOGIN_URL = 'https://claude.ai/login?returnTo=%2Fnew';
const NAME = value('--name', process.env.CLAUDE_ACCOUNT_NAME || 'claude');
const WAIT_MS = Number(process.env.CLAUDE_AUTH_WAIT_MS || 10 * 60 * 1000);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchJson(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${url} -> HTTP ${resp.status}`);
    return resp.json();
}

async function devtoolsReady() {
    try { return await fetchJson(`http://127.0.0.1:${PORT}/json/version`); } catch { return null; }
}

class CDP {
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        this.pending = new Map();
        this.ws.onmessage = (ev) => {
            const message = JSON.parse(ev.data);
            if (!message.id || !this.pending.has(message.id)) return;
            const { resolve, reject, timer } = this.pending.get(message.id);
            this.pending.delete(message.id);
            clearTimeout(timer);
            message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
        };
    }
    ready() {
        return new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
    }
    send(method, params = {}, timeoutMs = 15000) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Chrome DevTools timed out: ${method}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
    }
    close() {
        for (const { reject, timer } of this.pending.values()) {
            clearTimeout(timer);
            reject(new Error('Chrome DevTools connection closed'));
        }
        this.pending.clear();
        try { this.ws.close(); } catch { /* already gone */ }
    }
}

async function waitDevtools(deadline = 60) {
    for (let i = 0; i < deadline * 4; i++) {
        const version = await devtoolsReady();
        if (version) return version;
        await sleep(250);
    }
    throw new Error(`Chrome DevTools did not answer on port ${PORT}`);
}

async function claudePage() {
    for (let i = 0; i < 80; i++) {
        const targets = await fetchJson(`http://127.0.0.1:${PORT}/json`);
        const page = targets.find(t => t.type === 'page' && /claude\.ai/.test(t.url)) || targets.find(t => t.type === 'page');
        if (page?.webSocketDebuggerUrl) return page;
        await sleep(250);
    }
    throw new Error('No claude.ai page appeared in the browser');
}

function launchChrome(executable) {
    fs.mkdirSync(PROFILE, { recursive: true });
    const child = spawn(executable, [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${PROFILE}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
        '--use-mock-keychain',
        LOGIN_URL,
    ], { stdio: 'ignore', detached: false });
    child.on('error', (error) => console.error(`[claude-auth] could not start Chrome: ${error.message}`));
    return child;
}

async function claudeCookies(cdp) {
    const result = await cdp.send('Network.getAllCookies');
    return (result.cookies || []).filter(cookie => /(^|\.)claude\.ai$/.test(cookie.domain));
}

function cookieHeader(cookies) {
    return cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
}

// Read the organisations inside the page: same cookies, same user agent, same
// Cloudflare clearance the browser just earned.
async function orgFromPage(cdp) {
    try {
        const result = await cdp.send('Runtime.evaluate', {
            expression: `(async () => {
                try {
                    const resp = await fetch('/api/organizations', { credentials: 'include', headers: { accept: 'application/json' } });
                    return JSON.stringify({ status: resp.status, body: await resp.text() });
                } catch (error) { return JSON.stringify({ status: 0, body: String(error) }); }
            })()`,
            awaitPromise: true,
            returnByValue: true,
        }, 30000);
        const payload = JSON.parse(result?.result?.value || '{}');
        if (payload.status !== 200) return { org: '', reason: `HTTP ${payload.status}` };
        const list = JSON.parse(payload.body);
        const org = claudeWeb.pickOrganization(Array.isArray(list) ? list : (list?.organizations || []));
        return org ? { org: String(org.uuid || org.id), reason: null } : { org: '', reason: 'no organisation' };
    } catch (error) {
        return { org: '', reason: error.message };
    }
}

async function storeLogin({ cookie, org, source }) {
    const config = claudeWeb.normalizeConfig({ provider: claudeWeb.PROVIDER, cookie, org, model: value('--model', claudeWeb.DEFAULT_MODEL) });
    if (!claudeWeb.hasCredentials(config)) throw new Error('the captured cookies contain no sessionKey — sign in fully, then retry');
    const dir = capture.storeDir(ROOT);
    const file = capture.targetFileFor(dir, {
        base: NAME,
        // A re-capture of the same login repairs that file rather than adding a second
        // session for one account, which is what gets a login flagged.
        matches: (json) => claudeWeb.detectProvider(json) === claudeWeb.PROVIDER && String(json.cookie || '') === config.cookie,
    });
    capture.writeAuthFile(file, { name: NAME, ...config });
    console.log(`\n[claude-auth] stored ${accountsDir.shortPath(file)} (${source})`);
    if (!config.org) {
        console.log('[claude-auth] no organisation uuid yet — the gateway discovers it on the first request.');
    } else {
        console.log(`[claude-auth] organisation ${config.org}`);
    }
    const reload = await capture.notifyGatewayReload();
    if (reload.reloaded) console.log(`[claude-auth] gateway reloaded at ${reload.url} (added: ${(reload.added || []).join(', ') || 'none'})`);
    else console.log('[claude-auth] no running gateway to reload; it picks the login up on its next start.');
    return file;
}

async function main() {
    // Non-interactive: a cookie string is enough, and it is validated before it is stored.
    const inline = value('--cookie', '');
    if (inline) {
        const cookies = inline.includes(';') ? inline : `sessionKey=${inline}`;
        const config = claudeWeb.normalizeConfig({ provider: claudeWeb.PROVIDER, cookie: cookies });
        let org = '';
        try {
            org = await claudeWeb.resolveOrganization(config, { signal: AbortSignal.timeout(20000) });
        } catch (error) {
            console.error(`[claude-auth] claude.ai did not confirm this cookie: ${error.message}`);
            if (has('--force')) console.log('[claude-auth] --force given: storing it anyway.');
            else return 1;
        }
        await storeLogin({ cookie: cookies, org, source: 'cookie argument' });
        return 0;
    }

    const executable = locateChrome({});
    if (!executable) {
        console.error('[claude-auth] no Chrome or Chromium found. Set CHROME_PATH=/path/to/chrome and retry.');
        return 1;
    }
    console.log(`[claude-auth] opening ${executable}`);
    console.log('[claude-auth] sign in to claude.ai in that window; this exits as soon as the session cookie appears.');
    const child = launchChrome(executable);
    let cdp = null;
    try {
        await waitDevtools();
        const page = await claudePage();
        cdp = new CDP(page.webSocketDebuggerUrl);
        await cdp.ready();
        await cdp.send('Network.enable');

        const started = Date.now();
        let lastHint = 0;
        let cookies = [];
        while (Date.now() - started < WAIT_MS) {
            cookies = await claudeCookies(cdp);
            const session = cookies.find(cookie => cookie.name === 'sessionKey' && String(cookie.value || '').length > 20);
            if (session) break;
            if (Date.now() - lastHint > 30000) {
                lastHint = Date.now();
                const left = Math.max(0, Math.round((WAIT_MS - (Date.now() - started)) / 1000));
                console.log(`[claude-auth] waiting for the claude.ai session… ${left}s left`);
            }
            await sleep(1500);
        }
        if (!cookies.some(cookie => cookie.name === 'sessionKey' && String(cookie.value || '').length > 20)) {
            console.error('[claude-auth] timed out before a claude.ai session existed. Nothing was stored.');
            return 1;
        }

        const { org, reason } = await orgFromPage(cdp);
        if (reason) console.log(`[claude-auth] organisation lookup: ${reason}`);
        await storeLogin({ cookie: cookieHeader(cookies), org, source: 'browser login' });
        return 0;
    } finally {
        if (cdp && !has('--keep')) {
            try { await cdp.send('Browser.close', {}, 5000); } catch { /* already closed */ }
        } else if (cdp) {
            console.log(`[claude-auth] browser left open on port ${PORT} (--keep)`);
        }
        cdp?.close();
        if (!has('--keep') && child && child.exitCode === null) {
            await sleep(500);
            try { child.kill(); } catch { /* exited on its own */ }
        }
    }
}

main().then(code => process.exit(code)).catch(error => {
    console.error(`[claude-auth] ${error.message}`);
    process.exit(1);
});
