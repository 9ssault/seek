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
  rowCookie:         document.getElementById('rowCookie'),
  rowSource:         document.getElementById('rowSource'),
  chkSignOut:        document.getElementById('chkSignOut'),
};

let lastExport = null;

// Where the captured token came from, and whether DeepSeek accepted it.
const SOURCE_LABEL = { header: 'Live header', storage: 'Page storage', cookie: 'Cookie', none: 'None' };
const SIGN_OUT_KEY = 'sign_out_after_push';
let signOutAfterPush = true;

// ─── Helpers ────────────────────────────────────────────────────────────────

function cookieCount(cookie) {
  return String(cookie || '').split(';').map((p) => p.trim()).filter(Boolean).length;
}

function buildAuthJson(data) {
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
  const source = data && typeof data === 'object' ? data : {};
  const auth   = buildAuthJson(source);
  lastExport   = auth;

  const hasRead  = !!source._lastUpdated;
  // DeepSeek answered INVALID_TOKEN for this capture: it must never be exported.
  const rejected = hasRead && source._verified === false;
  const cookieN  = cookieCount(auth.cookie);
  const ready    = !!(auth.token && auth.cookie) && !rejected;

  // Account row
  const displayName = auth.name || auth.email || '';
  setValue(
    els.rowUser,
    rejected ? 'Not signed in' : displayName ? displayName : (hasRead ? 'Signed in' : 'Not read'),
    rejected || !displayName ? (hasRead && !rejected ? 'ready' : '') : 'ready'
  );

  // Token row
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

  // Google sign-in section: show when not yet read
  els.googleSignInSection.hidden = hasRead;

  // Callout
  if (!hasRead) {
    showCallout('warning', 'Open DeepSeek first', 'Sign in, then read the current tab — or use Sign in with Google below.');
    return;
  }

  if (rejected) {
    showCallout('error', 'Token rejected by DeepSeek', source._error || 'Sign in, send one short message, then collect again.');
    els.googleSignInSection.hidden = false;
  } else if (ready) {
    const who = auth.name || auth.email;
    const verified = source._verified === true && !source._unverified;
    showCallout(
      'ok',
      verified ? 'Session verified' : 'Session captured',
      verified
        ? (who ? `DeepSeek accepted this token. Signed in as ${who}.` : 'DeepSeek accepted this token. Ready to export.')
        : 'Captured offline, so DeepSeek has not confirmed the token yet.'
    );
  } else if (!auth.token && cookieN) {
    showCallout('warning', 'Send one message', 'Send one short message in the DeepSeek tab, then read the tab again to capture the token.');
  } else {
    showCallout('warning', 'Session not found', 'Sign in to DeepSeek and try again.');
    els.googleSignInSection.hidden = false;
  }
}

// ─── Load stored auth ────────────────────────────────────────────────────────

async function loadAuth() {
  try {
    const response = await send('export');
    if (response && response.success) render(response.auth);
    else showCallout('error', 'Could not read stored session', '');
  } catch (e) {
    showCallout('error', 'Extension error', e.message);
  }
}

// ─── Collect button ──────────────────────────────────────────────────────────

els.btnCollect.addEventListener('click', async () => {
  showCallout('warning', 'Reading tab…', 'Looking for your active session.');
  try {
    const response = await send('collect');
    if (response?.auth) render(response.auth);
    if (!(response && response.success)) showCallout('error', 'Collect failed', response?.error || 'Unknown error');
  } catch (e) {
    showCallout('error', 'Collect failed', e.message);
  }
});

// ─── Copy button ─────────────────────────────────────────────────────────────

els.btnCopy.addEventListener('click', async () => {
  if (!lastExport?.token || !lastExport?.cookie) return;
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
  if (!lastExport?.token || !lastExport?.cookie) return;
  const blob = new Blob([exportText(lastExport)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'deepseek-auth.json';
  a.click();
  URL.revokeObjectURL(url);
  flashButton(els.btnSave, '✓ Saved');
});

// ─── Push to Proxy button ────────────────────────────────────────────────────

els.btnPush.addEventListener('click', async () => {
  if (!lastExport?.token || !lastExport?.cookie) return;
  els.btnPush.disabled = true;

  // Server expects { name, auth } — derive a display name from the session.
  const accountName = lastExport.name || lastExport.email || 'DeepSeek Account';
  const payload = JSON.stringify({ name: accountName, auth: lastExport });
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
        if (res.status === 201 && signOutAfterPush) {
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
            : `Session sent to ${base}`
        );
        flashButton(els.btnPush, '✓ Pushed');
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
    chrome.storage.local.get(SIGN_OUT_KEY, (stored) => {
      if (typeof stored?.[SIGN_OUT_KEY] === 'boolean') {
        signOutAfterPush = stored[SIGN_OUT_KEY];
        if (els.chkSignOut) els.chkSignOut.checked = signOutAfterPush;
      }
    });
  } catch { /* storage unavailable; keep the default on */ }
}

els.chkSignOut?.addEventListener('change', () => {
  signOutAfterPush = Boolean(els.chkSignOut.checked);
  try { chrome.storage.local.set({ [SIGN_OUT_KEY]: signOutAfterPush }); } catch { /* ignore */ }
});

if (inExtension()) {
  loadSignOutPreference();
  loadAuth();
} else {
  render({});
}
