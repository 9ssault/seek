'use strict';

// Bulk capture: one request brings in many logins through the same verified path as the
// dashboard, and the inbox turns a dropped file into a loaded account. Both exist for the
// operator who captures ten sessions in a browser and does not want ten dialogs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = fs.mkdtempSync(path.join(os.tmpdir(), 'unseeked-bulk-'));
const inbox = fs.mkdtempSync(path.join(os.tmpdir(), 'unseeked-inbox-'));
// Set before the server module is loaded: the import verifier and the accounts dir are
// read at require time, and a test must never write into the real store.
process.env.DEEPSEEK_AUTH_DIR = store;
process.env.DEEPSEEK_IMPORT_VERIFY_OFF = '1';
process.env.SEEK_ACCOUNT_INBOX_DIR = inbox;
delete process.env.SEEK_ACCOUNT_INBOX_OFF;
delete process.env.DEEPSEEK_AUTH_PATH;

const S = require('../server.js').__test;

const WASM = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
function jar(token, extra = {}) {
    return {
        token,
        cookie: 'intercom-device-id=1; __cf_bm=abc; cf_clearance=xyz',
        wasmUrl: WASM,
        ...extra,
    };
}

test('bulk import adds every capture and reports each one in order', async (t) => {
    const original = S.accounts.splice(0, S.accounts.length);
    t.after(() => { S.accounts.splice(0, S.accounts.length, ...original); });
    const report = await S.adminImportAccountsBulk({
        accounts: [
            { name: 'bulk-alpha', auth: jar('bulk-token-alpha') },
            { name: 'bulk-beta', auth: jar('bulk-token-beta') },
        ],
    });
    assert.equal(report.total, 2);
    assert.equal(report.added, 2);
    assert.equal(report.failed, 0);
    assert.deepEqual(report.results.map(r => r.name), ['bulk-alpha', 'bulk-beta']);
    assert.deepEqual(report.results.map(r => r.ok), [true, true]);
    for (const row of report.results) assert.equal(row.replaced, false);
    // The files landed in the managed store, named from the request.
    const written = fs.readdirSync(store).filter(name => name.endsWith('.json') && name.startsWith('bulk-'));
    assert.deepEqual(written.sort(), ['bulk-alpha.json', 'bulk-beta.json']);
});

test('two Grok logins pushed under the same generic name both land', async (t) => {
    const original = S.accounts.splice(0, S.accounts.length);
    t.after(() => { S.accounts.splice(0, S.accounts.length, ...original); });
    // The extension falls back to "Grok Account" when a session exposes no identity. Two
    // real logins then share a name, and reusing the first one's file dropped the second.
    const first = await S.adminImportAccount({
        name: 'Grok Account', provider: 'grok',
        auth: { provider: 'grok', cookie: 'sso=grok-one; cf_clearance=a' },
    });
    const second = await S.adminImportAccount({
        name: 'Grok Account', provider: 'grok',
        auth: { provider: 'grok', cookie: 'sso=grok-two; cf_clearance=b' },
    });
    assert.notEqual(first.account.id, second.account.id);
    assert.equal(second.replaced, false);
    // The second login keeps a name of its own instead of being a copy of the first.
    assert.equal(second.account.config.name, 'Grok Account 2');
    const files = fs.readdirSync(store).filter(n => n.startsWith('grok-account') && n.endsWith('.json'));
    assert.equal(files.length, 2, `one file per login, got ${files.join(', ')}`);
    const stored = fs.readdirSync(store)
        .filter(n => n.startsWith('grok-account') && n.endsWith('.json'))
        .map(n => JSON.parse(fs.readFileSync(path.join(store, n), 'utf8')).cookie);
    assert.deepEqual(stored.sort(), ['sso=grok-one; cf_clearance=a', 'sso=grok-two; cf_clearance=b']);
});

test('a duplicate inside one batch is reported, and the rest still land', async (t) => {
    const original = S.accounts.splice(0, S.accounts.length);
    t.after(() => { S.accounts.splice(0, S.accounts.length, ...original); });
    await S.adminImportAccountsBulk({ accounts: [{ name: 'dup-one', auth: jar('dup-token') }] });
    const report = await S.adminImportAccountsBulk({
        accounts: [
            { name: 'dup-one', auth: jar('dup-token') },
            { name: 'dup-two', auth: jar('dup-token-fresh') },
        ],
    });
    assert.equal(report.duplicates, 1);
    assert.equal(report.added, 1);
    assert.equal(report.failed, 0);
    assert.equal(report.results[0].ok, false);
    assert.equal(report.results[0].error, 'duplicate_account');
    assert.equal(report.results[1].ok, true);
});

test('a bad payload fails only itself, with the reason on its own row', async (t) => {
    const original = S.accounts.splice(0, S.accounts.length);
    t.after(() => { S.accounts.splice(0, S.accounts.length, ...original); });
    const report = await S.adminImportAccountsBulk({
        accounts: [
            { name: 'broken-one', auth: { cookie: 'a=b' } },
            { name: 'good-one', auth: jar('good-token') },
        ],
    });
    assert.equal(report.failed, 1);
    assert.equal(report.added, 1);
    assert.equal(report.results[0].ok, false);
    assert.equal(report.results[0].error, 'invalid_auth');
    assert.ok(report.results[0].message.length > 0);
});

test('an oversized batch is refused before any account is touched', async () => {
    const accounts = Array.from({ length: 51 }, (_, i) => ({ name: `bulk-${i}`, auth: jar(`overflow-${i}`) }));
    await assert.rejects(S.adminImportAccountsBulk({ accounts }),
        err => err.status === 422 && err.type === 'too_many_accounts');
    assert.deepEqual(fs.readdirSync(store).filter(name => name.startsWith('bulk-5')), []);
});

test('the inbox imports a dropped jar and files it, and rejects a broken one', async (t) => {
    const original = S.accounts.splice(0, S.accounts.length);
    t.after(() => { S.accounts.splice(0, S.accounts.length, ...original); });
    fs.writeFileSync(path.join(inbox, 'inbox-acme.json'), JSON.stringify(jar('inbox-token-acme', { name: 'acme-dropped' })));
    fs.writeFileSync(path.join(inbox, 'inbox-broken.json'), '{ not json');
    const report = await S.accountInboxPass();
    assert.equal(report.imported.length, 1);
    assert.equal(report.imported[0].file, 'inbox-acme.json');
    assert.equal(report.rejected.length, 1);
    assert.equal(report.rejected[0].error, 'invalid_json');
    // A name inside the jar wins over the filename: that is what the operator typed.
    const loaded = S.accounts.find(a => a.config?.token === 'inbox-token-acme');
    assert.ok(loaded, 'the dropped jar is in the pool');
    assert.equal(loaded.config?.name, 'acme-dropped');
    // Both files are filed, so the next pass does not process them again.
    assert.deepEqual(fs.readdirSync(inbox).filter(n => n.endsWith('.json')), []);
    assert.deepEqual(fs.readdirSync(path.join(inbox, 'imported')), ['inbox-acme.json']);
    assert.deepEqual(fs.readdirSync(path.join(inbox, 'rejected')), ['inbox-broken.json']);
    const second = await S.accountInboxPass();
    assert.equal(second.imported.length, 0);
});

test('the inbox can be switched off, and says so instead of running', async () => {
    process.env.SEEK_ACCOUNT_INBOX_OFF = '1';
    try {
        assert.equal(S.accountInboxDir(), '');
        const report = await S.accountInboxPass();
        assert.equal(report.skipped, 'disabled');
    } finally {
        delete process.env.SEEK_ACCOUNT_INBOX_OFF;
    }
});
