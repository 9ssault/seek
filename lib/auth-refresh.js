'use strict';
/**
 * auth-refresh - keep a login usable without a human in the loop.
 *
 * Three jobs, all of them offline-first:
 *   cleanToken        one token, never two "Bearer " prefixes, never a JSON blob
 *   probeAccountToken one live PoW challenge, with the real status and latency
 *   refreshAccount    credential login when a password is stored, otherwise the
 *                     WAF/session refresh script, then the file is rewritten
 *
 * Nothing here logs a token or a cookie. A refresh that cannot be done returns
 * { ok: false, reason } so the caller can rotate to another login immediately.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const authHealth = require('./auth-health');

const REFRESH_TIMEOUT_MS = Number(process.env.DEEPSEEK_REFRESH_TIMEOUT_MS || 90000);
const LOGIN_URL = `${authHealth.BASE_URL}/api/v0/users/login`;
const inflight = new Map();

function cleanToken(raw) {
    let value = raw;
    if (value && typeof value === 'object') {
        value = value.value ?? value.token ?? value.access_token ?? value.userToken ?? '';
    }
    if (typeof value !== 'string') return '';
    let text = value.trim();
    if (!text) return '';
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('"') && text.endsWith('"'))) {
        try {
            const parsed = JSON.parse(text);
            return cleanToken(parsed);
        } catch (_) { /* a token that merely starts with a brace */ }
    }
    // Some importers prepend Bearer twice; DeepSeek wants the bare token in the
    // header builder, which adds exactly one prefix.
    while (/^Bearer\s+/i.test(text)) text = text.replace(/^Bearer\s+/i, '').trim();
    return text.replace(/[\r\n\t]/g, '');
}

function normalizeConfig(config) {
    if (!config || typeof config !== 'object') return config;
    if ('token' in config) config.token = cleanToken(config.token);
    if (Array.isArray(config.accounts)) config.accounts.forEach(normalizeConfig);
    return config;
}

function accountAuth(account) {
    const config = account?.config || {};
    return {
        token: cleanToken(config.token),
        cookie: config.cookie || '',
        hif_dliq: config.hif_dliq || '',
        hif_leim: config.hif_leim || '',
    };
}

async function probeAccountToken(account, options = {}) {
    const auth = accountAuth(account);
    if (!auth.token) return { ok: false, kind: 'no_credentials', status: 0, latencyMs: 0, code: null };
    const verdict = await authHealth.probeAccount(auth, options);
    const ok = verdict.kind === 'ok';
    return {
        ok,
        kind: verdict.kind,
        status: verdict.status,
        code: verdict.code ?? null,
        latencyMs: verdict.latencyMs,
        retryAfterSec: verdict.retryAfterSec ?? null,
    };
}

function writeAccountFile(file, config) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, file);
}

function readAccountFile(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return null;
    }
}

async function loginWithCredentials(account, fetchImpl = globalThis.fetch) {
    const config = account.config || {};
    const email = config.email || config.mobile || config.phone || '';
    const password = config.password || config._password || '';
    if (!email || !password) return { ok: false, reason: 'no_credentials' };
    try {
        const res = await fetchImpl(LOGIN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': authHealth.DEFAULT_UA },
            body: JSON.stringify({
                email,
                password,
                device_id: config.device_id || '',
                os: 'web',
            }),
            signal: AbortSignal.timeout(20000),
        });
        const json = await res.json().catch(() => null);
        const data = json?.data?.biz_data || {};
        const token = cleanToken(data.user?.token || data.token || '');
        if (!res.ok || !token) {
            return { ok: false, reason: `login ${res.status}`, code: json?.data?.biz_code ?? null };
        }
        const cookie = data.user?.cookie || config.cookie || '';
        return { ok: true, token, cookie };
    } catch (err) {
        return { ok: false, reason: err?.name === 'TimeoutError' ? 'timed out' : (err?.message || 'network error') };
    }
}

function browserRefresh(account) {
    if (!account?.file || account.merged) return Promise.resolve({ ok: false, reason: 'merged_or_missing_file' });
    const script = path.join(__dirname, '..', 'scripts', 'refresh_waf_tokens.js');
    if (!fs.existsSync(script)) return Promise.resolve({ ok: false, reason: 'no_refresh_script' });
    return new Promise((resolve) => {
        let settled = false;
        const done = (result) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
        const child = spawn(process.execPath, [script, account.file], {
            cwd: path.join(__dirname, '..'),
            env: { ...process.env, DEEPSEEK_WAF_HEADLESS: process.env.DEEPSEEK_WAF_HEADLESS || '1' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let tail = '';
        child.stdout.on('data', (chunk) => { tail = (tail + chunk).slice(-2000); });
        child.stderr.on('data', (chunk) => { tail = (tail + chunk).slice(-2000); });
        const timer = setTimeout(() => {
            try { child.kill('SIGTERM'); } catch (_) { /* already gone */ }
            done({ ok: false, reason: 'timeout' });
        }, REFRESH_TIMEOUT_MS);
        timer.unref?.();
        child.on('error', (err) => done({ ok: false, reason: err.message }));
        child.on('exit', (code) => done({ ok: code === 0, reason: code === 0 ? '' : `exit ${code}`, tail }));
    });
}

/**
 * Refresh one login. Order: stored credentials first (fast, no browser), then
 * the WAF script (slow, but it is what fixes a 401 caused by an expired edge
 * token). The file is re-read only after the writer exited cleanly.
 */
async function refreshAccount(account, options = {}) {
    if (!account) return { ok: false, reason: 'no_account' };
    const key = account.file || account.id;
    if (inflight.has(key)) return inflight.get(key);
    const task = (async () => {
        const current = await probeAccountToken(account, options);
        if (current.ok) return { ok: true, reason: 'already_valid', probe: current };

        const login = await loginWithCredentials(account, options.fetchImpl || globalThis.fetch);
        if (login.ok) {
            const config = { ...(account.config || {}) };
            config.token = login.token;
            if (login.cookie) config.cookie = login.cookie;
            if (account.file) {
                const stored = readAccountFile(account.file) || config;
                stored.token = config.token;
                if (login.cookie) stored.cookie = config.cookie;
                writeAccountFile(account.file, stored);
            }
            account.config = config;
            account.headers = authHealth.buildHeaders(accountAuth(account));
            const after = await probeAccountToken(account, options);
            return { ok: after.ok, reason: after.ok ? 'credential_login' : `credential_login_unverified:${after.kind}`, probe: after };
        }

        if (account.merged || !account.file) {
            return { ok: false, reason: login.reason === 'no_credentials' ? 'merged_no_refresh' : login.reason };
        }
        const browser = await browserRefresh(account);
        if (!browser.ok) return { ok: false, reason: browser.reason || login.reason || 'refresh_failed' };
        const stored = readAccountFile(account.file);
        if (!stored) return { ok: false, reason: 'auth_file_unreadable' };
        normalizeConfig(stored);
        account.config = { ...(account.config || {}), ...stored };
        account.headers = authHealth.buildHeaders(accountAuth(account));
        const after = await probeAccountToken(account, options);
        return { ok: after.ok, reason: after.ok ? 'waf_session' : `waf_refresh_unverified:${after.kind}`, probe: after };
    })();
    inflight.set(key, task);
    try {
        return await task;
    } finally {
        inflight.delete(key);
    }
}

module.exports = {
    cleanToken,
    normalizeConfig,
    probeAccountToken,
    loginWithCredentials,
    refreshAccount,
    writeAccountFile,
};
