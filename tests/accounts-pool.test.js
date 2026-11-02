'use strict';

// The pool script is the operator's side of both providers: it must read the same
// store the gateway reads, count a login once, and be able to stand up a full-sized
// two-provider pool offline so the routing code can be exercised without real accounts.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pool = require('../scripts/accounts_pool.js');

function tempDir(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-pool-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

function writeJson(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

test('a single account file and a merged file both expand into logins', () => {
    const single = pool.expandFile('/store/one.json', { name: 'one', token: 't', cookie: 'c' });
    assert.equal(single.length, 1);
    assert.equal(single[0].merged, false);
    assert.equal(single[0].label, 'one');

    const merged = pool.expandFile('/store/all.json', {
        accounts: [
            { name: 'a', token: 'ta', cookie: 'ca' },
            { name: 'b', token: 'tb', cookie: 'cb' },
        ],
    });
    assert.equal(merged.length, 2);
    assert.deepEqual(merged.map(entry => entry.label), ['a', 'b']);
    assert.ok(merged.every(entry => entry.merged));
    assert.equal(merged[1].key, '/store/all.json#b');
});

test('the provider comes from the login itself, not from its file name', () => {
    assert.equal(pool.providerOf({ token: 't', cookie: 'c' }), 'deepseek');
    assert.equal(pool.providerOf({ provider: 'claude', cookie: 'sessionKey=x' }), 'claude');
    // A bare claude.ai cookie jar is Claude even without the marker.
    assert.equal(pool.providerOf({ cookie: 'sessionKey=abc; cf_clearance=def' }), 'claude');
});

test('a login is counted once: a standalone file supersedes the merged copy', () => {
    const entries = [
        { file: '/store/all.json', label: 'work', merged: true, provider: 'deepseek', config: { name: 'work', token: 'aaa', cookie: 'c' } },
        { file: '/store/work.json', label: null, merged: false, provider: 'deepseek', config: { name: 'work', token: 'aaa', cookie: 'c' } },
        { file: '/store/other.json', label: null, merged: false, provider: 'deepseek', config: { name: 'other', token: 'bbb', cookie: 'c' } },
    ];
    const kept = pool.dedupe(entries);
    assert.equal(kept.length, 2);
    assert.deepEqual(kept.map(entry => path.basename(entry.file)), ['work.json', 'other.json']);
});

test('an exact duplicate credential is dropped, keeping the first', () => {
    const kept = pool.dedupe([
        { file: '/store/a.json', merged: false, provider: 'deepseek', config: { token: 'same', cookie: 'c1' } },
        { file: '/store/b.json', merged: false, provider: 'deepseek', config: { token: 'same', cookie: 'c2' } },
    ]);
    assert.equal(kept.length, 1);
    assert.equal(path.basename(kept[0].file), 'a.json');
});

test('reading a store picks up both providers and skips stray files', t => {
    const dir = tempDir(t);
    writeJson(path.join(dir, 'ds-1.json'), { token: 'a'.repeat(64), cookie: 'c' });
    writeJson(path.join(dir, 'cl-1.json'), { provider: 'claude', cookie: 'sessionKey=x' });
    fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
    fs.writeFileSync(path.join(dir, '.hidden.json'), '{}');

    const read = pool.readPool(dir);
    assert.equal(read.entries.length, 2);
    assert.deepEqual(read.entries.map(entry => entry.provider).sort(), ['claude', 'deepseek']);
    assert.equal(read.problems.length, 1);
    assert.match(read.problems[0].message, /invalid JSON/);
});

test('fixtures stand up 20 logins per provider, deterministic and clearly fake', () => {
    const entries = pool.fixtureEntries(20);
    assert.equal(entries.length, 40);
    for (const provider of ['deepseek', 'claude']) {
        const own = entries.filter(entry => entry.provider === provider);
        assert.equal(own.length, 20, `${provider} fixtures`);
        assert.ok(own.every(entry => entry.config._fixture === true), `${provider} fixtures are marked`);
    }
    const deepseek = entries.filter(entry => entry.provider === 'deepseek').map(entry => entry.config.token);
    const claude = entries.filter(entry => entry.provider === 'claude').map(entry => entry.config.cookie);
    assert.equal(new Set(deepseek).size, 20, 'tokens are unique');
    assert.equal(new Set(claude).size, 20, 'cookies are unique');
    assert.ok(deepseek.every(token => /^[0-9a-f]{64}$/.test(token)), 'token-shaped');
    assert.ok(claude.every(cookie => /^sessionKey=/.test(cookie)), 'cookie-shaped');
    // Stable across runs: a fixture file that changes bytes on every run would make
    // any test that reads it flaky for no reason.
    assert.deepEqual(pool.fixtureEntries(20), entries);
});

test('a 20+20 fixture pool is a loadable two-provider store', t => {
    const dir = tempDir(t);
    for (const entry of pool.fixtureEntries(20)) {
        writeJson(path.join(dir, `${entry.name}.json`), entry.config);
    }
    const read = pool.readPool(dir);
    assert.equal(read.entries.length, 40);
    assert.equal(read.problems.length, 0);
    assert.equal(read.entries.filter(entry => entry.provider === 'deepseek').length, 20);
    assert.equal(read.entries.filter(entry => entry.provider === 'claude').length, 20);
    assert.ok(read.entries.every(entry => pool.hasCredentials(entry)), 'every fixture carries credentials');
});

test('the quarantine plan only names dead standalone logins inside the store', () => {
    const dir = '/store';
    const rows = [
        { entry: { file: '/store/dead.json', merged: false }, result: { kind: 'auth' } },
        { entry: { file: '/store/merged.json', merged: true }, result: { kind: 'auth' } },
        { entry: { file: '/elsewhere/dead.json', merged: false }, result: { kind: 'auth' } },
        { entry: { file: '/store/live.json', merged: false }, result: { kind: 'ok' } },
    ];
    const plan = pool.quarantinePlan(rows, dir);
    assert.equal(plan.length, 1);
    assert.equal(plan[0].from, '/store/dead.json');
    assert.equal(plan[0].to, path.join(dir, '.removed', 'dead.json'));
});

test('summarize reports each provider separately', () => {
    const rows = [
        { entry: { provider: 'deepseek' }, result: { kind: 'ok' } },
        { entry: { provider: 'deepseek' }, result: { kind: 'auth' } },
        { entry: { provider: 'claude' }, result: { kind: 'ratelimit' } },
        { entry: { provider: 'claude' }, result: { kind: 'ok' } },
    ];
    const summary = pool.summarize(rows);
    assert.equal(summary.total, 4);
    assert.equal(summary.live, 2);
    assert.equal(summary.needsAttention, 2);
    assert.deepEqual(summary.byProvider.deepseek, { total: 2, live: 1, dead: 1, throttled: 0, other: 0 });
    assert.deepEqual(summary.byProvider.claude, { total: 2, live: 1, dead: 0, throttled: 1, other: 0 });
});
