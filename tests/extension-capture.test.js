// The Chrome extension is the minter for accounts/*.json, so its capture rules are
// tested against the real background.js: it must take the token DeepSeek actually
// authenticates with (the observed Authorization header) and refuse a token the API
// rejects, instead of exporting a localStorage guess that answers INVALID_TOKEN.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const BACKGROUND = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'background.js'), 'utf8');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'chrome-extension', 'manifest.json'), 'utf8'));

function loadBackground({ cookies = [], stores = {}, fetchImpl } = {}) {
  const listeners = {};
  const written = {};
  const removedCookies = [];
  const navigations = [];
  const pageCalls = [];
  const fetches = [];
  const chrome = {
    runtime: {
      id: 'test', lastError: null,
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      sendMessage() {},
      getManifest: () => ({ version: MANIFEST.version }),
    },
    storage: { local: { set: (obj) => { Object.assign(written, obj); return Promise.resolve(); }, get() {} } },
    webRequest: { onBeforeSendHeaders: { addListener: (fn) => { listeners.headers = fn; } } },
    cookies: {
      getAll: (options, cb) => cb(cookies),
      remove: (details, cb) => { removedCookies.push(details); cb({ name: details.name }); },
    },
    scripting: {
      executeScript: async (options) => {
        // world:'MAIN' is the page patch/clear path; the collect path reads stores.
        if (options?.world === 'MAIN') pageCalls.push(options);
        return [{ result: options?.world === 'MAIN' ? true : stores }];
      },
    },
    tabs: {
      query: (query, cb) => { if (cb) cb([{ id: 7, active: true, url: 'https://chat.deepseek.com/' }]); },
      sendMessage() {}, create() {},
      update: async (id, info) => { navigations.push({ id, url: info?.url }); },
      onUpdated: { addListener() {}, removeListener() {} },
    },
  };
  const context = vm.createContext({
    chrome,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
    fetch: async (...args) => { fetches.push(args); return fetchImpl ? fetchImpl(...args) : (() => { throw new Error('no network in test'); })(); },
  });
  vm.runInContext(BACKGROUND, context, { filename: 'background.js' });
  return { context, listeners, written, removedCookies, navigations, pageCalls, fetches };
}

const USER = JSON.stringify({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '', biz_data: { id: 'user-1', email: 'me@example.com', mobile: null } } });
const INVALID = JSON.stringify({ code: 40003, msg: 'INVALID_TOKEN', data: null });

test('the observed Authorization header wins over a token-shaped localStorage value', () => {
  const { context, listeners } = loadBackground();
  listeners.headers({
    requestHeaders: [
      { name: 'authorization', value: 'Bearer HEADER-TOKEN' },
      { name: 'x-hif-dliq', value: 'HD-1' },
      { name: 'x-hif-leim', value: 'HL-1' },
    ],
  });
  const observed = context.freshObservedHeaders();
  assert.equal(observed.token, 'HEADER-TOKEN');
  assert.equal(observed.hif_dliq, 'HD-1');

  const chosen = context.chooseToken([{ userToken: 'STORAGE-TOKEN' }], observed);
  assert.equal(chosen.source, 'header');
  assert.equal(chosen.token, 'HEADER-TOKEN', 'the header is what DeepSeek authenticates, not the guess');
});

test('a stale header capture falls back to storage, and a cookie token is the last resort', () => {
  const { context, listeners } = loadBackground();
  listeners.headers({ requestHeaders: [{ name: 'authorization', value: 'Bearer OLD' }] });
  // 11 minutes later the remembered header is too old to trust.
  const later = Date.now() + 11 * 60 * 1000;
  assert.equal(context.freshObservedHeaders(later), null);
  assert.equal(context.chooseToken([{ userToken: 'FROM-STORAGE' }], null).source, 'storage');
  assert.equal(context.chooseToken([{}], null, 'FROM-COOKIE').source, 'cookie');
  assert.equal(context.chooseToken([{}], null, '').source, 'none');
});

