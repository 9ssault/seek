#!/usr/bin/env node
/**
 * Rate-limit and token health checker for every DeepSeek login on this machine.
 *
 * For each auth file it asks DeepSeek for a PoW challenge — the cheapest request that
 * needs working credentials and answers with the same auth / throttle / WAF signals —
 * and reports one state per login instead of a bare pass/fail:
 *
 *   ok         credentials work; a challenge came back
 *   ratelimit  the login is throttled (HTTP 429 or DeepSeek's throttle text)
 *   waf        the edge served a WAF challenge page: its aws-waf-token expired
 *   auth       the login itself is dead or expired (biz_code 40001-40003)
 *   upstream   DeepSeek answered 5xx
 *   network    the request never completed
 *
 * Usage:
 *   node scripts/ratelimit_check.js                 # check every login
 *   node scripts/ratelimit_check.js --json          # machine-readable report
 *   node scripts/ratelimit_check.js --refresh       # re-harvest WAF tokens, then re-check
 *   node scripts/ratelimit_check.js --whoami        # also resolve the signed-in identity
 *   node scripts/ratelimit_check.js --concurrency 1 # one probe at a time
 *   node scripts/ratelimit_check.js --quarantine    # list logins whose token is dead
 *   node scripts/ratelimit_check.js --quarantine --apply  # move them to accounts/.removed
 *
 * A dead token (biz_code 40001-40003) can never recover on its own: DeepSeek does not
 * re-issue it, and a WAF refresh does not touch it. Quarantine moves those files out
 * of the pool — into accounts/.removed, never deleted — so the proxy stops spending
 * requests on them. Re-capture the login with the browser extension to bring it back.
 *
 * Exit codes: 0 every login is ready, 2 something needs attention, 1 fatal error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { probeAccount, fetchIdentity } = require('../lib/auth-health');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_AUTH = process.env.DEEPSEEK_AUTH_PATH || path.join(ROOT, 'deepseek-auth.json');
const DEFAULT_ACCOUNTS_DIR = process.env.DEEPSEEK_AUTH_DIR || path.join(ROOT, 'accounts');

function cliValue(args, name, fallback = null) {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    const next = args[i + 1];
    return next && !next.startsWith('--') ? next : fallback;
}

function envNumber(name, fallback) {
    const raw = Number(process.env[name]);
    return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// Same discovery order as the proxy: DEEPSEEK_AUTH_DIR, then a comma list, then the
// default file plus ./accounts/*.json.
function authFiles(env = process.env, { root = ROOT } = {}) {
    if (env.DEEPSEEK_AUTH_DIR) {
        try {
            return fs.readdirSync(env.DEEPSEEK_AUTH_DIR)
                .filter((f) => f.endsWith('.json'))
                .sort()
                .map((f) => path.join(env.DEEPSEEK_AUTH_DIR, f));
        } catch (err) {
            return [];
        }
    }
    if (env.DEEPSEEK_AUTH_PATH && env.DEEPSEEK_AUTH_PATH.includes(',')) {
        return env.DEEPSEEK_AUTH_PATH.split(',').map((s) => s.trim()).filter(Boolean);
    }
    const files = [];
    const single = env.DEEPSEEK_AUTH_PATH || path.join(root, 'deepseek-auth.json');
    if (fs.existsSync(single)) files.push(path.resolve(single));
    const dir = env.DEEPSEEK_AUTH_DIR || path.join(root, 'accounts');
    try {
        for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
            files.push(path.resolve(dir, name));
        }
    } catch (err) {
        /* no accounts dir is normal */
    }
    return [...new Set(files)];
}

function readAuth(file) {
    try {
        const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return { auth: null, problem: 'not a JSON object' };
        return { auth, problem: null };
    } catch (err) {
        return { auth: null, problem: err instanceof SyntaxError ? 'invalid JSON' : `unreadable (${err.code || 'error'})` };
    }
}

function label(file) {
    const rel = path.relative(ROOT, file);
    return rel && !rel.startsWith('..') ? rel : file;
}

