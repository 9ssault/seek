/**
 * background.js — DeepSeek Auth Exporter v1.5
 * Service worker. Collects DeepSeek session data (cookies + localStorage)
 * and drives a fully-automatic Google Sign-In flow with stealth + YesCaptcha.
 * Works in both Chrome and Firefox/Helium (Manifest V3).
 */

// Firefox uses `browser`, Chrome uses `chrome`. Normalise to `chrome`.
// In a service-worker context `self` is the global; `chrome` is already
// available in Chrome workers, and Firefox 109+ also exposes it globally.
// The guard below handles the rare case where only `browser` is present.
if (typeof chrome === 'undefined' && typeof browser !== 'undefined') {
  // eslint-disable-next-line no-global-assign
  chrome = browser;
}

const STORAGE_KEY   = 'deepseek_auth';
const CLAUDE_KEY    = 'claude_auth';
const DEFAULT_WASM  = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const TOKEN_KEYS    = ['userToken', 'token', 'auth_token', 'access_token', 'accessToken'];
const DEEPSEEK_CHAT = 'https://chat.deepseek.com';
const CLAUDE_CHAT   = 'https://claude.ai';
const CLAUDE_ORGS   = '/api/organizations';
const USERS_PATH    = '/api/v0/users/current';
const POW_PATH      = '/api/v0/chat/create_pow_challenge';
// Headers describe the request the app itself made; older than this and the user
// has almost certainly changed session since.
const HEADER_FRESH_MS = 10 * 60 * 1000;

// ─── Live header capture ────────────────────────────────────────────────────
// DeepSeek authenticates with the Authorization header it sends, and the hif pair
// only ever exists as request headers. localStorage holds token-shaped values that
// are not necessarily that bearer, so an observed header always wins.
let observedHeaders = null; // { token, hif_dliq, hif_leim, at }

function headerValue(details, name) {
  const wanted = name.toLowerCase();
  for (const header of details?.requestHeaders || []) {
    if (String(header.name || '').toLowerCase() === wanted) return String(header.value || '');
  }
  return '';
}

function rememberRequestHeaders(details) {
  const authorization = headerValue(details, 'authorization');
  const hifDliq = headerValue(details, 'x-hif-dliq');
  const hifLeim = headerValue(details, 'x-hif-leim');
  if (!authorization && !hifDliq && !hifLeim) return;
  const bearer = authorization.replace(/^Bearer\s+/i, '').trim();
  observedHeaders = {
    token:     bearer || observedHeaders?.token || '',
    hif_dliq:  hifDliq || observedHeaders?.hif_dliq || '',
    hif_leim:  hifLeim || observedHeaders?.hif_leim || '',
    at:        Date.now(),
  };
}

if (chrome.webRequest?.onBeforeSendHeaders) {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    rememberRequestHeaders,
    { urls: ['https://chat.deepseek.com/*'] },
    ['requestHeaders', 'extraHeaders'],
  );
}

function freshObservedHeaders(now = Date.now()) {
  if (!observedHeaders) return null;
  if (now - observedHeaders.at > HEADER_FRESH_MS) return null;
  return observedHeaders;
}

// Which token to keep, and where it came from, so the popup can explain a rejection.
function chooseToken(stores, observed, cookieToken = '') {
  if (observed?.token) return { token: observed.token, source: 'header' };
  const fromStore = tokenFromStores(stores);
  if (fromStore) return { token: fromStore, source: 'storage' };
  if (cookieToken) return { token: cookieToken, source: 'cookie' };
  return { token: '', source: 'none' };
}

function authHeaders(auth) {
  return {
    'User-Agent': (typeof navigator !== 'undefined' && navigator.userAgent) || 'Mozilla/5.0',
    'x-client-platform': 'web',
    'x-client-version': '2.4.2',
    'x-client-locale': 'en',
    'x-client-timezone-offset': '-240',
    'x-app-version': '2.4.2',
    Authorization: `Bearer ${auth.token || ''}`,
    'x-hif-dliq': auth.hif_dliq || '',
    'x-hif-leim': auth.hif_leim || '',
    Origin: DEEPSEEK_CHAT,
    Referer: `${DEEPSEEK_CHAT}/`,
    Cookie: auth.cookie || '',
    'Content-Type': 'application/json',
  };
}

