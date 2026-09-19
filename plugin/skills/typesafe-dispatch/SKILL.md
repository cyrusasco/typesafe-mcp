---
name: typesafe-dispatch
description: >
  Reviewed dispatch pipeline for ZCode requests that need a routing decision.
  Use when a request is multi-step, ambiguous, or build-shaped: choosing
  between direct edit / plan-first / multi-agent build / research / QA,
  picking an executor (zcode subagent, gstack-eng, codex-cli, deepseek-api,
  qwen-api), or judging ambiguity/risk/difficulty before acting. Starts with
  a no-TS GATE (most simple requests must bypass this pipeline entirely),
  then runs ts_feasible (hard availability pre-filter), ONE batched TypeSafe
  ts_ask (Battery #1), and ts_decide threshold enforcement
  (auto / flagged / escalate). Includes destructive-op safety (ts_safety +
  user confirmation), degraded mode, recursion guard, and pilot success
  criteria before Batteries #2/#3 may be built.
---

# typesafe-dispatch

Reviewed dispatch pipeline: GATE → state → ts_feasible → ONE batched ts_ask
(Battery #1) → ts_decide → act per band. The MCP server ships with this
plugin — its tools surface as `ts_ping`, `ts_ask`, `ts_decide`, `ts_safety`,
`ts_feasible` (the plugin provides them). In sessions without the `ts_*`
tools, run `node <plugin-install-dir>/../scripts/cli.mjs` (or
`scripts/cli.mjs` at the marketplace root) — same functions, same guards,
same ledger.

## 1. GATE (no TS)

Simple, deterministic requests are executed DIRECTLY — no TypeSafe call, no
battery:

- single-file edit with an obvious target
- run a known command
- direct lookup / recall / short answer from context already in hand

Philosophy: **most everyday requests must bypass this pipeline.** If you are
sending everything through TS, the design has failed — re-read the gate.
(哲理:日常簡單請求一律直接做,唔好濫用 pipeline。)

Only when the request is genuinely multi-step, ambiguous, or build-shaped do
you enter the FLOW.

## 2. FLOW

1. **Build state** (see §4): bounded cwd/task-spec/file-list context.
2. **`ts_feasible()`** — P0 #2: pre-filter the executor registry by hard
   availability. ONLY feasible ids go into the executor Choice criteria.
   Hard constraint from code > TS Choice, always.
3. **ONE batched `ts_ask`** with the Battery #1 template (§3). One call, all
   questions together — never split Battery #1 into multiple asks.
4. **`ts_decide(answers)`** — server-side deterministic thresholds (§5).
5. **Act per band:**
   - `auto` → proceed with the decided route without further ceremony.
   - `flagged` → proceed, but say so ("TS was lukewarm on X") and pick the
     safer reading when two readings exist.
   - `escalate` → do NOT act on the TS answer: ask the user, or resolve in
     the main LLM with your own reasoning. Escalation is the designed
     outcome for genuinely unclear work, not a failure. When the overall
     decision is escalate ONLY because an immaterial question hit the
     deadband (e.g. `difficulty` when no downstream policy consumes it)
     while every routing question is auto — resolve in the main LLM and
     proceed, stating the resolution (ignore uncertainty on unused
     branches; measured in the 2026-09-20 E2E run).
6. **Hard-constraint overrides (code beats TS):**
   - `needs_agentic_file_access` = yes but the executor Choice picked a
     non-agentic executor → OVERRIDE to the zcode subagent (zcode-gp) and
     note the contradiction to the user.
   - A task outside every feasible executor's `what`/`not_for` → do not
     route it there just because Choice said so.
7. **Dispatch:** embed the returned TS JSON (answers + usage + call_id)
   **verbatim** into the subagent prompt — the subagent gets the raw
   judgment, not your paraphrase.
8. **Batteries #2 (verification) and #3 (merge) are PHASE 2/3 — NOT YET
   ACTIVE. Do not improvise them.** After Battery #1 you act; verification
   comes only when those batteries are built and announced.

## 3. BATTERY #1 TEMPLATE

Trimmed per eng review. Copy into `ts_ask`, filling the executor criteria
from the `ts_feasible` subset (each entry's `what`/`not_for` from
executors.json):

```json
{
  "workflow": {
    "type": "choice",
    "instructions": "How should this task be executed? Pick the single best workflow.",
    "criteria": {
      "direct_edit": "Single-file or few-line change with no design decisions — fix this string, tweak this rule, adjust a constant.",
      "plan_first": "Multi-step or ambiguous; a short plan should be written and confirmed before code changes.",
      "multi_agent_build": "Parallelizable build work worth splitting across subagents; multiple independent workstreams.",
      "research_only": "The user needs information or analysis; no code changes yet.",
      "qa_check": "Verification task — run/inspect and report pass/fail, not build.",
      "other": "None of the above fit (no-match escape)."
    }
  },
  "executor": {
    "type": "choice",
    "instructions": "Which executor should do the work? Choose ONLY from the feasible candidates listed in the state.",
    "criteria": {
      "<feasible id>": "<its what — and what it is not for>",
      "other": "None of the listed executors fit."
    }
  },
  "needs_agentic_file_access": {
    "type": "noul",
    "instructions": "true if the chosen work requires reading/writing repo files or running commands, false if pure reasoning on provided context suffices."
  },
  "ambiguity": {
    "type": "noul",
    "instructions": "true if the task spec is too unclear to act on without asking the user something first."
  },
  "risk": {
    "type": "noul",
    "instructions": "ADVISORY ONLY: true if this task could damage state — deletes, force pushes, schema changes, wide rewrites. This answer NEVER authorizes anything: destructive operations always go through ts_safety plus explicit user confirmation, full stop.",
    "criteria": { "true": "plausible destructive or hard-to-reverse side effects", "false": "routine reversible work" }
  },
  "difficulty": {
    "type": "score",
    "instructions": "How hard is this task?",
    "criteria": [
      "trivial one-line tweak (typo, constant, styling)",
      "small focused change in one area (single function/file, clear path)",
      "multi-file feature spanning a few related modules",
      "architecture-touching change (cross-cutting contracts, schemas, pipelines)",
      "novel problem with no local precedent (needs design or research; no existing pattern to copy)"
    ]
  }
}
```

At most **2–3 speculative questions** may be added (e.g. "does the user
care more about speed than correctness here?"), and each MUST state its
premise explicitly in its `instructions`. Every Choice question MUST keep an
`other` option.

## 4. STATE GUIDANCE

- **Bound the context**: cwd, the task spec (verbatim user ask), and a
  relevant file list (paths + one-line role). NOT the whole repo, not full
  file contents. state + questions share ~32k tokens.
- **Prefer English-normalized state text** — Jev's primary training language
  is English; CJK judgments carry higher variance. If the state is CJK, set
  `options.lang: "cjk"` (it is logged; keep an eye on variance).
  (中文 state 可以用,但要記 `lang:"cjk"`。)
- Use **named JSON fields** (`{cwd, task, files, constraints}`), and
  **backtick paths** inside text (`src/app.ts`) for nested references.
- Secrets never belong in state; the server redacts patterns before egress,
  but do not rely on that.

## 5. THRESHOLD TABLE

Server enforces (in `ts_decide`); this table explains. Defaults, overridable
per-call via the `policy` arg:

| Signal | auto-grade | flagged | escalate |
| --- | --- | --- | --- |
| choice / score confidence | ≥ 0.75 | 0.5 – 0.75 | < 0.5 |
| noul p | ≥ 0.8 → `yes`; ≤ 0.2 → `no` | 0.65–0.8 → `flagged_yes`; 0.2–0.35 → `flagged_no` | 0.35 – 0.65 → `escalate` (deadband: can't tell) |

Overall decision = worst per-question band (any escalate → escalate; else
any flagged → flagged; else auto). A missing numeric signal escalates
conservatively. `yes`/`no` count as auto-grade with the stated direction.

## 6. RECURSION GUARD

Subagents must NEVER call `ts_ask`/`ts_decide` and must never re-enter this
skill. The dispatch decision is made ONCE by the main agent; dispatched work
executes it. The server enforces this too — `ts_ask` with `depth > 0` is
rejected outright.

## 7. DEGRADED MODE

If `ts_ask` returns `{mode: "degraded", reason: ...}` (`no_key`,
`budget_capped`, `breaker_open`, timeout, …): proceed with **plain LLM
judgment** using the same battery questions as a thinking scaffold, tell the
user TypeSafe was skipped and why, and keep ledger discipline (only ts_ask /
ts_decide write the ledger — just don't fake one). Degraded ≠ blocked.

## 8. PILOT SUCCESS CRITERIA

Before Batteries #2 (verification) and #3 (merge) get built, the pilot must
show:

- routing agreement with the user's preferred route **≥ 85%** over **30–50
  labeled requests**;
- added dispatch latency **< 300 ms** (the ts_ask call itself);
- measured tokens/$ per day within the cap (see `ts_ping`);
- healthy gate-bypass rate — most simple requests never hit TS.

Miss the bar → tune the battery (contrastive criteria, state shape) before
adding batteries.

## 9. EXECUTOR REGISTRY

The executor registry ships inside the plugin; `ts_feasible` reads it
automatically — edit the copy at the marketplace root (or plugin dir) to
change it. Current entries:
`zcode-gp`, `gstack-eng`, `codex-cli`, `deepseek-api`, `qwen-api`.

Adding an entry: append an object with
`{id, kind (zcode_subagent|cli_exec|api_exec), model, what, not_for,
examples, requires:{env:[],command:[]}, cost, speed, agentic}`. Keep the
registry **< 8 entries** — two-stage dispatch was deliberately cut. Set
`requires` honestly; `ts_feasible` uses it as the hard gate. Remember: every
TS Choice must include an `other` option (no-match escape).

## 10. GUARDED DISPATCH (mid-work 即時監察) — v1.3.0

While a subagent WORKS, a guard checks its consequential actions
(Bash|Edit|Write) and corrects it IMMEDIATELY when an action is off-spec —
not after completion. Guard only high-stakes dispatches (user asked, or risk
judgment says so); everyday subagent runs stay unguarded.

**Spec discipline: write the spec in ENGLISH** (Jev is English-primary; a
CJK spec misjudges English shell actions — measured). One line + scope.

### A-path — automatic (hook), where the harness fires PreToolUse for subagent sessions

1. Before dispatch: `node scripts/guard-spec.mjs push 'One-line English spec; scope: /only/this/dir'`
   (FIFO queue: first spec-less subagent session claims it).
2. The `subagent-guard` hook then runs on every Bash|Edit|Write of that
   subagent, in order: deterministic destructive patterns → **always block**;
   read-only Bash → instant allow; otherwise one batched Jev call
   (`on_spec` + `reversible` Noul). `on_spec ≤ 0.35` → **block, and the block
   reason IS the correction** (the subagent reads it and self-corrects).
   3 strikes → stop-and-report. TS degraded/unavailable → allow through
   (fail-open; destructive is still deterministic-blocked).
   Every Jev call lands in the ledger (battery `subagent-guard`).
3. On harnesss where user-level PreToolUse hooks do NOT fire for subagent
   sessions (ZCode as of 2026-09-20 — under verification), the hook is inert
   for subagents there; use the B-path instead.

### B-path — main-agent monitor loop (works TODAY on ZCode, no hooks needed)

1. Push the spec as above, then dispatch with `run_in_background: true`.
2. Poll `TaskOutput(block=false)` every ~15–30s; watch the latest
   consequential actions in the output.
3. For each consequential action, run ONE batched judgment
   (`cli.mjs ask` with the same `on_spec`/`reversible` questions, state =
   spec + action).
4. `on_spec ≤ 0.35` → `TaskStop(task_id)` immediately, then
   `SendMessage(agentId, correction)` — correction = verdict + spec excerpt +
   what to do instead. The agent resumes with the fix in context.
5. Three corrections → stop for good and escalate to the user.

(中譯:B-path 就係「你做嘢我隔籬睇」— 你個 subagent 背景行,主 agent 每
15–30 秒睇一眼,見到離譜動作即刻拉停+糾正,唔使等佢做完先驗收。)

**Notes (measured in the 2026-09-20 E2E run):**
- Payload files for `cli.mjs` must use real Windows paths (`C:/...`), NOT
  MSYS `/tmp/...` — node does not resolve them (`/tmp` works as a CLI
  argument via MSYS conversion but breaks inside `node -e` scripts).
- Full-pipeline cost reference: a complete Gate → feasible → Battery #1 →
  dispatch → verify run measured **1,353 TS tokens across 2 ask calls**
  (833 for the 6-question dispatch battery, 520 for the 2-question
  verification battery), ~1.2s + ~0.7s latency.

