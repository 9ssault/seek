# Design Specification: Universal Error Auto-Rotation, 401 Auto-Refresh, Google Sign-In & Chrome Extension Enhancements

**Date:** 2026-10-31  
**Project:** FreeDeepseekAPI-EN  
**Author:** Antigravity  

---

## 1. Intent and Why
`FreeDeepseekAPI-EN` pools web chat credentials for DeepSeek to serve OpenAI-, Anthropic-, and Responses-compatible completions. Currently:
1. When any upstream account encounters an HTTP 401 (auth failure), 403, 5xx server error, PoW challenge error, or network drop, `callDeepSeekWithFailover()` immediately aborts the inbound request instead of rotating to another ready account in the pool.
2. Web tokens naturally expire (~24 hours) or get revoked, but the system treats 401 as a 10-minute transient cooldown without ever refreshing the token or disabling permanently dead accounts.
3. Adding accounts via Google Sign-In often gets blocked by Google's bot detection (*"This browser or app may not be secure"*) due to default automated Chromium flags.
4. Added and imported accounts lack identity metadata and are saved under generic sequential names (`deepseek-auth (1).json`, `account-1.json`).
5. The bundled Chrome extension exports generic `deepseek-auth.json` files without user identifiers, token validation, or direct sync to the local proxy.

The intent is to make `FreeDeepseekAPI-EN` completely resilient: requests never fail if at least one working account exists, invalid tokens are refreshed automatically, Google login works out-of-the-box, and accounts are automatically named after the authenticated user across both the core proxy and the Chrome extension.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **Universal In-Flight Failover:** Catch all upstream failures (HTTP 401, 403, 429, 500, 502, 503, 504, PoW failures, network timeouts/resets) inside `callDeepSeekWithFailover()` and seamlessly rotate to the next available account within the same request.
- **Automated Token Refresh:** When an account hits 401 or business code `40003`, attempt automatic refresh (via stored account credentials or headless browser CDP session renewal), save the refreshed credentials to disk, and retry before rotating.
- **Stealth Google Sign-In:** Configure Chromium with anti-detection flags (`--disable-blink-features=AutomationControlled`, clean User-Agent, CDP `navigator.webdriver` suppression) so Google OAuth is never blocked.
- **User/Account Naming Everywhere:** Extract user nickname, email, or identifier from DeepSeek web state and automatically name saved account files (`accounts/<user_or_email>.json`) and dashboard entries.
- **Enhanced Chrome Extension:** Upgrade `chrome-extension/` to auto-extract user identity, validate sessions before download, name export files dynamically (`deepseek-auth-<user>.json`), and offer a one-click *"Push to Local Proxy"* button.
- **Admin & Dashboard Tooling:** Add one-click Google Sign-In, *"Probe All Accounts"*, and per-account *"Refresh Token"* actions in the web dashboard.

### Non-Goals
- Bypassing Cloudflare or AWS WAF captchas without a real browser (WAF verification requires headless/interactive browser execution).
- Breaking existing OpenAI, Anthropic, or Responses API compatibility or existing CLI scripts.

### Anti-Goals
- Dropping request context on failover (the full conversation recovery prompt must always carry over).
- Silent degradation: if all accounts in the pool are genuinely exhausted, return a clear, structured error with appropriate HTTP status.

---

## 3. Constraints
- Must remain compatible with Node.js >= 18.
- Must keep all existing unit tests passing (all 299 tests currently pass).
- Avoid saving credentials in git or logging secrets in plain text.
- Must run cleanly inside the Linux sandbox and local development environment.

---

## 4. Approaches Considered
- **Approach A (CLI-only Stealth Auth & Manual File Import):** Only update `deepseek_chrome_auth.js` with stealth flags and auto-naming, leaving dashboard imports manual. *Rejected: does not fulfill the user's desire for full enhancement and web dashboard integration.*
- **Approach B (Full Dashboard + CLI Stealth Google Login, Universal Failover & Chrome Extension Overhaul - Chosen):** Complete end-to-end upgrade touching core rotation, auto-refresh engine, stealth Google login in both CLI and Web Dashboard, and an upgraded Chrome extension with direct proxy push.

---

## 5. Architectural & Implementation Details

### 5.1 Universal Failover on Any Error in `server.js`
In `callDeepSeekWithFailover(promptText, recoveryPrompt)`:
- Replace `if (!isAccountRateLimitError(e)) throw e;` with a comprehensive error handler.
- On error:
  - If error is 401 / 40003: trigger `tryAutoRefreshAccount(account)`. If refresh succeeds, retry the turn. If refresh fails, flag `account.invalid = true` or `account.cooldownReason = 'auth'`, release lock, and fail over to next ready login.
  - If error is 429: mark rate-limited with `Retry-After`.
  - If error is 5xx, PoW challenge error, or network socket drop: count failure, apply transient cooldown (15–30s), release chat lock, and rotate to the next account.
