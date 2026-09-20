#!/usr/bin/env node
/**
 * cli.mjs — Bash entry into typesafe-mcp for sessions that don't have the MCP
 * tools loaded (old sessions, scheduled tasks, other CLIs). Same functions,
 * same guards, same ledger as the MCP surface.
 *
 *   node cli.mjs ping
 *   node cli.mjs ask <state.json|-> <questions.json|-> [--battery label] [--lang en|cjk|auto]
 *   node cli.mjs decide <answers.json|->          # pipe the ts_ask result's answers in
 *   node cli.mjs safety "git push --force origin main"
 *   node cli.mjs feasible
 *
 * `-` reads JSON from stdin. Exit 0 on success, 1 on error, 2 on degraded.
 */
import fs from "node:fs";
import { tsPing, tsAsk, tsDecide, tsSafety, tsFeasible, tsSuggestSkill } from "../plugin/server.mjs";

const args = process.argv.slice(2);
const [cmd, ...rest] = args;
const flags = {};
for (let i = 0; i < rest.length; i++) {
  const m = /^--(\w+)(?:=(.*))?$/.exec(rest[i]);
  if (m) { flags[m[1]] = m[2] !== undefined ? m[2] : rest[++i]; }
}
const positional = rest.filter((a) => !a.startsWith("--"));
const readJson = (p) =>
  p === "-" ? JSON.parse(fs.readFileSync(0, "utf8")) : JSON.parse(fs.readFileSync(p, "utf8"));

try {
  switch (cmd) {
    case "ping":
      console.log(JSON.stringify(tsPing(), null, 2));
      break;
    case "ask": {
      const [stateP, questionsP] = positional;
      if (!stateP || !questionsP) throw new Error("usage: cli.mjs ask <state.json|-> <questions.json|-> [--battery b] [--lang en]");
      const result = await tsAsk({
        state: readJson(stateP),
        questions: readJson(questionsP),
        options: { battery: flags.battery ?? "cli", lang: flags.lang ?? "auto" },
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.mode === "degraded") process.exit(2);
      break;
    }
    case "decide": {
      const [answersP] = positional;
      if (!answersP) throw new Error("usage: cli.mjs decide <answers.json|->   (answers field of a ts_ask result)");
      console.log(JSON.stringify(tsDecide({ answers: readJson(answersP), ...(flags.policy ? { policy: readJson(flags.policy) } : {}) }), null, 2));
      break;
    }
    case "safety": {
      const text = positional.join(" ") || flags.text;
      if (!text) throw new Error("usage: cli.mjs safety \"command or plan text\"");
      console.log(JSON.stringify(tsSafety({ text }), null, 2));
      break;
    }
    case "feasible":
      console.log(JSON.stringify(tsFeasible(), null, 2));
      break;
    case "suggest": {
      const task = positional.join(" ");
      if (!task && !flags.require) throw new Error('usage: cli.mjs suggest "task text" [--require skill] [--allow a,b] [--exclude a,b]');
      const result = await tsSuggestSkill({
        task: task || `use ${flags.require}`,
        options: {
          require: flags.require,
          allow: flags.allow?.split(",").map((s) => s.trim()).filter(Boolean),
          exclude: flags.exclude?.split(",").map((s) => s.trim()).filter(Boolean),
          top_k: flags.top_k,
        },
      });
      console.log(JSON.stringify(result, null, 2));
      if (result.mode === "degraded") process.exit(2);
      break;
    }
    default:
      throw new Error(`unknown command: ${cmd ?? "(none)"} — use ping|ask|decide|safety|feasible|suggest`);
  }
} catch (e) {
  process.stderr.write(`cli: ${e?.message ?? e}\n`);
  process.exit(1);
}