// A token DeepSeek rejects still exports cleanly and then fails every request in the
// proxy, so verify against the API before calling a capture good.
async function verifySession(auth, fetchImpl = globalThis.fetch) {
  if (!auth?.token) return { ok: false, reason: 'no_token', message: 'No token captured yet. Sign in and send one short message first.' };
  let response;
  try {
    response = await fetchImpl(`${DEEPSEEK_CHAT}${USERS_PATH}`, { method: 'GET', headers: authHeaders(auth) });
  } catch (e) {
    // No network is not the same as a bad token: keep the capture, say it is unverified.
    return { ok: true, unverified: true, message: `Could not verify the session (${e.message || 'offline'}).` };
  }
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML sign-in page */ }
  const biz = Number(json?.data?.biz_code ?? json?.code ?? 0);
  const data = json?.data?.biz_data;
  if (data && (data.id || data.email || data.mobile)) {
    return {
      ok: true,
      identity: { id: data.id || '', email: data.email || '', mobile: data.mobile || '' },
    };
  }
  if ([40001, 40002, 40003].includes(biz) || /invalid token|authorization failed/i.test(text)) {
    return {
      ok: false,
      reason: 'invalid_token',
      message: 'DeepSeek rejected this token (INVALID_TOKEN). Reload chat.deepseek.com, send one short message (for example "ok"), then collect again.',
    };
  }
  return {
    ok: false,
    reason: 'not_signed_in',
    message: 'This browser session is not signed in to DeepSeek. Sign in first, then collect.',
  };
}

// ─── Storage helpers ─────────────────────────────────────────────────────────

function parseMaybeJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function normalizeToken(raw) {
  if (!raw) return '';
  const parsed = parseMaybeJson(raw);
  if (parsed && typeof parsed === 'object') {
    return String(
      parsed.value || parsed.token || parsed.access_token || parsed.accessToken || ''
    ).trim().replace(/^Bearer\s+/i, '');
  }
  return String(raw).trim().replace(/^Bearer\s+/i, '');
}

function tokenFromStores(stores) {
  for (const store of stores) {
    for (const key of TOKEN_KEYS) {
      const token = normalizeToken(store[key]);
      if (token) return token;
    }
  }
  // Fallback: any key that has "token" in its name
  for (const store of stores) {
    for (const [key, value] of Object.entries(store || {})) {
      if (!/token/i.test(key)) continue;
      const token = normalizeToken(value);
      if (token) return token;
    }
  }
  return '';
}

function fieldFromStores(stores, names) {
  for (const store of stores) {
    for (const name of names) {
      const value = String(store[name] || '').trim();
      if (value) return value;
    }
  }
  return '';
}

function identityFromStores(stores, pageUserInfo) {
  if (pageUserInfo && typeof pageUserInfo === 'object') {
    const name  = String(pageUserInfo.name || pageUserInfo.nickname || pageUserInfo.email || '').trim();
    const email = String(pageUserInfo.email || '').trim();
    if (name || email) return { name: name || email, email };
  }
  for (const store of stores) {
    for (const key of ['user_info', 'user', 'userInfo', 'profile']) {
      const raw    = store[key];
      const parsed = parseMaybeJson(raw);
      if (parsed && typeof parsed === 'object') {
        const name  = String(parsed.name || parsed.nickname || parsed.email || parsed.username || '').trim();
        const email = String(parsed.email || '').trim();
        if (name || email) return { name: name || email, email };
      }
    }
  }
  return { name: '', email: '' };
}

// ─── Cookie reader ───────────────────────────────────────────────────────────

async function readCookies() {
  const groups = await Promise.all([
    new Promise((resolve) => chrome.cookies.getAll({ domain: 'deepseek.com' }, (c) => resolve(c || []))),
    new Promise((resolve) => chrome.cookies.getAll({ url: 'https://chat.deepseek.com' }, (c) => resolve(c || []))),
  ]);
  const byName = new Map();
  for (const cookie of groups.flat().filter(Boolean)) {
    if (!cookie.name || cookie.value == null) continue;
    // Only accept deepseek.com cookies
    const domain = String(cookie.domain || '').replace(/^\./, '');
    if (!/(?:^|\.)deepseek\.com$/i.test(domain)) continue;
    byName.set(cookie.name, cookie.value);
  }
  const parts = [...byName.entries()].map(([name, value]) => `${name}=${value}`);
  return {
    token:         byName.get('token') || '',
    cookie:        parts.join('; '),
    ds_session_id: byName.get('ds_session_id') || '',
    smidV2:        byName.get('smidV2') || '',
  };
}

