# typesafe-mcp

<p align="center"><img src="docs/pipeline.svg" alt="typesafe-dispatch pipeline: Gate → ts_feasible → Battery #1 → ts_decide → dispatch (+skill suggestion) → guarded subagent → verify → report, with a JSONL ledger under everything" width="880"></p>

**TypeSafe System One (Jev) routing and monitoring for agent work.** v1.9 adds a dedicated Codex control plane: parent English plan → Jev hardness/model/effort/role/Skill choices using live capability and GitNexus evidence → native child execution → receipt-backed monitoring/correction → parent evidence review.

The Codex workflow is **not a context compactor**. Every governed command is submitted to Jev; the legacy ZCode GATE/bypass rule is not carried into the Codex adapter. Existing Skills stay at their canonical paths. Global model/account settings and existing plugin/MCP ownership are unchanged.

**Delivery boundary:** the implementation and offline tests are in this repo. The control plane returns an action outbox that the parent host must execute through its real native tools; an MCP server cannot magically spawn or monitor its parent host. Packaged lifecycle hooks are advisory, not whole-process enforcement. Live Jev/GitNexus access, actual child model settings, effective permissions and deployment require separate observed receipts. Do not infer those from fixture tests.

See [Codex protocol and exact boundaries](plugin/codex/PROTOCOL.md), [Codex Skill](plugin/skills/typesafe-codex/SKILL.md), and [v1.9 changes](docs/V1_9_CHANGELOG.md). Legacy ZCode/Claude workflows remain separate; their historical narrative below is not a Codex acceptance claim. Node 22+ is the tested baseline; no runtime dependencies.

The [local integration receipt](docs/CODEX_LOCAL_INSTALL.md) records main-home installation, real Jev/Guardian probes, the first rejected routing result, and the remaining host-reload/native-execution gate. Installed does not mean every existing task has loaded the tools.

## Install — ZCode

1. In ZCode: **Discover** → **`+`** → add this GitHub repo:
   `https://github.com/cyrusasco/typesafe-mcp`
2. Install the **typesafe-dispatch** plugin. ZCode wires the `ts_*` MCP tools
   (`ts_ping`, `ts_ask`, `ts_decide`, `ts_safety`, `ts_feasible`) and the
   `typesafe-dispatch` skill automatically (ZCode probes
   `plugin/.zcode-plugin/plugin.json`).
