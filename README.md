<p align="center">
  <img src="assets/banner.svg" alt="seek — a gateway to DeepSeek web, made by Hyperion" width="100%">
</p>

# seek

*Made by Hyperion.*

One self-hosted gateway in front of DeepSeek web. It speaks OpenAI chat-completions, Anthropic messages and OpenAI responses, keeps **one upstream chat per conversation**, and spreads requests across a pool of logins so a throttled or dead account does not end the session.

**You probably need a lot of accounts for bigger tasks.** A DeepSeek web login serves one chat at a time and its session expires; the pool rotates, cools down and re-authenticates on its own, but the work runs out of logins long before it runs out of ideas.

## Run

```bash
git clone https://github.com/9ssault/seek.git
cd seek
npm start          # http://127.0.0.1:9655/v1  ·  dashboard at /dashboard
```

No dependencies to install: Node 22+ and its own standard library.

## Logins

Logins live in `~/.seek/accounts` — one JSON file each, outside the checkout, so every clone reads the same pool and nothing credential-shaped can be committed. `SEEK_HOME` moves the store; `DEEPSEEK_AUTH_DIR` overrides it outright. An older in-tree `accounts/` is still read until you adopt it.

Both providers are captured from a real browser session; neither asks for a password on disk.

```bash
npm run auth -- --name work          # chat.deepseek.com: opens Chrome, waits, stores, reloads
npm run claude:auth -- --name work   # claude.ai: same, cookie jar instead of a token
npm run accounts:share               # adopt an existing checkout's accounts/ into the store
npm run doctor
```

Nothing to edit by hand: the capture writes mode `0600`, validates against the upstream first, and reloads a running gateway. `npm run claude:auth -- --cookie "sessionKey=…"` skips the browser for CI, and `--force` stores a cookie the upstream does not confirm yet.

`npm run waf:refresh` refreshes the WAF tokens in place (DeepSeek only — a Claude cookie is renewed by capturing it again), and `GET /health` lists every login, its provider, its role and its cooldown.

## Point an agent at it

```bash
npm run setup:agents      # Claude Code, Codex, OpenCode, Hermes, OpenClaw
```

Any OpenAI-compatible client works: base URL `http://127.0.0.1:9655/v1`, key `local` (or `PROXY_API_KEY`), model `deepseek-v4-flash`, with `-thinking` and `-nosearch` variants.

A Claude login merges into the same pool — same endpoints, same dashboard, same one-conversation-per-agent rule. The model id picks the upstream:

| ID | Upstream |
|---|---|
| `claude-sonnet-4-5`, `claude-opus-4-1`, `claude-haiku-4-5` | claude.ai, once a Claude login is loaded |
| `claude/…`, `anthropic/…` | claude.ai, explicitly, even with no Claude login (the error then names the missing account) |
| `deepseek-v4-flash*` | chat.deepseek.com |

With no Claude login in the pool, `claude-sonnet-4-5` keeps resolving to DeepSeek exactly as before, so an existing Claude Code setup does not change on upgrade. `npm run setup:agents -- --model claude-sonnet-4-5` points an agent at Claude instead.

## Tools on `/`

The reverse-engineering and pentest tools installed on this machine become slash commands in OpenCode and Codex — `/rea`, `/jadx`, `/apktool`, `/ghidra`, `/rizin`, `/ida`, `/frida`, `/gdb`, `/tshark`, `/nmap`, `/binwalk`, `/unblob`, `/yara`, and `/pentest` (183+ recon and OSINT tools from [AKCodez/hackingtool-plugin](https://github.com/AKCodez/hackingtool-plugin), vendored in `plugins/hackingtool/`).

```bash
npm run setup:tools            # what is installed, written to both harnesses
npm run setup:tools -- --all   # every entry, missing ones marked
```

## What it keeps straight

- One conversation, one upstream chat. A new conversation gets a new chat instead of continuing the last one.
- The persona is sent once per chat; later turns carry a one-line reminder, so the prompt budget goes to the work.
- A prompt that has to be trimmed is summarized on an idle login, and that summary is **cumulative** — the session keeps its goal and decisions, not just its newest turn.
- Memory survives restarts (`~/.freedeepseek-api/memory.json`), and a login is never given two chats at once.


## Browser extension

`chrome-extension/` captures a login from the browser you are already signed into: Google sign-in, live header capture, verification against DeepSeek before it is kept, pool status, and a duplicate check so the same login is never added twice. Load it unpacked from `chrome://extensions`, and it fills the pool one login at a time — which is the point.

## Container

Rootless Podman, no root, no capabilities, no writable root filesystem.

```bash
podman build --tag localhost/seek:local --file Containerfile .
podman secret create --replace free-deepseek-auth ./deepseek-auth.json
```

```bash
podman run --detach \
  --name seek \
  --publish 127.0.0.1:9655:9655 \
  --secret free-deepseek-auth,type=mount,target=/run/secrets/deepseek-auth.json,mode=0400 \
  --secret free-deepseek-proxy-key,type=mount,target=/run/secrets/proxy-api-key,mode=0400 \
  --read-only \
  --cap-drop=ALL \
  --security-opt=no-new-privileges \
  localhost/seek:local
```

The image refuses to start without `PROXY_API_KEY_FILE`, and `/readyz` answers `503` while no login can serve a chat.

## Docs

| | |
|---|---|
| [`docs/api.md`](docs/api.md) | Endpoints, streaming, images, tools |
| [`docs/agents.md`](docs/agents.md) | One-click setup per agent |
| [`docs/auth.md`](docs/auth.md) | Auth files, capture, rotation |
| [`docs/models.md`](docs/models.md) | Model IDs and flags |
| [`docs/integration.md`](docs/integration.md) | The contract to build against: endpoints, errors, sessions |

## License

Apache 2.0. Not affiliated with DeepSeek; it speaks to the public web app with your own account.
