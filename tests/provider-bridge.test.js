'use strict';

// The bridge is what lets one gateway answer from either upstream. Its contract is
// narrow on purpose: same class of model, never across a pinned login, never across an
// explicit claude/ prompt, and only when the other side actually has a login to serve.
const test = require('node:test');
const assert = require('node:assert');

const S = require('../server.js').__test;

test('a DeepSeek model bridges to a Claude model of the same class', () => {
    // Bridges target the models a standard claude.ai plan actually serves.
    assert.equal(S.bridgeModelFor('deepseek-v4-flash-thinking', 'claude'), 'claude-sonnet-4-6');
    assert.equal(S.bridgeModelFor('deepseek-v4-flash-thinking-nosearch', 'claude'), 'claude-sonnet-4-6');
    assert.equal(S.bridgeModelFor('deepseek-v4-flash', 'claude'), 'claude-haiku-4-5');
    assert.equal(S.bridgeModelFor('deepseek-v4-flash-nosearch', 'claude'), 'claude-haiku-4-5');
});

test('a Claude model bridges back to the matching DeepSeek model', () => {
    assert.equal(S.bridgeModelFor('claude-opus-4-1', 'deepseek'), 'deepseek-v4-flash-thinking');
    assert.equal(S.bridgeModelFor('claude-sonnet-4-5', 'deepseek'), 'deepseek-v4-flash-thinking');
    assert.equal(S.bridgeModelFor('claude-haiku-4-5', 'deepseek'), 'deepseek-v4-flash');
    // The aliases an agent actually sends resolve before the table is consulted.
    assert.equal(S.bridgeModelFor('sonnet', 'deepseek'), 'deepseek-v4-flash-thinking');
    assert.equal(S.bridgeModelFor('haiku', 'deepseek'), 'deepseek-v4-flash');
});

test('an id this build has never seen bridges by class, or not at all', () => {
    assert.equal(S.bridgeModelFor('claude-sonnet-9-0-20990101', 'deepseek'), 'deepseek-v4-flash-thinking');
    assert.equal(S.bridgeModelFor('claude-haiku-9-0-20990101', 'deepseek'), 'deepseek-v4-flash');
    assert.equal(S.bridgeModelFor('deepseek-v4-flash-thinking', 'claude'), 'claude-sonnet-4-6');
    assert.equal(S.bridgeModelFor('totally-unknown', 'claude'), null);
    // An absent model id means the provider default, so it bridges to the default's class.
    assert.equal(S.bridgeModelFor('', 'deepseek'), 'deepseek-v4-flash-thinking');
});

test('the bridge is a two-way, one-hop switch', () => {
    assert.equal(S.alternateProvider('deepseek'), 'claude');
    assert.equal(S.alternateProvider('claude'), 'deepseek');
});

test('cross-provider fallback is on by default and can be switched off', () => {
    assert.equal(S.crossProviderFallbackEnabled({}), true);
    assert.equal(S.crossProviderFallbackEnabled({ SEEK_CROSS_PROVIDER_FALLBACK_OFF: '1' }), false);
    assert.equal(S.crossProviderFallbackEnabled({ SEEK_CROSS_PROVIDER_FALLBACK_OFF: 'true' }), false);
    assert.equal(S.crossProviderFallbackEnabled({ SEEK_CROSS_PROVIDER_FALLBACK_OFF: '0' }), true);
});

