/**
 * popup.js — DeepSeek Auth Exporter v1.5
 * Handles UI state, session collection, export, and Google Sign-In flow.
 * Works in both Chrome and Firefox/Helium (Manifest V3).
 */

// Firefox exposes `browser`, Chrome exposes `chrome`. Normalise to `chrome`
// so the rest of the file can use one name without branching everywhere.
if (typeof chrome === 'undefined' && typeof browser !== 'undefined') {
  // eslint-disable-next-line no-global-assign
  chrome = browser;
}

const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const PROXY_URLS = ['http://127.0.0.1:9655', 'http://localhost:9655'];
// Which upstream this popup is capturing for. The two captures are stored under
// separate keys, so switching never overwrites the other provider's session.
let provider = 'deepseek';
// How many logins the pool has, and whether this capture is already one of them.
// Two chats on one login is what gets that login throttled, so a duplicate is
// reported before anything is pushed (and before this browser is signed out).
let poolSnapshot = null;

const els = {
  callout:           document.getElementById('callout'),
  calloutTitle:      document.getElementById('calloutTitle'),
  calloutBody:       document.getElementById('calloutBody'),
  btnCollect:        document.getElementById('btnCollect'),
  btnCopy:           document.getElementById('btnCopy'),
  btnSave:           document.getElementById('btnSave'),
  btnPush:           document.getElementById('btnPush'),
  btnGoogleSignIn:   document.getElementById('btnGoogleSignIn'),
  googleSignInSection: document.getElementById('googleSignInSection'),
  rowUser:           document.getElementById('rowUser'),
  rowToken:          document.getElementById('rowToken'),
  checkToken:        document.getElementById('checkToken'),
  rowCookie:         document.getElementById('rowCookie'),
  rowSource:         document.getElementById('rowSource'),
  checkLimits:       document.getElementById('checkLimits'),
  rowLimits:         document.getElementById('rowLimits'),
  chkSignOut:        document.getElementById('chkSignOut'),
  signOutRow:        document.getElementById('signOutRow'),
  pasteSection:      document.getElementById('pasteSection'),
  pasteCookie:       document.getElementById('pasteCookie'),
  pasteHint:         document.getElementById('pasteHint'),
  btnPasteSave:      document.getElementById('btnPasteSave'),
  chkAutoPush:       document.getElementById('chkAutoPush'),
  autoPushRow:       document.getElementById('autoPushRow'),
};

const providerButtons = Array.from(document.querySelectorAll('.provider-btn'));

let lastExport = null;

// Where the captured token came from, and whether DeepSeek accepted it.
const SOURCE_LABEL = { header: 'Live header', storage: 'Page storage', cookie: 'Cookie', none: 'None' };
const SIGN_OUT_KEY = 'sign_out_after_push';
const AUTO_PUSH_KEY = 'auto_push_after_capture';
let signOutAfterPush = true;
// One click instead of two: after a capture verifies, send it to the proxy. Off means
// the popup only captures and the push stays a deliberate press.
let autoPushOnCapture = true;

// ─── Helpers ────────────────────────────────────────────────────────────────

function cookieCount(cookie) {
  return String(cookie || '').split(';').map((p) => p.trim()).filter(Boolean).length;
}

// The two cookie-only upstreams. A login for either one IS its cookie jar: there is no
// bearer token to capture, so "ready" is the presence of that site's session cookie.
const JAR_PROVIDERS = {
  claude: { id: 'claude', label: 'Claude', host: 'claude.ai', key: 'sessionKey', collect: 'collectClaude', file: 'claude-auth.json', account: 'Claude Account' },
  grok:   { id: 'grok',   label: 'Grok',   host: 'grok.com',   key: 'sso',       collect: 'collectGrok',   file: 'grok-auth.json',   account: 'Grok Account' },
};

function jarInfo(p = provider) { return JAR_PROVIDERS[p] || null; }

function jarCookieKey(p = provider) { return JAR_PROVIDERS[p]?.key || 'sessionKey'; }

