#!/usr/bin/env node
/**
 * subagent-guard.mjs — PreToolUse 即時守衛(A 路徑)。
 * 
 * 淨係守 subagent session(payload.session_id 以 sess_subagent_ 開頭先理;
 * 冇 session_id / 主 session → exit 0 放行,fail-open)。Matcher 掛 Bash|Edit|Write。
 *
 * 判斷次序:
 *   1. destructive deterministic 檢查(ts_safety patterns)→ 中即 block(唔使 Jev)
 *   2. spec 由 ~/.zcode/typesafe-state/ 讀:spec-<sessionId>.json,冇就由
 *      pending-specs.json FIFO claim(主 agent dispatch 前用 guard-spec.mjs push)
 *      冇 spec → exit 0(未 guarded 嘅 dispatch 唔騷擾)
 *   3. Jev 一個 batched ts_ask:on_spec Noul + reversible Noul(degraded → 放行)
 *   4. on_spec ≤ 0.35 → block(exit 2 + stderr reason)= 即時更正;
 *      strikes ≥ 3 → block 並叫佢停手 report
 *
 * Block 格式 = house convention(clp-guard.mjs):stderr reason + exit 2。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { tsSafety, tsAsk } from "../plugin/server.mjs";

const STATE_DIR = path.join(os.homedir(), ".zcode", "typesafe-state");
const BLOCK_THRESHOLD = 0.35; // on_spec ≤ 此值 = 離題,即時更正
const STRIKE_LIMIT = 3;

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try { input = raw.trim() ? JSON.parse(raw) : {}; } catch { process.exit(0); }

const BLOCK = (reason) => { process.stderr.write(`[subagent-guard] ${reason}\n`); process.exit(2); };

const sessionId = String(input.session_id ?? input.sessionId ?? "");
if (!sessionId.startsWith("sess_subagent")) process.exit(0); // 主 session / 冇 id → 唔守

const tool = String(input.tool_name ?? input.toolName ?? "");
const toolInput = input.tool_input ?? input.toolInput ?? {};
const action = tool === "Bash" ? String(toolInput.command ?? "") : JSON.stringify(toolInput).slice(0, 500);
if (!action || action === "{}") process.exit(0);

// 1. deterministic destructive 檢查(永遠 fail-closed)
const safety = tsSafety({ text: tool === "Bash" ? action : `${tool} ${action}` });
if (safety.destructive) {
  BLOCK(`DESTRUCTIVE 檢測(${safety.matched.join(", ")}):破壞性操作必須先用戶確認,冇例外。移除呢步或者問用戶。`);
}

// 2. spec 載入(直接檔案 → FIFO claim)
const specFile = path.join(STATE_DIR, `spec-${sessionId}.json`);
let guard;
try {
  guard = JSON.parse(fs.readFileSync(specFile, "utf8"));
} catch {
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

// read-only Bash 唔經 Jev:錯嘅 read 冇後果,唔值得冒 false-positive 都要即時擋
const READ_ONLY = /^\s*(grep|egrep|rg|ls|dir|cat|head|tail|wc|stat|file|find|which|where|whoami|pwd|date|echo|printf|diff|cmp|test|true|false|node\s+--check|git\s+(status|log|diff|show|branch))\b/i;
const MUTATION_HINT = /(>|>>|\bsed\s+-i|\btee\b|\bmkdir\b|\brm\b|\bmv\b|\bcp\b|\btouch\b|\bchmod\b|\bcurl\b|\bnpm\s+(i|install|ci)\b|\bgit\s+(add|commit|push|pull|checkout|reset|merge|rebase))/i;
if (tool === "Bash" && READ_ONLY.test(action) && !MUTATION_HINT.test(action)) process.exit(0);

// 3. Jev 判斷(degraded → fail-open 放行;destructive 上面已擋)
const result = await tsAsk({
  state: {
    task_spec: guard.spec ?? guard,
    constraints: guard.constraints ?? [],
    proposed_action: { tool, detail: action.slice(0, 600) },
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
});

if (result.mode !== "normal") process.exit(0); // TS 冇回應 → 放行(destructive 已擋)

const onSpec = result.answers?.on_spec?.noul;
const reversible = result.answers?.reversible?.noul;
if (typeof onSpec !== "number") process.exit(0);

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
