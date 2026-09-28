# v1.9 — Codex Jev control plane

## Added

- Parent-only English plan contract, current native model/effort/role route choices, per-subtask Jev hardness and Skill selection. No hardcoded Luna/Sol/Astra IDs or global model rewrites.
- Read-only current Skill path/hash/owner verification and same-project/revision fresh GitNexus evidence adapter. No cache/import/index fallback.
- Scoped, locked, atomic controller state; native-ID binding; durable action claim and observed receipt; interruption before same-child correction. Two-correction and event/run budgets, dependency ordering, negative-completion handling and idempotent event/receipt replay.
- Parent native bridge callbacks plus Codex Skill. Hooks provide lifecycle reminders only. No false background observer or permission-isolation claim.
- Exact evidence-hash final review; verdict-only acceptance rejected. Host-provided receipts remain assertions until the parent independently verifies originals.
- Isolated Codex packaging allowlist and Node built-in regression tests; Windows/Linux CI matrix with SHA-pinned actions.

## Fixed (shared/legacy surfaces)

- Packaged guard import; first-use state; explicit safe child binding; malformed patterns fail closed.
- Removed implicit reads of Claude's account settings for TypeSafe credentials; cache identity includes model/endpoint; shared server metadata now matches 1.9.0.
- Missing Jev no longer silently proceeds in the guarded path.
- API executor requires `--data-class open|standard|restricted`, checks actual lane clearance, uses environment base URL, redacts egress and HTTP error bodies, bounds request timeout/output and reserves budget before egress.
- Review requires diff plus `--test-command`, `--test-exit-code 0`, `--test-output`, `--data-class`; eliminates shared temp prompt and conflicting schema. `review-passed` is not final acceptance. Codex CLI reviewer returns `native-review-required` instead of calling the API executor or launching another Codex.

## Compatibility and limitations

These are intentional safety-contract changes. Update legacy callers to supply explicit classification/evidence. `guard-spec set <agentId> <spec>` is the explicit binding path. Legacy FIFO remains sequential-only, not the Codex controller. Legacy seven-day Skill cache, global subgoal registry and helper packaging are not used by the isolated Codex artifact and are not claimed fixed. Legacy feasibility does not prove host/provider availability.

API executor reservations coordinate that lane only; shared `tsAsk` retains a best-effort ledger budget/cache, not a cross-process hard quota. A crash may leave a reservation or claimed native effect requiring explicit reconciliation. The Codex adapter intentionally does not hide this by retrying effects or switching provider. Redaction detects known patterns only.

The source is not an activated installation. External TypeSafe/GitNexus calls, native execution effects, effective permissions, hook trust, account state and full end-to-end acceptance must be recorded separately. No home/account settings are migrated by this repository change.
