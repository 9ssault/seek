'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const claudeWeb = require('../lib/claude-web');
const accountsDir = require('../lib/accounts-dir');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'seek-claude-'));
}

function streamOf(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function framesFrom(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return text.split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
}

test('a login is Claude only when it says so or carries a sessionKey cookie', () => {
  assert.equal(claudeWeb.detectProvider({ provider: 'claude', cookie: 'sessionKey=abc' }), 'claude');
  assert.equal(claudeWeb.detectProvider({ cookie: 'a=1; sessionKey=abc' }), 'claude');
  assert.equal(claudeWeb.detectProvider({ token: 'x', cookie: 'a=1' }), 'deepseek');
  assert.equal(claudeWeb.detectProvider({ provider: 'deepseek', token: 'x', cookie: 'sessionKey=abc' }), 'deepseek');
  assert.equal(claudeWeb.detectProvider({}), 'deepseek');
});

test('normalizeConfig keeps a cookie jar as a string and settles the model id', () => {
  const config = claudeWeb.normalizeConfig({
    provider: 'claude',
    cookies: [{ name: 'sessionKey', value: 'abc' }, { name: 'cf_clearance', value: 'z' }],
    model: 'sonnet',
    organization_uuid: 'org-9',
  });
  assert.equal(config.provider, 'claude');
  assert.equal(config.cookie, 'sessionKey=abc; cf_clearance=z');
  assert.equal(config.cookies, undefined);
  assert.equal(config.org, 'org-9');
  assert.equal(config.model, 'claude-sonnet-4-5');
});

test('model aliases resolve to the dated web ids, unknown dated ids pass through', () => {
  assert.equal(claudeWeb.resolveModel('sonnet').web, 'claude-sonnet-4-5-20250929');
  assert.equal(claudeWeb.resolveModel('anthropic/claude-opus-4-1').web, 'claude-opus-4-1-20250805');
  assert.equal(claudeWeb.resolveModel('claude-haiku-4-5[1m]').gateway, 'claude-haiku-4-5');
  assert.equal(claudeWeb.resolveModel('claude-3-7-sonnet-20250219').web, 'claude-3-7-sonnet-20250219');
});

test('Claude SSE becomes the gateway frames, text and thinking kept apart', async () => {
  const body = streamOf([
    'event: message_start\ndata: {"type":"message_start","message":{"uuid":"msg-1"}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"weighing it"}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    'data: {"type":"message_stop"}\n\n',
  ]);
  const frames = await framesFrom(claudeWeb.translateStream(body));
  assert.deepEqual(frames[0], { response_message_id: 'msg-1' });
  assert.deepEqual(frames[1], { p: 'response/content', v: 'Hello' });
  assert.deepEqual(frames[2], { p: 'response/fragments', v: { type: 'THINK', content: 'weighing it' } });
  assert.deepEqual(frames[3], { p: 'response/content', v: ' world' });
  assert.deepEqual(frames[4], { p: 'response/finish_reason', v: 'stop' });
  assert.deepEqual(frames[5], { p: 'response/status', v: 'FINISHED' });
});

test('a truncated or legacy stream still ends with a finish reason', async () => {
  const legacy = await framesFrom(claudeWeb.translateStream(streamOf([
    'data: {"completion":"half an answer"}\n\n',
  ])));
  assert.deepEqual(legacy[0], { p: 'response/content', v: 'half an answer' });
  assert.deepEqual(legacy[1], { p: 'response/finish_reason', v: 'stop' });
  assert.deepEqual(legacy[2], { p: 'response/status', v: 'FINISHED' });

  const errored = await framesFrom(claudeWeb.translateStream(streamOf([
    'data: {"type":"error","error":{"type":"overloaded_error","message":"overloaded"}}\n\n',
  ])));
  assert.deepEqual(errored[0], { type: 'error', content: 'overloaded' });
  assert.deepEqual(errored[1], { p: 'response/finish_reason', v: 'error' });
});

test('stop reasons map onto the finish reasons the rest of the gateway knows', () => {
  assert.equal(claudeWeb.finishReasonFor('max_tokens'), 'length');
  assert.equal(claudeWeb.finishReasonFor('tool_use'), 'tool_calls');
  assert.equal(claudeWeb.finishReasonFor('end_turn'), 'stop');
  assert.equal(claudeWeb.finishReasonFor(undefined), 'stop');
});

test('HTTP failures are classified so the pool can tell auth from throttling', () => {
  assert.equal(claudeWeb.classifyStatus(401, '').type, 'authentication_error');
  assert.equal(claudeWeb.classifyStatus(403, '<title>Just a moment...</title>').type, 'waf_blocked');
  assert.equal(claudeWeb.classifyStatus(429, '', '42').retryAfter, 42);
  assert.equal(claudeWeb.classifyStatus(500, '').type, 'upstream_error');
});

test('the client walks organisations, creates a conversation and streams a turn', async (t) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, body: null, cookie: req.headers.cookie, platform: req.headers['anthropic-client-platform'] });
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      seen[seen.length - 1].body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
      if (req.url === '/api/organizations') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([{ uuid: 'org-1', capabilities: ['chat'] }, { uuid: 'org-2', capabilities: ['api'] }]));
        return;
      }
      if (req.url === '/api/organizations/org-1/chat_conversations') {
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ uuid: 'conv-1' }));
        return;
      }
      if (req.url === '/api/organizations/org-1/chat_conversations/conv-1/completion') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"type":"message_start","message":{"uuid":"msg-1"}}\n\n');
        res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"done"}}\n\n');
        res.write('data: {"type":"message_stop"}\n\n');
        res.end();
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { CLAUDE_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const config = claudeWeb.normalizeConfig({ provider: 'claude', cookie: 'sessionKey=abc' });

  const list = await claudeWeb.listOrganizations(config, { env });
  assert.equal(claudeWeb.pickOrganization(list).uuid, 'org-1');
  assert.equal(await claudeWeb.resolveOrganization(config, { env }), 'org-1');

  const conversation = await claudeWeb.createConversation(config, 'org-1', { env });
  assert.equal(conversation, 'conv-1');

  const { stream, model } = await claudeWeb.completeStream({
    config, org: 'org-1', conversationId: conversation,
    parentMessageUuid: claudeWeb.ROOT_MESSAGE_UUID,
    prompt: 'hello', model: 'claude-sonnet-4-5', env,
  });
  const frames = await framesFrom(stream);
  assert.deepEqual(frames[0], { response_message_id: 'msg-1' });
  assert.deepEqual(frames[1], { p: 'response/content', v: 'done' });
  assert.equal(model.web, 'claude-sonnet-4-5-20250929');

  const completion = seen.find(entry => entry.url.endsWith('/completion'));
  assert.equal(completion.body.prompt, 'hello');
  assert.equal(completion.body.model, 'claude-sonnet-4-5-20250929');
  assert.equal(completion.body.parent_message_uuid, claudeWeb.ROOT_MESSAGE_UUID);
  assert.equal(completion.body.rendering_mode, 'messages');
  assert.equal(completion.cookie, 'sessionKey=abc');
  assert.equal(completion.platform, 'web_claude_ai');
});

