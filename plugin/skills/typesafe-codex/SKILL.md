---
name: typesafe-codex
description: Route Codex work through Jev hardness/model/reasoning/Skill decisions, GitNexus context and receipt-backed in-progress correction when TypeSafe governance is enabled. Not a context compactor.
---

# Jev-governed Codex work

The parent owns intent, scope, permissions and final acceptance. Jev supplies the routing and monitoring decisions. Use this host-specific workflow, not the legacy ZCode dispatch skill. The canonical existing Skills, plugins, accounts and MCP connections retain their owners.

## Before work

For every user command in a governed task, form a bounded **English** plan and preserve the original intent. Submit to `ts_codex_plan` before dispatch, including trivial work; a lightweight supported route can be chosen by Jev. No silent parent bypass. This Skill and reminder hooks are instructions, not an OS enforcement boundary.

1. Read [the protocol](../../codex/PROTOCOL.md). Check live exposure of all `ts_codex_*` tools and native spawn/interrupt/followup. A config/cache entry is not exposure.
2. Obtain current supported model IDs, tier labels, reasoning efforts and roles from this host's tool schema, not a static model list. Parent-prefilter exactly one role contract appropriate to this plan's scope and declare `role_scope_admitted:true`; use separate explicit plans for different role scopes. Jev nominates the model/effort, then separately verifies exact-route adequacy and role/scope compatibility (both >=0.8). Low preference confidence is not authorization. Uncertain Skill selections still stop; monitoring/completion gates are unchanged. Only the chosen child's settings change; retain global model/account settings.
3. Obtain fresh current native Skill metadata, with canonical paths and exact frontmatter names. Supply the relevant bounded candidate set, including personal/shared/system/plugin sources when applicable. Load only selected original files; no copies or shadow names.
4. Query an exposed read-only GitNexus tool using its actual schema. Include source operation, actual identity, revision and observation time. Frozen `original_skills` covers only its own corpus, not all current Skills or the target project's code. Declare it as `scope:"skill_corpus"` with its actual `corpus_id`, `revision` and `provenance_sha256`; never attach the target project identity to those rows. Target code-graph evidence instead uses `scope:"project"` and must match the plan project/revision. Do not index/update or invent graph results to fill a missing tool.
5. Classify/minimize data **locally before Jev egress**. The Codex adapter accepts explicitly approved open/standard metadata only. Never send credentials, account files, complete transcripts or a whole repository. Redaction is a secondary known-pattern check, not a data-loss-prevention guarantee. Read the user's TypeSafe key only through the server's configured auth path; do not print or copy it.

## Native bridge — required, not automatic MCP magic

`ts_codex_plan` returns durable `pending` actions. The MCP process does not control Codex children itself. The parent is the native bridge:

- Before each native action, `ts_codex_claim` its exact ID. Never repeat a claimed action after an uncertain result; reconcile its native receipt first.
- For `spawn`: call this host's native `spawn_agent` with the exact selected role/model/effort, `fork_turns: none`, and the returned WAIT message. Record the returned native agent ID with `ts_codex_ack` plus the actual tool-result reference. Then claim and deliver the returned start followup. WAIT is cooperative; do not describe it as permission isolation.
- While children are running, deliver each meaningful progress, tool, diff and test event via `ts_codex_event`. Use native status/messages and bounded waits rather than waiting only for the final report. Preserve event ID, child ID, phase, summary and evidence references. Missing coverage must be recorded, never invented.
- On an interrupt action: interrupt **only the bound child**, acknowledge the observed stop receipt, then deliver the returned corrective followup to **the same child**. No correction is marked delivered until its native receipt exists. Two corrections max, 64 events per child, 30-minute run window. Exhaustion/uncertainty pauses for parent inspection and a new scoped Jev plan; do not quietly raise a tier or create a replacement child.
- A `post` event observes a completed effect. Never claim it prevented it. Current generic PreToolUse payloads do not identify the child separately; do not infer child identity from parent session ID. The shipped hooks only remind at user prompt and child start. No blanket hook-enforcement claim.

The testable JS bridge is `../../codex/native-bridge.mjs`; its callbacks must invoke actual native tools, never shell-launch another Codex. Callback fixtures prove protocol behavior only.

## Finish

Submit complete changed-file coverage, artifact/diff identities, passing test commands/exits/raw-output hashes and unresolved items with `ts_codex_complete`. A passing sentence is insufficient. Read originals and independently review as the parent, then `ts_codex_finalize` with the exact evidence hash and review references. Report route, monitoring findings, actual correction receipts, test evidence, uncovered areas and outstanding runtime limitations to the user in their language. A recorded acceptance is not independent proof of host claims, OS permissions or external-provider authentication.

Missing Jev, GitNexus or native tools is an explicit blocked integration dependency, not permission to substitute a provider or cached evidence. No project-pair rebinding, credential migration, global installs, publishing or permission changes are granted by this Skill.
