#!/usr/bin/env node
/**
 * review-comment.mjs — Battery #2 lite: post-work review with automatic correction
 * comments (v1.8.0). The lesson that built this: fast-but-broken is worthless, and
 * opt-in verification never happens (3 audits, 0 guard-spec pushes).
 *
 *   node scripts/review-comment.mjs --spec '<one-line task spec>' \
 *     [--diff-file <file> | --diff '<text>'] [--test-result 'pass' | 'fail: <output>'] \
 *     [--reviewer deepseek-api|codex-cli] [--model <variant>] [--artifact-note '<text>']
 *
 * Decision ladder (deterministic first — "use code when you can"):
 *   1. tests fail            → correct, NO model call (failing tests are the truth)
 *   2. reviewer says broken  → ONE Jev validity judgment: do the broken_why entries cite
 *                              concrete spec violations present in the diff?
 *                              ≥0.65 → correct (directive = the reviewer's comments)
 *                              <0.65 → escalate (review not grounded — main LLM looks)
 *   3. reviewer says pass    → accept, with risks surfaced (no Jev call needed)
 * Caller manages fix-loops (skill: ≤2) by re-running after each correction.
 * Every step ledgered (battery review-comment).
 */
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const server = await import(pathToFileURL(path.join(HERE, "..", "plugin", "server.mjs")).href);
const { loadConfig, appendLedger, tsAsk } = server;

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const spec = flag("--spec");
if (!spec) { process.stderr.write('usage: review-comment.mjs --spec "<spec>" [--diff-file f|--diff text] [--test-result pass|fail:out] [--reviewer lane] [--model v]\n'); process.exit(1); }
const diff = flag("--diff") ?? (flag("--diff-file") ? fs.readFileSync(flag("--diff-file"), "utf8") : "(no diff provided — judge from spec vs artifact note)");
const testResult = flag("--test-result") ?? "not run";
const reviewer = flag("--reviewer") ?? "deepseek-api";
const model = flag("--model");
const artifactNote = flag("--artifact-note") ?? "";

const ledger = (extra) => appendLedger(loadConfig().ledgerDir, { ts: new Date().toISOString(), call_id: `rc_${Date.now().toString(36)}`, tool: "review_comment", battery: "review-comment", mode: "normal", ...extra });

// --- 1. deterministic gate: failing tests need nobody's opinion ---
if (/^fail/i.test(testResult.trim())) {
  ledger({ verdict: "correct", via: "deterministic-tests", detail: String(testResult).slice(0, 120) });
  console.log(JSON.stringify({
    verdict: "correct", via: "deterministic-tests",
    directive: `Tests are failing — fix before anything else. Output: ${String(testResult).slice(0, 300)}`,
  }, null, 2));
  process.exit(0);
}

// --- 2. reviewer call via api-exec (reuses both API styles + cap guard + its own ledger) ---
const reviewerPrompt = [
  "You are a strict code reviewer dispatched by an orchestration pipeline.",
  `TASK SPEC: ${spec}`,
  `TEST RESULTS: ${testResult}`,
  artifactNote ? `ARTIFACT NOTE: ${artifactNote}` : "",
  "DIFF / CHANGES:",
  diff.slice(0, 24000),
  "",
  'Return ONLY this JSON (no fences): {"verdict":"pass"|"broken","broken_why":["concrete violation, each with evidence quoted from the diff"],"risks":["non-blocking concerns"]}',
  "verdict=broken ONLY for concrete evidence-cited problems (logic errors, spec violations, missing requirements, broken interfaces). Style preferences belong in risks, never in broken_why. If tests passed and the diff satisfies the spec, verdict=pass.",
].filter(Boolean).join("\n");