test('only a login that can serve right now makes its provider bridgeable', () => {
    const before = S.accounts.slice();
    S.accounts.length = 0;
    try {
        S.accounts.push({
            id: 'ds-live', provider: 'deepseek', config: { token: 't', cookie: 'c' },
            cooldownUntil: 0, headers: {}, failures: 0,
        });
        S.accounts.push({
            id: 'cl-parked', provider: 'claude', config: { cookie: 'sessionKey=x' },
            cooldownUntil: Date.now() + 60_000, headers: {}, failures: 0,
        });
        assert.equal(S.providerHasReadyAccount('deepseek'), true);
        assert.equal(S.providerHasReadyAccount('claude'), false);

        S.accounts[0].cooldownUntil = Date.now() + 60_000;
        assert.equal(S.providerHasReadyAccount('deepseek'), false);

        S.accounts[1].cooldownUntil = 0;
        assert.equal(S.providerHasReadyAccount('claude'), true);

        // A rejected login is parked even with a clean cooldown.
        S.accounts[1].invalid = true;
        assert.equal(S.providerHasReadyAccount('claude'), false);
    } finally {
        S.accounts.length = 0;
        S.accounts.push(...before);
    }
});

// ─── end to end: a real request, two mocked upstreams ──────────────────────
const http = require('node:http');
const pow = require('../lib/pow');

const COMPLETION = '/api/v0/chat/completion';
const SESSION_CREATE = '/api/v0/chat_session/create';
const POW = '/api/v0/chat/create_pow_challenge';

function deepseekAccount(id) {
  return {
    id,
    provider: 'deepseek',
    file: `/tmp/bridge-test/${id}.json`,
    config: { token: `tok-${id}`, cookie: `ck=${id}` },
    headers: { Authorization: `Bearer ${id}` },
    cooldownUntil: 0, failures: 0, lastUsedAt: 0,
  };
}

function claudeAccount(id) {
  return {
    id,
    provider: 'claude',
    file: `/tmp/bridge-test/${id}.json`,
    config: { provider: 'claude', cookie: `sessionKey=sk-${id}`, org: 'org-1' },
    headers: { Cookie: `sessionKey=sk-${id}` },
    cooldownUntil: 0, failures: 0, lastUsedAt: 0,
  };
}

function claudeSse(text, messageId = 'msg-1') {
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { uuid: messageId } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ].join('');
}

