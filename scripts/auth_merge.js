#!/usr/bin/env node
'use strict';

// Folds every DeepSeek login on this machine into ONE auth file:
//
//   deepseek-auth.json
//   {
//     "version": 1,
//     "orchestrator": "dgrondin514",
//     "accounts": [ { "name": "...", "token": "...", "cookie": "..." }, … ]
//   }
//
// The named orchestrator is the login the proxy keeps free for compaction summaries
// and memory folding; the rest serve chats. Nothing is deleted: the old files are
// copied to a backup directory and then moved to accounts/.removed/.
//
//   node scripts/auth_merge.js                          # show the plan, write nothing
//   node scripts/auth_merge.js --apply                  # write the merged file
//   node scripts/auth_merge.js --orchestrator my-login  # pick the orchestrator
//   node scripts/auth_merge.js --out /path/auth.json    # merge somewhere else

const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUTH_PATH = process.env.DEEPSEEK_AUTH_PATH && !/[,]/.test(process.env.DEEPSEEK_AUTH_PATH)
    ? process.env.DEEPSEEK_AUTH_PATH
    : path.join(ROOT, 'deepseek-auth.json');
const ACCOUNTS_DIR = process.env.DEEPSEEK_AUTH_DIR || path.join(ROOT, 'accounts');
const BACKUP_ROOT = path.join(os.homedir(), '.freedeepseek-api', 'backups');

const SENSITIVE = new Set(['token', 'cookie', 'hif_dliq', 'hif_leim', 'wasmUrl']);

function cliValue(args, name, fallback = null) {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    const next = args[i + 1];
    return next && !next.startsWith('--') ? next : fallback;
}

function label(file) {
    const rel = path.relative(ROOT, file);
    return rel && !rel.startsWith('..') ? rel : file;
}

// A file may already be a merged one; flatten it instead of nesting it.
function entriesOf(file, json) {
    const orchestrator = String(json && !Array.isArray(json) ? (json.orchestrator || '') : '').trim();
    const list = Array.isArray(json) ? json : (Array.isArray(json?.accounts) ? json.accounts : null);
    const base = path.basename(file, '.json');
    if (!list) return [{ file, name: String(json?.name || base).trim(), config: json, role: /^orchestrator$/i.test(String(json?.role || '')) || orchestrator === base ? 'orchestrator' : 'worker' }];
    return list.map((entry, index) => {
        const name = String(entry?.name || entry?.id || `${base}-${index + 1}`).trim();
        const role = /^orchestrator$/i.test(String(entry?.role || '')) || orchestrator === name ? 'orchestrator' : 'worker';
        return { file, name, config: entry, role };
    });
}

function discoverFiles() {
    const files = [];
    if (fs.existsSync(AUTH_PATH)) files.push(path.resolve(AUTH_PATH));
    try {
        for (const name of fs.readdirSync(ACCOUNTS_DIR).filter(f => f.endsWith('.json')).sort()) {
            files.push(path.resolve(ACCOUNTS_DIR, name));
        }
    } catch (err) { /* no accounts dir is normal */ }
    return [...new Set(files)];
}

function collect() {
    const byToken = new Map();
    const problems = [];
    const seenNames = new Set();
    const logins = [];
    let folded = 0;
    for (const file of discoverFiles()) {
        let json;
        try {
            json = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            problems.push(`${label(file)}: ${err instanceof SyntaxError ? 'invalid JSON' : err.message}`);
            continue;
        }
        for (const entry of entriesOf(file, json)) {
            const config = entry.config || {};
            if (!config.token || !config.cookie) {
                problems.push(`${label(file)}: ${entry.name} has no token or cookie`);
                continue;
            }
            // A dedicated file already names the login, and that name is the id the
            // dashboard and x-account-id already use. Prefer it over a masked e-mail.
            const fromOwnFile = path.resolve(file) !== path.resolve(AUTH_PATH);
            const candidate = { name: fromOwnFile ? path.basename(file, '.json') : entry.name, display: config.name || null, file, config, role: entry.role, fromOwnFile };
            const existing = byToken.get(config.token);
            if (existing) {
                // The same login can sit in the merged file and in its own file at once.
                // The dedicated file wins because its name is already the account id.
                if (!existing.fromOwnFile && candidate.fromOwnFile) byToken.set(config.token, candidate);
                folded++;
                continue;
            }
            byToken.set(config.token, candidate);
        }
    }
    for (const login of byToken.values()) {
        let name = login.name;
        let n = 2;
        while (seenNames.has(name)) name = `${login.name}-${n++}`;
        seenNames.add(name);
        logins.push({ ...login, name });
    }
    return { logins, problems, folded };
}