function summarize(results) {
    const counts = {};
    for (const r of results) counts[r.kind] = (counts[r.kind] || 0) + 1;
    return {
        total: results.length,
        counts,
        ready: results.filter((r) => r.kind === 'ok').length,
        needsAttention: results.filter((r) => r.kind !== 'ok').length,
        refreshable: results.filter((r) => r.kind === 'waf').map((r) => r.file),
    };
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

function runRefresh(file) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'refresh_waf_tokens.js'), file], {
            cwd: ROOT,
            stdio: 'ignore',
            windowsHide: true,
            env: { ...process.env, DEEPSEEK_WAF_CONCURRENCY: '1' },
        });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
    });
}

function pad(value, width) {
    const text = String(value ?? '');
    return text.length >= width ? `${text.slice(0, Math.max(0, width - 1))}…` : text.padEnd(width);
}

function noteFor(result) {
    if (result.kind === 'ratelimit' && result.retryAfterSec != null) return `retry after ${result.retryAfterSec}s`;
    if (result.identity) return result.identity.loggedIn
        ? `signed in as ${result.identity.email || result.identity.mobile || result.identity.id}`
        : `anonymous session (${result.identity.reason || 'no user'})`;
    return result.note || '';
}

// Dead logins (biz_code 40001-40003) stay in accounts/ and cost the proxy a failed
// request per attempt, forever: DeepSeek never re-issues that token and a WAF
// refresh cannot mint one. Quarantine moves the file aside; nothing is deleted.
function quarantinePlan(results, { accountsDir = DEFAULT_ACCOUNTS_DIR } = {}) {
    const dir = path.resolve(accountsDir);
    const inside = (file) => {
        const rel = path.relative(dir, path.resolve(file));
        return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    return results
        .filter((r) => r.kind === 'auth' && inside(r.file))
        .map((r) => ({
            from: path.resolve(r.file),
            to: path.join(dir, '.removed', path.basename(r.file)),
            reason: r.note || 'credentials rejected',
        }));
}

function applyQuarantine(plan) {
    return plan.map((item) => {
        try {
            fs.mkdirSync(path.dirname(item.to), { recursive: true });
            // Never overwrite an earlier quarantined copy of the same login.
            let to = item.to;
            if (fs.existsSync(to)) to = to.replace(/\.json$/, `-${Date.now()}.json`);
            fs.renameSync(item.from, to);
            return { ...item, to, ok: true };
        } catch (err) {
            return { ...item, ok: false, error: err.message };
        }
    });
}

async function checkOne(file, { timeoutMs, whoami }) {
    const { auth, problem } = readAuth(file);
    if (!auth) return { file, kind: 'auth', status: 0, latencyMs: 0, note: problem, detail: '' };
    if (!auth.token || !auth.cookie) {
        return { file, kind: 'auth', status: 0, latencyMs: 0, note: 'token or cookie missing', detail: '' };
    }
    const probe = await probeAccount(auth, { timeoutMs });
    const result = { file, ...probe };
    if (whoami) result.identity = await fetchIdentity(auth, { timeoutMs });
    return result;
}

async function main(argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*///')[0].split('/**')[1].replace(/^\s*\* ?/gm, '').trim());
        return 0;
    }
    const asJson = argv.includes('--json');
    const whoami = argv.includes('--whoami');
    const refresh = argv.includes('--refresh');
    const concurrency = Math.max(1, Number(cliValue(argv, '--concurrency', envNumber('RATELIMIT_CONCURRENCY', 2))) || 2);
    const timeoutMs = Math.max(1000, Number(cliValue(argv, '--timeout', envNumber('RATELIMIT_TIMEOUT_MS', 15000))) || 15000);

    const files = authFiles();
    if (!files.length) {
        console.error(`[ratelimit] No auth files found (looked in ${DEFAULT_AUTH} and ${DEFAULT_ACCOUNTS_DIR}).`);
        return 2;
    }

    let results = await mapWithConcurrency(files, concurrency, (file) => checkOne(file, { timeoutMs, whoami }));

    if (refresh) {
        const stale = results.filter((r) => r.kind === 'waf').map((r) => r.file);
        if (stale.length) {
            if (!asJson) console.log(`[ratelimit] Refreshing ${stale.length} stale aws-waf-token(s)…`);
            for (const file of stale) {
                const ok = await runRefresh(file);
                if (!asJson) console.log(`[ratelimit] ${label(file)} → ${ok ? 'refreshed' : 'refresh failed'}`);
            }
            results = await mapWithConcurrency(files, concurrency, (file) => checkOne(file, { timeoutMs, whoami }));
        }
    }

    const summary = summarize(results);

    // --quarantine lists the dead logins; --apply moves them into accounts/.removed.
    let quarantine = null;
    if (argv.includes('--quarantine')) {
        const plan = quarantinePlan(results);
        const applied = argv.includes('--apply') ? applyQuarantine(plan) : null;
        quarantine = { candidates: plan.map((p) => ({ ...p, file: label(p.from), from: label(p.from) })), applied };
        if (applied) {
            // They are out of the pool now; re-read the directory so the report matches disk.
            results = await mapWithConcurrency(authFiles(), concurrency, (file) => checkOne(file, { timeoutMs, whoami }));
            Object.assign(summary, summarize(results));
        }
    }

    if (asJson) {
        console.log(JSON.stringify({ summary, quarantine, results: results.map((r) => ({ ...r, file: label(r.file) })) }, null, 2));
        return summary.needsAttention ? 2 : 0;
    }

    const width = Math.max(12, ...results.map((r) => label(r.file).length));
    console.log(`${pad('account', width)}  ${pad('state', 9)}  ${pad('http', 4)}  ${pad('ms', 6)}  note`);
    for (const r of results) {
        console.log(`${pad(label(r.file), width)}  ${pad(r.kind, 9)}  ${pad(r.status || '-', 4)}  ${pad(r.latencyMs, 6)}  ${noteFor(r)}`);
    }
    const parts = Object.entries(summary.counts).map(([kind, n]) => `${n} ${kind}`);
    console.log(`\n[ratelimit] ${summary.ready}/${summary.total} ready${parts.length ? ` (${parts.join(', ')})` : ''}`);
    if (summary.refreshable.length) {
        console.log(`[ratelimit] ${summary.refreshable.length} login(s) need a fresh aws-waf-token: rerun with --refresh.`);
    }
    if (summary.counts.ratelimit) {
        console.log('[ratelimit] Throttled logins are parked by the proxy until their window resets; extra logins cover the load.');
    }
    if (quarantine) {
        const { candidates, applied } = quarantine;
        if (!candidates.length) {
            console.log('[ratelimit] Nothing to quarantine: every login in accounts/ authenticated.');
        } else if (!applied) {
            console.log(`\n[ratelimit] ${candidates.length} dead login(s) — their token is rejected, and no refresh can fix that:`);
            for (const c of candidates) console.log(`  · ${c.file} (${c.reason})`);
            console.log('[ratelimit] Move them out of the pool with: node scripts/ratelimit_check.js --quarantine --apply');
        } else {
            const moved = applied.filter((a) => a.ok);
            const failed = applied.filter((a) => !a.ok);
            console.log(`\n[ratelimit] Moved ${moved.length} dead login(s) to ${label(path.join(DEFAULT_ACCOUNTS_DIR, '.removed'))} (nothing deleted):`);
            for (const m of moved) console.log(`  · ${label(m.from)} → ${label(m.to)} (${m.reason})`);
            for (const f of failed) console.log(`  ✗ ${label(f.from)} could not be moved: ${f.error}`);
            console.log('[ratelimit] Re-capture each one with the browser extension to bring it back into the pool.');
        }
    }
    return summary.needsAttention ? 2 : 0;
}

if (require.main === module) {
    main()
        .then((code) => { process.exitCode = code; })
        .catch((err) => { console.error('[ratelimit] ERROR:', err.message); process.exit(1); });
}

module.exports = { authFiles, summarize, checkOne, mapWithConcurrency, label, quarantinePlan, applyQuarantine };
