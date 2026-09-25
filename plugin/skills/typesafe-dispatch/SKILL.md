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
7. **Skill suggestion (when dispatching to a subagent):** run
   `ts_suggest_skill` with the task text (see §11).
   - User NAMED a skill → `options.require` = that skill (local lookup,
     ZERO API).
   - Recommended → add ONE soft line to the dispatch prompt:
     `Relevant: <skill> (fit X[, near-tie Y]) — load it first; ignore if it
     does not fit.` and mention the skill in the guard spec.
   - `skill: null` (with transparent `candidates_fit`) is a first-class
     answer — measured: small refactor tasks rate review/ponytail ≈ 0.35
     (they are heavyweight workflows); you may still load one manually on
     your own judgment.
8. **Dispatch (dedup → auto-guard → embed → purpose-built):**
   - FIRST run `node scripts/subgoal.mjs check '<one-line task spec>'` — if
     `duplicate:true`, reference the existing `of` agent/task instead of
     dispatching again (measured: 5 duplicate dispatches wasted tokens).
     Otherwise `register '<spec>' --ref <agentId|label>` right after spawn,
     and `done <ref>` when it completes.
   - **AUTO-GUARD (v1.8.0, default-ON):** every build dispatch (workflow
     multi_agent_build / plan_first) MUST push the guard spec
     (`guard-spec.mjs push '<ENGLISH spec>'`), dispatch with
     `run_in_background: true`, and run `cli.mjs judge` on consequential
     actions every 15–30s. Skipping the guard requires stating WHY to the
     user (three audits: opt-in guard was skipped 3/3 times; the skipped
     session thrashed 73 edit failures overnight). On verdict `correct`
     → TaskStop + SendMessage correction immediately.
   - Embed the returned TS JSON (answers + usage + call_id) **verbatim** in
     the subagent prompt — raw judgment, not your paraphrase.
   - api_exec/cli_exec lanes: the dispatch prompt MUST demand a
     purpose-built return: "Return ONLY a compact typed result — claims[],
     files[], verdict — no prose narrative." (Doc §II.A arithmetic:
     mixed-model routing only pays when the cheap model gets a small
     context and returns a compact typed chunk, not a transcript to reread.)
   - `data_class` from Battery #1 feeds `ts_feasible --data-class
     <open|standard|restricted>`: secrets/.env/infra tasks physically
     cannot reach non-first-party lanes (registry `data_class` clearance).
9. **POST-WORK REVIEW (v1.8.0 — Battery #2 lite, ACTIVE):** when the
   subagent finishes build work, run
   `node scripts/review-comment.mjs --spec '<spec>' --diff-file <diff> --test-result 'pass|fail: <out>' [--reviewer deepseek-api|codex-cli] [--model deepseek-reasoner]`
   BEFORE reporting to the user. Ladder: failing tests → instant correct
   (no model call); reviewer broken + Jev-validated → SendMessage the
   correction (≤2 fix-loops, re-review after each); reviewer pass → accept
   with risks surfaced. The "fast but broken" failure mode dies here —
   never report unreviewed build work.
10. **Battery #3 (merge) is still PHASE 3 — not yet active. Do not
   improvise it.**

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
  },
  "data_class": {
    "type": "choice",
    "instructions": "What is the most sensitive DATA this task will touch? Drives trust-aware executor routing (ts_feasible data_class filter).",
    "criteria": {
      "open": "public docs / open-source style code only",
      "standard": "application code in the repo",
      "restricted": "secrets, .env, infra config, credentials, customer data",
      "other": "cannot determine"
    }
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
not after completion. **v1.8.0: default-ON for every build dispatch
(multi_agent_build / plan_first).** Skipping requires stating WHY to the
user — three audits found opt-in guard was skipped every single time, and
the one session that skipped it thrashed 73 edit failures overnight.

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
3. On harnesses where user-level PreToolUse hooks do NOT fire for subagent
   sessions, the hook is inert for subagents there; use the B-path instead.
   **ZCode status: CONFIRMED NOT FIRING — tested twice (2026-09-20 probe;
   2026-09-21 full retest with a queued spec and an off-scope Write that
   sailed through unblocked). On ZCode the B-path below is THE mid-work
   guard. The shipped hook still serves Claude Code installs.**

### B-path — main-agent monitor loop (works TODAY on ZCode, no hooks needed)

1. Push the spec as above, then dispatch with `run_in_background: true`.
2. Poll `TaskOutput(block=false)` every ~15–30s; watch the latest
   consequential actions in the output.
3. For each consequential action, get a verdict with ONE command:
   `node scripts/cli.mjs judge "<task spec>" "<action text>" [--tool Bash|Write|Edit]`
   → returns `{verdict: proceed|inspect|correct}` + a ready-made directive
   (proceed = let it continue; inspect = deadband, look yourself; correct =
   "STOP the subagent and send a correction", includes reversibility).
4. On `correct`: `TaskStop(task_id)` immediately, then
   `SendMessage(agentId, correction)` — correction = verdict + spec excerpt +
   what to do instead (including "delete the file if already created").
   The agent resumes with the fix in context.
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

## 11. SKILL SUGGESTION (v1.4.0)

`ts_suggest_skill(task, options)` — two TypeSafe requests, progressive
disclosure (official skill_suggestion cookbook + win4r/jev-skill-suggester
pattern):

1. **Rank** the whole local catalog in ONE call: Choice over every skill
   (the probability distribution IS the ranking) + `needs_skill` Noul.
2. **Verify** the top-3 with each skill's 400-char excerpt: final Choice
   (may answer `none`) + per-candidate `fit` Noul.

**Recommendation rule (fit-led, measured):** winner = highest fit ≥ 0.80.
Choice confidence is NOT a hard gate — generic-candidate rosters split the
distribution evenly (codex/review/ponytail ≈ 0.33/0.17/0.16, conf 0.49) so a
confidence gate never clears; docs: "low confidence need not invalidate a
harmless preference choice". Confidence only SURFACES near-ties (runner-up
within 0.10 fit AND conf < 0.65 → `near_tie` reported, recommendation still
issued with the soft-line).

**Acceptance measurements (2026-09-20):**
- Shopage CSS task → `shopage-modifier` fit 0.95 conf 0.99 ✅
- Small refactor + review → honest `null` (codex 0.48 / ponytail 0.35 /
  review 0.35 — heavyweight workflows don't fit small tasks; correct
  anti-over-loading behavior) ✅
- Translation task → `null`, needs_skill 0.11 ✅
- `--require ponytail-review` → local lookup, **0 API calls** ✅

**Options:** `require` (user-named, zero API, bypasses excludes — 建議歸建議,
老闆點名話事), `allow`/`exclude` (per-call roster filters),
`skills-exclude.json` in DATA_DIR (persisted exclusions; excluded skills are
still reachable via require). Ponytail family deliberately NOT excluded
(user decision 2026-09-20).

**Catalog:** scans `~/.zcode/skills` + `~/.agents/skills` — 79 skills incl.
Windows junction/symlinked gstack skills (cycle-guarded). Index cached 7
days in DATA_DIR (`skills-index.json`, gitignored); rebuild with
`node scripts/skill-catalog.mjs build --force`. Cost per full suggest:
~2 calls, ~9.4k in / ~0.9k out tokens.

## 12. DOC-DRIVEN PROTOCOLS (v1.6.0, from the Jev Engineering note)

### 12.1 Shared retrieval for read-only fan-out
Reading + searching is ~2/3 of token spend. Before dispatching ≥2 READ-ONLY
subagents (verification, review, analysis), do ONE retrieval pass yourself
(relevant file list + one-line roles + key excerpts) and embed the SAME
retrieval block in EVERY subagent prompt, with the instruction: "do not
re-glob/re-grep beyond this block unless a lead dead-ends."

### 12.2 Visibility levels for distilled chunks
Subagent outputs are distilled into typed chunks (claims = SHORT,
artifact_summary = LONG, full output = FULL — the Battery #3 state shape).
Consume at the right level: verification batteries eat SHORT (claims);
escalation and final reports eat LONG; FULL only when a verdict is
contested. Never paste FULL outputs into prompts by default. (The full
visibility-ladder — per-query HIDE/SHORT/LONG/FULL over harness context —
is harness-native and out of plugin reach; this is our layer's version.)

### 12.3 Per-directory GOTCHAS.md
When dispatching work scoped to a directory, check for `<dir>/GOTCHAS.md`;
if present, embed it (or its key lines) in the subagent prompt. Encourage
the user to keep a footguns file per sensitive directory — condition-bound
instruction the harness cannot compact away.

## 13. API-EXEC LANES + REASONING LEVELS (v1.7.0)

**Invocation:** `node scripts/api-exec.mjs <executorId> <prompt-file|-> [--model variant]`
— purpose-built wrapper ON by default (returns claims/files/verdict JSON;
`--raw` skips it); every call ledgered (`battery api-exec-<id>`).

**Reasoning levels (code-side policy; only api_exec lanes have them — F3):**

| Lane | Model variants | Policy |
|---|---|---|
| deepseek-api | `deepseek-chat`(fast)/ `deepseek-reasoner`(deep) | Battery #1 difficulty ≥ 3 → reasoner; ≤ 2 → chat; `--model` overrides |
| qwen-api | `qwen3.8-flash-next` | Fast lane, one level. LOCAL deployment behind a tunnel (Anthropic Messages API) — inference stays on-machine, payload transits the tunnel edge; data_class standard |

**Context cap:** qwen 256k — api-exec refuses prompts estimated above 80%
of the registry cap before egress. Dispatch prompt = bounded purpose-built
context (doc §II.A): small context in, compact typed chunk out.

