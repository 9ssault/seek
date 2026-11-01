# Comprehensive Authentication, Rotation, Refresh & Dashboard Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform FreeDeepseekAPI-EN into a fully resilient, self-healing proxy with universal error rotation, auto-refresh on 401s, stealth Google login, automatic account naming by user identity, an overhauled Chrome extension, and a rich localhost dashboard showing real values.

**Architecture:** Update `server.js`'s completion pipeline to catch all upstream errors (401, 403, 429, 5xx, network drops, PoW failures) and fail over across the account pool in-flight. Implement an auto-refresh engine supporting credential re-login and background headless session renewal, persist refreshed tokens to disk, suppress Google OAuth automation detection in Chromium, automatically extract and assign account names from user profiles, upgrade the Chrome extension with dynamic naming and direct local proxy push, and add real-time probe and latency metrics to the localhost dashboard.

**Tech Stack:** Node.js (>=18), Chromium/CDP (Chrome DevTools Protocol), Vanilla JS/DOM (Dashboard & Extension), Node test runner (`node:test`).

**Spec:** `docs/superpowers/specs/2026-10-31-auth-rotation-refresh-design.md`

## Global Constraints
- Node.js >= 18 native modules only (no extra npm runtime dependencies).
- Zero test regressions (all 299 existing unit tests in `npm test` must continue to pass).
- No secrets or raw auth tokens committed to git or printed in un-redacted console logs.
- Account file permissions must remain `0600` on POSIX platforms.

## Review Focus
1. **Immediate In-Flight Failover:** An HTTP 401, 500, or socket drop during turn 1 must immediately rotate to Account B in the same client request without returning an error to the client.
2. **Conversation Context Carryover:** When rotation happens on error, the replacement account must receive the complete recovery prompt with full prior turn history.
3. **Google Sign-In Stealth:** Chromium must boot without `--enable-automation` and with `--disable-blink-features=AutomationControlled` plus `navigator.webdriver` undefined so Google login never shows "This browser or app may not be secure".
4. **Dynamic User Account Naming:** When adding or importing accounts without a name, the user's nickname or email must be extracted from the auth state and used as the filename and display name instead of generic numbers.
5. **Dashboard Live Values:** Real probe response times (ms), real token validity badges (`Valid`, `401 Expired`, `Rate-Limited`), and real latency metrics must display accurately in the localhost dashboard.

---

### Task 1: Universal Error Catching & In-Flight Failover in `server.js`

**Files:**
- Modify: `server.js:4740-4785` (`callDeepSeekWithFailover`), `server.js:680-715` (`markAccountFailure`), `server.js:920-945`
- Test: `tests/account-failover.test.js`

- [ ] **Step 1: Write failing unit test for in-flight failover on HTTP 401 and code 40003**
  In `tests/account-failover.test.js`, add a test where Account A fails with 401 / code 40003 on completion or PoW challenge, and verify that the request succeeds on Account B within the same HTTP request and sets `x-account-id: B`.
- [ ] **Step 2: Run test to confirm failure**
  Run `node --test tests/account-failover.test.js` and verify it fails because `callDeepSeekWithFailover` throws on non-rate-limit errors.
- [ ] **Step 3: Write failing unit test for in-flight failover on HTTP 500, 502, 503, and network errors**
  In `tests/account-failover.test.js`, add a test verifying that transient upstream server errors and socket connection resets trigger failover to Account B.
- [ ] **Step 4: Update `callDeepSeekWithFailover()` to rotate on all upstream errors**
  In `server.js`:
  - Catch all errors thrown during `askDeepSeekStream` and `readDeepSeekResponse`.
  - Mark account failure/cooldown appropriately.
  - Release account chat lock and refFileIds.
  - Fail over to the next candidate account in the pool for up to `accounts.length` hops.
- [ ] **Step 5: Run unit tests to verify pass**
  Run `npm test` and verify that the new failover tests pass and all existing tests remain green.

---

### Task 2: Token Normalization, Sanitization & Automated Refresh Engine

**Files:**
- Create: `lib/auth-refresh.js`
- Modify: `server.js:220-250`, `server.js:690-735`, `server.js:3330-3345`
- Test: `tests/account-failover.test.js`

- [ ] **Step 1: Implement `lib/auth-refresh.js`**
  Create helper functions:
  - `cleanToken(raw)`: strips duplicate `Bearer ` prefixes, trims whitespace, extracts token from JSON strings or `{ value: ... }`.
  - `probeAccountToken(account, fetchFn)`: issues a live PoW challenge request to test if credentials return `code: 0` vs `code: 40003`.
  - `refreshAccountWithCredentials(account, fetchFn)`: attempts direct `POST /api/v0/users/login` if credentials are saved in config.
  - `saveRefreshedAccount(account)`: writes updated config atomically to disk with mode `0600`.
- [ ] **Step 2: Integrate token normalization on load**
  In `server.js`:
  - Normalize `config.token` inside `buildBaseHeaders()` and `buildAccountsList()`.
  - Ensure duplicate `Bearer ` is never sent.
- [ ] **Step 3: Integrate auto-refresh attempt before failover**
  In `callDeepSeekWithFailover()`:
  - When encountering 401 / 40003, call `tryAutoRefreshAccount(account)`.
  - If refreshed, retry turn on current account.
  - If refresh fails, mark account `invalid: true` (or cooldown), log error, and fail over immediately to the next account.
