#!/usr/bin/env node
/**
 * typesafe-dispatch hook — UserPromptSubmit 偵測（照 clp-detect.mjs 範本:
 * 唔 block,只注入提醒;唔關事就靜靜哋 exit 0）
 *
 * prompt 睇落係 build-shaped / multi-step / 整合類工作 → 注入 dispatch 規則
 * (連舊 session 冇 ts_* MCP tool 嘅 cli.mjs 後路都寫埋)。
 * 簡單請求唔會 trigger —— 注入文字本身都講明「簡單直接做」,呼應 GATE 哲學。
 *
 * Smoke test:
 *   echo '{"hook_event_name":"UserPromptSubmit","prompt":"幫我做一個自動同步pipeline"}' | node dispatch-reminder.mjs
 *   echo '{"hook_event_name":"UserPromptSubmit","prompt":"而家幾點"}'            | node dispatch-reminder.mjs   (無輸出)
 */
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

let input = {};
try {
  input = raw.trim() ? JSON.parse(raw) : {};
} catch {
  process.exit(0); // 解析唔到一律放行
}

const prompt = String(input.prompt || input.userPrompt || "");

const BUILD_KW =
  /(build|implement|create|install|integrate|整合|自動化|automate|pipeline|refactor|重構|migrate|遷移|upgrade|升級|做一個|做個|起一個|起個|寫一個|寫個|加一個|加個|新增|subagent|multi-?step|多步|dispatch)/i;
const FORCE_KW = /(typesafe|ts_ask|ts_decide|battery|executor)/i;

if (!prompt || !(BUILD_KW.test(prompt) || FORCE_KW.test(prompt))) {
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext:
        "【typesafe-dispatch】呢個 request 如果係 multi-step/ambiguous/build-shaped:先照 skill `typesafe-dispatch`（typesafe-dispatch plugin 內置嗰份 SKILL.md）行 — ts_feasible 預過濾 → 一次 batched ts_ask（Battery #1）→ ts_decide 分 band → 先至郁手派工;subagent dispatch 前行 ts_suggest_skill 搵skill。呢個 session 冇 ts_* MCP tool 嘅話,用 Bash: node <plugin-install-dir>/../scripts/cli.mjs（ask/decide/safety/feasible/suggest/judge/ping）。高風險/大改 subagent 一定要開 GUARD（Jev 做緊嗰陣即時監察）:dispatch 前先 `node scripts/guard-spec.mjs push '<一行英文 spec>'` + run_in_background,行緊期間每 15–30s 用 `cli.mjs judge \"<spec>\" \"<action>\"` 判佢最新動作,on_spec ≤0.35 就 TaskStop + SendMessage 糾正。簡單/單一改動嘅 request 直接做,唔好行 pipeline（GATE 哲學）。破壞性操作:ts_safety + 用戶確認,冇例外。",
    },
  }),
);
process.exit(0);
