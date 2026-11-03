# Chrome / Firefox Extension — Setup Guide

## Loading the Extension

### Chrome (Load Unpacked)

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder inside this project
5. The "unseeked" icon appears in your toolbar

### Firefox / Helium (Load Temporary Add-on)

1. Open Firefox and go to `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Navigate into the `chrome-extension/` folder and select **`manifest.json`**
4. The extension icon appears in your toolbar

> **Note:** Temporary add-ons in Firefox are removed when the browser restarts.
> For a permanent install you would need to sign the extension via addons.mozilla.org,
> but for local use the temporary method works fine.

### Why "Load Unpacked" works now

The extension was missing the `tabs` permission required by `chrome.tabs.query()`. Version 1.3 adds:

| Added | Reason |
|-------|--------|
| `"tabs"` | Required to query/open DeepSeek tabs |
| `"identity"` | Required for Google Sign-In via `chrome.identity` |
| `"https://accounts.google.com/*"` | Host permission for the OAuth flow |

---

## Google Sign-In — One-Time Setup

The **Sign in with Google** button uses Chrome's built-in OAuth2 identity API (`chrome.identity.getAuthToken`). This requires a Google Cloud project with the extension's ID registered.

### Steps

1. **Get your extension ID**  
   After loading unpacked, find the ID on `chrome://extensions/` — it looks like `abcdefghijklmnopqrstuvwxyz123456`.

2. **Create a Google Cloud OAuth client**  
   - Go to [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → Credentials
   - Click **Create credentials → OAuth 2.0 Client ID**
   - Application type: **Chrome Extension**
   - Item ID: paste your extension ID
   - Copy the resulting **Client ID** (ends in `.apps.googleusercontent.com`)

3. **Add the Client ID to manifest.json**  
   Edit `chrome-extension/manifest.json` and replace the placeholder:
   ```json
   "oauth2": {
     "client_id": "YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com",
     "scopes": ["openid", "email", "profile"]
   }
   ```

4. **Reload the extension** on `chrome://extensions/`

> **Without a real Client ID** the Google Sign-In button will show an error — but  
> all other functionality (Read tab, Copy, Download, Push to Proxy) works without it.  
> You can still sign in to DeepSeek manually and click **Read current tab**.

---

## Two providers

The popup has a **DeepSeek / Claude** switch under the header. Each capture is stored under its own key, so switching never overwrites the other one.

- **DeepSeek** — token from the live request header plus cookies, verified against `chat.deepseek.com`.
- **Claude** — a claude.ai cookie jar (`sessionKey` and the Cloudflare cookies the browser holds), verified against `claude.ai/api/organizations`, which also yields the organisation uuid the proxy stores with the login. There is no token to capture, and *Push to Proxy* never signs the browser out of claude.ai.

The manifest needs `https://claude.ai/*` for that verification request; reload the unpacked extension after updating.

**When the Claude tab says there is no session**, it names the claude.ai cookies it could actually read, e.g. *read 2 cookies (lastActiveOrg, __cf_bm) but no sessionKey*. That means the browser holds no claude.ai login (or holds one for a different profile), so sign in at claude.ai and press **Read current tab** again. A jar can never be imported, exported or pushed without `sessionKey`, and a DeepSeek session found under the Claude key is cleared on sight instead of being shown as a Claude login.

Reloading the extension is required after every update: the popup, the worker and the CSS are read from disk only when the extension reloads, and the version in `manifest.json` (currently 1.9) is how you tell the running build apart.

## Usage

| Button | What it does |
|--------|-------------|
| **Sign in with Google** | Opens a Chrome OAuth consent screen, then navigates to `chat.deepseek.com/sign_in?provider=google` |
| **Read current tab** | Takes the `Authorization` header and `x-hif-*` pair from a request the tab actually sent, plus cookies, then asks DeepSeek who they belong to. A token DeepSeek rejects is shown as **Token rejected by DeepSeek** and cannot be exported |
| **Copy** | Copies the JSON to your clipboard |
| **Download** | Saves `deepseek-auth.json`, or `claude-auth.json` when the Claude tab is selected |
| **Push to Proxy** | POSTs `{ name, provider, auth }` to the running unseeked server at `http://127.0.0.1:9655/admin/accounts/import`. When the server answers **201** (a new account), this browser is then signed out of DeepSeek — cookies and page storage cleared, tab sent to `/sign_in` — so the login belongs to the proxy only. It is a local sign-out with no server logout call, so the imported token keeps working |

**Auto-push.** Both toggles are on by default: *Push to the proxy as soon as a session is captured* sends a verified capture straight into the pool after **Read current tab**, with no second press, and *Sign this browser out of DeepSeek after adding it to the proxy* applies the local sign-out only to a newly created account (never to a Claude push, which leaves claude.ai signed in). Turn the first one off to keep the push a deliberate step.

**Capture order matters.** The extension reads the request the DeepSeek tab itself sent, so after signing in send **one short message** (for example `ok`) and then click **Read current tab**. If it says *Send one message* or *Token rejected*, that reload-plus-one-message is the fix; a token guessed out of `localStorage` is not the bearer DeepSeek authenticates with and is rejected with `INVALID_TOKEN`.

Requires the `webRequest` permission (granted on install; reload the unpacked extension after updating so Chrome re-asks).