// grok.com uses `sso`, but a session started on X carries `auth_token`; either one is a
// signed-in Grok login.
const JAR_COOKIE_RE = {
  claude: /(^|;\s*)sessionKey=[^;]+/,
  grok: /(^|;\s*)(?:sso|sso-rw|auth_token)=[^;]+/,
};

function cookieHasJarKey(cookie, p = provider) {
  const re = JAR_COOKIE_RE[p] || new RegExp(`(^|;\\s*)${jarCookieKey(p)}=[^;]+`);
  return re.test(String(cookie || ''));
}

function cookieHasSessionKey(cookie) {
  return cookieHasJarKey(cookie, 'claude');
}

// A stored jar capture is only usable if it came from that provider's collector. A record
// carrying a DeepSeek field (token, _tokenSource) is a DeepSeek session that ended up
// under the wrong key — every browser that upgraded from an older build can have one —
// and must never be shown or exported as a cookie-jar login.
function isForeignJarRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (JAR_PROVIDERS[record.provider]) return false;
  return Boolean(record.provider === 'deepseek' || record.token || record._tokenSource || record.hif_dliq);
}

function isForeignClaudeRecord(record) { return isForeignJarRecord(record); }

function cookieNames(cookie) {
  return String(cookie || '').split(';')
    .map((part) => part.split('=')[0].trim())
    .filter(Boolean);
}

function buildAuthJson(data) {
  // A Claude or Grok login is the cookie jar itself; there is no token to send.
  const j = jarInfo();
  if (j) {
    return {
      provider: j.id,
      name: data.name || '',
      cookie: String(data.cookie || '').trim(),
      org: data.org || '',
    };
  }
  const cookie = String(data.cookie || '').trim() || [
    data.ds_session_id && `ds_session_id=${data.ds_session_id}`,
    data.smidV2 && `smidV2=${data.smidV2}`,
  ].filter(Boolean).join('; ');

  return {
    name:     data.name || '',
    email:    data.email || '',
    token:    data.token || '',
    hif_dliq: data.hif_dliq || '',
    hif_leim: data.hif_leim || '',
    cookie,
    wasmUrl:  data.wasmUrl || WASM_URL,
  };
}

function exportText(auth) {
  return `${JSON.stringify(auth, null, 2)}\n`;
}

function setValue(el, text, kind) {
  el.textContent = text;
  el.className = `value${kind ? ` ${kind}` : ''}`;
}

function showCallout(kind, title, body) {
  els.callout.hidden = false;
  els.callout.className = `callout ${kind}`;
  els.calloutTitle.textContent = title;
  els.calloutBody.textContent = body;
}

function hideCallout() {
  els.callout.hidden = true;
}

function flashButton(btn, label, durationMs = 1400) {
  const target = btn.querySelector('.btn-label');
  if (!target) return;
  const prev = target.textContent;
  target.textContent = label;
  window.setTimeout(() => { target.textContent = prev; }, durationMs);
}

function inExtension() {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.id === 'string';
}

// Chrome keeps a service worker alive for its own idle window, so the popup (read fresh
// from disk every time it opens) can be newer than the worker answering it. A worker that
// does not know an action returns nothing, and Chrome reports that as a closed port.
const WORKER_GONE = /message port closed|receiving end does not exist|could not establish connection|extension context invalidated/i;

function send(action, data = {}) {
  return new Promise((resolve, reject) => {
    if (!inExtension()) {
      reject(new Error('Reload the unpacked extension, then open this popup from the toolbar.'));
      return;
    }
    const finish = (response) => {
      const err = chrome.runtime.lastError;
      if (!err) { resolve(response); return; }
      // A silent worker is not a failed capture: resolve `undefined` so the caller can
      // say "reload the extension" — the only thing that actually fixes a stale worker.
      if (WORKER_GONE.test(String(err.message || ''))) { resolve(undefined); return; }
      reject(new Error(err.message));
    };
    try {
      chrome.runtime.sendMessage({ action, ...data }, finish);
    } catch (e) {
      if (WORKER_GONE.test(String(e.message || ''))) resolve(undefined);
      else reject(e);
    }
  });
}

