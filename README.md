# typesafe-mcp

**TypeSafe System One dispatch pipeline as a ZCode plugin**: typed subagent
routing (Battery #1), deterministic thresholds, destructive-op guard, usage
ledger. Zero-dependency stdio MCP server (node 18+, plain fetch, node:crypto)
wrapping the [TypeSafe](https://typesafe.ai) System One API (Jev), plus the
executor registry and skill for the `typesafe-dispatch` pipeline.

JSON-RPC 2.0 over stdio, one message per line. The plugin is fully
self-contained: server, launcher, skill, and default data files all ship
inside `plugin/`.

## Install (users)

1. In ZCode: **Discover** → **`+`** → add this GitHub repo:
   `https://github.com/cyrusasco/typesafe-mcp`
2. Install the **typesafe-dispatch** plugin. ZCode wires the `ts_*` MCP tools
   (`ts_ping`, `ts_ask`, `ts_decide`, `ts_safety`, `ts_feasible`) and the
   `typesafe-dispatch` skill automatically.
3. **Bring your own TypeSafe API key** — the server degrades gracefully
   without one (`ts_ask` returns `{mode:"degraded", reason:"no_key"}` and
   never calls the API). Set it either way:
   - `TYPESAFE_API_KEY` as a real environment variable (recommended —
     survives plugin updates), or
   - a `.env` file next to the installed `server.mjs` (copy
     `plugin/.env.example`). Optional: point `TYPESAFE_DATA_DIR` at a stable
     directory so your `.env` + ledger survive plugin-cache refreshes.

Key resolution order: `process.env` → `<data dir>/.env` → `<plugin dir>/.env`
→ `~/.claude/settings.json` env block. Values are never logged.

### Data layout (where your stuff lives)

The server resolves one **data dir** at startup, in this order:

1. `$TYPESAFE_DATA_DIR` if set;
2. the plugin's **parent directory**, when it contains `executors.json`
   (a repo checkout / marketplace-root layout — this is what you get when
   running from a clone, so the ledger stays at the repo root);
3. the **plugin directory itself** (self-contained install; the shipped
   default `executors.json` / `patterns.json` are used).

The data dir holds `ledger/` (append-only usage log — personal, gitignored),
`.env`, `executors.json`, `patterns.json`. Edit the `executors.json` copy in
your data dir to change the executor registry; `ts_feasible` reads it
automatically.

### Optional: UserPromptSubmit reminder hook

The author runs a small hook (`hooks/dispatch-reminder.mjs` in the repo) that
detects build-shaped prompts and injects a one-line reminder to consult the
`typesafe-dispatch` skill. It is NOT installed by the plugin. To replicate:
register a `UserPromptSubmit` hook in your ZCode config pointing at
`node <path-to>/hooks/dispatch-reminder.mjs` (use your own absolute path —
the script reads the prompt on stdin and prints JSON `additionalContext`, or
exits silently for simple requests).

## Tools

| Tool | What |
| --- | --- |
| `ts_ping` | Health: has_key / model / today's token usage vs cap / circuit breaker. No API call. |
| `ts_ask` | THE one generic batched ask. Pre-flight: `no_key` → `budget_capped` → `breaker_open` all return `{mode:"degraded",reason}` without calling the API; `depth>0` rejected (recursion guard — subagents must not call). Redacts secrets before egress (count only). 429/529 retried w/ backoff; 422 surfaces the validation body (caller bug). |
| `ts_decide` | Deterministic threshold enforcement (the skill supplies semantics only). choice/score confidence: ≥0.75 auto, 0.5–0.75 flagged, <0.5 escalate. noul: ≥0.8 yes, ≤0.2 no, 0.35–0.65 escalate (deadband), else flagged_yes/no. Policy arg overrides per-kind/per-question. |
| `ts_safety` | **P0 #1** — destructive-op detection is deterministic code (`patterns.json`), never TS. destructive + not user-confirmed → always ask the user. |
| `ts_feasible` | **P0 #2** — hard-availability pre-filter of the executor registry (`requires.env` set, `requires.command` on PATH) so TS Choice only ever chooses among feasible executors. |

## Env vars (see `plugin/.env.example`)

`TYPESAFE_API_KEY` (required for normal mode), `TYPESAFE_MODEL` (default
`jev-latest`), `TYPESAFE_DAILY_TOKEN_CAP` (200000), `TYPESAFE_TIMEOUT_MS`
(5000), `TYPESAFE_MAX_RETRIES` (2), `TYPESAFE_DATA_DIR` (optional data-dir
pin).

## Ledger

`<data dir>/ledger/YYYY-MM-DD.jsonl` — one atomic append per call
(`fs.appendFileSync`). Fields: ts, call_id, tool, battery, depth, lang, mode,
model, questions_hash (sha256 of canonical questions — template-drift
detection), state_bytes, redactions, answers_summary (top-line values only),
usage, latency_ms, decision?, error?. **Never raw secrets or full state.**

## Circuit breaker

≥3 consecutive transient failures (timeout / network / 5xx / exhausted 429)
→ open for 5 min → ts_ask degrades with `breaker_open`; a probe after cooldown
is allowed (half_open). 401/422 are caller/config errors: thrown as errors,
not counted.

## Local development

```
node scripts/smoke.mjs        # 23 checks, no key, no network, no cost — ALL GREEN = pass
node scripts/live-test.mjs    # one REAL API call (costs a few hundred tokens; needs a key)
node scripts/cli.mjs ping     # CLI surface: ping|ask|decide|safety|feasible
node scripts/cli.mjs safety "git push --force origin main"
```

When running from a clone, scripts/ and the live data (`ledger/`, `executors.json`,
`.env`) sit at the repo root; the server inside `plugin/` picks them up via
rule 2 of the data-dir resolution. `.env` and `ledger/` are gitignored — your
key and usage history never leave the machine.

The `typesafe-dispatch` skill (in `plugin/skills/typesafe-dispatch/SKILL.md`)
documents the full pipeline: GATE philosophy, Battery #1 template, state
guidance, threshold table, recursion guard, degraded mode, and the pilot
success criteria that must be met before Batteries #2/#3 get built.

## License

MIT — see [LICENSE](LICENSE).