const tmpPrompt = path.join(HERE, "..", "rc-prompt.tmp");
fs.writeFileSync(tmpPrompt, reviewerPrompt);
const run = spawnSync(process.execPath, [path.join(HERE, "api-exec.mjs"), reviewer, "-", ...(model ? ["--model", model] : [])], {
  input: fs.readFileSync(tmpPrompt, "utf8"), encoding: "utf8", timeout: 180000, maxBuffer: 4 * 1024 * 1024,
});
fs.rmSync(tmpPrompt, { force: true });
const raw = String(run.stdout ?? "").trim();
if (run.status !== 0 || !raw) {
  // reviewer lane down → degraded, NOT a pass (fail-closed: no silent acceptance)
  ledger({ verdict: "escalate", via: "reviewer-unavailable", detail: String(run.stderr ?? "").slice(0, 150) });
  console.log(JSON.stringify({ verdict: "escalate", via: "reviewer-unavailable", directive: "Reviewer lane unavailable — main LLM must review the diff manually before reporting. Never accept work unreviewed." }, null, 2));
  process.exit(0);
}
let review;
try {
  const m = /\{[\s\S]*\}/.exec(raw);
  review = JSON.parse(m ? m[0] : raw);
  if (!["pass", "broken"].includes(review.verdict)) throw new Error("bad verdict");
} catch {
  ledger({ verdict: "escalate", via: "reviewer-unparseable", detail: raw.slice(0, 150) });
  console.log(JSON.stringify({ verdict: "escalate", via: "reviewer-unparseable", raw: raw.slice(0, 400), directive: "Reviewer output was not valid JSON — main LLM must review manually." }, null, 2));
  process.exit(0);
}

// --- 3. reviewer says pass → deterministic accept (risks surfaced, no Jev needed) ---
if (review.verdict === "pass") {
  ledger({ verdict: "accept", via: "reviewer-pass", risks: (review.risks ?? []).length });
  console.log(JSON.stringify({ verdict: "accept", via: "reviewer-pass", risks: review.risks ?? [], directive: "Accept the work; mention notable risks to the user if any." }, null, 2));
  process.exit(0);
}

// --- 4. reviewer says broken → ONE Jev validity judgment (is the critique grounded?) ---
const j = await tsAsk({
  state: { task_spec: spec, diff: diff.slice(0, 12000), reviewer_broken_why: review.broken_why ?? [] },
  questions: {
    review_validity: {
      type: "noul",
      instructions: "`state.reviewer_broken_why` lists problems a reviewer claims to see in `state.diff` against `state.task_spec`. true = the cited problems are actually present in the diff and genuinely violate the spec (evidence matches); false = the critique is vague, evidence-free, or misreads the diff.",
      criteria: { true: "critique grounded — problems verifiable in the diff", false: "critique vague or misreads the diff" },
    },
  },
  options: { battery: "review-comment", lang: "en" },
});
const validity = j.mode === "normal" ? (j.answers.review_validity?.noul ?? 0.5) : null;
if (validity === null) {
  // Jev down → trust the reviewer anyway (it already cited evidence), mark degraded
  ledger({ verdict: "correct", via: "reviewer-broken", jev: "degraded", why_count: (review.broken_why ?? []).length });
  console.log(JSON.stringify({ verdict: "correct", via: "reviewer-broken", note: "Jev validity check unavailable — trusting evidence-cited review", directive: review.broken_why ?? [] }, null, 2));
  process.exit(0);
}
const grounded = validity >= 0.65;
ledger({ verdict: grounded ? "correct" : "escalate", via: "reviewer-broken", jev: "normal", validity: +validity.toFixed(2) });
console.log(JSON.stringify({
  verdict: grounded ? "correct" : "escalate",
  validity: +validity.toFixed(2),
  directive: grounded
    ? `Send this correction back to the subagent (fix-loop; ≤2 loops total):\n${(review.broken_why ?? []).map((w, i) => `${i + 1}. ${w}`).join("\n")}\nThen re-run review-comment.`
    : "Reviewer claims problems but Jev rates the critique ungrounded — main LLM reads the diff itself and decides (do NOT auto-correct off a shaky review).",
  broken_why: review.broken_why, risks: review.risks ?? [],
}, null, 2));
