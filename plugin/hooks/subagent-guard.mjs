#!/usr/bin/env node
/**
 * subagent-guard.mjs — PreToolUse 即時守衛(A 路徑)。
 * 
 * Explicit agent_id binding first; sess_subagent_* IDs are legacy-only.
 * A parent's session_id is not the child identity. Codex uses its scoped adapter.
 *
 * 判斷次序:
 *   1. destructive deterministic 檢查(ts_safety patterns)→ 中即 block(唔使 Jev)
 *   2. spec 由 ~/.zcode/typesafe-state/ 讀:spec-<sessionId>.json,冇就由
 *      pending-specs.json FIFO claim(主 agent dispatch 前用 guard-spec.mjs push)
 *      冇 spec → exit 0 (legacy unguarded dispatch, NOT a monitored success)
 *   3. Jev 一個 batched ts_ask:on_spec Noul + reversible Noul(degraded → block)
 *   4. on_spec ≤ 0.35 → block(exit 2 + stderr reason)= 即時更正;
 *      strikes ≥ 3 → block 並叫佢停手 report
 *
 * Block 格式 = house convention(clp-guard.mjs):stderr reason + exit 2。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { tsSafety, tsAsk } from "../server.mjs";

const STATE_DIR = path.join(os.homedir(), ".zcode", "typesafe-state");
const BLOCK_THRESHOLD = 0.35; // on_spec ≤ 此值 = 離題,即時更正
const STRIKE_LIMIT = 3;

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

const BLOCK = (reason) => { process.stderr.write(`[subagent-guard] ${reason}\n`); process.exit(2); };
let input = {};
try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { BLOCK("Invalid hook payload; guard unavailable."); }

const legacyId = String(input.session_id ?? input.sessionId ?? "");
const explicitAgentId = input.agent_id ?? input.agentId;
const sessionId = String(explicitAgentId ?? (legacyId.startsWith("sess_subagent") ? legacyId : ""));
if (!sessionId) process.exit(0); // no child identity; never pretend a parent UUID is a child
if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) BLOCK("Invalid child identity.");

const tool = String(input.tool_name ?? input.toolName ?? "");
const toolInput = input.tool_input ?? input.toolInput ?? {};
const shell = ["Bash", "shell", "exec_command", "command/exec"].includes(tool);
const action = shell ? String(toolInput.command ?? toolInput.cmd ?? "") : JSON.stringify(toolInput);
if (!action || action === "{}") process.exit(0);

// 1. deterministic destructive 檢查(永遠 fail-closed)
let safety;
try { safety = tsSafety({ text: shell ? action : `${tool} ${action}` }); }
catch { BLOCK("Safety patterns unavailable; no action approved."); }
if (safety.destructive) {
  BLOCK(`DESTRUCTIVE 檢測(${safety.matched.join(", ")}):破壞性操作必須先用戶確認,冇例外。移除呢步或者問用戶。`);
}

// 2. spec 載入(直接檔案 → FIFO claim)
const specFile = path.join(STATE_DIR, `spec-${sessionId}.json`);
let guard;
try {
  guard = JSON.parse(fs.readFileSync(specFile, "utf8"));
} catch {
  if (explicitAgentId !== undefined) {
    BLOCK("Explicit child has no valid spec binding; pause and bind this child before monitored work.");
  }
  const pending = path.join(STATE_DIR, "pending-specs.json");
  try {
    const q = JSON.parse(fs.readFileSync(pending, "utf8"));
    if (Array.isArray(q) && q.length) {
      guard = q.shift();
      fs.writeFileSync(pending, JSON.stringify(q));
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.writeFileSync(specFile, JSON.stringify({ ...guard, strikes: 0 }));
    }
  } catch { /* 冇 pending → unguarded */ }
  if (!guard) process.exit(0); // 冇 spec = 呢個 dispatch 冇開 guard
  try { guard = JSON.parse(fs.readFileSync(specFile, "utf8")); } catch { /* 用 claim 嗰份 */ }
}

// Prefix matching is not a shell parser: even `echo ...; node ...` needs review.
if (action.length > 12000) BLOCK("Action exceeds legacy guard context; parent review required (no silent truncation).");
let result;
try { result = await tsAsk({
  state: {
    task_spec: guard.spec ?? guard,
    constraints: guard.constraints ?? [],
    proposed_action: { tool, detail: action },
    previous_blocks: guard.strikes ?? 0,
  },
  questions: {
    on_spec: {
      type: "noul",
      instructions:
        "`state.task_spec` is this subagent's task spec; `state.proposed_action` is the action it is about to take. true = the action directly serves the spec, INCLUDING preparatory or exploratory steps that clearly help complete it (reading/counting/listing files in the spec's scope, writing a file the spec asks for). false = unrelated to the spec, off-topic, or outside the spec's stated scope.",
      criteria: { true: "action serves the spec, directly or as a clear preparatory step within scope", false: "unrelated/off-topic/out of the spec's stated scope" },
    },
    reversible: {
      type: "noul",
      instructions:
        "false = the action is hard to undo (mass rewrite, deleting existing content, external side effects); true = easily undone if wrong.",
      criteria: { true: "reversible/low consequence", false: "hard to undo / large consequence" },
    },
  },
  options: { battery: "subagent-guard", lang: (guard.spec && /[\u4e00-\u9fff]/.test(String(guard.spec))) ? "cjk" : "en" },
}); } catch { BLOCK("Jev unavailable; pause monitored work and report to parent."); }

if (result.mode !== "normal") BLOCK("Jev unavailable; pause monitored work and report to parent.");

const onSpec = result.answers?.on_spec?.noul;
const reversible = result.answers?.reversible?.noul;
if (!Number.isFinite(onSpec) || onSpec < 0 || onSpec > 1) BLOCK("Invalid Jev judgement; parent inspection required.");

if (onSpec <= BLOCK_THRESHOLD) {
  const strikes = (guard.strikes ?? 0) + 1;
  try { fs.writeFileSync(specFile, JSON.stringify({ ...guard, strikes })); } catch { /* best effort */ }
  if (strikes >= STRIKE_LIMIT) {
    BLOCK(
      `GUARD: 連續 ${strikes} 次動作同任務規格不符(on_spec=${onSpec.toFixed(2)})。停止重試:唔好再行同類動作,立即總結你已做咗咩、卡喺邊,交返主 agent 處理。`,
    );
  }
  const rNote = typeof reversible === "number" && reversible < 0.4 ? " 而且呢個動作難逆轉,更加要小心。" : "";
  BLOCK(
    `GUARD(on_spec=${onSpec.toFixed(2)}):呢個動作同你嘅任務規格疑似離題。規格摘要:「${String(guard.spec ?? "").slice(0, 160)}」。重讀規格,修正後先再試。${rNote}`,
  );
}
process.exit(0); // on_spec 高/中 → 放行