// Both upstreams behind one fetch: the point of the test is that a request that starts
// on DeepSeek finishes on Claude without the client doing anything.
function installBoth(t, { deepseek, claude }) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    const method = String(options.method || 'GET').toUpperCase();
    calls.push({ path: u.pathname, method });
    if (u.pathname === POW) {
      return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { challenge: { algorithm: 'DeepSeekHashV1', challenge: 'c', salt: 's', signature: 'sig', difficulty: 1, expire_at: 1, target_path: '/api/v0/chat/completion' } } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname === SESSION_CREATE) {
      return new Response(JSON.stringify({ code: 0, data: { biz_code: 0, biz_data: { id: 'ds-sess-1' } } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.pathname === COMPLETION) return deepseek();
    if (/^\/api\/organizations\/[^/]+\/chat_conversations$/.test(u.pathname)) {
      return new Response(JSON.stringify({ uuid: 'conv-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\/chat_conversations\/[^/]+\/completion$/.test(u.pathname)) return claude();
    throw new Error(`bridge test: unexpected upstream call ${method} ${u.pathname}`);
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  t.mock.method(pow, 'solvePOW', async () => 1);
  return calls;
}

function httpJson(port, body, headers = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

function httpGet(port, pathName) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: pathName, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function startServer(t) {
  const server = S.server;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return server.address().port;
}

function useAccounts(t, list) {
  const original = S.accounts.splice(0, S.accounts.length, ...list);
  t.after(() => { S.accounts.splice(0, S.accounts.length, ...original); });
}

test('a DeepSeek 429 finishes on Claude and says so in a header', async (t) => {
  useAccounts(t, [deepseekAccount('ds-1'), claudeAccount('cl-1')]);
  const calls = installBoth(t, {
    deepseek: () => new Response(JSON.stringify({ code: 429, msg: 'too frequent' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } }),
    claude: () => new Response(claudeSse('answered by claude'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  t.after(() => { S.sessions.delete('bridge-e2e'); });
  const port = await startServer(t);

  const res = await httpJson(port, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'name a colour' }] }, { 'x-agent-session': 'bridge-e2e' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, 'answered by claude');
  assert.match(String(res.headers['x-seek-bridge']), /^DeepSeek->Claude; model=claude-haiku-4-5/);
  assert.equal(res.headers['x-account-id'], 'cl-1');
  assert.ok(calls.some(call => /chat_conversations\/conv-1\/completion$/.test(call.path)), 'Claude completion was called');
});

test('a pinned login is never bridged away from', async (t) => {
  useAccounts(t, [deepseekAccount('ds-1'), claudeAccount('cl-1')]);
  const calls = installBoth(t, {
    deepseek: () => new Response(JSON.stringify({ code: 429, msg: 'too frequent' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } }),
    claude: () => new Response(claudeSse('should not be reached'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  t.after(() => { S.sessions.delete('bridge-pinned'); });
  const port = await startServer(t);

  const res = await httpJson(port, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'name a colour' }] }, { 'x-agent-session': 'bridge-pinned', 'x-account-id': 'ds-1' });
  assert.equal(res.status, 429, res.text);
  assert.equal(res.headers['x-seek-bridge'], undefined);
  assert.ok(!calls.some(call => /chat_conversations/.test(call.path)), 'Claude must not be touched for a pinned request');
});

test('an explicit claude/ prefix is an instruction, not a default to override', async (t) => {
  const cooling = claudeAccount('cl-1');
  cooling.cooldownUntil = Date.now() + 120_000;
  useAccounts(t, [cooling, deepseekAccount('ds-1')]);
  const calls = installBoth(t, {
    deepseek: () => new Response('', { status: 500 }),
    claude: () => new Response(claudeSse('should not be reached'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  t.after(() => { S.sessions.delete('bridge-prefix'); });
  const port = await startServer(t);

  const res = await httpJson(port, { model: 'claude/sonnet-4-5', messages: [{ role: 'user', content: 'name a colour' }] }, { 'x-agent-session': 'bridge-prefix' });
  assert.equal(res.status, 429, res.text);
  assert.ok(!calls.some(call => call.path === COMPLETION), 'DeepSeek must not answer a claude/ request');
});

test('a parked pool is bridged before the first hop, with no wasted DeepSeek call', async (t) => {
  const parked = deepseekAccount('ds-1');
  parked.cooldownUntil = Date.now() + 600_000;
  parked.cooldownReason = 'rate_limit';
  useAccounts(t, [parked, claudeAccount('cl-1')]);
  const calls = installBoth(t, {
    deepseek: () => new Response(JSON.stringify({ code: 429, msg: 'too frequent' }), { status: 429, headers: { 'content-type': 'application/json' } }),
    claude: () => new Response(claudeSse('answered by claude without a wasted hop'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  t.after(() => { S.sessions.delete('bridge-preflight'); });
  const port = await startServer(t);

  const res = await httpJson(port, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'name a colour' }] }, { 'x-agent-session': 'bridge-preflight' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, 'answered by claude without a wasted hop');
  assert.match(String(res.headers['x-seek-bridge']), /^DeepSeek->Claude/);
  // The whole point: no PoW solve and no chat create against a pool that cannot answer.
  assert.ok(!calls.some(call => call.path === POW), 'no PoW was solved on the parked pool');
  assert.ok(!calls.some(call => call.path === SESSION_CREATE), 'no chat was created on the parked pool');
  assert.ok(!calls.some(call => call.path === COMPLETION), 'no completion was attempted on the parked pool');
});

test('a parked pool with nothing to bridge to still answers 429, without a wasted hop', async (t) => {
  const parked = deepseekAccount('ds-1');
  parked.cooldownUntil = Date.now() + 600_000;
  parked.cooldownReason = 'rate_limit';
  useAccounts(t, [parked]);
  const calls = installBoth(t, {
    deepseek: () => new Response('', { status: 500 }),
    claude: () => new Response(claudeSse('unreachable'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  t.after(() => { S.sessions.delete('bridge-none'); });
  const port = await startServer(t);

  const res = await httpJson(port, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'name a colour' }] }, { 'x-agent-session': 'bridge-none' });
  assert.equal(res.status, 429, res.text);
  assert.equal(res.json.error.type, 'rate_limit');
  assert.ok(Number(res.headers['retry-after']) > 0, 'a retry hint is still given');
  assert.ok(!calls.some(call => call.path === POW), 'the parked pool was not probed with a PoW');
});

test('a bridge is counted in /health and in the accounts payload', async (t) => {
  useAccounts(t, [deepseekAccount('ds-1'), claudeAccount('cl-1')]);
  installBoth(t, {
    deepseek: () => new Response(JSON.stringify({ code: 429, msg: 'too frequent' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1' } }),
    claude: () => new Response(claudeSse('counted'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  t.after(() => { S.sessions.delete('bridge-stats'); });
  const port = await startServer(t);

  const before = await httpGet(port, '/health');
  const beforeTotal = before.json.bridge ? before.json.bridge.total : 0;

  const res = await httpJson(port, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] }, { 'x-agent-session': 'bridge-stats' });
  assert.equal(res.status, 200, res.text);

  const after = await httpGet(port, '/health');
  assert.equal(after.json.bridge.total, beforeTotal + 1);
  assert.equal(after.json.bridge.last.route, 'deepseek->claude');
  assert.equal(after.json.bridge.last.model, 'claude-haiku-4-5');
  assert.equal(after.json.bridge.by_route['deepseek->claude'] >= 1, true);

  const roster = await httpGet(port, '/admin/accounts');
  assert.equal(roster.json.bridge.total, after.json.bridge.total);
});

// ─── refusal repair across the two pools ───────────────────────────────────
function deepseekSse(text) {
  return `data: ${JSON.stringify({ v: { response: { message_id: 2, fragments: [{ type: 'RESPONSE', content: text }] } } })}\n\n`
    + 'data: {"p":"response/status","v":"FINISHED"}\n\n';
}

test('a refusal that survives every DeepSeek rung is reissued on Claude', async (t) => {
  useAccounts(t, [deepseekAccount('ds-1'), claudeAccount('cl-1')]);
  const calls = installBoth(t, {
    deepseek: () => new Response(deepseekSse("I can't help with that."), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    claude: () => new Response(claudeSse('Here is the complete loader, in full.'), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  t.after(() => { S.sessions.delete('refusal-bridge'); });
  const port = await startServer(t);

  const res = await httpJson(port, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'write the loader' }] }, { 'x-agent-session': 'refusal-bridge' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, 'Here is the complete loader, in full.');
  assert.match(String(res.headers['x-seek-bridge']), /^DeepSeek->Claude; model=claude-haiku-4-5; reason=refusal_repair/);
  // Five rungs on the original side — the fourth is the crescendo, which opens a chat and
  // then closes it — plus the original turn, then exactly one call on the other side.
  assert.equal(calls.filter(call => call.path === COMPLETION).length, 7);
  assert.equal(calls.filter(call => /\/chat_conversations\/conv-1\/completion$/.test(call.path)).length, 1);
});

test('a refusal with no login on the other side is reported, not retried forever', async (t) => {
  useAccounts(t, [deepseekAccount('ds-1')]);
  installBoth(t, {
    deepseek: () => new Response(deepseekSse("I can't help with that."), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    claude: () => { throw new Error('Claude has no login and must not be called'); },
  });
  t.after(() => { S.sessions.delete('refusal-solo'); });
  const port = await startServer(t);

  const res = await httpJson(port, { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'write the loader' }] }, { 'x-agent-session': 'refusal-solo' });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.choices[0].message.content, "I can't help with that.");
  assert.equal(res.headers['x-seek-bridge'], undefined);
});