test('a capture DeepSeek rejects is marked unusable instead of exported', async () => {
  const { context, written } = loadBackground({
    cookies: [{ name: 'ds_session_id', value: 'sess', domain: '.deepseek.com' }, { name: 'aws-waf-token', value: 'waf', domain: '.deepseek.com' }],
    stores: { localStorage: { userToken: 'BAD-TOKEN' }, sessionStorage: {} },
    fetchImpl: async () => new Response(INVALID, { status: 200 }),
  });
  const auth = await context.collectAndStore(1);
  assert.equal(auth._verified, false);
  assert.match(auth._error, /INVALID_TOKEN|rejected/i);
  assert.equal(auth.token, 'BAD-TOKEN');
  assert.equal(written.deepseek_auth._verified, false, 'the stored session keeps the failure visible');
});

test('a verified capture takes the identity and the header hif pair', async () => {
  const seen = [];
  const { context, listeners } = loadBackground({
    cookies: [
      { name: 'ds_session_id', value: 'sess', domain: '.deepseek.com' },
      { name: 'smidV2', value: 'dev', domain: 'chat.deepseek.com' },
    ],
    stores: { localStorage: { userToken: 'LOCAL-TOKEN' }, sessionStorage: {} },
    fetchImpl: async (url, options) => {
      seen.push({ url, headers: options.headers });
      return new Response(USER, { status: 200 });
    },
  });
  listeners.headers({
    requestHeaders: [
      { name: 'Authorization', value: 'Bearer LIVE-TOKEN' },
      { name: 'X-Hif-Dliq', value: 'HD-LIVE' },
      { name: 'X-Hif-Leim', value: 'HL-LIVE' },
    ],
  });

  const auth = await context.collectAndStore(1);
  assert.equal(auth._verified, true);
  assert.equal(auth._unverified, false);
  assert.equal(auth.token, 'LIVE-TOKEN');
  assert.equal(auth.hif_dliq, 'HD-LIVE');
  assert.equal(auth.hif_leim, 'HL-LIVE');
  assert.equal(auth.email, 'me@example.com');
  assert.equal(auth._userId, 'user-1');
  assert.match(seen[0].url, /\/api\/v0\/users\/current$/);
  assert.equal(seen[0].headers.Authorization, 'Bearer LIVE-TOKEN');
  assert.match(seen[0].headers.Cookie, /ds_session_id=sess/);
});

test('an offline capture is kept but reported as unverified, never as rejected', async () => {
  const { context } = loadBackground({
    cookies: [{ name: 'ds_session_id', value: 'sess', domain: '.deepseek.com' }],
    stores: { localStorage: { userToken: 'TOK' }, sessionStorage: {} },
    fetchImpl: async () => { throw new Error('EAI_AGAIN'); },
  });
  const auth = await context.collectAndStore(1);
  assert.equal(auth._verified, true);
  assert.equal(auth._unverified, true);
});

test('signing out clears the browser session without making a server logout call', async () => {
  const env = loadBackground({
    cookies: [
      { name: 'ds_session_id', value: 'sess', domain: '.deepseek.com', path: '/' },
      { name: 'smidV2', value: 'dev', domain: 'chat.deepseek.com', path: '/' },
    ],
    stores: { localStorage: {}, sessionStorage: {} },
  });
  env.listeners.headers({ requestHeaders: [{ name: 'authorization', value: 'Bearer LIVE' }] });
  assert.equal(env.context.freshObservedHeaders().token, 'LIVE');

  const result = await env.context.signOutDeepSeek();

  assert.equal(result.success, true);
  assert.equal(result.cookiesRemoved, 2);
  assert.deepEqual(env.removedCookies.map((c) => c.name).sort(), ['ds_session_id', 'smidV2']);
  assert.equal(env.removedCookies[0].url, 'https://deepseek.com/');
  assert.equal(env.removedCookies[1].url, 'https://chat.deepseek.com/');
  assert.equal(env.pageCalls.length, 1, 'localStorage is cleared in the page');
  assert.deepEqual(env.navigations, [{ id: 7, url: 'https://chat.deepseek.com/sign_in' }]);
  assert.equal(env.context.freshObservedHeaders(), null, 'a stale header can never be captured later');
  assert.equal(env.fetches.length, 0, 'no server-side logout: the imported token must stay valid');
});

test('the sign-out toggle is on by default, persisted, and gates the push sign-out', () => {
  const html = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.html'), 'utf8');
  const popup = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');
  assert.match(html, /<input type="checkbox" id="chkSignOut" checked>/, 'on by default');
  assert.match(popup, /const SIGN_OUT_KEY = 'sign_out_after_push'/);
  assert.match(popup, /if \(res\.status === 201 && signOutAfterPush && provider === 'deepseek'\)/, 'an unchecked toggle keeps the session, and a Claude push never signs the browser out of claude.ai');
  assert.match(popup, /chrome\.storage\.local\.set\(\{ \[SIGN_OUT_KEY\]: signOutAfterPush \}\)/, 'the choice persists');
});

