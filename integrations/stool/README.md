# stool on seek

Point tool's own `ask` / `profile` / `stoolai` paths at this proxy instead of the
HyperRouter pool. Nothing in `stool` is edited and nothing is overwritten: the
two variables it already reads are set in your shell, or sourced for one run.

```sh
# one shell
. /home/abc/FreeDeepseekAPI-EN/integrations/stool/seek.env

# one command only
env $(grep -v '^#' integrations/stool/seek.env | xargs) stool ask "how do I pivot from a mailbox?"
```

`integrations/stool/seek.env`:

```
HYPERROUTER_BASE_URL=http://127.0.0.1:9655/v1
HYPERROUTER_API_KEY=local
```

- `HYPERROUTER_BASE_URL` is the only thing stool needs to find a different
  OpenAI-compatible endpoint; the key is required by the variable's name only, and
  this proxy accepts `local` unless you set `PROXY_API_KEY`.
- `stool router` / `stool ask --check` read the same variables, so they report
  `seek` immediately after sourcing.
- Unset them (or start a new shell) to go back to the router. `STOOL_NO_ROUTER=1`
  keeps stool fully offline.
- `stoolai` runs every `RUN:` line through `bash -c` as before; the model behind
  those lines is what changes.

## What seek serves to stool

| stool call | model id to use |
|---|---|
| `stool ask "..."` | `deepseek-v4-flash` (native DeepSeek search on) |
| `stool ask --model auto-quality` | `deepseek-v4-flash-thinking` |
| `stoolai` / `stool assess` | `deepseek-v4-flash-nosearch` (agent keeps its own web tools) |
| image or PDF page as context | any id; the proxy converts the attachment |

All three wire protocols are live on the same port: `/v1/chat/completions`,
`/v1/messages` (Anthropic) and `/v1/responses`. `GET /v1/models` lists the ids
above, so a client that probes the endpoint finds them.

## Health and the persona

`curl -s 127.0.0.1:9655/health | jq '{persona, accounts: [.accounts[] | {name, ready, auth_state}]}'`

stool's own operator voice (`hyperion_persona.txt`) is unaffected — it is sent as
the system prompt by stool and passed through. The proxy's persona is appended
after it, so the rules that ship with seek never replace stool's voice.
