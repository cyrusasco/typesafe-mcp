#!/usr/bin/env node
/**
 * live-test.mjs — one REAL TypeSafe API call (exercises all 3 primitives in a
 * single batched ask, per the one-request-many-questions rule). Uses whatever
 * key resolution finds (env → .env → ~/.claude/settings.json). Costs a few
 * hundred tokens. Run: node scripts/live-test.mjs
 */
import { tsPing, tsAsk, tsDecide } from "../plugin/server.mjs";

const ping = tsPing();
console.log("[1] ts_ping:", JSON.stringify(ping, null, 2));
if (!ping.has_key) {
  console.log("NO KEY — put TYPESAFE_API_KEY in typesafe-mcp/.env (or rely on the settings.json fallback) and rerun.");
  process.exit(0);
}

const before = ping.today.calls;

// Bounded English state (CJK note: Jev is English-primary; keep state en-normalized)
const result = await tsAsk({
  state: {
    cwd: "~/projects/demo-cli",
    task: "Add a --verbose flag to a small Node.js CLI tool so it prints step-by-step progress when enabled.",
    files: [{ path: "cli.js", role: "entry point; hand-rolled argv parsing, ~120 lines" }],
    constraints: ["no new dependencies", "default behavior unchanged"],
  },
  questions: {
    workflow: {
      type: "choice",
      instructions: "How should this task be executed? Pick the single best workflow.",
      criteria: {
        direct_edit: "Single-file or few-line change with no design decisions.",
        plan_first: "Multi-step or ambiguous; plan and confirm before code changes.",
        research_only: "The user needs information or analysis; no code changes yet.",
        other: "None of the above fit.",
      },
    },
    needs_agentic_file_access: {
      type: "noul",
      instructions:
        "true if the chosen work requires reading/writing repo files or running commands, false if pure reasoning on provided context suffices.",
    },
    difficulty: {
      type: "score",
      instructions: "How hard is this task?",
      criteria: [
        "trivial one-line tweak (typo, constant, styling)",
        "small focused change in one area (single function/file, clear path)",
        "multi-file feature spanning a few related modules",
      ],
    },
  },
  options: { battery: "live-test", lang: "en" },
});

console.log("\n[2] ts_ask:", JSON.stringify(result, null, 2));

if (result.mode === "normal") {
  const decision = tsDecide({ answers: result.answers });
  console.log("\n[3] ts_decide:", JSON.stringify(decision, null, 2));
  console.log(`\nALL OK — batched ask ${result.latency_ms}ms, usage ${JSON.stringify(result.usage)}, ledger call #${before + 1} today`);
} else {
  console.log(`\nDEGRADED (${result.reason}) — server guards worked; check key/network.`);
}