// ─── Page store reader ───────────────────────────────────────────────────────

function collectPageStoresFn() {
  const dump = (store) => {
    const out = {};
    try {
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i);
        if (key) out[key] = store.getItem(key) || '';
      }
    } catch { /* blocked */ }
    return out;
  };

  let wasmUrl = '';
  try {
    wasmUrl = performance
      .getEntriesByType('resource')
      .map((r) => r.name)
      .find((n) => /sha3.*\.wasm/i.test(n)) || '';
  } catch { wasmUrl = ''; }

  let userInfo = null;
  try {
    const raw = window.localStorage.getItem('user_info')
             || window.localStorage.getItem('user')
             || window.localStorage.getItem('profile');
    if (raw) userInfo = JSON.parse(raw);
  } catch { userInfo = null; }

  return {
    href:           location.href,
    localStorage:   dump(window.localStorage),
    sessionStorage: dump(window.sessionStorage),
    userInfo,
    wasmUrl,
  };
}

async function readPageStores(tabId) {
  // Preferred path: executeScript (needs scripting + host_permissions)
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId },
      func:   collectPageStoresFn,
    });
    const value = injected?.[0]?.result;
    if (value) return value;
  } catch {
    // Fall through to content-script message
  }

  // Fallback: content script already injected
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'readPageStores' }, (response) => {
      if (chrome.runtime.lastError) resolve({});
      else resolve(response?.data || {});
    });
  });
}

// ─── Find the active DeepSeek tab ────────────────────────────────────────────

function findDeepSeekTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: 'https://chat.deepseek.com/*' }, (tabs) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      const active = tabs.find((t) => t.active) || tabs[0];
      resolve(active || null);
    });
  });
}

// ─── Collect & store ─────────────────────────────────────────────────────────

async function collectAndStore(tabId) {
  const cookies = await readCookies();
  const page    = tabId ? await readPageStores(tabId) : {};
  const stores  = [page.localStorage || {}, page.sessionStorage || {}];
  const observed = freshObservedHeaders();
  const chosen   = chooseToken(stores, observed, normalizeToken(cookies.token));
  const identity = identityFromStores(stores, page.userInfo);

  const auth = {
    name:          identity.name,
    email:         identity.email,
    token:         chosen.token,
    hif_dliq:      observed?.hif_dliq || fieldFromStores(stores, ['hif_dliq', 'x-hif-dliq']),
    hif_leim:      observed?.hif_leim || fieldFromStores(stores, ['hif_leim', 'x-hif-leim']),
    cookie:        cookies.cookie,
    wasmUrl:       page.wasmUrl || DEFAULT_WASM,
    ds_session_id: cookies.ds_session_id,
    smidV2:        cookies.smidV2,
    _tokenSource:  chosen.source,
    _lastUpdated:  new Date().toISOString(),
  };

  const check = await verifySession(auth);
  if (!check.ok) {
    // Keep the failure visible instead of exporting a file that cannot serve.
    const rejected = { ...auth, _verified: false, _error: check.message };
    await chrome.storage.local.set({ [STORAGE_KEY]: rejected });
    return rejected;
  }

  const verified = {
    ...auth,
    name:      auth.name || check.identity?.email || '',
    email:     auth.email || check.identity?.email || '',
    _verified: true,
    _unverified: Boolean(check.unverified),
    _userId:   check.identity?.id || '',
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: verified });
  return verified;
}