// The worker states its own manifest version. When it disagrees with the popup's, the two
// halves of the extension are different builds and every capture is unreliable — so say so
// before the user presses anything.
let workerMismatch = null;
async function checkWorkerBuild() {
  const pong = await send('ping');
  let mine = null;
  try { mine = inExtension() ? chrome.runtime.getManifest().version : null; } catch { mine = null; }
  if (!pong || !pong.build) { workerMismatch = { worker: null, popup: mine }; return workerMismatch; }
  workerMismatch = pong.build === mine ? null : { worker: pong.build, popup: mine };
  return workerMismatch;
}

function showReloadWarning() {
  const detail = workerMismatch?.worker
    ? `The popup is v${workerMismatch.popup} but the background worker is still v${workerMismatch.worker}.`
    : 'The background worker did not answer.';
  showCallout(
    'error',
    'Reload the extension',
    `${detail} Open chrome://extensions, press Reload on this extension, then reopen the popup — an older worker cannot collect a claude.ai login.`
  );
}

// ─── Render ─────────────────────────────────────────────────────────────────

function render(data) {
  const j = jarInfo();
  const claude = Boolean(j);
  const host = j ? j.host : 'DeepSeek';
  // A stored capture belongs to exactly one upstream. An older background worker that
  // ignores `provider` would hand back the DeepSeek session for a jar tab, and painting
  // it here would show a DeepSeek login under a cookie-jar heading.
  const raw = data && typeof data === 'object' ? data : {};
  const capturedAs = JAR_PROVIDERS[raw.provider] ? raw.provider
    : (raw.token || raw._tokenSource || raw.hif_dliq) ? 'deepseek' : null;
  const source = capturedAs && capturedAs !== provider ? {} : raw;
  const auth   = buildAuthJson(source);
  lastExport   = auth;

  const hasRead  = !!source._lastUpdated;
  // The upstream answered with a rejection (DeepSeek INVALID_TOKEN, claude.ai 401):
  // that capture must never be exported.
  const rejected = hasRead && source._verified === false;
  const cookieN  = cookieCount(auth.cookie);
  const ready    = (claude ? cookieHasJarKey(auth.cookie) : !!(auth.token && auth.cookie)) && !rejected;
  els.checkToken.hidden = claude;

  // Account row
  const displayName = auth.name || auth.email || '';
  setValue(
    els.rowUser,
    rejected ? 'Not signed in' : displayName ? displayName : (hasRead ? 'Signed in' : 'Not read'),
    rejected || !displayName ? (hasRead && !rejected ? 'ready' : '') : 'ready'
  );

  // Token row (DeepSeek only; a Claude login is a cookie jar)
  setValue(
    els.rowToken,
    rejected ? 'Rejected' : auth.token ? 'Ready' : (hasRead ? 'Missing' : 'Not read'),
    rejected ? 'missing' : auth.token ? 'ready' : (hasRead ? 'missing' : '')
  );

  // Cookie row
  setValue(
    els.rowCookie,
    cookieN ? `Ready (${cookieN})` : (hasRead ? 'Missing' : 'Not read'),
    cookieN ? 'ready' : (hasRead ? 'missing' : '')
  );

  // Capture row: which source the token came from, and what DeepSeek said about it.
  const sourceLabel = SOURCE_LABEL[source._tokenSource] || (hasRead ? 'Unknown' : 'Not read');
  const verdict = rejected
    ? 'rejected'
    : source._verified === true
      ? (source._unverified ? 'unverified (offline)' : 'verified')
      : '';
  setValue(
    els.rowSource,
    hasRead ? [sourceLabel, verdict].filter(Boolean).join(' · ') : 'Not read',
    rejected ? 'missing' : ready ? 'ready' : ''
  );

  renderLimits();

  // Action buttons
  els.btnCopy.disabled = !ready;
  els.btnSave.disabled = !ready;
  els.btnPush.disabled = !ready;

  // Google sign-in is a DeepSeek flow only.
  els.googleSignInSection.hidden = hasRead || claude;
  els.signOutRow.hidden = claude;

  // Callout
  if (!hasRead) {
    showCallout(
      'warning',
      `Open ${host} first`,
      claude
        ? `Sign in on ${host} in this browser, then read the current tab — or paste the cookie below.`
        : 'Sign in, then read the current tab — or use Sign in with Google below.'
    );
    return;
  }

  if (rejected) {
    showCallout(
      'error',
      `${host} rejected this session`,
      source._error || (claude ? 'Sign in again, then read the tab.' : 'Sign in, send one short message, then collect again.')
    );
    els.googleSignInSection.hidden = claude;
  } else if (ready) {
    const who = auth.name || auth.email;
    const verified = source._verified === true && !source._unverified;
    const upstream = host;
    showCallout(
      'ok',
      verified ? 'Session verified' : 'Session captured',
      verified
        ? (who ? `${upstream} accepted this session. Signed in as ${who}.` : `${upstream} accepted this session. Ready to export.`)
        : `Captured offline, so ${upstream} has not confirmed the session yet.`
    );
  } else if (!claude && !auth.token && cookieN) {
    showCallout('warning', 'Send one message', 'Send one short message in the DeepSeek tab, then read the tab again to capture the token.');
  } else {
    const names = claude ? cookieNames(auth.cookie) : [];
    showCallout(
      'warning',
      'Session not found',
      claude
        ? (names.length
          ? `Read ${names.length} ${host} cookie${names.length === 1 ? '' : 's'} (${names.join(', ')}) but no ${j.key}. Sign in at ${host} and read the tab again — or paste the cookie below.`
          : `Use a tab signed in to ${host} and read it again — or paste the cookie below.`)
        : 'Sign in to DeepSeek and try again.'
    );
    els.googleSignInSection.hidden = claude;
  }
}