- Hops continue up to `accounts.length` until an account succeeds or deadline is hit.

### 5.2 Auto-Refresh Engine
- **Credential-Based Refresh:** If an account config contains `email`/`mobile` and `_password` (or stored credentials), issue a direct login request to `https://chat.deepseek.com/api/v0/users/login`.
- **Headless Browser Refresh:** If the account has an associated Chrome profile or Chrome is installed (`/usr/bin/chromium`), spin up headless Chromium via CDP, navigate to `chat.deepseek.com`, harvest fresh `localStorage.userToken` and cookies, update the auth file atomically on disk, and reload the account pool.
- **Disk Synchronization:** Write refreshed tokens back to `accounts/<id>.json` with mode `0600`.

### 5.3 Google OAuth Stealth Mode
In `scripts/deepseek_chrome_auth.js` and Chrome launcher:
- Pass:
  - `--disable-blink-features=AutomationControlled`
  - `--user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"`
  - `--disable-features=AutofillServerCommunication,OptimizationHints,MediaRouter`
- Via CDP:
  ```javascript
  await connection.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
  });
  ```
- This prevents Google from detecting automation and allows Google OAuth sign-in to complete cleanly.

### 5.4 Automatic User/Account Naming
- In `readPageAuth()` and Chrome extension:
  - Read `localStorage.getItem('user_info')`, `user`, or DOM profile badge.
  - Extract email or nickname.
  - Slugify the extracted identity (e.g. `alex-smith` or `dev-alex-gmail-com`).
  - Save file as `accounts/<slug>.json` and set `"name": "<User Name or Email>"`.
- In `adminImportAccount()`:
  - If no explicit name was provided, automatically inspect `auth.name`, `auth.email`, or parsed `user_info` before falling back to generic slugs.

### 5.5 Chrome Extension Overhaul (`chrome-extension/`)
- **Metadata Extraction:** Update `content.js` and `background.js` to extract `user_info` / user profile name and email alongside `userToken` and cookies.
- **Dynamic File Naming:** In `popup.js`, download as `deepseek-auth-<username>.json` instead of generic `deepseek-auth.json`.
- **Direct Push Button:** Add a *"Push to FreeDeepseekAPI"* button in `popup.html` and `popup.js` that sends the payload directly to `http://localhost:9655/admin/accounts/import`.
- **Pre-Flight Validation:** Test token and cookie completeness in popup with live status chips.

### 5.6 Comprehensive Localhost Dashboard Enhancements (`public/dashboard/`)
- **Real-Time Health & Verification Indicators:**
  - Enhance account cards and inspector in `public/dashboard/accounts.js` to display real token validation state (`Valid` [green], `Expired / 401` [red], `Rate-Limited` [yellow], `Cooldown` [amber], `Busy` [blue]).
  - Show real measured latency (ms) from upstream probes, last success timestamp, last error preview, and success rate percentage.
- **Interactive Health Actions:**
  - Add **"Test / Probe Token"** button for each account row to execute an immediate live PoW challenge/probe, displaying actual latency and validity status.
  - Add **"Probe All Accounts"** in the top action bar: concurrently checks all loaded accounts and dynamically highlights live vs expired credentials.
  - Add **"Refresh Token"** button per account to invoke on-demand auto-refresh.
- **One-Click Google Sign-In in Dashboard:**
  - In the "Add Account" dialog, add a prominent **"Sign in with Google"** button. Clicking it triggers the stealth Chromium launcher on the host with Google OAuth bypass, tracks sign-in progress via SSE/polling, automatically extracts the user's Google/DeepSeek identity, and saves it directly to the pool named after the user.
- **Traffic & Status Diagram Enhancements (`public/dashboard/status.js`):**
  - Display real p50 / p95 latency numbers, actual failure rate %, and error type distribution breakdown (401 Auth, 429 Rate Limit, 5xx Upstream, Network).
  - Update lane diagrams to accurately reflect healthy vs expired capacity.
- **Chat Test View Quick-Pinning (`public/dashboard/chat.js`):**
  - Add an account selector in the built-in Chat test window to easily pin and test any specific account on demand.

---

## 6. Verification and Testing Plan
1. **Automated Unit Tests:**
   - In `tests/account-failover.test.js`:
     - Test in-flight failover on HTTP 401 and code 40003 (verifying the request succeeds on Account B without client error).
     - Test in-flight failover on HTTP 500, 502, 503, and network errors.
     - Test account auto-refresh callback logic and persistence.
     - Test account auto-naming from user profile payload.
2. **Syntax and Existing Tests:**
   - Run `npm run test:syntax` and `npm run test:unit` to ensure zero regressions across all 299 existing tests.
3. **Manual / Live Smoke Verification:**
   - Verify Chrome extension builds and packages properly.
   - Verify stealth Chrome launcher boots with Google OAuth compatibility.