// ─── Sign out after the login reaches the proxy ─────────────────────────────
// Once the proxy holds a login, leaving the same account signed in here is what
// makes the next capture confusing: the browser keeps a session the proxy already
// owns. This is a LOCAL sign-out (cookies + page storage for deepseek.com) and it
// deliberately makes no server-side logout call, so the token the proxy just
// imported stays valid. Verified: the bearer authenticates with no cookie at all.
async function signOutDeepSeek() {
  const cookies = await new Promise((resolve) => {
    chrome.cookies.getAll({ domain: 'deepseek.com' }, (found) => resolve(found || []));
  });

  const removed = [];
  for (const cookie of cookies) {
    if (!cookie?.name) continue;
    const host = String(cookie.domain || '').replace(/^\./, '') || 'chat.deepseek.com';
    const url = `https://${host}${cookie.path || '/'}`;
    const gone = await new Promise((resolve) => {
      chrome.cookies.remove({ url, name: cookie.name, storeId: cookie.storeId }, (value) => resolve(Boolean(value)));
    });
    if (gone) removed.push(cookie.name);
  }

  // The app keeps its session in localStorage too; drop it, then land on sign-in so
  // the next capture starts from a clean, obviously-signed-out page.
  let pageCleared = false;
  const tab = await findDeepSeekTab();
  if (tab?.id) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: 'MAIN',
        func: () => {
          let cleared = false;
          try { window.localStorage.clear(); cleared = true; } catch {}
          try { window.sessionStorage.clear(); } catch {}
          return cleared;
        },
      });
      pageCleared = results?.[0]?.result === true;
    } catch { /* tab may be gone */ }
    try { await chrome.tabs.update(tab.id, { url: `${DEEPSEEK_CHAT}/sign_in` }); } catch {}
  }

  // Forget the headers we observed, so a stale Authorization cannot be captured as
  // if it belonged to the next login.
  observedHeaders = null;
  return { success: true, cookiesRemoved: removed.length, pageCleared, tabId: tab?.id || null };
}

// ─── Claude capture ──────────────────────────────────────────────────────────
// The claude.ai web app authenticates with cookies only — there is no bearer token,
// so a Claude login is the jar itself (sessionKey plus the Cloudflare cookies the
// browser holds). The proxy stores that jar as-is and replays it.
const CLAUDE_COOKIE_NAMES = ['sessionKey', 'cf_clearance', '__cf_bm', 'lastActiveOrg'];

async function readClaudeCookies() {
  // Three queries on purpose. `domain` and `url` cover the jars Chrome reports in the
  // usual way; the unfiltered list catches a session cookie that the narrower queries
  // skip (for example one stored for a claude.ai subdomain). A `getAll` that throws —
  // no host permission yet after an update — resolves empty instead of failing the read.
  const ask = (details) => new Promise((resolve) => {
    try {
      chrome.cookies.getAll(details, (c) => {
        void chrome.runtime.lastError;
        resolve(c || []);
      });
    } catch {
      resolve([]);
    }
  });
  const groups = await Promise.all([
    ask({ domain: 'claude.ai' }),
    ask({ url: 'https://claude.ai' }),
    ask({}),
  ]);
  const byName = new Map();
  for (const cookie of groups.flat().filter(Boolean)) {
    if (!cookie.name || cookie.value == null) continue;
    const domain = String(cookie.domain || '').replace(/^\./, '');
    if (!/(?:^|\.)claude\.ai$/i.test(domain)) continue;
    const hostOnly = cookie.domain && !String(cookie.domain).startsWith('.');
    // Prefer a host cookie for claude.ai itself over one from a deeper subdomain.
    if (byName.has(cookie.name) && !hostOnly) continue;
    byName.set(cookie.name, cookie.value);
  }
  const parts = [...byName.entries()].map(([name, value]) => `${name}=${value}`);
  return {
    cookie: parts.join('; '),
    sessionKey: byName.get('sessionKey') || '',
    lastActiveOrg: byName.get('lastActiveOrg') || '',
    names: [...byName.keys()],
  };
}