test('an expired cookie is an error the pool can fail over on, not a silent empty answer', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'session expired' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { CLAUDE_BASE_URL: `http://127.0.0.1:${server.address().port}` };
  const config = claudeWeb.normalizeConfig({ provider: 'claude', cookie: 'sessionKey=stale' });
  await assert.rejects(
    () => claudeWeb.listOrganizations(config, { env }),
    (error) => error instanceof claudeWeb.ClaudeWebError && error.status === 401 && error.type === 'authentication_error',
  );
});

test('the server routes Claude ids to Claude only when a Claude login exists', () => {
  const { resolveProvider, resolveModelConfig, claudeWeb: wired } = require('../server.js').__test;
  assert.equal(wired, claudeWeb);
  // No Claude account: the old behaviour, so an existing Claude Code setup keeps working.
  assert.equal(resolveProvider('claude-sonnet-4-5', { claudeReady: false }), 'deepseek');
  assert.equal(resolveProvider('claude-sonnet-4-5', { claudeReady: true }), 'claude');
  assert.equal(resolveProvider('claude-opus-4-1', { claudeReady: true }), 'claude');
  assert.equal(resolveProvider('deepseek-v4-flash', { claudeReady: true }), 'deepseek');
  // An explicit prefix is an instruction, not a hint.
  assert.equal(resolveProvider('claude/sonnet', { claudeReady: false }), 'claude');
  assert.equal(resolveProvider('anthropic/claude-haiku-4-5', { claudeReady: false }), 'claude');

  assert.match(resolveModelConfig('claude-sonnet-4-5', 'claude').real_model, /Claude/);
  assert.equal(resolveModelConfig('claude-3-7-sonnet-20250219', 'claude').web_model, 'claude-3-7-sonnet-20250219');
  assert.equal(resolveModelConfig('claude-sonnet-4-5').real_model, 'DeepSeek-V4.1-Flash (web search)');
});

