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
    runtime: { id: 'test', lastError: null, onMessage: { addListener: (fn) => { listeners.message = fn; } }, sendMessage() {} },
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
  assert.match(popup, /if \(res\.status === 201 && signOutAfterPush\)/, 'an unchecked toggle keeps the session');
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
  assert.match(popup, /if \(res\.status === 201 && signOutAfterPush\)/, 'only a 201 means the account was added');
  assert.match(popup, /send\('signOut'\)/);
  assert.match(popup, /Pushed and signed out/);
});

test('the extension requests the webRequest permission its header capture needs', () => {
  assert.ok(MANIFEST.permissions.includes('webRequest'), 'manifest must grant webRequest');
  assert.ok(MANIFEST.host_permissions.includes('https://chat.deepseek.com/*'));
  assert.match(BACKGROUND, /onBeforeSendHeaders/);
  assert.match(BACKGROUND, /extraHeaders/, 'without extraHeaders Chrome hides Authorization');
});

test('the popup refuses to export a rejected capture', () => {
  const popup = fs.readFileSync(path.join(ROOT, 'chrome-extension', 'popup.js'), 'utf8');
  assert.match(popup, /source\._verified === false/);
  assert.match(popup, /Token rejected by DeepSeek/);
  assert.match(popup, /const ready\s+= !!\(auth\.token && auth\.cookie\) && !rejected/);
});

test('every extension file still parses', () => {
  for (const file of ['background.js', 'content.js', 'popup.js']) {
    assert.doesNotThrow(() => new vm.Script(fs.readFileSync(path.join(ROOT, 'chrome-extension', file), 'utf8')), file);
  }
});
