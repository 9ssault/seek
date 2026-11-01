# Linking another project to the proxy

This is the contract a consumer (another app, agent, or service) may rely on. Anything
listed as *stable* will not change shape without a major version; everything else is
additive and free to grow.

## Base

```
http://127.0.0.1:9655/v1
```

* Authorization: `Bearer <PROXY_API_KEY>` when `PROXY_API_KEY` is set. When it is unset
  the proxy accepts unauthenticated loopback calls, so a single-machine tool needs no key.
* CORS: loopback origins are always allowed; add others with `PROXY_CORS_ORIGINS=https://app.example,https://other.example`.
* Bodies are JSON. `MAX_REQUEST_BODY_BYTES` (30 MiB default) bounds a request.

## Stable endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI chat-completions, streaming and not |
| `POST` | `/v1/messages` | Anthropic messages (send `anthropic-version`) |
| `POST` | `/v1/responses` | OpenAI responses (`input`, `input_image`) |
| `GET` | `/v1/models` | The ids below |
| `GET` | `/health` | Pool and session state, private fields only with the key |
| `GET` | `/readyz` | `200` when a login can serve, `503` when none can |
| `POST` | `/new` | Start a new upstream chat for the caller's session |
| `POST` | `/reset-session?agent=all` | Reset one or every session |

Model ids are stable, including the legacy `-search` aliases:

```
deepseek-v4-flash                (web search on)
deepseek-v4-flash-thinking       (DeepThink + web search)
deepseek-v4-flash-nosearch       (no web search)
deepseek-v4-flash-thinking-nosearch
```

An unknown id is not rejected: it falls back to the default model. Model *display* names
in generated agent configs are cosmetic and may change.

## Sessions

* Without a header, a session is `unkeyed-<client hash>:<first-turn fingerprint>`, so one
  process keeps continuity per conversation without ever sharing a chat across chats.
* Send `x-agent-session: <id>` (or `user: <id>`) for explicit, stable keying — this is
  what a linked project should do, one id per conversation.
* A live upstream chat keeps the system prompt and prior turns; only the new turn is sent.

## Response headers

| Header | Meaning |
|---|---|
| `x-account-id` | Which login served the request |
| `X-FreeDeepseek-Context-Compacted` | `true` when the prompt had to be trimmed |

## Errors

`{"error": {"type": "...", "message": "..."}}`, with `Retry-After` on throttling.

| Status | `type` | Meaning |
|---|---|---|
| `401` | `authentication_error` | Wrong proxy key |
| `413` | `payload_too_large` | Body over the limit |
| `422` | `invalid_request` | Bad parameters |
| `429` | `rate_limit_error` | Every usable login is throttled; retry after the delay |
| `502` | `upstream_http_error`, `empty_response` | DeepSeek failed or answered nothing |
| `503` | `overloaded` | In-flight limit reached (`DEEPSEEK_MAX_CONCURRENT`) |
| `504` | `request_timeout` | Request deadline (`DEEPSEEK_REQUEST_DEADLINE_MS`) |

A `429` is a pool-wide condition, not a bad request: back off and retry, do not rewrite
the prompt. `400 context_length_exceeded` means the prompt was too large even after
compaction — shorten it rather than retrying unchanged.

## Behaviour a consumer can count on

* One login never serves two chats at once; a second request queues or fails over.
* A prompt over `DEEPSEEK_MAX_PROMPT_CHARS` is trimmed, not rejected, and the trimmed
  middle is summarized by an idle login.
* Empty replies, broken tool markup and timeouts retry on the same chat before failing.
* `/health` and `/admin/*` are additive: new fields appear, existing ones keep meaning.
  `/admin/*` is for the bundled dashboard; do not build a product on it.
