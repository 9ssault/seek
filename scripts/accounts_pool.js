#!/usr/bin/env node
/**
 * Account pool automation for both upstreams at once.
 *
 * The gateway loads DeepSeek logins (token + cookie) and Claude logins (cookie jar)
 * from one directory. This script is the operator's side of that pool: it reports what
 * is in it, proves which logins still work, provisions new ones from credentials you
 * already have, repairs the ones a refresh can fix, and keeps only live logins in
 * rotation.
 *
 *   node scripts/accounts_pool.js status
 *   node scripts/accounts_pool.js sweep               # probe every login, both providers
 *   node scripts/accounts_pool.js sweep --apply       # ...and move dead ones to .removed
 *   node scripts/accounts_pool.js sweep --json
 *   node scripts/accounts_pool.js refresh             # re-harvest WAF/session cookies
 *   node scripts/accounts_pool.js watch               # sweep + repair + quarantine every 15 minutes
 *   node scripts/accounts_pool.js watch --no-apply    # ...report only, move nothing
 *   node scripts/accounts_pool.js provision accounts.json --apply
 *   node scripts/accounts_pool.js fixtures --count 20 # 20 DeepSeek + 20 Claude test files
 *
 * `provision` takes a JSON array of entries and builds auth files from them:
 *
 *   [
 *     { "name": "ds-01", "provider": "deepseek", "email": "…", "password": "…" },
 *     { "name": "ds-02", "provider": "deepseek", "token": "…", "cookie": "…" },
 *     { "name": "cl-01", "provider": "claude",   "cookie": "sessionKey=…; cf_clearance=…" }
 *   ]
 *
 * A DeepSeek entry with email/password is signed in through the web login endpoint, so
 * the token is minted rather than pasted. The password is used and dropped: it is not
 * written to the auth file unless `--keep-credentials` is passed.
 *
 * Every entry is verified before it is stored, and a stored login that stops working is
 * `refresh`ed first and quarantined only when that fails — so the pool converges on
 * logins that actually serve.
 *
 * Exit codes: 0 everything probed alive, 2 something needs attention, 1 fatal.
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const accountsDir = require('../lib/accounts-dir');
const authCapture = require('./lib/auth-capture');
const authRefresh = require('../lib/auth-refresh');
const claudeWeb = require('../lib/claude-web');

const ROOT = path.resolve(__dirname, '..');
const PROVIDERS = ['deepseek', 'claude'];
const FIXTURE_DIR = path.join(ROOT, 'tests', 'fixtures', 'pool');

function envNumber(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function argValue(argv, name, fallback = null) {
    const i = argv.indexOf(name);
    if (i < 0) return fallback;
    const next = argv[i + 1];
    return next && !next.startsWith('--') ? next : fallback;
}

function storeDir(env = process.env) {
    return accountsDir.resolveAccountsDir({ root: ROOT, env });
}

function displayPath(file) {
    return accountsDir.shortPath(file);
}

// One file may hold one login or many (`{ accounts: [...] }`). A merged entry has no
// file of its own, so it can be probed but not quarantined or rewritten.
function expandFile(file, json) {
    const list = Array.isArray(json) ? json : (Array.isArray(json?.accounts) ? json.accounts : null);
    if (!list) return [{ file, key: path.resolve(file), label: String(json?.name || '').trim() || null, config: json, merged: false }];
    return list
        .filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry))
        .map((entry, index) => ({
            file,
            key: `${path.resolve(file)}#${String(entry.name || entry.id || index)}`,
            label: String(entry.name || entry.id || `account-${index + 1}`).trim(),
            config: entry,
            merged: true,
        }));
}

function providerOf(config = {}) {
    return claudeWeb.detectProvider(config) === claudeWeb.PROVIDER ? 'claude' : 'deepseek';
}

function readPool(dir = storeDir()) {
    const entries = [];
    const problems = [];
    let names = [];
    try {
        names = fs.readdirSync(dir).filter(name => name.endsWith('.json') && !name.startsWith('.'))
            .map(name => path.join(dir, name))
            .sort();
    } catch (error) {
        problems.push({ file: displayPath(dir), message: error.code === 'ENOENT' ? 'no such directory' : 'unreadable' });
        return { dir, entries, problems };
    }
    for (const file of names) {
        let json;
        try {
            json = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (error) {
            problems.push({ file: displayPath(file), message: error instanceof SyntaxError ? 'invalid JSON' : `unreadable (${error.code || 'error'})` });
            continue;
        }
        if (!json || typeof json !== 'object') {
            problems.push({ file: displayPath(file), message: 'not a JSON object' });
            continue;
        }
        for (const entry of expandFile(file, json)) {
            authRefresh.normalizeConfig(entry.config);
            claudeWeb.normalizeConfig(entry.config);
            entries.push({ ...entry, provider: providerOf(entry.config) });
        }
    }
    return { dir, entries: dedupe(entries), problems };
}

// The loader keeps one login once: a standalone file supersedes the copy of the same
// login inside a merged file (only the standalone one can be refreshed or quarantined),
// and an exact duplicate credential is dropped. A status that counted both would report
// a pool twice the size the gateway actually serves from.
function dedupe(entries) {
    const credential = (entry) => entry.provider === 'claude'
        ? `claude:${entry.config?.cookie || ''}`
        : `deepseek:${entry.config?.token || ''}`;
    const loginName = (entry) => String(entry.config?.name || entry.label || '').trim().toLowerCase();
    const standaloneTokens = new Set(entries.filter(e => !e.merged && e.config?.token).map(e => e.config.token));
    const standaloneCookies = new Set(entries.filter(e => !e.merged && e.provider === 'claude' && e.config?.cookie).map(e => e.config.cookie));
    const standaloneNames = new Set(entries.filter(e => !e.merged).map(loginName).filter(Boolean));
    const seen = new Set();
    const kept = [];
    for (const entry of entries) {
        if (entry.merged) {
            const token = entry.config?.token;
            const cookie = entry.config?.cookie;
            const name = loginName(entry);
            if ((token && standaloneTokens.has(token))
                || (cookie && standaloneCookies.has(cookie))
                || (name && standaloneNames.has(name))) continue;
        }
        const id = credential(entry);
        if (id !== 'deepseek:' && id !== 'claude:' && seen.has(id)) continue;
        if (id !== 'deepseek:' && id !== 'claude:') seen.add(id);
        kept.push(entry);
    }
    return kept;
}

function hasCredentials(entry) {
    if (entry.provider === 'claude') return claudeWeb.hasCredentials(entry.config || {});
    return Boolean(entry.config?.token && entry.config?.cookie);
}

// The cheapest call that needs working credentials and costs no generation quota:
// a DeepSeek PoW challenge, or claude.ai's organisation list (the same first call a
// turn makes, so a working probe means a working turn).
async function probeEntry(entry, { timeoutMs = 15000 } = {}) {
    const started = Date.now();
    if (!hasCredentials(entry)) {
        return { ok: false, kind: 'no_credentials', status: 0, latencyMs: 0, org: null, detail: entry.provider === 'claude' ? 'no sessionKey cookie' : 'token or cookie missing' };
    }
    if (entry.provider === 'claude') {
        const probe = await claudeWeb.probeLogin(entry.config, { timeoutMs });
        return { ...probe, latencyMs: probe.latencyMs ?? (Date.now() - started) };
    }
    const probe = await authRefresh.probeAccountToken({ config: entry.config }, { timeoutMs });
    return { ...probe, org: null, detail: probe.detail || '' };
}

async function mapWithConcurrency(items, limit, worker) {
    const results = new Array(items.length);
    let next = 0;
    const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    });
    await Promise.all(runners);
    return results;
}

function pad(value, width) {
    const text = String(value ?? '');
    return text.length >= width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}

function summarize(rows) {
    const byProvider = {};
    for (const provider of PROVIDERS) {
        const own = rows.filter(row => row.entry.provider === provider);
        byProvider[provider] = {
            total: own.length,
            live: own.filter(row => row.result.kind === 'ok').length,
            dead: own.filter(row => row.result.kind === 'auth').length,
            throttled: own.filter(row => row.result.kind === 'ratelimit').length,
            other: own.filter(row => !['ok', 'auth', 'ratelimit'].includes(row.result.kind)).length,
        };
    }
    return {
        total: rows.length,
        live: rows.filter(row => row.result.kind === 'ok').length,
        needsAttention: rows.filter(row => row.result.kind !== 'ok').length,
        byProvider,
    };
}

function rowName(entry) {
    return entry.label || path.basename(entry.file, '.json');
}

// ─── status ────────────────────────────────────────────────────────────────

function commandStatus({ json = false } = {}) {
    const pool = readPool();
    const rows = pool.entries.map(entry => ({
        name: rowName(entry),
        provider: entry.provider,
        file: displayPath(entry.file),
        merged: entry.merged,
        credentials: hasCredentials(entry),
        enabled: entry.config?.enabled !== false,
    }));
    const summary = {};
    for (const provider of PROVIDERS) {
        const own = rows.filter(row => row.provider === provider);
        summary[provider] = {
            total: own.length,
            credentialed: own.filter(row => row.credentials).length,
            enabled: own.filter(row => row.enabled).length,
        };
    }
    if (json) {
        console.log(JSON.stringify({ dir: pool.dir, summary, rows, problems: pool.problems }, null, 2));
        return 0;
    }
    console.log(`[pool] ${displayPath(pool.dir)}`);
    console.log(`${pad('login', 26)}  ${pad('provider', 9)}  ${pad('state', 14)}  file`);
    for (const row of rows) {
        const state = !row.credentials ? 'no_credentials' : row.enabled ? 'ready' : 'disabled';
        console.log(`${pad(row.name, 26)}  ${pad(row.provider, 9)}  ${pad(state, 14)}  ${row.file}${row.merged ? ' (merged)' : ''}`);
    }
    for (const problem of pool.problems) console.log(`  ✗ ${problem.file}: ${problem.message}`);
    const parts = PROVIDERS.map(provider => `${summary[provider].total} ${provider}`);
    console.log(`\n[pool] ${rows.length} login(s) — ${parts.join(', ')}`);
    if (!rows.length) console.log('[pool] Empty. Add logins with `npm run auth`, `npm run claude:auth`, or `node scripts/accounts_pool.js provision <file>.json`.');
    return rows.length ? 0 : 2;
}

// ─── sweep ─────────────────────────────────────────────────────────────────

function quarantinePlan(rows, dir) {
    const inside = (file) => {
        const rel = path.relative(path.resolve(dir), path.resolve(file));
        return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    return rows
        .filter(row => row.result.kind === 'auth' && !row.entry.merged && inside(row.entry.file))
        .map(row => ({
            from: path.resolve(row.entry.file),
            to: path.join(path.resolve(dir), '.removed', path.basename(row.entry.file)),
            reason: row.result.detail || row.result.status ? `rejected (${row.result.status || row.result.detail})` : 'rejected',
        }));
}

function applyQuarantine(plan) {
    return plan.map(item => {
        try {
            fs.mkdirSync(path.dirname(item.to), { recursive: true });
            let to = item.to;
            if (fs.existsSync(to)) to = to.replace(/\.json$/, `-${Date.now()}.json`);
            fs.renameSync(item.from, to);
            return { ...item, to, ok: true };
        } catch (error) {
            return { ...item, ok: false, error: error.message };
        }
    });
}

async function commandSweep(argv) {
    const json = argv.includes('--json');
    const apply = argv.includes('--apply');
    const repair = argv.includes('--repair');
    const includeFixtures = argv.includes('--include-fixtures');
    const concurrency = Math.max(1, Number(argValue(argv, '--concurrency', envNumber('POOL_CONCURRENCY', 3))) || 3);
    const timeoutMs = Math.max(1000, Number(argValue(argv, '--timeout', envNumber('POOL_TIMEOUT_MS', 15000))) || 15000);
    const dir = storeDir();
    const pool = readPool(dir);
    let entries = pool.entries;
    if (!includeFixtures) entries = entries.filter(entry => entry.config?._fixture !== true);

    if (!entries.length) {
        console.error(`[pool] No logins to probe in ${displayPath(dir)}.`);
        return 2;
    }

    const probeAll = () => mapWithConcurrency(entries, concurrency, async entry => ({
        entry,
        result: await probeEntry(entry, { timeoutMs }),
    }));

    let rows = await probeAll();

    // A stale edge cookie answers like a dead login. One repair attempt per login,
    // only for DeepSeek (Claude cookies come from the browser, not from a token endpoint).
    const repairable = rows.filter(row => row.result.kind === 'auth'
        && row.entry.provider === 'deepseek' && !row.entry.merged);
    if (repair && repairable.length) {
        if (!json) console.log(`[pool] Repairing ${repairable.length} rejected DeepSeek login(s)…`);
        for (const row of repairable) {
            const outcome = await authRefresh.refreshAccount({
                file: row.entry.file,
                config: row.entry.config,
                merged: false,
            }, { force: true });
            if (!json) console.log(`[pool] ${rowName(row.entry)} → ${outcome.ok ? 'repaired' : `not repairable (${outcome.reason})`}`);
        }
        rows = await probeAll();
    }

    const summary = summarize(rows);
    let quarantine = null;
    if (apply) {
        const plan = quarantinePlan(rows, dir);
        const applied = applyQuarantine(plan);
        quarantine = {
            candidates: plan.map(item => ({ file: displayPath(item.from), reason: item.reason })),
            applied: applied.map(item => ({ file: displayPath(item.from), to: displayPath(item.to), ok: item.ok, error: item.error || null })),
        };
    }

    if (json) {
        console.log(JSON.stringify({
            dir: displayPath(dir),
            summary,
            quarantine,
            rows: rows.map(row => ({
                name: rowName(row.entry),
                provider: row.entry.provider,
                file: displayPath(row.entry.file),
                merged: row.entry.merged,
                kind: row.result.kind,
                status: row.result.status || 0,
                latency_ms: row.result.latencyMs ?? null,
                org: row.result.org || null,
                detail: row.result.detail || '',
            })),
            problems: pool.problems,
        }, null, 2));
        return summary.needsAttention ? 2 : 0;
    }

    const width = Math.max(20, ...rows.map(row => rowName(row.entry).length));
    console.log(`${pad('login', width)}  ${pad('provider', 9)}  ${pad('state', 12)}  ${pad('ms', 6)}  note`);
    for (const row of rows) {
        const note = row.result.kind === 'ratelimit' && row.result.retryAfterSec != null
            ? `retry after ${row.result.retryAfterSec}s`
            : (row.result.detail || '');
        console.log(`${pad(rowName(row.entry), width)}  ${pad(row.entry.provider, 9)}  ${pad(row.result.kind, 12)}  ${pad(row.result.latencyMs ?? '-', 6)}  ${note}`);
    }
    for (const problem of pool.problems) console.log(`  ✗ ${problem.file}: ${problem.message}`);
    const parts = PROVIDERS
        .filter(provider => summary.byProvider[provider].total)
        .map(provider => `${summary.byProvider[provider].live}/${summary.byProvider[provider].total} ${provider}`);
    console.log(`\n[pool] ${summary.live}/${summary.total} live${parts.length ? ` (${parts.join(', ')})` : ''}`);

    if (quarantine) {
        const moved = quarantine.applied.filter(item => item.ok);
        console.log(`[pool] Moved ${moved.length} dead login(s) out of rotation (nothing deleted).`);
        for (const item of moved) console.log(`  · ${item.file} → ${item.to}`);
        for (const item of quarantine.applied.filter(entry => !entry.ok)) console.log(`  ✗ ${item.file}: ${item.error}`);
    } else if (summary.byProvider.deepseek.dead || summary.byProvider.claude.dead) {
        console.log('[pool] Dead logins stay in the pool until you run this with --apply (or --repair first for DeepSeek).');
    }
    if (summary.byProvider.claude.throttled) {
        console.log('[pool] Throttled Claude logins are parked by the gateway until their window resets.');
    }
    return summary.needsAttention ? 2 : 0;
}

// ─── provision ─────────────────────────────────────────────────────────────

function readProvisionInput(file) {
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        throw new Error(`${file}: ${error instanceof SyntaxError ? 'invalid JSON' : `unreadable (${error.code || 'error'})`}`);
    }
    const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.accounts) ? raw.accounts : [raw]);
    return list.filter(entry => entry && typeof entry === 'object' && !Array.isArray(entry));
}

// Turn one input entry into a stored, verified auth file. Returns a row with the
// outcome; a rejected login is never written, so the pool cannot fill with dead files.
async function provisionOne(input, { dir, existing, keepCredentials, timeoutMs }) {
    const name = String(input.name || input.id || '').trim();
    if (!name) return { name: '(unnamed)', provider: null, kind: 'invalid', detail: 'name is required' };
    const declared = String(input.provider || input.api || '').toLowerCase();
    const provider = declared === 'claude' || declared === 'anthropic'
        ? 'claude'
        : (declared === 'deepseek' ? 'deepseek' : (input.token ? 'deepseek' : (claudeWeb.hasCredentials(input) ? 'claude' : 'deepseek')));
    const slug = authCapture.slug(name);
    if (!slug) return { name, provider, kind: 'invalid', detail: 'name has no usable characters' };

    if (provider === 'claude') {
        const config = claudeWeb.normalizeConfig({ provider: 'claude', ...input, name });
        if (!claudeWeb.hasCredentials(config)) {
            return { name, provider, kind: 'invalid', detail: 'a Claude login needs the claude.ai cookie (sessionKey=…)' };
        }
        if (existing.has(`claude:${config.cookie}`)) return { name, provider, kind: 'duplicate', detail: 'this cookie is already in the pool' };
        const probe = await claudeWeb.probeLogin(config, { timeoutMs });
        if (!probe.ok) return { name, provider, kind: probe.kind, status: probe.status, detail: probe.detail };
        config.org = probe.org;
        const file = path.join(dir, `${slug}.json`);
        authCapture.writeAuthFile(file, { name, ...config, enabled: true });
        existing.set(`claude:${config.cookie}`, file);
        return { name, provider, kind: 'ok', file, status: probe.status, org: probe.org };
    }

    let config = { ...input };
    delete config.provider;
    delete config.api;
    authRefresh.normalizeConfig(config);
    if (!config.token && (input.email || input.mobile) && (input.password || input._password)) {
        const login = await authRefresh.loginWithCredentials({ config: { ...config, password: input.password || input._password } });
        if (!login.ok) return { name, provider, kind: 'login_failed', detail: login.reason };
        config.token = login.token;
        if (login.cookie) config.cookie = config.cookie || login.cookie;
    }
    if (!config.token || !config.cookie) {
        return { name, provider, kind: 'invalid', detail: 'a DeepSeek login needs token and cookie, or email + password' };
    }
    if (existing.has(`deepseek:${config.token}`)) return { name, provider, kind: 'duplicate', detail: 'this token is already in the pool' };
    const probe = await authRefresh.probeAccountToken({ config }, { timeoutMs });
    if (probe.kind === 'auth') {
        return { name, provider, kind: 'auth', status: probe.status, detail: 'DeepSeek rejected these credentials' };
    }
    const stored = { name, token: config.token, cookie: config.cookie };
    for (const key of ['hif_dliq', 'hif_leim', 'device_id']) if (config[key]) stored[key] = config[key];
    if (keepCredentials) {
        if (input.email) stored.email = input.email;
        if (input.mobile) stored.mobile = input.mobile;
        if (input.password) stored.password = input.password;
    }
    const file = path.join(dir, `${slug}.json`);
    authCapture.writeAuthFile(file, stored);
    existing.set(`deepseek:${config.token}`, file);
    return { name, provider, kind: probe.kind === 'ok' ? 'ok' : `unverified:${probe.kind}`, file, status: probe.status };
}

async function commandProvision(argv) {
    const input = argValue(argv, '--from') || argv.find(arg => !arg.startsWith('--'));
    if (!input) {
        console.error('usage: accounts_pool.js provision <entries.json> [--apply] [--keep-credentials] [--concurrency 2]');
        return 1;
    }
    const apply = argv.includes('--apply');
    const keepCredentials = argv.includes('--keep-credentials');
    const concurrency = Math.max(1, Number(argValue(argv, '--concurrency', 2)) || 2);
    const timeoutMs = Math.max(1000, Number(argValue(argv, '--timeout', envNumber('POOL_TIMEOUT_MS', 15000))) || 15000);
    const dir = storeDir();
    const pool = readPool(dir);
    const existing = new Map();
    for (const entry of pool.entries) {
        if (entry.provider === 'claude') existing.set(`claude:${entry.config?.cookie || ''}`, entry.file);
        else existing.set(`deepseek:${entry.config?.token || ''}`, entry.file);
    }

    let entries;
    try {
        entries = readProvisionInput(input);
    } catch (error) {
        console.error(`[pool] ${error.message}`);
        return 1;
    }
    if (!entries.length) {
        console.error('[pool] The input file holds no entries.');
        return 1;
    }

    if (!apply) {
        console.log(`[pool] Dry run over ${entries.length} entry/entries from ${displayPath(path.resolve(input))}.`);
        console.log(`[pool] Nothing is written and no password is used until you add --apply.`);
        for (const entry of entries) {
            const provider = String(entry.provider || '').toLowerCase() === 'claude' ? 'claude' : 'deepseek';
            console.log(`  · ${pad(entry.name || '(unnamed)', 24)} ${pad(provider, 9)} ${entry.token ? 'token+cookie' : entry.cookie ? 'cookie' : entry.email ? 'email+password' : 'no credentials'}`);
        }
        console.log(`[pool] ${displayPath(dir)} would receive up to ${entries.length} file(s).`);
        return 0;
    }

    const rows = await mapWithConcurrency(entries, concurrency, entry => provisionOne(entry, {
        dir, existing, keepCredentials, timeoutMs,
    }));

    const live = rows.filter(row => row.kind === 'ok');
    const stored = rows.filter(row => row.kind.startsWith('unverified:'));
    const failed = rows.filter(row => !row.kind.startsWith('ok') && !row.kind.startsWith('unverified:'));
    const width = Math.max(12, ...rows.map(row => row.name.length));
    console.log(`${pad('login', width)}  ${pad('provider', 9)}  ${pad('result', 18)}  note`);
    for (const row of rows) {
        const where = row.file ? displayPath(row.file) : (row.detail || '');
        console.log(`${pad(row.name, width)}  ${pad(row.provider || '-', 9)}  ${pad(row.kind, 18)}  ${where}`);
    }
    console.log(`\n[pool] ${live.length} verified live, ${stored.length} stored but unverified, ${failed.length} rejected.`);
    if (stored.length) console.log('[pool] Unverified logins are kept because the probe could not answer (network or throttle); `sweep` will settle them.');
    if (failed.length) console.log('[pool] Rejected logins were not written. Fix the credentials in the input file and run again.');
    const counts = PROVIDERS
        .map(provider => `${live.filter(row => row.provider === provider).length} ${provider}`)
        .join(', ');
    const reload = await authCapture.notifyGatewayReload();
    if (reload.reloaded) {
        console.log(`[pool] Now in rotation: ${counts}. The gateway at ${reload.url} reloaded (added: ${(reload.added || []).join(', ') || 'none'}).`);
    } else {
        console.log(`[pool] Now in rotation: ${counts}. No gateway reloaded; it picks the logins up on its next start, or POST /admin/accounts/reload.`);
    }
    return failed.length ? 2 : 0;
}

// ─── refresh ───────────────────────────────────────────────────────────────

async function commandRefresh(argv) {
    const dir = storeDir();
    const pool = readPool(dir);
    const targets = pool.entries.filter(entry => entry.provider === 'deepseek' && !entry.merged && entry.file);
    if (!targets.length) {
        console.log('[pool] No standalone DeepSeek login files to repair. Claude cookies come from the browser: re-run npm run claude:auth, then re-import with provision.');
        return 0;
    }
    const rows = [];
    for (const entry of targets) {
        const outcome = await authRefresh.refreshAccount({ file: entry.file, config: entry.config, merged: false }, { force: true });
        rows.push({ name: rowName(entry), ok: outcome.ok, reason: outcome.reason || outcome.probe?.kind || '' });
        console.log(`[pool] ${pad(rowName(entry), 26)} ${outcome.ok ? 'repaired' : `failed (${outcome.reason})`}`);
    }
    const ok = rows.filter(row => row.ok).length;
    console.log(`\n[pool] ${ok}/${rows.length} repaired.`);
    return ok === rows.length ? 0 : 2;
}

// ─── watch ─────────────────────────────────────────────────────────────────

// Keep the pool converged without a human: one sweep per interval, with the DeepSeek
// repair attempt, so a login whose session died comes back instead of sitting there,
// and the ones that cannot be repaired leave the rotation. A background pass quarantines
// by default because that is the point of running it unattended; `--no-apply` makes it
// report-only. Long-running by design; Ctrl-C stops it.
async function commandWatch(argv) {
    const intervalMs = Math.max(60_000, Number(argValue(argv, '--interval', 15 * 60 * 1000)) || 15 * 60 * 1000);
    const once = argv.includes('--once');
    // Everything except watch's own flags is passed to the sweep, so `watch --json`
    // and `watch --include-fixtures` mean what they would mean on a single pass.
    const flags = [];
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--once' || argv[i] === '--no-apply') continue;
        if (argv[i] === '--interval') { i += 1; continue; }
        flags.push(argv[i]);
    }
    if (!flags.includes('--apply')) flags.push('--apply');
    for (;;) {
        const code = await commandSweep([...flags, '--repair']);
        if (once) return code;
        console.log(`[pool] next pass in ${Math.round(intervalMs / 60000)} minute(s).`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
}

// ─── fixtures ──────────────────────────────────────────────────────────────

// Deterministic test logins: one per index, stable bytes, no network, never a real
// credential. They exercise pool loading, rotation, cooldowns, provider routing and the
// dashboard without touching an upstream account.
function fixtureEntries(count) {
    const entries = [];
    for (const provider of PROVIDERS) {
        for (let i = 1; i <= count; i += 1) {
            const tag = `${provider}-${String(i).padStart(2, '0')}`;
            if (provider === 'claude') {
                const digest = crypto.createHash('sha256').update(`fixture:${tag}`).digest('hex');
                entries.push({
                    name: `fixture-${tag}`,
                    provider,
                    config: {
                        name: `fixture-${tag}`,
                        provider: 'claude',
                        cookie: `sessionKey=sk-ant-fixture-${digest.slice(0, 40)}; cf_clearance=fixture-${digest.slice(40, 72)}`,
                        org: `00000000-0000-4000-8000-${digest.slice(0, 12)}`,
                        model: claudeWeb.DEFAULT_MODEL,
                        _fixture: true,
                    },
                });
            } else {
                const digest = crypto.createHash('sha256').update(`fixture:${tag}`).digest('hex');
                entries.push({
                    name: `fixture-${tag}`,
                    provider,
                    config: {
                        name: `fixture-${tag}`,
                        token: digest,
                        cookie: `smidV2=fixture-${digest.slice(0, 16)}; intercom-device-id=fixture-${digest.slice(16, 32)}`,
                        _fixture: true,
                    },
                });
            }
        }
    }
    return entries;
}

function commandFixtures(argv) {
    const count = Math.max(1, Number(argValue(argv, '--count', 20)) || 20);
    const outDir = path.resolve(argValue(argv, '--dir', FIXTURE_DIR));
    const force = argv.includes('--force');
    fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
    const written = [];
    for (const entry of fixtureEntries(count)) {
        const file = path.join(outDir, `${entry.name}.json`);
        if (fs.existsSync(file) && !force) continue;
        authCapture.writeAuthFile(file, entry.config);
        written.push(displayPath(file));
    }
    const total = count * PROVIDERS.length;
    console.log(`[pool] ${written.length} fixture login(s) written to ${displayPath(outDir)} (${count} deepseek + ${count} claude = ${total} total).`);
    if (!written.length) console.log('[pool] Nothing overwritten; pass --force to regenerate.');
    console.log('[pool] Load them with: DEEPSEEK_AUTH_DIR=' + displayPath(outDir) + ' npm start');
    console.log('[pool] They are marked "_fixture": true, hold no real credentials, and are skipped by `sweep` unless --include-fixtures.');
    return 0;
}

// ─── main ──────────────────────────────────────────────────────────────────

const COMMANDS = {
    status: (argv) => commandStatus({ json: argv.includes('--json') }),
    sweep: commandSweep,
    provision: commandProvision,
    refresh: commandRefresh,
    watch: commandWatch,
    fixtures: commandFixtures,
};

async function main(argv = process.argv.slice(2)) {
    const [command = 'status', ...rest] = argv;
    if (command === '--help' || command === '-h' || command === 'help') {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].replace(/^\s*\* ?/gm, '').trim());
        return 0;
    }
    const run = COMMANDS[command];
    if (!run) {
        console.error(`[pool] Unknown command "${command}". One of: ${Object.keys(COMMANDS).join(', ')}.`);
        return 1;
    }
    return run(rest);
}

if (require.main === module) {
    main()
        .then(code => { process.exitCode = code; })
        .catch(error => { console.error('[pool] ERROR:', error.message); process.exit(1); });
}

module.exports = {
    PROVIDERS,
    FIXTURE_DIR,
    storeDir,
    readPool,
    dedupe,
    expandFile,
    providerOf,
    hasCredentials,
    probeEntry,
    summarize,
    quarantinePlan,
    applyQuarantine,
    fixtureEntries,
    main,
};