3. Bring your own TypeSafe API key — see [API key](#api-key) below.

Optional (ZCode has no plugin hook registration): register a `UserPromptSubmit`
hook pointing at `node <path-to>/hooks/dispatch-reminder.mjs` (repo root copy;
the script reads the prompt on stdin and prints JSON `additionalContext`, or
exits silently for simple requests).

## Install — Claude Code

```
claude plugin marketplace add cyrusasco/typesafe-mcp
claude plugin install typesafe-dispatch@typesafe-mcp
```

Claude Code probes `plugin/.claude-plugin/plugin.json` (manifest, validated
with `claude plugin validate`) and wires, with no extra steps:

- **MCP server** — `plugin/.mcp.json`: `node ${CLAUDE_PLUGIN_ROOT}/mcp-launcher.mjs`
- **Skill** — auto-discovered from `plugin/skills/typesafe-dispatch/`
- **Reminder hook** — `plugin/hooks/hooks.json` registers
  `hooks/dispatch-reminder.mjs` on `UserPromptSubmit` (build-shaped prompts get
  a one-line nudge toward the skill; simple prompts stay untouched)

Then bring your own TypeSafe API key — see [API key](#api-key) below.

## Package — Codex Desktop / CLI

Codex supports plugins and trusted lifecycle hooks. Build a separate, self-contained Codex artifact so legacy ZCode Skills/hooks do not leak into the new host workflow:

```text
node scripts/package-codex.mjs <absolute-new-output-directory>
```

The output contains `.codex-plugin/plugin.json`, `.mcp.json`, `skills/typesafe-codex/`, `hooks/hooks.json`, and the allowlisted runtime modules. It contains no credentials or user state. Existing output paths are rejected. Building does not install, trust hooks, modify Codex config, or launch Codex. Use your host's supported local-plugin installation flow and review hook trust before enabling it.

The Codex server entrypoint is `codex/server.mjs` **inside that output artifact**. It exposes eight `ts_codex_*` tools and uses the parent native bridge described in the [protocol](plugin/codex/PROTOCOL.md). It deliberately does not expose the legacy executor dispatcher as a substitute.

Codex auth belongs to TypeSafe only: place `TYPESAFE_API_KEY=...` in `~/.codex/typesafe/.env`, or supply it through the server environment. `TYPESAFE_DATA_DIR` overrides that directory; `TYPESAFE_CODEX_STATE_DIR` optionally overrides its scoped controller state directory. Do not put API keys in repo files, MCP arguments or prompts. `ts_codex_health` reports key presence, not authentication success. No credentials are copied from any other product.

The source documents current supported hooks at [Codex hooks](https://learn.chatgpt.com/docs/hooks). Per-child pre-action interception is **not** claimed: generic tool hook input has a parent session ID, not a distinct child identity, and not all tool paths use hooks.

## API key

**Bring your own TypeSafe API key** — the server degrades gracefully without
one (`ts_ask` returns `{mode:"degraded", reason:"no_key"}` and never calls the
API). Set it either way:

- `TYPESAFE_API_KEY` as a real environment variable (recommended — survives
  plugin updates), or
- a `.env` file next to the installed `server.mjs` (copy
  `plugin/.env.example`). Optional: point `TYPESAFE_DATA_DIR` at a stable
  directory so your `.env` + ledger survive plugin-cache refreshes.

Key resolution order: `process.env` → `<data dir>/.env` → `<plugin dir>/.env`
. No cross-product settings fallback. Values are never logged.

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

### UserPromptSubmit reminder hook (details)

`plugin/hooks/dispatch-reminder.mjs` detects build-shaped prompts and injects
a one-line reminder to consult the `typesafe-dispatch` skill:

- **Claude Code** — registered automatically via `plugin/hooks/hooks.json`.
- **ZCode** — register a `UserPromptSubmit` hook in your config pointing at
  `node <path-to>/hooks/dispatch-reminder.mjs` (use your own absolute path;
  a repo-root copy lives in `hooks/`).
- **Codex CLI** — no hook mechanism; not applicable.

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

Manifest validation (Claude Code target):

```
claude plugin validate .        # marketplace manifest
claude plugin validate plugin   # plugin manifest (strict-clean as of v1.2.0)
```

The `typesafe-dispatch` skill (in `plugin/skills/typesafe-dispatch/SKILL.md`)
documents the full pipeline: GATE philosophy, Battery #1 template, state
guidance, threshold table, recursion guard, degraded mode, and the pilot
success criteria that must be met before Batteries #2/#3 get built.

## License

MIT — see [LICENSE](LICENSE).

## Pilot log

- **2026-09-20 — full-pipeline E2E (all stages green):** Gate → ts_feasible → Battery #1 (6 questions, 1 call, 833 tok) → ts_decide (one deadband escalate resolved by main LLM per protocol) → guarded background dispatch → subagent (2 tool calls, correct output, ground-truth verified) → Battery #2 verify (format 0.91 / value 0.96 → auto). Total: **1,353 TS tokens, 2 ask calls**. Lessons folded into SKILL.md §2/§10 (MSYS /tmp path trap; deadband-on-immaterial-question resolution).
- **2026-09-20 — v1.4.0 skill-suggestion shipped (ts_suggest_skill):** two-request progressive disclosure over the 79-skill local catalog (junction/symlink-aware). Acceptance: Shopage CSS → shopage-modifier (fit 0.95) ✅; small refactor → honest null (review/ponytail fits ≈0.35 — heavyweight workflows, correct anti-over-load) ✅; translation → null (needs_skill 0.11) ✅; --require → 0 API calls ✅. Fit-led rule after measurement: Choice confidence cannot gate generic-candidate rosters (docs: low confidence ≠ invalid preference); confidence now only surfaces near-ties. ~9.4k in / 0.9k out tokens per suggest.
- **2026-09-21 — v1.5.0:** A-path verdict finalized: ZCode confirmed NOT firing PreToolUse for subagent tool calls (2nd experiment: queued spec + off-scope Write sailed through) — mid-work guard on ZCode is the B-path monitor, now ONE command (`cli.mjs judge "<spec>" "<action>"` → proceed/inspect/correct + ready-made directive; measured off-spec 0.01 → correct). Injection reminder now carries the guard protocol. Skill-suggestion confirmed working in real use (audit of 105 ledger lines). README got a pipeline diagram (docs/pipeline.svg).
- **2026-09-21 — v1.5.1 (audit-driven):** two fixes from the two-session compliance audit — (1) zero-cost tools (ts_ping/ts_safety/ts_feasible) now write ledger traces (audits kept inferring usage from prose); (2) same-payload re-ask dedupe: identical state+questions within 45s returns the cached result (measured: second call cached=true, 0 new tokens) — key hashes state AND questions so fixed-question/different-state batteries (judge) never collide.
- **2026-09-22 — v1.5.2 (dropout postmortem):** audit #3 caught the typesafe MCP server vanishing from a live session mid-work. Root cause from ZCode logs: 17x `Connection closed` spikes exactly inside the window where the source dir (which IS the live install) was being edited — momentary broken-file states killed spawns, and ZCode never auto-reconnects. Fixes: (1) launcher now retries early-exit spawns (3x, 1s backoff) so transient breakage no longer orphans a session toolless; (2) dedupe cache is now disk-persisted (DATA_DIR/dedupe-cache.json) — cross-process cli.mjs re-asks hit it (verified: second independent process cached=true, 0 new tokens); (3) non-OK API responses keep their body detail in ledger + degraded returns, so mystery 4xx/5xx (two unexplained Jev 400s) become diagnosable next time. CJK-heavy ask could not reproduce the 400s.
- **2026-09-22 — v1.6.0 (Jev Engineering doc, Tiers 1-3):** T1: subgoal dedup registry (check/register/done — kills the measured duplicate dispatches); trust routing (executor data_class clearance open<standard<restricted, ts_feasible --data-class filter, new Battery#1 data_class question; verified: restricted tasks physically cannot reach non-first-party lanes); purpose-built-context dispatch rule for api_exec lanes. T2 (skill §12): shared-retrieval protocol for read-only fan-out; visibility levels for distilled chunks; per-directory GOTCHAS.md convention. T3: scripts/progress-page.mjs renders the day's ledger to an auto-refreshing HTML progress page. Also fixed cli.mjs flag parser to accept hyphenated flags (--data-class was silently ignored).
- **2026-09-22 — v1.7.0 (three lanes live):** keys landed, reasoning lane unlocked. scripts/api-exec.mjs invokes api_exec lanes one-command (anthropic-messages + openai-compatible styles, purpose-built wrapper default, context-cap guard at 80% of registry limit, ledgered). Qwen lane = LOCAL qwen3.8-flash-next behind the user's tunnel (Anthropic Messages API, 256k cap — inference on-machine); DeepSeek lane = cloud with reasoning_variants (difficulty >=3 -> deepseek-reasoner, else deepseek-chat; skill §13). Live-verified: qwen answered a file-role question in exact claims/files/verdict JSON (5.3s); deepseek-chat 987ms. Trust routing active from day one: restricted tasks physically cannot reach these lanes.
- **2026-09-22 — v1.7.1 (security):** the user-private Qwen tunnel URL was accidentally committed as a registry base_url_default in v1.7.0. Removed from tree AND purged from full git history (filter-branch + force push). API KEYS WERE NEVER COMMITTED (fingerprint-verified against all history and the remote). Rule now explicit in the registry: private endpoint URLs live ONLY in .env (gitignored); registries carry env var NAMES, never values.
- **2026-09-26 — v1.8.0 (verification is default, not opt-in):** audit finding — Jev never commented mid-work in any session (3/3 skipped the opt-in guard), so fast-but-broken work shipped to the user, who manually called codex for review comments. Fixes: (1) AUTO-GUARD default-ON for every build dispatch (skipping requires stating why to the user); (2) scripts/review-comment.mjs = post-work review battery: failing tests -> instant correct (zero model calls), else diff+spec to deepseek-reasoner (or codex-cli) with strict-JSON verdict, ONE Jev validity judgment bands auto-correct (>=0.65) vs escalate, fix-loop <=2, everything ledgered; (3) skill FLOW 8/9 + §10 updated; injection text now mandates auto-guard + review-comment. Live-verified all three ladder paths: deterministic-tests catch; reasoner caught return-Infinity-vs-required-throw quoting the inline comment (Jev validity 0.97 -> correction directive with 2 evidence-cited points + risks); pass -> accept with risks surfaced.
