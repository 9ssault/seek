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
  chkSignOut:        document.getElementById('chkSignOut'),
  signOutRow:        document.getElementById('signOutRow'),
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

function cookieHasSessionKey(cookie) {
  return /(^|;\s*)sessionKey=[^;]+/.test(String(cookie || ''));
}

// A stored Claude capture is only usable if it came from the Claude collector. A record
// carrying a DeepSeek field (token, _tokenSource) is a DeepSeek session that ended up
// under the wrong key — every browser that upgraded from an older build can have one —
// and must never be shown or exported as a claude.ai login.
function isForeignClaudeRecord(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.provider === 'claude') return false;
  return Boolean(record.provider === 'deepseek' || record.token || record._tokenSource || record.hif_dliq);
}

function cookieNames(cookie) {
  return String(cookie || '').split(';')
    .map((part) => part.split('=')[0].trim())
    .filter(Boolean);
}

function buildAuthJson(data) {
  // A Claude login is the cookie jar itself; there is no token to send.
  if (provider === 'claude') {
    return {
      provider: 'claude',
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

function send(action, data = {}) {
  return new Promise((resolve, reject) => {
    if (!inExtension()) {
      reject(new Error('Reload the unpacked extension, then open this popup from the toolbar.'));
      return;
    }
    chrome.runtime.sendMessage({ action, ...data }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

// ─── Render ─────────────────────────────────────────────────────────────────

function render(data) {
  const claude = provider === 'claude';
  // A stored capture belongs to exactly one upstream. An older background worker that
  // ignores `provider` would hand back the DeepSeek session for a Claude tab, and
  // painting it here would show a DeepSeek login under a Claude heading.
  const raw = data && typeof data === 'object' ? data : {};
  const capturedAs = raw.provider === 'claude' ? 'claude'
    : (raw.token || raw._tokenSource || raw.hif_dliq) ? 'deepseek' : null;
  const source = capturedAs && capturedAs !== provider ? {} : raw;
  const auth   = buildAuthJson(source);
  lastExport   = auth;

  const hasRead  = !!source._lastUpdated;
  // The upstream answered with a rejection (DeepSeek INVALID_TOKEN, claude.ai 401):
  // that capture must never be exported.
  const rejected = hasRead && source._verified === false;
  const cookieN  = cookieCount(auth.cookie);
  const ready    = (claude ? cookieHasSessionKey(auth.cookie) : !!(auth.token && auth.cookie)) && !rejected;
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
      claude ? 'Open claude.ai first' : 'Open DeepSeek first',
      claude
        ? 'Sign in on claude.ai in this browser, then read the current tab.'
        : 'Sign in, then read the current tab — or use Sign in with Google below.'
    );
    return;
  }

  if (rejected) {
    showCallout(
      'error',
      claude ? 'claude.ai rejected this session' : 'Token rejected by DeepSeek',
      source._error || (claude ? 'Sign in again, then read the tab.' : 'Sign in, send one short message, then collect again.')
    );
    els.googleSignInSection.hidden = claude;
  } else if (ready) {
    const who = auth.name || auth.email;
    const verified = source._verified === true && !source._unverified;
    const upstream = claude ? 'claude.ai' : 'DeepSeek';
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
          ? `Read ${names.length} claude.ai cookie${names.length === 1 ? '' : 's'} (${names.join(', ')}) but no sessionKey. Sign in at claude.ai, then read the tab again.`
          : 'Use a tab signed in to claude.ai, then read it again.')
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
      showCallout('error', 'Reload the extension', 'The background worker is an older build. Open chrome://extensions and press Reload on this extension.');
      return;
    }
    if (!(response && response.success)) { showCallout('error', 'Could not read stored session', ''); return; }
    const stored = response.auth || {};

    // The Claude key held a DeepSeek session: clear it so it cannot be exported, and
    // say plainly what to do instead of painting someone else's login.
    if (provider === 'claude' && isForeignClaudeRecord(stored)) {
      await send('forget', { provider: 'claude' });
      render({});
      showCallout('warning', 'No claude.ai session yet', 'The stored capture under Claude belonged to DeepSeek, so it was cleared. Open claude.ai, sign in, then press Read current tab.');
      return;
    }

    // A stored jar with no sessionKey is not a login. Report the cookies that were
    // readable so a missing one is visible rather than guessed at.
    if (provider === 'claude' && stored._lastUpdated && !cookieHasSessionKey(stored.cookie)) {
      const names = cookieNames(stored.cookie);
      render({});
      showCallout(
        'warning',
        'No claude.ai session yet',
        names.length
          ? `The stored jar holds ${names.length} cookie${names.length === 1 ? '' : 's'} (${names.join(', ')}) and no sessionKey. Sign in at claude.ai, then press Read current tab.`
          : 'Nothing was captured yet. Open claude.ai in this browser, sign in, then press Read current tab.'
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
    const response = await send(provider === 'claude' ? 'collectClaude' : 'collect');
    if (response === undefined) {
      showCallout('error', 'Reload the extension', 'This build cannot collect a claude.ai login yet. Open chrome://extensions and press Reload on this extension.');
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
  return provider === 'claude'
    ? cookieHasSessionKey(lastExport.cookie)
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
  a.download = provider === 'claude' ? 'claude-auth.json' : 'deepseek-auth.json';
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

function renderPool() {
  const el = document.getElementById('poolLine');
  if (!el) return;
  if (!poolSnapshot) {
    el.textContent = 'proxy offline';
    el.dataset.state = 'off';
    return;
  }
  el.textContent = `${poolSnapshot.ready}/${poolSnapshot.total} logins ready`;
  el.dataset.state = 'on';
}

els.btnPush.addEventListener('click', async () => {
  if (!exportReady()) return;
  els.btnPush.disabled = true;

  // Server expects { name, provider, auth } — derive a display name from the session.
  const accountName = lastExport.name || lastExport.email || (provider === 'claude' ? 'Claude Account' : 'DeepSeek Account');
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
        // A brand-new account was created: sign this browser out of DeepSeek so the
        // login belongs to the proxy only, and the next capture starts clean. The
        // imported copy keeps working because it carries its own token and cookies.
        let signedOut = false;
        if (res.status === 201 && signOutAfterPush && provider === 'deepseek') {
          try {
            const out = await send('signOut');
            signedOut = Boolean(out && out.success);
          } catch { /* keep the push result even if sign-out fails */ }
        }
        showCallout(
          'ok',
          signedOut ? 'Pushed and signed out' : 'Pushed to proxy',
          signedOut
            ? `Session sent to ${base}. This browser is signed out of DeepSeek; the proxy keeps the login.`
            : `Session sent to ${base}${provider === 'claude' ? ' as a Claude login' : ''}`
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

// Switching provider swaps the stored session and every provider-specific row, so a
// DeepSeek capture is never shown as if it were a Claude login.
function setProvider(next) {
  provider = next === 'claude' ? 'claude' : 'deepseek';
  for (const btn of providerButtons) {
    const on = btn.dataset.provider === provider;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-selected', String(on));
  }
  lastExport = null;
  hideCallout();
  els.checkToken.hidden = provider === 'claude';
  els.signOutRow.hidden = provider === 'claude';
  if (inExtension()) loadAuth();
  else render({});
}

for (const btn of providerButtons) {
  btn.addEventListener('click', () => {
    if (btn.dataset.provider !== provider) setProvider(btn.dataset.provider);
  });
}

if (inExtension()) {
  loadSignOutPreference();
  setProvider('deepseek');
  readPool().then((pool) => { poolSnapshot = pool; renderPool(); });
} else {
  setProvider('deepseek');
}