test('the popup reports the capture source and the verification verdict', () => {
  const popup = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');
  assert.match(popup, /SOURCE_LABEL = \{ header: 'Live header', storage: 'Page storage'/);
  assert.match(popup, /source\._tokenSource/);
  assert.match(popup, /unverified \(offline\)/);
  const html = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.html'), 'utf8');
  assert.match(html, /id="rowSource"/);
});

test('the push signs the browser out only for a newly created account', () => {
  const popup = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');
  assert.match(popup, /if \(res\.status === 201 && signOutAfterPush && provider === 'deepseek'\)/, 'only a 201 means the account was added');
  assert.match(popup, /send\('signOut'\)/);
  assert.match(popup, /Pushed and signed out/);
});

test('the extension requests the webRequest permission its header capture needs', () => {
  assert.ok(MANIFEST.permissions.includes('webRequest'), 'manifest must grant webRequest');
  assert.ok(MANIFEST.host_permissions.includes('https://chat.deepseek.com/*'));
  assert.ok(MANIFEST.host_permissions.includes('https://claude.ai/*'), 'a Claude capture needs claude.ai');
  assert.match(BACKGROUND, /onBeforeSendHeaders/);
  assert.match(BACKGROUND, /extraHeaders/, 'without extraHeaders Chrome hides Authorization');
});

test('the popup refuses to export a rejected capture', () => {
  const popup = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');
  assert.match(popup, /source\._verified === false/);
  assert.match(popup, /Token rejected by DeepSeek/);
  assert.match(popup, /const ready\s+= \(claude \? cookieHasSessionKey\(auth\.cookie\) : !!\(auth\.token && auth\.cookie\)\) && !rejected/);
});

test('a claude.ai capture keeps the cookie jar and verifies it against the real login', async () => {
  const { context, written, fetches } = loadBackground({
    cookies: [
      { name: 'sessionKey', value: 'sk-ant-SECRET', domain: '.claude.ai' },
      { name: 'cf_clearance', value: 'cf-1', domain: '.claude.ai' },
      { name: 'timezone', value: 'Europe/Berlin', domain: 'claude.ai' },
      // A DeepSeek cookie in the same browser store must never leak into the Claude jar.
      { name: 'ds_session_id', value: 'ds', domain: '.deepseek.com' },
    ],
    fetchImpl: async () => new Response(JSON.stringify([{ uuid: 'org-1', name: 'Personal' }]), { status: 200 }),
  });

  const auth = await context.collectClaude();
  assert.equal(auth.provider, 'claude');
  assert.equal(auth._verified, true);
  assert.equal(auth.org, 'org-1');
  assert.equal(auth.name, 'Personal');
  assert.match(auth.cookie, /sessionKey=sk-ant-SECRET/);
  assert.match(auth.cookie, /cf_clearance=cf-1/);
  assert.doesNotMatch(auth.cookie, /ds_session_id/);
  assert.match(fetches[0][0], /^https:\/\/claude\.ai\/api\/organizations$/);
  assert.equal(fetches[0][1].credentials, 'include', 'the jar is what authenticates, so the browser must send it');
  assert.equal(written.claude_auth._verified, true, 'stored under its own key, not the DeepSeek slot');
});

test('a claude.ai capture without sessionKey, or one it rejects, is never marked usable', async () => {
  const empty = loadBackground({ cookies: [{ name: 'cf_clearance', value: 'cf', domain: '.claude.ai' }] });
  const missing = await empty.context.collectClaude();
  assert.equal(missing._verified, false);
  assert.match(missing._error, /Not signed in/i);
  // "Not signed in" alone leaves the user guessing; name the cookies that were readable.
  assert.match(missing._error, /cf_clearance/, 'the message lists the jar it did read');
  assert.equal(missing._cookies, 1);

  const rejected = loadBackground({
    cookies: [{ name: 'sessionKey', value: 'stale', domain: '.claude.ai' }],
    fetchImpl: async () => new Response('{"error":"unauthorized"}', { status: 401 }),
  });
  const auth = await rejected.context.collectClaude();
  assert.equal(auth._verified, false);
  assert.match(auth._error, /401/);
  assert.equal(rejected.written.claude_auth._verified, false);
});

test('a jar holding only non-session cookies is named, not guessed at', async () => {
  const { context } = loadBackground({
    cookies: [
      { name: 'lastActiveOrg', value: 'org-1', domain: '.claude.ai' },
      { name: '__cf_bm', value: 'bm', domain: '.claude.ai' },
    ],
  });
  const auth = await context.collectClaude();
  assert.equal(auth._verified, false);
  assert.match(auth._error, /read 2 cookies \(lastActiveOrg, __cf_bm\)/);
  assert.match(auth._error, /no sessionKey/);
});

function loadPopup(stored, { provider = 'claude' } = {}) {
  const sent = [];
  const rendered = {};
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id, textContent: '', className: '', hidden: false, disabled: false,
        dataset: {}, classList: { toggle() {}, add() {}, remove() {} },
        setAttribute() {}, removeAttribute() {}, addEventListener() {},
      });
    }
    return elements.get(id);
  };
  const document = {
    getElementById: el,
    querySelector: () => null,
    querySelectorAll: (sel) => (sel === '.provider-btn'
      ? [{ dataset: { provider: 'deepseek' }, classList: { toggle() {} }, setAttribute() {}, addEventListener() {} },
        { dataset: { provider: 'claude' }, classList: { toggle() {} }, setAttribute() {}, addEventListener() {} }]
      : []),
  };
  const chrome = {
    runtime: {
      id: 'test', lastError: null,
      getManifest: () => ({ version: MANIFEST.version }),
      sendMessage(message, cb) {
        sent.push(message);
        if (message.action === 'ping') { cb({ success: true, build: MANIFEST.version }); return; }
        if (message.action === 'export') { cb({ success: true, auth: stored }); return; }
        cb({ success: true });
      },
    },
    storage: { local: { get() {}, set: () => Promise.resolve() } },
  };
  const context = vm.createContext({
    chrome, document, console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
    navigator: { clipboard: { writeText: async () => {} } }, window: { setTimeout },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8'), context, { filename: 'popup.js' });
  vm.runInContext(`setProvider(${JSON.stringify(provider)})`, context);
  return { context, sent, el, rendered };
}

test('a DeepSeek session stored under the Claude key is cleared, never exported', async () => {
  const { sent, el } = loadPopup({
    provider: 'deepseek', token: '', _tokenSource: 'header', _verified: true,
    name: 'w**@tuta.io', cookie: 'ds_session_id=abc', _lastUpdated: '2026-01-01T00:00:00Z',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(sent.some((m) => m.action === 'forget' && m.provider === 'claude'), 'the foreign record is dropped');
  assert.equal(el('btnPush').disabled, true, 'nothing can be pushed from a cleared record');
  assert.match(el('calloutTitle').textContent, /No claude\.ai session/);
});

test('a stored jar without sessionKey reports the cookies it holds instead of "Session not found"', async () => {
  const { el, sent } = loadPopup({
    provider: 'claude', cookie: 'lastActiveOrg=org-1', _lastUpdated: '2026-01-01T00:00:00Z', _verified: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.some((m) => m.action === 'forget'), false, 'an honest Claude record is kept');
  assert.match(el('calloutBody').textContent, /lastActiveOrg/);
  assert.match(el('calloutBody').textContent, /no sessionKey/);
});

test('a row marked hidden really disappears, which is what kept DeepSeek rows on the Claude tab', () => {
  const css = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/, '`display` on .check/.toggle overrides the bare [hidden] UA rule');
});

test('a pasted jar is parsed from a cookie line, a Cookie: header, or JSON', () => {
  const { context } = loadBackground({});
  const parse = context.parsePastedJar;
  const plain = parse('sessionKey=sk-ant-1; cf_clearance=cf-1');
  assert.equal(plain.sessionKey, 'sk-ant-1');
  assert.deepEqual([...plain.names], ['sessionKey', 'cf_clearance'], 'the parsed jar crosses the vm realm');

  const header = parse('Cookie: sessionKey=sk-ant-2; lastActiveOrg=org-2');
  assert.equal(header.sessionKey, 'sk-ant-2', 'a copied header line is accepted');
  assert.doesNotMatch(header.cookie, /^Cookie:/i);

  const fromJson = parse(JSON.stringify([{ name: 'sessionKey', value: 'sk-ant-3' }, { name: 'cf_clearance', value: 'cf' }]));
  assert.equal(fromJson.sessionKey, 'sk-ant-3');
  assert.equal(fromJson.cookie, 'sessionKey=sk-ant-3; cf_clearance=cf');

  assert.equal(parse('lastActiveOrg=org-only').sessionKey, '', 'a jar with no sessionKey is refused downstream');
  assert.equal(parse('').cookie, '');
});

function messageSender(env) {
  return (request) => new Promise((resolve) => {
    const answered = env.listeners.message(request, {}, resolve);
    setTimeout(() => resolve(undefined), 50);
    void answered;
  });
}

// The popup reported "The message port closed before a response was received": a worker
// that returns without answering. Both sides are fixed — the worker always answers, and a
// popup that meets a silent worker says so instead of failing anonymously.
test('the worker answers every message, including one it does not know', async () => {
  const env = loadBackground({});
  const send = messageSender(env);

  const ping = await send({ action: 'ping' });
  assert.equal(ping.success, true);
  assert.equal(ping.build, MANIFEST.version, 'the worker reports the version it was loaded from');

  const unknown = await send({ action: 'somethingFromANewerBuild' });
  assert.equal(unknown.success, false);
  assert.match(unknown.error, /does not handle "somethingFromANewerBuild"/);
  assert.match(unknown.error, /Reload/);
});

test('a pasted jar is verified and stored through the same key as a capture', async () => {
  const env = loadBackground({
    fetchImpl: async () => new Response(JSON.stringify([{ uuid: 'org-9', name: 'Pasted' }]), { status: 200 }),
  });
  const send = messageSender(env);

  const refused = await send({ action: 'setClaudeCookie', cookie: 'lastActiveOrg=only' });
  assert.equal(refused.success, false);
  assert.match(refused.error, /no sessionKey/);

  const ok = await send({ action: 'setClaudeCookie', cookie: 'sessionKey=sk-ant-paste; cf_clearance=cf' });
  assert.equal(ok.success, true);
  assert.equal(ok.auth.provider, 'claude');
  assert.equal(ok.auth.org, 'org-9');
  assert.equal(ok.auth._source, 'pasted');
  assert.equal(env.written.claude_auth._verified, true, 'stored under the Claude key');
});

test('a stale worker is reported, not shown as a failed capture', () => {
  const popup = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');
  assert.match(popup, /message port closed/);
  assert.match(popup, /if \(WORKER_GONE\.test\(String\(err\.message \|\| ''\)\)\) \{ resolve\(undefined\); return; \}/);
  assert.match(popup, /async function checkWorkerBuild\(\)/);
  assert.match(popup, /The popup is v\$\{workerMismatch\.popup\} but the background worker is still v\$\{workerMismatch\.worker\}/);
});

test('the Claude tab offers a paste path for a jar the cookies API cannot see', () => {
  const html = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.html'), 'utf8');
  const popup = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');
  assert.match(html, /id="pasteSection"/);
  assert.match(html, /id="pasteCookie"/);
  assert.match(popup, /els\.pasteSection\.hidden = provider !== 'claude'/);
  assert.match(popup, /send\('setClaudeCookie', \{ cookie \}\)/);
});

test('every extension file still parses', () => {
  for (const file of ['background.js', 'content.js', 'popup.js']) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(ROOT, 'chrome-extension', file), 'utf8')), file);
  }
});

test('a capture can be pushed without a second press, and the choice persists', () => {
  const html = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.html'), 'utf8');
  const popup = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');
  assert.match(html, /<input type="checkbox" id="chkAutoPush" checked>/, 'on by default');
  assert.match(popup, /autoPushOnCapture && exportReady\(\) && !els\.btnPush\.disabled\) els\.btnPush\.click\(\)/);
  assert.match(popup, /chrome\.storage\.local\.set\(\{ \[AUTO_PUSH_KEY\]: autoPushOnCapture \}\)/);
});

test('a stored capture from the other provider is never painted as this one', () => {
  const popup = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');
  assert.match(popup, /const capturedAs = raw\.provider === 'claude' \? 'claude'/);
  assert.match(popup, /const source = capturedAs && capturedAs !== provider \? \{\} : raw/);
  assert.match(popup, /An older background worker that/);
});
