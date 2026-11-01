# stool on seek

Point stool's own `ask`, `profile` and `stoolai` paths at this proxy instead of any
other pool. Nothing in `stool` is edited and nothing is overwritten: the two
variables `bin/router.py` already reads are set in your shell, or sourced for one run.

```sh
# one shell
. integrations/stool/seek.env

# one command only
env $(grep -v '^#' integrations/stool/seek.env | xargs) stool ask "how do I pivot from a mailbox?"
```

`integrations/stool/seek.env`:

```
FREEDEEPSEEK_BASE_URL=http://127.0.0.1:9655/v1
FREEDEEPSEEK_API_KEY=local
```

The gateway owns account rotation and failover, so stool needs nothing else. Model
ids it serves: `deepseek-v4-flash`, `deepseek-v4-flash-thinking`,
`deepseek-v4-flash-nosearch`, `deepseek-v4-flash-thinking-nosearch`.
