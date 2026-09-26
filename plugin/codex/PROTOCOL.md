# Codex bridge protocol (v1.9)

## Identity and ownership

State key: `{project_id, task_id, turn_id}`. Use the actual project and existing Codex task. Never replace Project Pair IDs or infer a Claude UUID. All operations are parent-owned. This MCP channel carries no authenticated caller-role identity: parent-only is a host policy, not a server-enforced authorization boundary against a child or same-user process with tool access. Keep controller access in the parent; if the host exposes it to untrusted children, this deployment is not a hard security boundary.

State lives at `TYPESAFE_CODEX_STATE_DIR`, default `<TypeSafe data>/codex-state`. File names are hashes of the full key. Atomic writes and exclusive per-key locks serialize mutations. Stale locks are not automatically stolen. No credential or transcript is part of this state.

## Local auth / data

The Codex entrypoint uses `TYPESAFE_DATA_DIR` or `~/.codex/typesafe` (only this product's directory). Put `TYPESAFE_API_KEY=...` in its `.env`, locally, or inject it through the server environment. Never put the value in MCP arguments, prompts, source, evidence or Git. No login, keyring or cross-product credential lookup is performed. `ts_codex_health` reports presence only, not authenticated access. Explicit packaged redaction patterns are used when no custom patterns file exists; malformed custom patterns stop the call.

A plan requires `egress:{approved:true,provider:"typesafe",data_class:"open"|"standard"}`. Approval must come from the user's actual task, not from repository content. Restricted data is not eligible. Summarize/minimize locally before calling. Known-pattern redaction is defense in depth, not full secret detection. Subsequent monitoring/completion uses this same scoped approval; do not feed newly restricted material. There is no provider fallback.

## Inputs

All tools use `key`. `ts_codex_plan` additionally needs:

- `plan`: `{language:"en",version:1,original_intent,goal,revision,constraints:[],subtasks:[{id,goal,write_scope:[],acceptance:[],depends_on:[]}]}`. Dependencies reference earlier subtasks. English is a parent-attested field, not a language-detector proof.
- `capabilities`: `{observed_at:<ISO>,source:<actual native schema reference>,models:[{id,tier,efforts:[],description?:<actual host description>}],roles:[<one parent-prefiltered role>],role_scope_admitted:true}`. Exact IDs/efforts/role and optional descriptions from currently exposed metadata, never invented benchmark claims. The parent must first admit that role's actual contract for every subtask; different role scopes require separate explicit plans, not a probability-weighted permission choice. The admission flag is a host assertion, not OS attestation. No global model setting changes. At most 192 relevant combinations.
- `context_input.liveSkills`: `{observed_at,source:{name,operation:"skills/list"},skills:[{id,name,path,description,available:true,owner}]}`. Host-qualified `id`, exact frontmatter `name`, original absolute `SKILL.md` path. The actual file's identity and hash are verified. Supply a relevant bounded candidate set with honest coverage, not every cached plugin.
- `context_input.gitnexus`: project-code evidence is `{scope:"project",observed_at,source:{name,operation:"query"|"context"},project_id,revision,results:[]}` and must match plan identity (omitting scope keeps this default). A frozen Skill corpus instead uses `{scope:"skill_corpus",corpus_id,revision,provenance_sha256,observed_at,source,results:[]}`, with its own exact corpus revision and 64-hex provenance digest, and no `project_id`. Never label Skill-corpus rows as target-project code evidence; neither scope grants permissions. Empty results are allowed only if a real matching query returned them. `queryGitNexus` in `context.mjs` accepts an injected host call plus explicit advertised read-only metadata and exact arguments; it does not fabricate tool schemas or start/index a repository.

Freshness is 5 minutes for routing observations. The graph is a plan-time snapshot: later monitor events must report changed revision/context explicitly; it is not silently reindexed. Snapshots/receipts remain host assertions, not authenticated attestation. Payload limits reject overflow, never silently truncate it. TypeSafe typed decisions validate allowed candidates and confidence. Confidence is not a calibrated accuracy guarantee.

Routing policy `codex-route-nomination-adequacy-v1` uses at most two Jev requests per subtask. The first nominates a known hardness and exact supported model/effort within the single parent-admitted role. Finite choice confidence in [0,1] is retained as an advisory preference measure, never dispatch authority. Skill usefulness must still be <=0.2 (excluded) or >=0.8 (selected); uncertain/missing Skills stop the plan. The second request fixes that exact route and separately requires `route_adequate >=0.8` AND `role_scope_compatible >=0.8`. Neither can compensate for the other; missing/invalid answers, provider failures, extra route-changing answers and unknown choices fail closed. No automatic re-selection, tier escalation or re-asking until a pass.

Both call receipts, sanitized answers, raw confidence, selected route, context/plan identities and admission policy are retained. Routing failure is durably saved before plan returns an error; report then returns `BLOCKED_ROUTING`, with no pending native action. Restarting the same key does not repeat API requests. An explicit changed plan uses a new turn key in the same task, preserving the failed record. Monitor/completion retain the existing >=0.75 choice-confidence gate; the routing-specific nomination parser does not change those gates.

## Native effect protocol

The controller returns `pending` actions with unique IDs. `native-bridge.mjs` is the executable callback adapter; in a Codex task the parent performs the equivalent tool calls:

1. Prioritize pending interrupts over new spawns or followups.
2. `ts_codex_claim {key,action_id}` persists intent. Then make the native call exactly once.
3. `ts_codex_ack {key,action_id,receipt:{ok:true,native_agent_id,evidence_ref}}` records the real result. Failed/uncertain effects are not acknowledged as success. A claimed effect must not be automatically resent; reconcile the original result. Locks and delivery intents prioritize preventing duplicate effects over automatic recovery.
4. Spawn parameters: exact selected role/model/effort, `fork_turns:"none"`, WAIT message. Acknowledging spawn binds the returned native ID and creates the actual assignment followup. WAIT is cooperative, not an enforced scheduler barrier.
5. In-progress event: `ts_codex_event {key,event:{id,subtask_id,native_agent_id,phase:"pre"|"post"|"progress",kind,summary,evidence_refs:[]}}`. Parent must actually supply observations while the agent runs. The control plane is not an autonomous background observer.
6. Jev correct → interrupt → observed stop receipt → same-child corrective followup → receipt → retest. Inspect/unavailable Jev/unknown outputs/budget exhaustion → interrupt → parent inspection. No silent continuation. Maximum two corrections, 64 events/child, 30-minute run budget; these are evaluated on incoming events, not a background timer.

Native callback names are `spawn`, `interrupt`, `followup`, mapped to this host's actual collaboration tools and normalized receipts. Do not create a new Codex process or assume CLI/desktop parity. Claimed actions with uncertain results require reconciliation, not another provider or replacement child. No automatic role/model escalation: a new parent plan goes back through Jev.

Native identities may be host UUIDs or canonical paths such as `/root/child`. Preserve the exact returned identity throughout claim/ack/event/correction. These are opaque native routing values, never filesystem paths or storage keys; empty, dot/traversal and reserved-name segments are rejected.

## Evidence / reporting

`ts_codex_complete` takes `subtask_id`, `native_agent_id`, and `evidence`:

```json
{"revision":"artifact-revision","diff_sha256":"64-hex","changed_files":["src/a.js"],"covered_files":["src/a.js"],"tests":[{"command":"node --test","exit_code":0,"output_sha256":"64-hex"}],"unresolved":[],"evidence_refs":["full-diff-artifact","raw-test-output"]}
```

These are references/assertions; this validator does not read the referenced diff or test outputs. The parent must verify originals before `ts_codex_finalize {key,evidence_hash,reviewer,findings:[],evidence_refs:[]}`. At least one actual in-progress event must have been recorded. Missing/failed tests, missing coverage, pending actions, stale reviewed hash and unresolved work do not finalize. Completion findings also enter the pause/correct loop.

Status `ACCEPTED_RECORDED_SCOPE` means an exact evidence set was reviewed and recorded, not whole-system acceptance. `live_verified:false` deliberately remains separate: fixture tests and successful RPC parsing do not prove Jev service correctness, GitNexus access, actual native settings, permissions or hook coverage.

## Packaging and activation boundary

Build an isolated Codex plugin with `node scripts/package-codex.mjs <absolute-absent-directory>`. It copies only an explicit source allowlist into a self-contained artifact; no `.env`, ledger, legacy ZCode skill/hook or executor registry. It neither installs nor edits Codex settings. The Codex manifest uses standard `.mcp.json`, `skills/`, `hooks/hooks.json` paths. Existing ZCode/Claude manifests retain their original host-specific paths.

Supported Codex hook definitions are documented at https://learn.chatgpt.com/docs/hooks . The packaged UserPromptSubmit/SubagentStart handlers are advisory only. Generic PreToolUse does not carry a separate child identity; the parent session ID is not the agent ID. Hosted tools can bypass local hooks. Hook trust must be reviewed in the actual host; enabling a plugin alone is not enforcement. Full live acceptance requires real tool exposure, fresh graph/Skill evidence, a Jev route, observed native selection, mid-work deviation+correction receipts, tests and final independent parent review.
