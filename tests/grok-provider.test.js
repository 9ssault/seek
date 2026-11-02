// Grok is the third upstream: a grok.com cookie jar (`sso`), its own model registry, and
// the same DeepSeek frame contract every other transport speaks. No live grok.com login
// exists here, so the transport is exercised against a mocked upstream — the point of
// these tests is that the plumbing (detection, routing, bridge, import, model list) is
// real, and that the stream translation accepts every frame shape grok.com is known to
// send rather than only the documented one.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const grokWeb = require('../lib/grok-web');
const S = require('../server.js').__test;

function grokSse(tokens, { conversationId = 'conv-1', responseId = 'resp-1', stop = true } = {}) {
  const frames = [
    `data: ${JSON.stringify({ result: { conversation: { id: conversationId }, response: { modelResponse: { responseId, conversationId } } } })}\n\n`,
    ...tokens.map(token => `data: ${JSON.stringify({ result: { response: { token } } })}\n\n`),
  ];
  if (stop) frames.push(`data: ${JSON.stringify({ result: { response: { isHardStop: true, stopReason: 'end_turn' } } })}\n\n`);
  return frames.join('');
}

async function collect(stream) {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text.split('\n\n').filter(Boolean).map(block => {
    const line = block.split('\n').find(l => l.startsWith('data:'));
    return line ? JSON.parse(line.slice(5).trim()) : null;
  }).filter(Boolean);
}

test('a Grok login is recognised by its jar, and a DeepSeek or Claude jar is not', () => {
  assert.equal(grokWeb.detectProvider({ cookie: 'sso=sso-abc; __cf_bm=1' }), 'grok');
  assert.equal(grokWeb.detectProvider({ provider: 'xai', cookie: 'a=b' }), 'grok');
  assert.equal(grokWeb.detectProvider({ cookie: 'sessionKey=sk-ant' }), 'claude');
  assert.equal(grokWeb.detectProvider({ token: 'tok', cookie: 'sso=x' }), 'deepseek', 'a token always means DeepSeek');
  assert.equal(grokWeb.detectProvider({ cookie: 'ds_session_id=1' }), 'deepseek');

  assert.equal(grokWeb.hasCredentials({ cookie: 'sso=x' }), true);
  assert.equal(grokWeb.hasCredentials({ cookie: 'sessionKey=x' }), false);
});

test('model ids resolve for the aliases an agent sends', () => {
  assert.equal(grokWeb.resolveModel('grok').gateway, 'grok-4');
  assert.equal(grokWeb.resolveModel('grok-4-fast').web, 'grok-4-fast');
  assert.equal(grokWeb.resolveModel('xai/grok-3').gateway, 'grok-3');
  assert.equal(grokWeb.isGrokModel('grok-4-fast'), true);
  assert.equal(grokWeb.isGrokModel('claude-sonnet-4-5'), false);
  assert.equal(grokWeb.isGrokModel('deepseek-v4-flash'), false);
  // An unknown grok id is forwarded, not refused.
  assert.equal(grokWeb.resolveModel('grok-9-preview').web, 'grok-9-preview');
});

test('the stream translation accepts the documented frame and the variants around it', async () => {
  const documented = await collect(grokWeb.translateStream(grokSse(['Hel', 'lo'])));
  assert.equal(documented.map(f => f.p).filter(Boolean).length > 0, true);
  assert.equal(documented.filter(f => f.p === 'response/content').map(f => f.v).join(''), 'Hello');
  assert.equal(documented.find(f => f.p === 'response/finish_reason').v, 'stop');
  assert.ok(documented.some(f => f.response_message_id === 'resp-1'), 'the response id is reported once');

  // A build that renames the field must not empty the answer.
  const renamed = await collect(grokWeb.translateStream([
    `data: ${JSON.stringify({ token: 'A' })}\n\n`,
    `data: ${JSON.stringify({ response: { message: 'B' } })}\n\n`,
  ].join('')));
  assert.equal(renamed.filter(f => f.p === 'response/content').map(f => f.v).join(''), 'AB');

  // A whole message in the first frame is the answer...
  const whole = await collect(grokWeb.translateStream(
    `data: ${JSON.stringify({ result: { modelResponse: { fullMessage: 'C', conversationId: 'c2' } } })}\n\n`,
  ));
  assert.equal(whole.filter(f => f.p === 'response/content').map(f => f.v).join(''), 'C');

  // ...and a closing frame that repeats the whole text must not double the answer.
  const repeated = await collect(grokWeb.translateStream([
    `data: ${JSON.stringify({ result: { response: { token: 'Hello' } } })}\n\n`,
    `data: ${JSON.stringify({ result: { modelResponse: { fullMessage: 'Hello' } } })}\n\n`,
  ].join('')));
  assert.equal(repeated.filter(f => f.p === 'response/content').map(f => f.v).join(''), 'Hello');

  // Thinking blocks are reasoning, never prose in the answer.
  const thinking = await collect(grokWeb.translateStream([
    `data: ${JSON.stringify({ response: { thinking: 'considering' } })}\n\n`,
    `data: ${JSON.stringify({ response: { token: 'answer' } })}\n\n`,
  ].join('')));
  assert.equal(thinking.find(f => f.p === 'response/fragments').v.type, 'THINK');
  assert.doesNotMatch(thinking.filter(f => f.p === 'response/content').map(f => f.v).join(''), /considering/);
});

