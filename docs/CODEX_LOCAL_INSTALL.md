# Codex local integration receipt — 2026-09-26

This is an additive personal-home integration, not a second Codex runtime, a new account, or JevCompact. The source-validation record in `CODEX_VALIDATION.md` describes the earlier source-only checkpoint; this receipt separates later observations from that checkpoint.

## Installation and compatibility

- The existing stable Codex CLI 0.154.0 installed `typesafe-codex@personal` from the personal marketplace. Its install/list results reported installed and enabled. No Codex runtime was installed or updated.
- The official bundled plugin validator accepted the self-contained 14-file artifact. The TypeSafe key remains in its designated local `.env`, excluded from package, repository, evidence and prompts.
- Existing main-home instructions were retained, with one additive dated Jev parent-workflow block. Existing model, account configuration, MCP allowlists and other plugin settings were preserved.
- A frozen original-Skill graph is typed as `skill_corpus`, retaining its own identity/revision/provenance. It is not relabelled as the target project's code graph or the full current Skill inventory. Fresh canonical Skill files remain separately checked.

## Original-Skills connection repair

The accepted prepared-snapshot launcher used its snapshot run ID as the audit-log directory. A second connection encountered Windows sharing error 32 while an unrelated existing Guardian process held the original audit file. That process was not stopped.

`scripts/prepare-original-skills-adapter.mjs` generates a separate pinned adapter, rather than editing the accepted launcher, Guardian binary, prepared index, dependency artifacts or registry. It verifies the two explicitly supplied source hashes and all seven original artifact pins. The generated Invoke differs in exactly one audit-allocation line: each connection gets a fresh GUID directory under the same approved runtime root. Snapshot identity and all other authority code remain unchanged. The generated Start preserves the original seven checks and adds pins for the original Start and generated Invoke.

The generator rejects input/hash drift, duplicate replacement targets, output reuse, path traversal and reparse paths. Independent review found and corrected JavaScript replacement-token expansion for legal paths containing `$&` or `$'`; regression coverage retains those failures. This is not a hostile-same-user race-proof filesystem sandbox.

The main `original_skills` setting changed only its launcher path to the generated adapter. An ownership/rollback receipt remains local. Rollback restores only that exact launcher setting, not a wholesale old configuration file.

## Actual transport observations

- Installed TypeSafe stdio server: initialization, eight advertised tools and local key-presence health succeeded. Health alone is not authentication.
- A real TypeSafe request resolved to `jev-1.13.0`; the earlier bounded authentication smoke succeeded.
- Fresh pinned Guardian `list_repos`, `query` and `context` succeeded through an owned Windows no-window stdio transport. The graph returned its real frozen corpus and a real matching Skill-document node. Nothing was indexed or hardcoded as a discovery result.
- The Guardian required an allowed absolute repository path even though upstream tool metadata also described names. A name-based query was refused; the next query used the exact path returned by live `list_repos`. The refusal is retained, not called a pass.
- A Node/PowerShell transport attempt detached its owned Guardian without returning metadata. It is recorded as failed. The exact orphaned tree was identified and stopped; the unrelated pre-existing Guardian was retained. A Windows `CREATE_NO_WINDOW` Python transport then completed actual protocol reads and closed cleanly. This does not establish that every host/transport behaves identically.

## First live route correctly stopped

The initial Cartesian route question produced a genuine response, not a fixture: hardness `routine` confidence 0.32; assignment confidence 0.21; testing Skill usefulness 0.92; optional change-method usefulness 0.72. The original controller correctly rejected it and no native child was launched. Keep this failed observation distinct from later tests.