function writeMerged(outPath, orchestrator, logins) {
    const payload = {
        version: 1,
        orchestrator,
        accounts: logins.map(({ name, display, config, role }) => {
            // `name` is the stable id; `display` is the readable label the dashboard shows.
            const entry = { name };
            if (display && display !== name) entry.display = display;
            for (const [key, value] of Object.entries(config)) {
                if (key === 'name' || key === 'display' || key === 'id' || key === 'role') continue;
                entry[key] = value;
            }
            if (role === 'orchestrator') entry.role = 'orchestrator';
            return entry;
        }),
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
    const tmp = `${outPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, outPath);
    return payload;
}

function backup(files) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(BACKUP_ROOT, `merge-${stamp}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const file of files) {
        if (!fs.existsSync(file)) continue;
        const target = path.join(dir, path.basename(file));
        fs.copyFileSync(file, target);
        fs.chmodSync(target, 0o600);
    }
    return dir;
}

function main(argv = process.argv.slice(2)) {
    if (argv.includes('--help') || argv.includes('-h')) {
        console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1].replace(/^\s*\/\/ ?/gm, '').trim());
        return 0;
    }
    const apply = argv.includes('--apply');
    const outPath = path.resolve(cliValue(argv, '--out', AUTH_PATH));
    const { logins, problems, folded } = collect();

    if (!logins.length) {
        console.error(`[merge] No usable login found (looked at ${label(AUTH_PATH)} and ${label(ACCOUNTS_DIR)}).`);
        for (const p of problems) console.error(`  · ${p}`);
        return 2;
    }

    const current = logins.find(l => l.role === 'orchestrator');
    const requested = cliValue(argv, '--orchestrator', null);
    const orchestrator = requested || current?.name || logins[0].name;
    if (!logins.some(l => l.name === orchestrator)) {
        console.error(`[merge] --orchestrator ${orchestrator} is not one of: ${logins.map(l => l.name).join(', ')}`);
        return 2;
    }

    console.log(`[merge] ${logins.length} login(s) → ${label(outPath)}`);
    console.log(`[merge] orchestrator: ${orchestrator} (kept free for summaries and memory)`);
    for (const login of logins) {
        const mark = login.name === orchestrator ? '*' : ' ';
        console.log(`  ${mark} ${login.name.padEnd(28)} from ${label(login.file)}  token ${String(login.config.token).slice(0, 6)}…`);
    }
    if (folded) console.log(`[merge] folded ${folded} duplicate copy(ies) of the same login`);
    for (const p of problems) console.log(`  ! ${p}`);

    if (!apply) {
        console.log('\n[merge] Dry run. Nothing was written. Rerun with --apply.');
        return 0;
    }

    const files = discoverFiles();
    const backupDir = backup(files);
    console.log(`\n[merge] backup: ${backupDir}`);
    const payload = writeMerged(outPath, orchestrator, logins);
    console.log(`[merge] wrote ${label(outPath)} with ${payload.accounts.length} login(s), mode 0600`);

    // The merged file now holds every login. The loader dedupes by token, so leaving
    // the old files is harmless; --prune moves them aside (never deletes) once the
    // proxy runs code that reads a merged file.
    const removedDir = path.join(ACCOUNTS_DIR, '.removed', 'merged');
    let moved = 0;
    if (argv.includes('--prune')) {
        for (const file of files) {
            if (path.resolve(file) === outPath) continue;
            fs.mkdirSync(removedDir, { recursive: true });
            const target = path.join(removedDir, path.basename(file));
            fs.renameSync(file, fs.existsSync(target) ? `${target}.${Date.now()}` : target);
            moved++;
        }
        if (moved) console.log(`[merge] moved ${moved} old file(s) to ${label(removedDir)}`);
    } else if (files.some(file => path.resolve(file) !== outPath)) {
        console.log('[merge] Old per-login files kept (the loader dedupes by token). Add --prune to move them to accounts/.removed/merged.');
    }

    console.log('\n[merge] Reload the pool:  curl -X POST http://127.0.0.1:9655/admin/accounts/reload');
    console.log('[merge] Or restart the proxy. GET /health shows each account and its role.');
    return 0;
}

if (require.main === module) {
    const code = main();
    process.exitCode = code;
}

module.exports = { collect, entriesOf, writeMerged, main };