test('the store prefers the shared directory, honours a legacy one, and never invents files', () => {
  const home = tmpdir();
  const root = tmpdir();
  try {
    const env = { SEEK_HOME: path.join(home, '.seek') };
    // Neither directory has logins: the shared one is where the next capture goes.
    assert.equal(accountsDir.resolveAccountsDir({ root, env, home }), path.join(home, '.seek', 'accounts'));

    // An older in-tree store keeps being served until it is adopted.
    fs.mkdirSync(path.join(root, 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'accounts', 'a.json'), '{}');
    assert.equal(accountsDir.resolveAccountsDir({ root, env, home }), path.join(root, 'accounts'));

    // Once the shared store holds logins it wins, so every checkout agrees.
    fs.mkdirSync(path.join(home, '.seek', 'accounts'), { recursive: true });
    fs.writeFileSync(path.join(home, '.seek', 'accounts', 'b.json'), '{}');
    assert.equal(accountsDir.resolveAccountsDir({ root, env, home }), path.join(home, '.seek', 'accounts'));

    // An explicit override still beats everything.
    assert.equal(
      accountsDir.resolveAccountsDir({ root, env: { ...env, DEEPSEEK_AUTH_DIR: path.join(home, 'x') }, home }),
      path.join(home, 'x'),
    );
    assert.match(accountsDir.describeStore(path.join(home, '.seek', 'accounts'), { home, env }), /~\/\.seek\/accounts \(1 login file\)/);
    assert.match(accountsDir.describeStore(path.join(home, 'empty'), { home, env }), /npm run auth/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A Cloudflare challenge is the single most common false "your login is dead" report:
// claude.ai answers 403 with a "Just a moment…" page when it wants a browser check, and
// the cookie is still perfectly valid. It must read as `waf`, never as `auth`.
test('a Cloudflare challenge is a retryable block, not a rejected cookie', async () => {
  const challenge = '<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>';
  const probe = await claudeWeb.probeLogin({ cookie: 'sessionKey=sk-ant-ok' }, {
    fetchImpl: async () => new Response(challenge, { status: 403, headers: { 'content-type': 'text/html' } }),
  });
  assert.equal(probe.ok, false);
  assert.equal(probe.kind, 'waf');
  assert.equal(probe.waf, true);

  // A real 401 is still an auth failure.
  const dead = await claudeWeb.probeLogin({ cookie: 'sessionKey=sk-ant-dead' }, {
    fetchImpl: async () => new Response('{"error":{"type":"authentication_error"}}', { status: 401 }),
  });
  assert.equal(dead.kind, 'auth');
  assert.equal(dead.waf, false);
});

test('a Cloudflare-challenged Claude turn cools down without being marked dead', () => {
  const { markClaudeFailure } = require('../server.js').__test;
  const account = { id: 'cl', provider: 'claude', config: { cookie: 'sessionKey=x' }, cooldownUntil: 0, failures: 0 };
  markClaudeFailure(account, 403, 'Claude answered HTTP 403: <title>Just a moment...</title>');
  assert.notEqual(account.invalid, true, 'a challenge must not mark the login dead');
  assert.equal(account.cooldownReason, 'waf');
  assert.ok(account.cooldownUntil > Date.now(), 'it still backs off');

  const dead = { id: 'cl2', provider: 'claude', config: { cookie: 'sessionKey=y' }, cooldownUntil: 0, failures: 0 };
  markClaudeFailure(dead, 401, 'Claude answered HTTP 401: authentication_error');
  assert.equal(dead.invalid, true, 'a real 401 does mark it dead');
});