// The cookie jar is the credential, so it is worth one round trip before calling a
// capture good: a stale jar imports cleanly and then fails every request in the pool.
// Cloudflare cookies are sent automatically because this is the same browser.
async function verifyClaude(jar, fetchImpl = globalThis.fetch) {
  if (!jar?.sessionKey) {
    return { ok: false, reason: 'no_session', message: 'Not signed in to claude.ai. Sign in in this tab, then read it again.' };
  }
  let response;
  try {
    response = await fetchImpl(`${CLAUDE_CHAT}${CLAUDE_ORGS}`, {
      method: 'GET',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  } catch (e) {
    return { ok: true, unverified: true, message: `Could not verify the login (${e.message || 'offline'}).` };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: 'session_rejected', message: `claude.ai rejected this session (HTTP ${response.status}). Sign in again, then read the tab.` };
  }
  if (!response.ok) {
    return { ok: false, reason: 'verify_failed', message: `claude.ai answered HTTP ${response.status} while verifying the login.` };
  }
  let list = null;
  try { list = await response.json(); } catch { list = null; }
  const org = Array.isArray(list) ? (list.find((o) => o && o.uuid) || null) : null;
  return { ok: true, org: org?.uuid || jar.lastActiveOrg || '', organization: org?.name || '' };
}

async function collectClaude() {
  const jar = await readClaudeCookies();
  const check = await verifyClaude(jar);
  const base = {
    provider: 'claude',
    cookie: jar.cookie,
    org: check.org || '',
    _cookies: jar.names.length,
    _cookieNames: jar.names,
    _lastUpdated: new Date().toISOString(),
  };
  if (!check.ok) {
    // Name what was actually readable: "no sessionKey" most often means the jar only
    // holds a non-session cookie, and the popup can say so instead of guessing.
    const detail = check.reason === 'no_session' && jar.names.length
      ? `Not signed in to claude.ai: read ${jar.names.length} cookie${jar.names.length === 1 ? '' : 's'} (${jar.names.join(', ')}) but no sessionKey. Sign in again at claude.ai, then press Read current tab.`
      : check.message;
    const rejected = { ...base, _verified: false, _error: detail };
    await chrome.storage.local.set({ [CLAUDE_KEY]: rejected });
    return rejected;
  }
  const verified = {
    ...base,
    name: check.organization || '',
    _verified: true,
    _unverified: Boolean(check.unverified),
  };
  await chrome.storage.local.set({ [CLAUDE_KEY]: verified });
  return verified;
}

const YESCAPTCHA_EXT_ID = 'jiofmdifioeejeilfkpegipdjiopiekl';

// ─── Stealth injection ────────────────────────────────────────────────────────

/**
 * Patches the page's main JS context to remove automation fingerprints.
 * Must run in world:'MAIN' so patches affect the page, not the extension sandbox.
 */
async function injectStealth(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        // Remove webdriver flag (Selenium/CDP detection)
        try {
          Object.defineProperty(navigator, 'webdriver', {
            get: () => undefined,
            configurable: true,
          });
        } catch {}

        // Normalize permissions.query so it mirrors a real browser
        try {
          const orig = navigator.permissions.query.bind(navigator.permissions);
          navigator.permissions.query = (p) =>
            p.name === 'notifications'
              ? Promise.resolve({ state: Notification.permission })
              : orig(p);
        } catch {}

        // Wipe Chrome DevTools / Selenium artefacts
        for (const key of Object.keys(window)) {
          if (/^cdc_|^__selenium|^__webdriver|^_Selenium/.test(key)) {
            try { delete window[key]; } catch {}
          }
        }

        // Realistic plugin list (empty list is a bot signal)
        if (navigator.plugins.length === 0) {
          try {
            Object.defineProperty(navigator, 'plugins', {
              get: () => [1, 2, 3, 4, 5],
              configurable: true,
            });
          } catch {}
        }
      },
    });
  } catch {}
}

// ─── YesCaptcha integration ───────────────────────────────────────────────────

/**
 * Pings the YesCaptcha extension so it is primed for the given tab.
 * Tries several message shapes — their internal API isn't public, so we
 * fire common patterns and move on regardless of the response.
 */
async function activateYesCaptcha(tabId) {
  const messages = [
    { action: 'enableTab', tabId },
    { action: 'enable',    tabId },
    { type:   'enable',    tabId },
    { cmd:    'start',     tabId },
  ];
  for (const msg of messages) {
    await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(YESCAPTCHA_EXT_ID, msg, () => {
          chrome.runtime.lastError; // suppress "no listener" error
          resolve();
        });
      } catch { resolve(); }
      setTimeout(resolve, 400); // never block longer than 400 ms per attempt
    });
  }
}

// ─── Google Sign-In helper ───────────────────────────────────────────────────

