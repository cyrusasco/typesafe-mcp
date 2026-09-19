#!/usr/bin/env node
/**
 * typesafe-mcp smoke test — NO real API call, NO key required, NO cost.
 * Exercises: .env presence, ts_ping, ts_safety, ts_feasible, ts_decide,
 * ts_ask no-key degraded path (must return fast, not hang), recursion guard,
 * redaction engine, and ledger writes. ALL GREEN = pass.
 * (Real API test happens when the user supplies a key.)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  tsPing, tsAsk, tsDecide, tsSafety, tsFeasible,
  loadConfig, readLedgerToday, redactDeep, canonicalJson,
} from "../plugin/server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

let pass = 0, fail = 0;
function check(name, cond, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (cond) pass++; else fail++;
}

// Deterministic no-key config: NEVER touches a real key, NEVER hits the API.
const cfg = loadConfig({ key: null });

// 1. .env presence
check(".env present", fs.existsSync(path.join(ROOT, ".env")));
check(".env.example present", fs.existsSync(path.join(ROOT, ".env.example")));

// 2. ts_ping
const ping = tsPing(cfg);
check("ts_ping ok:true", ping.ok === true);
check("ts_ping shape", typeof ping.has_key === "boolean" && typeof ping.today.cap === "number"
  && ["closed", "open", "half_open"].includes(ping.breaker.state) && !!ping.server_time,
  `has_key=${ping.has_key} cap=${ping.today.cap} breaker=${ping.breaker.state}`);
check("ts_ping has_key=false (forced no-key smoke config)", ping.has_key === false);

// 3. ts_safety — deterministic destructive detection
const s1 = tsSafety({ text: "please run: rm -rf /" }, cfg);
check("ts_safety 'rm -rf /' destructive:true", s1.destructive === true && s1.matched.includes("rm_rf"), `matched=${s1.matched.join(",")}`);
const s2 = tsSafety({ text: "ls -la" }, cfg);
check("ts_safety 'ls -la' destructive:false", s2.destructive === false);
const s1b = tsSafety({ text: "git push --force origin main" }, cfg);
check("ts_safety force-push detected", s1b.destructive === true && s1b.matched.includes("git_push_force"), `matched=${s1b.matched.join(",")}`);

// 4. ts_feasible — scrub executor keys for determinism, restore after
const savedEnv = {};
for (const v of ["DEEPSEEK_API_KEY", "QWEN_API_KEY"]) { savedEnv[v] = process.env[v]; delete process.env[v]; }
let feas;
try { feas = tsFeasible({}, cfg); } finally {
  for (const v of Object.keys(savedEnv)) if (savedEnv[v] !== undefined) process.env[v] = savedEnv[v];
}
check("ts_feasible zcode-gp feasible", feas.feasible.includes("zcode-gp"), `feasible=${feas.feasible.join(",")}`);
const infMap = Object.fromEntries(feas.infeasible.map((x) => [x.id, x.reason]));
check("ts_feasible deepseek-api infeasible (no key)", "deepseek-api" in infMap && /DEEPSEEK_API_KEY/.test(infMap["deepseek-api"]));
check("ts_feasible qwen-api infeasible (no key)", "qwen-api" in infMap && /QWEN_API_KEY/.test(infMap["qwen-api"]), `reason=${infMap["qwen-api"] ?? ""}`);

// 5. ts_decide — deterministic thresholds
const dec = tsDecide({
  answers: {
    pick: { choice: "plan_first", probabilities: { plan_first: 0.9, other: 0.1 }, confidence: 0.9 },
    risky: { noul: 0.5 },
  },
}, cfg);
check("ts_decide choice conf 0.9 → auto", dec.per_question.pick.band === "auto");
check("ts_decide noul 0.5 → escalate (deadband)", dec.per_question.risky.band === "escalate");
check("ts_decide overall escalate wins", dec.decision === "escalate");
check("ts_decide log_record in ledger shape", dec.log_record.tool === "ts_decide" && dec.log_record.decision === "escalate");

// 6. ts_ask no-key → degraded, fast, no hang
const ledgerBefore = readLedgerToday(cfg.ledgerDir).length;
const t0 = Date.now();
const ask = await tsAsk(
  {
    state: { cwd: "C:/tmp/demo", task: "smoke test demo task" },
    questions: { q_demo: { type: "noul", instructions: "demo question — is this a test?" } },
    options: { battery: "smoke", depth: 0, lang: "en" },
  },
  cfg,
);
const elapsed = Date.now() - t0;
check("ts_ask no-key → degraded no_key", ask.mode === "degraded" && ask.reason === "no_key", JSON.stringify(ask));
check("ts_ask no-key returned fast (<2000ms, no hang)", elapsed < 2000, `${elapsed}ms`);

// 6b. recursion guard: depth>0 must reject with an error
let rejected = false;
try { await tsAsk({ state: "x", questions: { a: { type: "noul", instructions: "x" } }, options: { depth: 1 } }, cfg); }
catch (e) { rejected = /recursion guard/.test(e.message); }
check("ts_ask depth>0 rejected (recursion guard)", rejected);

// 6c. redaction engine sanity (no API involved)
const red = redactDeep({ s: "key is sk-abcdefghijklmnop1234 and API_KEY: supersecret99" }, cfg.patterns.redaction);
check("redaction replaces secrets, counts only", red.count >= 2 && !JSON.stringify(red.value).includes("sk-abcdefghijklmnop") && !JSON.stringify(red.value).includes("supersecret99"), `count=${red.count}`);

// 7. ledger lines written (ts_ask degraded line + ts_decide line)
const ledgerAfter = readLedgerToday(cfg.ledgerDir);
const newLines = ledgerAfter.slice(ledgerBefore);
const askLine = newLines.find((l) => l.tool === "ts_ask" && l.mode === "degraded" && l.error === "no_key" && l.battery === "smoke");
const decideLine = ledgerAfter.find((l) => l.tool === "ts_decide" && l.decision === "escalate");
const askLineCount = newLines.filter((l) => l.tool === "ts_ask" && l.mode === "degraded" && l.error === "no_key").length;
check("ledger: exactly one ts_ask degraded/no_key line written", askLineCount === 1 && Boolean(askLine), `ts_ask line=${Boolean(askLine)} (count=${askLineCount})`);
check("ledger: ts_decide line written", Boolean(decideLine));
check("ledger: line carries no raw state content", askLine && !JSON.stringify(askLine).includes("smoke test demo task"));

// bonus: canonical JSON hash stability
check("canonicalJson key-order stable", canonicalJson({ b: 1, a: { d: 2, c: 3 } }) === canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));

console.log(`\n${fail === 0 ? "ALL GREEN" : "FAILED"} — ${pass} pass, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