Low choice concentration can reflect several plausible alternatives, but this one response does not establish that as the sole cause. The revised policy and its test evidence must be reviewed separately; a failed call is never silently reclassified as a successful route. [TypeSafe confidence documentation](https://docs.typesafe.ai/confidence) and the [official composition guidance](https://github.com/typesafe-ai/skills/blob/main/skills/typesafe-ai/SKILL.md) distinguish preference distributions from separate adequacy checks and permission policy.

## Revised policy and remaining live routing block

The bounded source correction separates nomination from adequacy. A single role must first be admitted by the parent for the actual scope. After Jev nominates an exact supported model/effort and unambiguous Skills, a second request must independently pass both route adequacy and role/scope compatibility at >=0.8. Raw preference confidence remains recorded. Monitor/completion retain their >=0.75 gate; uncertain Skill usefulness still blocks. Failed routing receipts persist and a restart of the same key never automatically re-asks.

In a control-plane-only probe (no native action delivery permitted), Jev nominated `gpt-6-luna` / `low` / `test_qa`, then returned adequacy **0.53** and role compatibility **0.86**. This correctly persisted `BLOCKED_ROUTING`, with no spawn action. A separate bounded plan added the exact currently exposed host model descriptions, after a regression proved the old route compiler dropped them. It still returned adequacy **0.46**, role compatibility **0.86**, and stayed blocked. The added metadata did not resolve the live uncertainty. These are failed live routing gates, not proof that the model is incapable, not passed retrospectively, and not grounds to lower thresholds or dispatch anyway. No further live routing retry was performed at this checkpoint.

A persistent Node-REPL harness timeout between these probes is retained as a transport/test-harness failure. No extra provider receipt or controller state was found from that attempt; the subsequent bounded Python stdio probe recorded real provider receipts and exact process shutdown. Do not represent the harness failure as a service decision or a pass.

Final local offline suite: **108 tests, 108 passed, 0 failed, 0 skipped** on Windows/Node 24.18.0. TDD records include corpus scope 7 failing regressions, native path identity 1 failure, generator replacement-token paths 2 failures, nomination/adequacy correction 9 failures, dropped host model-description evidence 1 failure, and the Windows inspection-environment and installed-shell-selection regressions before their corresponding fixes. Offline mocked responses are not live routing acceptance.

The first published Windows CI run exposed a fixture portability error: hosted `TEMP` used the short path `RUNNER~1`, correctly rejected by the production adapter's canonical-path guard. The positive fixture now resolves its temporary parent to the real canonical path before creating its owned root; production alias/reparse rejection is unchanged. The original failed hosted run is retained; subsequent exact-head CI is reported separately, never inferred from local results.

The next hosted Windows run reached the OS inspection helper but failed closed. Adding an explicit OS profile/temp-path allowlist did **not** resolve it: the subsequent `75954ad` run reported `ETIMEDOUT`, with no exit status and signal `SIGTERM`. That observation does not establish the underlying PowerShell startup cause. The helper now prefers an already-installed PowerShell 7 at its standard absolute path, with built-in Windows PowerShell as fallback, and closes unused stdin. No shell is installed. It retains the 15-second timeout, attribute rejection, bounded diagnostics and environment allowlist without arbitrary credentials, PATH or execution hooks. The fixture interpreter uses run-owned profile/temp paths. The revised helper passes all 16 local adapter tests; hosted confirmation is reported separately on the exact source head, not inferred from this local result.

## Host-pickup boundary

At the observed checkpoint, this existing task's tool catalog did **not** expose `ts_codex_*` or `original_skills`. The direct stdio acceptance probes above are not represented as native task-tool exposure. Plugin installation, a successful provider request and static hooks are not proof that all existing tasks are already governed.

Reload the existing Desktop host, retain this same task/Project Pair, and freshly inspect tool exposure before native dispatch. The next gate is an actual Jev-selected native child with in-progress events, exact-child interruption/correction if indicated, raw test evidence and independent parent review. That native gate is **NOT_RUN** at this checkpoint. Do not invent receipts or substitute a new task/runtime to bypass missing exposure. Lifecycle hooks remain advisory and their trust/enforcement is not claimed.

Host reload alone is not a proven fix for Jev's separate adequacy block. A future parent review must resolve the actual missing routing evidence or request a precisely scoped calibration exception; it must not silently override Jev, replay blocked plans, or repeatedly resample the same question until it passes. The overall integration is installed but **not fully accepted**. Existing unrelated provider/Skill/plugin functionality was preserved, not re-certified by this focused task.
