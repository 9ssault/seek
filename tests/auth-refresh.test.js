'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const refresh = require('../lib/auth-refresh');

function response(status, body) {
    return {
        status,
        ok: status >= 200 && status < 300,
        headers: { get: () => null },
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
        json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    };
}

test('cleanToken removes every Bearer prefix and unwraps JSON shapes', () => {
    assert.equal(refresh.cleanToken('Bearer abc'), 'abc');
    assert.equal(refresh.cleanToken('Bearer  Bearer abc '), 'abc');
    assert.equal(refresh.cleanToken('"abc"'), 'abc');
    assert.equal(refresh.cleanToken('{"token":"abc"}'), 'abc');
    assert.equal(refresh.cleanToken({ value: 'abc' }), 'abc');
    assert.equal(refresh.cleanToken('  a\nb\t '), 'ab');
    assert.equal(refresh.cleanToken(null), '');
    assert.equal(refresh.cleanToken(42), '');
});

test('normalizeConfig cleans a token and nested account entries', () => {
    const config = { token: 'Bearer x', accounts: [{ token: 'Bearer y' }] };
    refresh.normalizeConfig(config);
    assert.equal(config.token, 'x');
    assert.equal(config.accounts[0].token, 'y');
});

test('probeAccountToken reports valid credentials with latency', async () => {
    const fetchImpl = async () => response(200, {
        code: 0,
        data: { biz_data: { challenge: { algorithm: 'x' } } },
    });
    const probe = await refresh.probeAccountToken(
        { config: { token: 'Bearer good', cookie: 'a=b' } },
        { fetchImpl },
    );
    assert.equal(probe.ok, true);
    assert.equal(probe.kind, 'ok');
    assert.equal(probe.status, 200);
    assert.ok(probe.latencyMs >= 0);
});

test('probeAccountToken reports a 401 as an auth failure', async () => {
    const fetchImpl = async () => response(401, { code: 40003, msg: 'invalid token' });
    const probe = await refresh.probeAccountToken({ config: { token: 'x', cookie: 'a=b' } }, { fetchImpl });
    assert.equal(probe.ok, false);
    assert.equal(probe.kind, 'auth');
    assert.equal(probe.status, 401);
});

test('a merged account is never rewritten by a browser refresh', async () => {
    const fetchImpl = async () => response(401, { code: 40003 });
    const result = await refresh.refreshAccount({ id: 'm', merged: true, file: '/tmp/x', config: { token: 'x', cookie: 'a=b' } }, { fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'merged_no_refresh');
});

test('writeAccountFile is atomic and 0600', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stool-auth-'));
    try {
        const file = path.join(dir, 'a.json');
        refresh.writeAccountFile(file, { token: 't', cookie: 'c' });
        assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { token: 't', cookie: 'c' });
        if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('loginWithCredentials returns the token from a biz_data payload', async () => {
    const fetchImpl = async () => response(200, {
        code: 0,
        data: { biz_data: { user: { token: 'fresh', cookie: 'c=1' } } },
    });
    const login = await refresh.loginWithCredentials({ config: { email: 'a@b.com', password: 'p' } }, fetchImpl);
    assert.equal(login.ok, true);
    assert.equal(login.token, 'fresh');
    assert.equal(login.cookie, 'c=1');
});