/**
 * Clicks the Google sign-in button in a page that's already loaded.
 * Uses multiple selector strategies + human-like mouse event sequence.
 * Returns true if a button was found and events were fired.
 */
async function clickGoogleButton(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const btn =
          document.querySelector('[data-provider="google"]') ||
          document.querySelector('[data-testid*="google" i]') ||
          document.querySelector('button[class*="google" i]') ||
          document.querySelector('div[class*="google" i][role="button"]') ||
          (() =>
            [...document.querySelectorAll('button, [role="button"]')].find((el) =>
              el.innerHTML.includes('4285F4') ||
              /google/i.test(el.getAttribute('aria-label') || '') ||
              /continue with google/i.test(el.innerText || '')
            )
          )() ||
          [...document.querySelectorAll('button, [role="button"], a')]
            .find((el) => /google/i.test(el.innerText || el.textContent || ''));

        if (!btn) return false;

        const rect = btn.getBoundingClientRect();
        const cx = rect.left + rect.width  * 0.5 + (Math.random() - 0.5) * 6;
        const cy = rect.top  + rect.height * 0.5 + (Math.random() - 0.5) * 6;

        const fire = (type, extra = {}) =>
          btn.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, view: window,
            clientX: cx, clientY: cy, screenX: cx + 100, screenY: cy + 80,
            ...extra,
          }));

        fire('mouseover');
        fire('mouseenter', { bubbles: false });
        fire('mousemove');
        setTimeout(() => {
          fire('mousedown', { button: 0, buttons: 1 });
          setTimeout(() => {
            fire('mouseup',  { button: 0, buttons: 0 });
            fire('click',    { button: 0, buttons: 0 });
          }, 55 + Math.random() * 90);
        }, 90 + Math.random() * 140);

        return true;
      },
    });
    return results?.[0]?.result === true;
  } catch {
    return false;
  }
}

/**
 * Watches a tab until it lands on chat.deepseek.com (post-OAuth redirect),
 * applies stealth, collects & stores the session, then resolves with the auth.
 * Gives up after timeoutMs.
 */
function waitForDeepSeekSession(tabId, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error('Timed out waiting for DeepSeek sign-in.'));
    }, timeoutMs);

    async function onUpdated(updatedTabId, info, tab) {
      if (updatedTabId !== tabId) return;
      if (info.status !== 'complete') return;

      const url = tab.url || info.url || '';
      // We're back on chat.deepseek.com — OAuth flow finished.
      if (!url.startsWith(DEEPSEEK_CHAT)) return;

      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(deadline);

      // Give SPA a moment to hydrate and write tokens to storage.
      await new Promise((r) => setTimeout(r, 1800 + Math.random() * 600));

      // If still on sign-in page the user may need to pick an account —
      // nothing to collect yet; caller handles retry via popup feedback.
      try {
        const auth = await collectAndStore(tabId);
        resolve(auth);
      } catch (e) {
        reject(e);
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/**
 * Full auto flow:
 *  1. Open DeepSeek /sign_in
 *  2. Stealth-patch the page context
 *  3. Prime YesCaptcha on the tab (and on every subsequent tab it opens)
 *  4. Auto-click the Google button
 *  5. Activate YesCaptcha on the Google accounts tab as it opens
 *  6. Wait for the redirect back to chat.deepseek.com
 *  7. Collect & store session → return auth
 */
async function openDeepSeekWithGoogle() {
  const signInUrl = `${DEEPSEEK_CHAT}/sign_in`;

  // Open or reuse a DeepSeek tab.
  let tab;
  const existing = await findDeepSeekTab();
  if (existing) {
    await chrome.tabs.update(existing.id, { url: signInUrl, active: true });
    tab = existing;
  } else {
    tab = await chrome.tabs.create({ url: signInUrl, active: true });
  }

  // Wait for sign-in page to fully load (max 15 s).
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }, 15000);
    function onUpdated(tabId, info) {
      if (tabId === tab.id && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });

  // React SPA mount delay.
  await new Promise((r) => setTimeout(r, 900 + Math.random() * 500));

  // 1. Stealth + YesCaptcha on the sign-in tab.
  await injectStealth(tab.id);
  await activateYesCaptcha(tab.id);

  // 2. Watch for the Google accounts popup/tab so we can stealth + YesCaptcha it too.
  //    Google OAuth opens in the same tab (redirect), so we watch onUpdated for
  //    accounts.google.com on our tab, and apply YesCaptcha immediately.
  const googleTabWatcher = async (updatedTabId, info, updatedTab) => {
    if (info.status !== 'complete') return;
    const url = (updatedTab.url || '').toLowerCase();
    if (!url.includes('accounts.google.com') && !url.includes('google.com/o/oauth')) return;
    // Apply stealth + YesCaptcha to the Google accounts page.
    try { await injectStealth(updatedTabId); } catch {}
    try { await activateYesCaptcha(updatedTabId); } catch {}
  };
  chrome.tabs.onUpdated.addListener(googleTabWatcher);

  // 3. Start the session-ready watcher BEFORE clicking so we don't miss the redirect.
  const sessionPromise = waitForDeepSeekSession(tab.id, 90000);

  // 4. Click the Google button.
  const clicked = await clickGoogleButton(tab.id);

  // 5. If button not found yet, retry once after a short extra delay.
  if (!clicked) {
    await new Promise((r) => setTimeout(r, 1500));
    await clickGoogleButton(tab.id);
  }

  // 6. Await the full sign-in cycle.
  let auth;
  try {
    auth = await sessionPromise;
  } finally {
    chrome.tabs.onUpdated.removeListener(googleTabWatcher);
  }

  return { tab, auth };
}