// ─── Load stored auth ────────────────────────────────────────────────────────

async function loadAuth() {
  try {
    const response = await send('export', { provider });
    if (response === undefined) {
      await checkWorkerBuild();
      showReloadWarning();
      return;
    }
    if (!(response && response.success)) { showCallout('error', 'Could not read stored session', ''); return; }
    const stored = response.auth || {};

    const j = jarInfo();
    // The jar key held a DeepSeek session: clear it so it cannot be exported, and say
    // plainly what to do instead of painting someone else's login.
    if (j && isForeignJarRecord(stored)) {
      await send('forget', { provider: j.id });
      render({});
      showCallout('warning', `No ${j.host} session yet`, `The stored capture under ${j.label} belonged to DeepSeek, so it was cleared. Open ${j.host}, sign in, then press Read current tab.`);
      return;
    }

    // A stored jar with no session cookie is not a login. Report the cookies that were
    // readable so a missing one is visible rather than guessed at.
    if (j && stored._lastUpdated && !cookieHasJarKey(stored.cookie)) {
      const names = cookieNames(stored.cookie);
      render({});
      showCallout(
        'warning',
        `No ${j.host} session yet`,
        names.length
          ? `The stored jar holds ${names.length} cookie${names.length === 1 ? '' : 's'} (${names.join(', ')}) and no ${j.key}. Sign in at ${j.host} and press Read current tab — or paste the cookie below.`
          : `Nothing was captured yet. Open ${j.host} in this browser, sign in, then press Read current tab — or paste the cookie below.`
      );
      return;
    }

    render(stored);
  } catch (e) {
    showCallout('error', 'Extension error', e.message);
  }
}

// ─── Collect button ──────────────────────────────────────────────────────────

els.btnCollect.addEventListener('click', async () => {
  showCallout('warning', 'Reading tab…', 'Looking for your active session.');
  try {
    const response = await send(jarInfo() ? jarInfo().collect : 'collect');
    if (response === undefined) {
      await checkWorkerBuild();
      showReloadWarning();
      return;
    }
    if (response?.auth) render(response.auth);
    if (!(response && response.success)) { showCallout('error', 'Collect failed', response?.error || 'Unknown error'); return; }
    // Captured and verified: hand it to the proxy without a second press.
    if (autoPushOnCapture && exportReady() && !els.btnPush.disabled) els.btnPush.click();
  } catch (e) {
    showCallout('error', 'Collect failed', e.message);
  }
});