test('the conversation id is reported so an agent session can continue its chat', async () => {
  const seen = [];
  const stream = grokWeb.translateStream(grokSse(['hi'], { conversationId: 'conv-42' }), {
    onConversation: (id) => seen.push(id),
  });
  await collect(stream);
  assert.deepEqual(seen, ['conv-42']);
});

test('a rejected login is an auth verdict, not a silent success', async () => {
  const probe = await grokWeb.probeLogin({ cookie: 'sso=dead' }, {
    fetchImpl: async () => new Response('{"error":"unauthorized"}', { status: 401 }),
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.kind, 'auth');

  const throttled = await grokWeb.probeLogin({ cookie: 'sso=busy' }, {
    fetchImpl: async () => new Response('slow down', { status: 429, headers: { 'retry-after': '17' } }),
  });
  assert.equal(throttled.kind, 'ratelimit');
  assert.equal(throttled.retryAfterSec, 17);

  const nonJson = await grokWeb.probeLogin({ cookie: 'sso=ok' }, {
    fetchImpl: async () => new Response('<html>signed in</html>', { status: 200 }),
  });
  assert.equal(nonJson.ok, true, 'a moved endpoint must not mark a good login dead');
  assert.equal(nonJson.kind, 'unverified');
});

test('the server routes Grok ids to Grok only when a Grok login exists', () => {
  assert.equal(S.resolveProvider('grok-4', { grokReady: false }), 'deepseek');
  assert.equal(S.resolveProvider('grok-4', { grokReady: true }), 'grok');
  assert.equal(S.resolveProvider('xai/grok-4', { grokReady: false }), 'grok', 'an explicit prefix is an instruction');
  assert.equal(S.resolveProvider('claude-sonnet-4-5', { grokReady: true, claudeReady: true }), 'claude');
  assert.match(S.resolveModelConfig('grok-4', 'grok').real_model, /Grok/);
  assert.equal(S.providerModelIds('grok').includes('grok-4'), true);
});

test('the bridge maps between Grok and the other pools by class', () => {
  assert.equal(S.bridgeModelFor('deepseek-v4-flash-thinking', 'grok'), 'grok-4');
  assert.equal(S.bridgeModelFor('deepseek-v4-flash', 'grok'), 'grok-4-fast');
  assert.equal(S.bridgeModelFor('grok-4', 'deepseek'), 'deepseek-v4-flash-thinking');
  assert.equal(S.bridgeModelFor('grok-4-fast', 'deepseek'), 'deepseek-v4-flash');
  assert.equal(S.bridgeModelFor('grok-4', 'claude'), 'claude-sonnet-4-5');
  assert.equal(S.alternateProvider('grok'), 'deepseek');
});

test('a Grok import verifies the jar and stores it under its own provider', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-import-'));
  const previous = process.env.DEEPSEEK_AUTH_DIR;
  process.env.DEEPSEEK_AUTH_DIR = dir;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ user: { email: 'g@example.com' } }), { status: 200 });
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.DEEPSEEK_AUTH_DIR;
    else process.env.DEEPSEEK_AUTH_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const result = await S.adminImportAccount({ name: 'grok-main', auth: { provider: 'grok', cookie: 'sso=sso-1; __cf_bm=bm' } });
  assert.equal(result.account.provider, 'grok');
  const written = JSON.parse(fs.readFileSync(result.account.file, 'utf8'));
  assert.equal(written.provider, 'grok', 'the file says which upstream it belongs to');
  assert.match(written.cookie, /sso=sso-1/);

  await assert.rejects(
    () => S.adminImportAccount({ name: 'grok-bad', auth: { provider: 'grok', cookie: 'cf_clearance=only' } }),
    (e) => e.status === 422 && /sso/.test(e.message),
  );
});

// The whole path: one OpenAI-shaped request, a Grok jar in the pool, a mocked grok.com.
test('a chat completion served by Grok comes back as OpenAI chunks', async (t) => {
  const server = S.server;
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, body: options.body ? JSON.parse(options.body) : null });
    if (u.pathname === '/rest/app-chat/conversations/new') {
      return new Response(grokSse(['Hello ', 'from ', 'Grok']), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`grok test: unexpected upstream call ${u.pathname}`);
  };
  const previous = S.accounts.splice(0, S.accounts.length, {
    id: 'grok-1', provider: 'grok', file: '/tmp/grok-test/g1.json',
    config: { provider: 'grok', cookie: 'sso=sso-1' },
    cooldownUntil: 0, failures: 0, lastUsedAt: 0,
  });
  t.after(() => {
    globalThis.fetch = originalFetch;
    S.accounts.splice(0, S.accounts.length, ...previous);
    S.sessions.delete('grok-e2e');
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const payload = JSON.stringify({ model: 'grok-4', messages: [{ role: 'user', content: 'name a colour' }] });

  const res = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-agent-session': 'grok-e2e' },
    }, (r) => {
      let text = '';
      r.setEncoding('utf8');
      r.on('data', c => { text += c; });
      r.on('end', () => resolve({ status: r.statusCode, text }));
    });
    req.on('error', reject);
    req.end(payload);
  });

  assert.equal(res.status, 200, res.text);
  assert.match(res.text, /Hello from Grok/);
  assert.equal(calls[0].path, '/rest/app-chat/conversations/new');
  assert.equal(calls[0].body.modelName, 'grok-4');
});