// ─── Message handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {

  // Collect session from the active DeepSeek tab
  if (request.action === 'collect') {
    findDeepSeekTab().then(async (tab) => {
      if (!tab) {
        sendResponse({ success: false, error: 'Open chat.deepseek.com and sign in first.' });
        return;
      }
      try {
        const auth = await collectAndStore(tab.id);
        if (auth && auth._verified === false) {
          sendResponse({ success: false, error: auth._error || 'DeepSeek rejected this session.', auth });
        } else {
          sendResponse({ success: true, auth });
        }
      } catch (e) {
        sendResponse({ success: false, error: e.message || String(e) });
      }
    });
    return true; // keep message channel open for async response
  }

  // Sign the browser out of DeepSeek (called by the popup after a successful push)
  if (request.action === 'signOut') {
    signOutDeepSeek()
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ success: false, error: e.message || String(e) }));
    return true;
  }

  // Collect a claude.ai cookie jar (no token, no tab script needed)
  if (request.action === 'collectClaude') {
    collectClaude()
      .then((auth) => {
        if (auth && auth._verified === false) {
          sendResponse({ success: false, error: auth._error || 'claude.ai rejected this session.', auth });
        } else {
          sendResponse({ success: true, auth });
        }
      })
      .catch((e) => sendResponse({ success: false, error: e.message || String(e) }));
    return true;
  }

  // Export previously stored auth, per provider
  if (request.action === 'export') {
    const key = request.provider === 'claude' ? CLAUDE_KEY : STORAGE_KEY;
    chrome.storage.local.get(key, (result) => {
      sendResponse({ success: true, auth: result[key] || {} });
    });
    return true;
  }

  // Drop one provider's stored capture. The popup calls this when a key holds a record
  // that is not usable for that provider (a DeepSeek session sitting under the Claude key),
  // so it can never be exported or pushed as the wrong login.
  if (request.action === 'forget') {
    const key = request.provider === 'claude' ? CLAUDE_KEY : STORAGE_KEY;
    chrome.storage.local.remove(key, () => sendResponse({ success: true }));
    return true;
  }

  // Google Sign-In: open DeepSeek, auto-click Google button, wait for OAuth
  // redirect back to chat.deepseek.com, then auto-collect the session.
  // Responds with { success, auth } — no manual "Read tab" step needed.
  if (request.action === 'googleSignIn') {
    openDeepSeekWithGoogle()
      .then(({ tab, auth }) => {
        if (auth && auth._verified === false) {
          sendResponse({ success: false, error: auth._error || 'DeepSeek rejected this session.', tabId: tab?.id, auth });
        } else {
          sendResponse({ success: true, tabId: tab?.id, auth });
        }
      })
      .catch((e) => {
        sendResponse({ success: false, error: e.message || String(e) });
      });
    return true;
  }
});