// ─── Copy button ─────────────────────────────────────────────────────────────

// A Claude capture has no token, so "ready" is measured per provider rather than
// on the DeepSeek shape.
function exportReady() {
  if (!lastExport) return false;
  return jarInfo()
    ? cookieHasJarKey(lastExport.cookie)
    : Boolean(lastExport.token && lastExport.cookie);
}

els.btnCopy.addEventListener('click', async () => {
  if (!exportReady()) return;
  try {
    await navigator.clipboard.writeText(exportText(lastExport));
    flashButton(els.btnCopy, '✓ Copied');
  } catch {
    // Fallback for clipboard API failure
    const ta = document.createElement('textarea');
    ta.value = exportText(lastExport);
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    flashButton(els.btnCopy, '✓ Copied');
  }
});

// ─── Save / Download button ──────────────────────────────────────────────────

els.btnSave.addEventListener('click', () => {
  if (!exportReady()) return;
  const blob = new Blob([exportText(lastExport)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = jarInfo() ? jarInfo().file : 'deepseek-auth.json';
  a.click();
  URL.revokeObjectURL(url);
  flashButton(els.btnSave, '✓ Saved');
});

// ─── Push to Proxy button ────────────────────────────────────────────────────

async function readPool() {
  for (const base of PROXY_URLS) {
    try {
      const res = await fetch(`${base}/health`, { cache: 'no-store' });
      if (!res.ok) continue;
      const json = await res.json();
      const accounts = Array.isArray(json?.accounts) ? json.accounts : [];
      return {
        base,
        total: accounts.length,
        ready: accounts.filter(a => a && a.ready !== false && a.enabled !== false && !a.cooldown).length,
        labels: accounts.map(a => String(a?.name || a?.id || '').toLowerCase()).filter(Boolean),
        // login label -> token fingerprint, so a re-capture of the same login is told apart
        // from pushing the very same session twice.
        tokens: Object.fromEntries(accounts
          .map(a => [String(a?.name || a?.id || '').toLowerCase(), a?.token_fingerprint || ''])
          .filter(([label]) => Boolean(label))),
        needsAuth: accounts.map(a => a && a.needs_auth ? String(a?.name || a?.id || '').toLowerCase() : '').filter(Boolean),
        // Per-login limits, so the popup can show this account's windows rather than the
        // pool's worst one. Keyed the same way needsAuth/tokens are.
        limits: Object.fromEntries(accounts
          .map(a => [String(a?.name || a?.id || '').toLowerCase(), a?.limits || null])
          .filter(([label]) => Boolean(label))),
        // Highest published quota window across the pool, so the popup can show the same
        // limits the dashboard does instead of only a ready count.
        peak: (() => {
          let best = null;
          for (const a of accounts) {
            const windows = a && a.limits && a.limits.windows ? a.limits.windows : {};
            for (const name of Object.keys(windows)) {
              const used = Number(windows[name] && windows[name].utilization);
              if (!Number.isFinite(used)) continue;
              if (!best || used > best.pct) best = { window: name, pct: Math.round(used * 100) };
            }
          }
          return best;
        })(),
      };
    } catch { /* try the next origin */ }
  }
  return null;
}

function poolMatches(who) {
  const needle = String(who || '').trim().toLowerCase();
  if (!needle || !poolSnapshot?.labels?.length) return false;
  return poolSnapshot.labels.includes(needle);
}

// Same fingerprint the proxy publishes: first 12 hex of sha256(token).
async function tokenFingerprint(token) {
  const bytes = new TextEncoder().encode(String(token || ''));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

// One login's limits, in the smallest readable form: published windows when the upstream
// reports them, otherwise the gateway's own counters. Empty until the pool has the login.
function limitsText(limits) {
  if (!limits) return '';
  const parts = [];
  const windows = limits.windows || {};
  for (const name of Object.keys(windows)) {
    const used = Number(windows[name] && windows[name].utilization);
    parts.push(Number.isFinite(used) ? `${name} ${Math.round(used * 100)}%` : `${name} —`);
  }
  if (!parts.length) {
    const req = limits.requests || {};
    if (Number(req['5h']) || Number(req['24h'])) parts.push(`${Number(req['5h']) || 0} in 5h`, `${Number(req['24h']) || 0} in 24h`);
  }
  if (limits.cooldown) parts.push('cooling down');
  return parts.join(' · ');
}

function renderLimits() {
  if (!els.checkLimits || !els.rowLimits) return;
  const who = String((lastExport && (lastExport.email || lastExport.name)) || '').trim().toLowerCase();
  const limits = who && poolSnapshot?.limits ? poolSnapshot.limits[who] : null;
  const text = limitsText(limits);
  els.checkLimits.hidden = !text;
  els.rowLimits.textContent = text || '—';
  els.rowLimits.title = limits && limits.source === 'upstream'
    ? 'Quota windows published by the upstream on every turn.'
    : 'Counted by the proxy: this upstream publishes no quota windows.';
}

function renderPool() {
  const el = document.getElementById('poolLine');
  if (!el) return;
  if (!poolSnapshot) {
    el.textContent = 'proxy offline';
    el.dataset.state = 'off';
    return;
  }
  const peak = poolSnapshot.peak ? ` · ${poolSnapshot.peak.window} ${poolSnapshot.peak.pct}%` : '';
  el.textContent = `${poolSnapshot.ready}/${poolSnapshot.total} logins ready${peak}`;
  el.title = poolSnapshot.peak
    ? `Highest upstream quota window in the pool: ${poolSnapshot.peak.window} at ${poolSnapshot.peak.pct}% used.`
    : 'No upstream quota windows have been reported yet.';
  el.dataset.state = 'on';
}

els.btnPush.addEventListener('click', async () => {
  if (!exportReady()) return;
  els.btnPush.disabled = true;

  // Server expects { name, provider, auth } — derive a display name from the session.
  const accountName = lastExport.name || lastExport.email || (jarInfo() ? jarInfo().account : 'DeepSeek Account');
  poolSnapshot = poolSnapshot || await readPool();
  const loginKey = String(lastExport.email || lastExport.name || '').trim().toLowerCase();
  const needsAuth = Boolean(loginKey && poolSnapshot?.needsAuth?.includes(loginKey));
  // The pool publishes a token fingerprint, which a Claude jar does not have; the
  // server's duplicate check covers that case instead.
  if (provider === 'deepseek' && poolMatches(lastExport.email || lastExport.name)) {
    // Same login, same session: nothing to do. A login the proxy rejected (needs_auth)
    // or a session that has since changed is a re-capture, and must go through — refusing
    // it would leave a dead login permanently unrepairable from this popup.
    const known = poolSnapshot?.tokens?.[loginKey] || '';
    const same = known && known === await tokenFingerprint(lastExport.token);
    if (same && !needsAuth) {
      renderPool();
      showCallout('warning', 'Already in the pool', `${accountName} is already one of the proxy's logins with this exact session. Nothing was pushed and nothing was signed out.`);
      els.btnPush.disabled = false;
      return;
    }
  }
  const payload = JSON.stringify({ name: accountName, provider, auth: lastExport });
  let pushed    = false;
  let lastError = '';

  for (const base of PROXY_URLS) {
    try {
      const res = await fetch(`${base}/admin/accounts/import`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    payload,
      });
      if (res.ok) {
        pushed = true;
        // A brand-new account was created: sign this browser out of that upstream so the
        // login belongs to the proxy only and the next capture starts clean. The imported
        // copy keeps working because it carries its own cookies.
        const upstream = provider === 'claude' ? 'claude.ai' : provider === 'grok' ? 'grok.com' : 'DeepSeek';
        let signedOut = false;
        if (res.status === 201 && signOutAfterPush) {
          try {
            const out = await send('signOut', { provider });
            signedOut = Boolean(out && out.success);
          } catch { /* keep the push result even if sign-out fails */ }
        }
        showCallout(
          'ok',
          signedOut ? 'Pushed and signed out' : 'Pushed to proxy',
          signedOut
            ? `Session sent to ${base}. This browser is signed out of ${upstream}; the proxy keeps the login.`
            : `Session sent to ${base}${jarInfo() ? ` as a ${jarInfo().label} login` : ''}`
        );
        flashButton(els.btnPush, '✓ Pushed');
        readPool().then((pool) => { poolSnapshot = pool; renderPool(); });
        break;
      } else {
        // Surface the server's error message when the request reaches the proxy
        // but is rejected (e.g. duplicate account, invalid auth).
        try {
          const json = await res.json();
          lastError = json?.error?.message || `HTTP ${res.status}`;
        } catch {
          lastError = `HTTP ${res.status}`;
        }
      }
    } catch (e) {
      lastError = e.message || 'Network error';
      // try next URL
    }
  }

  if (!pushed) {
    if (lastError && !lastError.startsWith('Network error') && !lastError.startsWith('Failed to fetch')) {
      showCallout('error', 'Push rejected', lastError);
    } else {
      showCallout('error', 'Proxy not running', 'Start FreeDeepseekAPI first (npm run dashboard).');
    }
    flashButton(els.btnPush, 'Failed');
  }

  els.btnPush.disabled = false;
});

// ─── Google Sign-In button ───────────────────────────────────────────────────

els.btnGoogleSignIn.addEventListener('click', async () => {
  if (!inExtension()) return;

  els.btnGoogleSignIn.disabled = true;
  const label = els.btnGoogleSignIn.querySelector('.btn-label');
  const prevLabel = label.textContent;

  // Step 1: opening page + clicking Google button (~1-2 s)
  label.textContent = 'Opening DeepSeek…';
  showCallout('warning', 'Opening sign-in…', 'Clicking the Google button automatically.');

  // Use a polling callout so the user sees live progress.
  const steps = [
    [2500,  'Redirecting to Google…',    'Sign in or pick your account in the tab.'],
    [8000,  'Waiting for Google…',       'Complete any account selection if prompted.'],
    [20000, 'Completing sign-in…',       'Almost there — finishing the OAuth flow.'],
    [45000, 'Still waiting…',            'This can take up to 90 s on slow connections.'],
  ];
  const stepTimers = steps.map(([delay, title, body]) =>
    window.setTimeout(() => {
      showCallout('warning', title, body);
      label.textContent = title;
    }, delay)
  );

  try {
    // Background does everything: open page → stealth → click Google →
    // watch for redirect → collect session. Returns { success, auth }.
    const response = await send('googleSignIn');

    // Clear progress timers.
    stepTimers.forEach((t) => clearTimeout(t));

    if (response && response.success && response.auth) {
      // Auto-collected — render immediately, no "Read current tab" needed.
      render(response.auth);
      showCallout('ok', 'Signed in & captured!', 'Session captured automatically. Ready to export.');
      label.textContent = '✓ Done';
      window.setTimeout(() => {
        label.textContent = prevLabel;
        els.btnGoogleSignIn.disabled = false;
      }, 3000);
    } else if (response && response.success) {
      // Signed in but collect not available yet (edge case).
      showCallout('ok', 'Signed in', 'Click "Read current tab" to capture your session.');
      label.textContent = 'Read tab ↑';
      window.setTimeout(() => {
        label.textContent = prevLabel;
        els.btnGoogleSignIn.disabled = false;
      }, 4000);
    } else {
      if (response?.auth) render(response.auth);
      throw new Error(response?.error || 'Could not complete sign-in.');
    }
  } catch (e) {
    stepTimers.forEach((t) => clearTimeout(t));
    showCallout('error', 'Sign-in failed', e.message);
    label.textContent = prevLabel;
    els.btnGoogleSignIn.disabled = false;
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────

function loadSignOutPreference() {
  try {
    chrome.storage.local.get([SIGN_OUT_KEY, AUTO_PUSH_KEY], (stored) => {
      if (typeof stored?.[SIGN_OUT_KEY] === 'boolean') {
        signOutAfterPush = stored[SIGN_OUT_KEY];
        if (els.chkSignOut) els.chkSignOut.checked = signOutAfterPush;
      }
      if (typeof stored?.[AUTO_PUSH_KEY] === 'boolean') {
        autoPushOnCapture = stored[AUTO_PUSH_KEY];
        if (els.chkAutoPush) els.chkAutoPush.checked = autoPushOnCapture;
      }
    });
  } catch { /* storage unavailable; keep the defaults on */ }
}

els.chkSignOut?.addEventListener('change', () => {
  signOutAfterPush = Boolean(els.chkSignOut.checked);
  try { chrome.storage.local.set({ [SIGN_OUT_KEY]: signOutAfterPush }); } catch { /* ignore */ }
});

els.chkAutoPush?.addEventListener('change', () => {
  autoPushOnCapture = Boolean(els.chkAutoPush.checked);
  try { chrome.storage.local.set({ [AUTO_PUSH_KEY]: autoPushOnCapture }); } catch { /* ignore */ }
});

// A pasted jar goes through the same verification and the same storage key as a captured
// one, so Copy / Download / Push cannot tell where it came from.
els.btnPasteSave?.addEventListener('click', async () => {
  const cookie = String(els.pasteCookie.value || '').trim();
  if (!cookie) {
    showCallout('warning', 'Nothing pasted', `Paste the ${jarInfo()?.host} cookie line first, then press Use this cookie.`);
    return;
  }
  showCallout('warning', 'Checking the cookie…', `Asking ${jarInfo()?.host} who it belongs to.`);
  try {
    const response = await send('setJarCookie', { provider, cookie });
    if (response === undefined) { await checkWorkerBuild(); showReloadWarning(); return; }
    if (!response?.success) { showCallout('error', 'That cookie was refused', response?.error || `${jarInfo()?.host} did not accept it.`); return; }
    render(response.auth);
    if (response.warning) {
      showCallout('warning', 'Session captured, not verified', `${response.warning} It was still stored — Push will tell you if the pool rejects it.`);
    }
    if (autoPushOnCapture && exportReady() && !els.btnPush.disabled) els.btnPush.click();
  } catch (e) {
    showCallout('error', 'Could not use that cookie', e.message);
  }
});

// Switching provider swaps the stored session and every provider-specific row, so a
// DeepSeek capture is never shown as if it were a Claude login.
function setProvider(next) {
  provider = JAR_PROVIDERS[next] ? next : 'deepseek';
  for (const btn of providerButtons) {
    const on = btn.dataset.provider === provider;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
  }
  lastExport = null;
  hideCallout();
  els.checkToken.hidden = Boolean(jarInfo());
  els.signOutRow.hidden = Boolean(jarInfo());
  els.btnCopy.disabled = true;
  els.btnSave.disabled = true;
  els.btnPush.disabled = true;
  els.pasteSection.hidden = !jarInfo();
  if (jarInfo()) {
    els.pasteCookie.placeholder = `${jarInfo().key}=…; cf_clearance=…`;
    els.pasteHint.textContent = `${jarInfo().host} → DevTools → Application → Cookies → copy ${jarInfo().key}`;
  }
  if (inExtension()) {
    checkWorkerBuild().then((mismatch) => { if (mismatch) { showReloadWarning(); return; } loadAuth(); });
  } else {
    render({});
  }
}

for (const btn of providerButtons) {
  btn.addEventListener('click', () => {
    if (btn.dataset.provider !== provider) setProvider(btn.dataset.provider);
  });
}  if (inExtension()) {
  loadSignOutPreference();
  setProvider('deepseek');
  readPool().then((pool) => { poolSnapshot = pool; renderPool(); renderLimits(); });
} else {
  setProvider('deepseek');
}
