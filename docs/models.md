# Models

One model: **DeepSeek-V4.1-Flash**. The proxy talks to [chat.deepseek.com](https://chat.deepseek.com), not the paid `api.deepseek.com` key.

`deepseek-flash` is a short alias of `deepseek-v4-flash`. The suffixes are the two switches from the DeepSeek chat composer. They do not select a different model.

| ID | DeepThink | Native web search |
|---|---|---|
| `deepseek-v4-flash` / `deepseek-flash` | off | on |
| `deepseek-v4-flash-thinking` | on | on |
| `deepseek-v4-flash-nosearch` | off | off |
| `deepseek-v4-flash-thinking-nosearch` | on | off |

**`-thinking` turns DeepThink on.** V4.1-Flash reasons before it answers. The underlying model stays DeepSeek-V4.1-Flash.

**Native Web Search of chat.deepseek.com is on by default.** Internet lookups go through that search. A harness `websearch`, `webfetch`, or `WebFetch` tool is not a substitute; the proxy drops those tools while search is on.

**`-nosearch` turns search off.** So does `"web_search": false` in the request body, on any id. `"web_search": true` turns it back on for a `-nosearch` id. Any other value returns `400 invalid_request_error`. With search off, a coding agent keeps its own web tools.

**Former `-search` IDs.** `deepseek-v4-flash-search` and `deepseek-v4-flash-thinking-search` still work and mean `deepseek-v4-flash` and `deepseek-v4-flash-thinking`. They are not listed in `/v1/models`.

## Claude

A second upstream, merged into the same pool. The id chooses the transport; the endpoint, the auth header and the response shape stay the same.

| ID | Web model | Thinking |
|---|---|---|
| `claude-sonnet-4-6` (`sonnet`) | `claude-sonnet-4-6` | on |
| `claude-haiku-4-5` (`haiku`) | `claude-haiku-4-5-20251001` | off |
| `claude-sonnet-4-5` | `claude-sonnet-4-5-20250929` | on (not served on a standard plan) |
| `claude-opus-4-1`, `claude-opus-4-6` (`opus`) | `claude-opus-4-1-20250805`, `claude-opus-4-6` | on (not served on a standard plan) |

A standard claude.ai login serves **Sonnet 4.6** and **Haiku 4.5**. Requesting any other id is answered with `403 permission_error: model_not_available`, which is a plan entitlement, not a rejected cookie: the gateway retries the same conversation on the next servable model (`sonnet-4-6` → `haiku-4-5`) and never parks the login for it. `opus` therefore resolves to Sonnet 4.6.

A Claude id routes to Claude only when a Claude login is loaded (`~/.seek/accounts/*.json` with `provider: "claude"` or a `sessionKey` cookie). Without one, `claude-sonnet-4-5` keeps resolving to DeepSeek, so an existing agent setup is unaffected. `claude/…` and `anthropic/…` always take the Claude path — an explicit prefix is an instruction, and the failure then names the missing login instead of answering from the other provider.

Claude turns also carry the login's real quota: claude.ai streams a `message_limit` frame with the `5h` and `7d` windows, which `GET /admin/accounts` and `/health` report per account under `limits`.

Claude has no native web search in this gateway, so `web_search` is ignored on those ids and a harness search tool is left alone.

## Grok

A third upstream, same contract. The ids below are the ones a grok.com account can actually serve; `grok-4`, `grok-4-fast`, `grok-4-1`, `grok-code-fast-1` and plain `grok-3` are answered with `Model is not found` and fall back to the servable pair.

| ID | Web model | Thinking |
|---|---|---|
| `grok-3-reasoning` (`grok`, `grok-latest`, `grok-4`) | `grok-3-reasoning` | on |
| `grok-3-mini-companion` (`grok-fast`) | `grok-3-mini-companion` | off |

Like Claude, the login is a cookie jar (`sso` plus the Cloudflare cookies), so there is no bearer token. Grok publishes no quota windows; the gateway's own 5h/24h request counters are what its `limits` view carries.

Older IDs are not registered: `deepseek-v4-pro`, `deepseek-chat`, `deepseek-reasoner`, `deepseek-r1`, `deepseek-instant`, `deepseek-expert`, and vision. They return `400 invalid_model`.

Claude Code names such as `claude-sonnet-*` and `claude-opus-*` map onto DeepSeek-V4.1-Flash and DeepSeek-V4.1-Flash with DeepThink.

List: `GET /v1/models`. Full map: `GET /v1/model-capabilities`.