- [ ] **Step 4: Run unit tests to verify token normalization and refresh**
  Run `node --test tests/account-failover.test.js` to confirm.

---

### Task 3: Stealth Google OAuth & Account Auto-Naming in CLI

**Files:**
- Modify: `scripts/deepseek_chrome_auth.js`
- Modify: `scripts/lib/chrome-setup.js`
- Test: `tests/chrome-setup.test.js`

- [ ] **Step 1: Write test for stealth Chrome launch arguments and name slugging**
  In `tests/chrome-setup.test.js`, test that stealth arguments include `--disable-blink-features=AutomationControlled` and clean User-Agent, and test `extractAccountIdentity(pageStores)`.
- [ ] **Step 2: Update Chrome launch arguments in `scripts/deepseek_chrome_auth.js`**
  - Add `--disable-blink-features=AutomationControlled`.
  - Omit `--enable-automation`.
  - Add `--user-agent="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"`.
  - Via CDP on connection ready, inject `Object.defineProperty(navigator, 'webdriver', { get: () => undefined });` via `Page.addScriptToEvaluateOnNewDocument`.
- [ ] **Step 3: Extract user identity and auto-name the account**
  In `readPageAuth()`:
  - Inspect `localStorage.getItem('user_info')`, `user`, or DOM profile element.
  - Extract email or nickname.
  - Save file to `accounts/<slug>.json` (if `accounts/` exists) or `deepseek-auth.json` with `"name": "<User Name or Email>"`, `"email": "<email>"`.
- [ ] **Step 4: Run tests to verify**
  Run `node --test tests/chrome-setup.test.js`.

---

### Task 4: Chrome Extension Overhaul (`chrome-extension/`)

**Files:**
- Modify: `chrome-extension/content.js`
- Modify: `chrome-extension/background.js`
- Modify: `chrome-extension/popup.html`
- Modify: `chrome-extension/popup.js`

- [ ] **Step 1: Update `content.js` and `background.js` to capture user profile metadata**
  - Extract `user_info` / profile name and email from `localStorage` and page stores.
  - Return `user` / `email` in the collected payload.
- [ ] **Step 2: Update `popup.html` with Push Button and Account Name display**
  - Add display showing the detected Account / User Name.
  - Add a *"Push to FreeDeepseekAPI"* button (`btnPush`) next to Copy and Save.
- [ ] **Step 3: Update `popup.js`**
  - In `buildAuthJson()`, include `name` and `email` properties.
  - When saving, dynamically download as `deepseek-auth-${slug}.json`.
  - In `btnPush`, send `POST http://localhost:9655/admin/accounts/import` with `{ name: auth.name, auth }`.
  - Show success callout when pushed to local proxy.
- [ ] **Step 4: Run syntax check on extension files**
  Run `node --check chrome-extension/background.js && node --check chrome-extension/content.js && node --check chrome-extension/popup.js`.

---

### Task 5: Localhost Dashboard Full Upgrade with Real Values & Probe Tooling

**Files:**
- Modify: `server.js:4050-4150` (admin endpoints)
- Modify: `public/dashboard/accounts.js`
- Modify: `public/dashboard/status.js`
- Modify: `public/dashboard/chat.js`
- Test: `tests/audit-dashboard.test.js`

- [ ] **Step 1: Add probe and refresh admin endpoints in `server.js`**
  - `POST /admin/accounts/:id/probe`: issues a live probe, returns `{ ok, status, code, latencyMs }`.
  - `POST /admin/accounts/:id/refresh`: triggers manual refresh, reloads account.
  - `POST /admin/accounts/probe-all`: concurrently probes all accounts and returns summary.
  - `POST /admin/accounts/google-login`: triggers stealth browser for interactive Google login.
- [ ] **Step 2: Enhance account cards and inspector in `public/dashboard/accounts.js`**
  - Display real token validity badge (`Valid` in green, `401 Expired` in red, `Rate-Limited` in yellow).
  - Display actual probe latency (ms).
  - Add **"Test Token"** button per row.
  - Add **"Probe All Accounts"** in the top action bar.
  - In the "Add Account" dialog, add **"Sign in with Google"** button with live progress indicator.
  - Auto-populate account name from imported auth.
- [ ] **Step 3: Enhance `public/dashboard/status.js` with real metrics**
  - Compute and display real p50/p95 latency, actual success rate percentage, and error breakdown.
- [ ] **Step 4: Enhance `public/dashboard/chat.js`**
  - Add an account pin selector so the operator can test specific accounts directly in the browser chat.
- [ ] **Step 5: Run dashboard tests to verify**
  Run `node --test tests/audit-dashboard.test.js`.

---

### Task 6: Final Verification & Integration Testing

**Files:**
- All modified files
- Tests: `tests/`

- [ ] **Step 1: Run complete syntax validation**
  Run `npm run test:syntax`.
- [ ] **Step 2: Run all unit and integration test suites**
  Run `npm run test:unit`.
- [ ] **Step 3: Test live account probe across real files**
  Execute `node scripts/doctor.js` and verify probe results.
- [ ] **Step 4: Mark task done in agent-memory**
  Verify evidence and update agent-memory.
