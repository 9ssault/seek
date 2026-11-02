#!/usr/bin/env node
/**
 * Move a checkout's logins into the shared store.
 *
 * Older installs keep auth files inside the repository (`accounts/`,
 * `deepseek-auth.json`). The gateway now reads `~/.seek/accounts` first, so a second
 * clone, a container, or the other provider sees the same pool. This copies those
 * files across without ever overwriting a stored login or deleting the originals.
 *
 *   npm run accounts:share
 *   npm run accounts:share -- --from /path/to/other/checkout/accounts --force
 */
'use strict';
const fs = require('fs');
const path = require('path');
const accountsDir = require('../lib/accounts-dir');
const capture = require('./lib/auth-capture');

const ROOT = path.resolve(__dirname, '..');

function argValue(args, name, fallback = '') {
    const index = args.indexOf(name);
    if (index === -1) return fallback;
    return args[index + 1] || fallback;
}

async function main() {
    const args = process.argv.slice(2);
    const from = path.resolve(argValue(args, '--from', path.join(ROOT, accountsDir.DIR_NAME)));
    const force = args.includes('--force');
    const to = capture.storeDir(ROOT);

    console.log(`from  ${accountsDir.shortPath(from)}`);
    console.log(`to    ${accountsDir.shortPath(to)}`);

    const names = accountsDir.authFileNames(from);
    if (names.length === 0) {
        console.log(`\nNothing to adopt: ${accountsDir.shortPath(from)} holds no .json auth files.`);
        console.log(`New logins go straight to ${accountsDir.shortPath(to)} — run npm run auth or npm run claude:auth.`);
        return 0;
    }
    if (path.resolve(from) === path.resolve(to)) {
        console.log('\nThat is already the store every checkout reads. Nothing to do.');
        return 0;
    }

    const copied = [];
    const identical = [];
    const conflicts = [];
    fs.mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const name of names) {
        const source = path.join(from, name);
        const target = path.join(to, name);
        const bytes = fs.readFileSync(source);
        if (fs.existsSync(target)) {
            const existing = fs.readFileSync(target);
            if (existing.equals(bytes)) {
                identical.push(name);
                continue;
            }
            if (!force) {
                conflicts.push(name);
                continue;
            }
        }
        capture.writeAuthFile(target, JSON.parse(bytes.toString('utf8')));
        copied.push(name);
    }

    console.log(`\nadopted ${copied.length}, already present ${identical.length}, left alone ${conflicts.length}`);
    for (const name of copied) console.log(`  + ${name}`);
    for (const name of conflicts) console.log(`  = ${name} (differs in the store; --force replaces it)`);

    if (conflicts.length) {
        console.log('\nA differing file is left untouched: the stored copy may be the fresher capture.');
    }
    if (copied.length || identical.length) {
        console.log(`\nThe store now serves ${accountsDir.countAuthFiles(to)} login file(s) for every checkout and both providers.`);
        console.log(`The copies in ${accountsDir.shortPath(from)} are no longer read; delete them when you are satisfied.`);
    }
    const reload = await capture.notifyGatewayReload();
    if (reload.reloaded) console.log(`Gateway reloaded at ${reload.url} (added: ${(reload.added || []).join(', ') || 'none'}).`);
    return 0;
}

main().then(code => process.exit(code)).catch(error => {
    console.error(`accounts:share failed: ${error.message}`);
    process.exit(1);
});
