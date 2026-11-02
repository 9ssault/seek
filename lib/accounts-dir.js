'use strict';
/**
 * Where auth files live.
 *
 * The checkout used to be the store, which meant two clones of this repo kept two
 * different login pools: a fresh clone reported "no accounts found" while the
 * logins sat in the other directory, and `npm run dashboard` had nothing to serve.
 *
 * The store is per-user and outside the tree now, so every checkout (and every
 * provider) reads the same logins, and a login is never something git can see.
 * Precedence:
 *
 *   1. DEEPSEEK_AUTH_DIR          explicit, unchanged, wins outright
 *   2. $SEEK_HOME/accounts        the shared store, when it already holds logins
 *   3. <checkout>/accounts        a pre-existing in-tree store, still honoured
 *   4. $SEEK_HOME/accounts        the default target for the next login
 *
 * Step 3 is read-only compatibility: a store that already has files keeps being
 * served, and `npm run accounts:share` moves it to the shared path.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR_NAME = 'accounts';

function sharedHome(env = process.env, home = os.homedir()) {
    const base = env.SEEK_HOME && String(env.SEEK_HOME).trim();
    return base ? path.resolve(base) : path.join(home, '.seek');
}

function sharedAccountsDir(env = process.env, home = os.homedir()) {
    return path.join(sharedHome(env, home), DIR_NAME);
}

// Auth files are plain `*.json`; editor droppings, temp files and the
// `.removed-<stamp>` copies this gateway writes when it archives a login are not.
function authFileNames(dir) {
    try {
        return fs.readdirSync(dir)
            .filter(name => name.endsWith('.json') && !name.startsWith('.'))
            .sort();
    } catch {
        return [];
    }
}

function countAuthFiles(dir) {
    return authFileNames(dir).length;
}

function resolveAccountsDir({ root = path.resolve(__dirname, '..'), env = process.env, home = os.homedir() } = {}) {
    const explicit = env.DEEPSEEK_AUTH_DIR && String(env.DEEPSEEK_AUTH_DIR).trim();
    if (explicit) return path.resolve(explicit);
    const shared = sharedAccountsDir(env, home);
    const local = path.join(root, DIR_NAME);
    if (countAuthFiles(shared) > 0) return shared;
    if (countAuthFiles(local) > 0) return local;
    return shared;
}

// `~/…` rather than an absolute path: the messages that print this end up in
// logs and issue reports, and a home directory is nobody else's business.
function shortPath(target, home = os.homedir()) {
    const abs = path.resolve(target);
    return abs === home ? '~' : abs.startsWith(home + path.sep) ? `~${abs.slice(home.length)}` : abs;
}

// One line that answers "where did it look?" — printed when a pool comes up
// empty, so the next report of "no accounts found" names the directory.
function describeStore(dir, { home = os.homedir(), env = process.env } = {}) {
    const count = countAuthFiles(dir);
    const where = shortPath(dir, home);
    if (count > 0) return `${where} (${count} login file${count === 1 ? '' : 's'})`;
    if (env.DEEPSEEK_AUTH_DIR) return `${where} (DEEPSEEK_AUTH_DIR, no .json files)`;
    if (env.DEEPSEEK_AUTH_PATH) return `${where} (empty; DEEPSEEK_AUTH_PATH=${env.DEEPSEEK_AUTH_PATH})`;
    return `${where} (empty — run npm run auth, or npm run accounts:share to adopt an existing checkout)`;
}

module.exports = {
    DIR_NAME,
    sharedHome,
    sharedAccountsDir,
    authFileNames,
    countAuthFiles,
    resolveAccountsDir,
    shortPath,
    describeStore,
};
