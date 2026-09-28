#!/usr/bin/env node
/**
 * typesafe-mcp — stdio MCP server wrapping the TypeSafe System One API.
 * Zero-dependency (node 18+, plain fetch, node:crypto), mirroring the proven
 * house plumbing from fast-jev-compaction/zcode-mcp/server.mjs (JSON-RPC 2.0,
 * one message per line on stdio) and hottoy-logistic-plugin/mcp/server.js
 * (tool schemas + error style).
 *
 * Tools (the ONLY tool surface — no per-battery tools):
 *   ts_ping     — health: key/model/daily usage/circuit breaker (no API call)
 *   ts_ask      — THE one generic batched System One ask (pre-flight guards,
 *                 egress redaction, retries, ledger)
 *   ts_decide   — deterministic threshold enforcement of answers (ledger)
 *   ts_safety   — P0 #1: deterministic destructive-op detection, never TS
 *   ts_feasible — P0 #2: hard-availability pre-filter of the executor registry
 *
 * API contract (verified against fast-jev-compaction/src/request.ts):
 *   POST https://api.typesafe.ai/v1/systemone
 *   headers: authorization: Bearer <key>, content-type: application/json
 *   body:    { model, state, questions }
 *   answer:  { model, answers: {id:{...}}, usage: {input_tokens, output_tokens} }
 *
 * Key resolution order (value NEVER logged): process.env.TYPESAFE_API_KEY →
 * <DATA_DIR>/.env → <this dir>/.env. Other products' account files are never read.
 *
 * DATA_DIR (operational data: ledger/, .env, executors.json, patterns.json):
 *   1. process.env.TYPESAFE_DATA_DIR (explicit override);
 *   2. this plugin's PARENT dir when it contains executors.json (repo
 *      checkout / marketplace-root layout — ledger + registry live one level
 *      up, alongside scripts/);
 *   3. this plugin dir itself (self-contained install: only plugin/ was
 *      copied into the plugin cache — in-plugin shipped defaults are used).
 *
 * Importing this module is side-effect free; the stdio server starts only when
 * run as the entry script. All ts* functions are exported for scripts/smoke.mjs.
 */
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const NAME = "typesafe-mcp";
const VERSION = "1.9.0";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";
const DEFAULTS = { model: "jev-latest", cap: 200000, timeoutMs: 5000, maxRetries: 2 };
const BREAKER_THRESHOLD = 3;               // consecutive failures → open
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // open for 5 minutes

// DATA_DIR: explicit override → parent dir that carries the live registry →
// in-plugin defaults (self-contained installs).
function resolveDataDir() {
  if (process.env.TYPESAFE_DATA_DIR) return path.resolve(process.env.TYPESAFE_DATA_DIR);
  try {
    const parent = path.join(HERE, "..");
    if (fs.existsSync(path.join(parent, "executors.json"))) return parent;
  } catch { /* stat failure — fall through to HERE */ }
  return HERE;
}
const DATA_DIR = resolveDataDir();

const log = (m) => process.stderr.write(`[${NAME}] ${m}\n`);
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

// ------------------------------------------------------------------ env (names only ever hit stderr; values never)
let DOTENV = null;
function parseEnvFile(p) {
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!(k in out)) out[k] = v;
  }
  return out;
}
function dotenv() {
  if (DOTENV) return DOTENV;
  DOTENV = {};
  // DATA_DIR/.env wins over the in-plugin .env; either may be absent — fine.
  for (const p of [path.join(DATA_DIR, ".env"), path.join(HERE, ".env")]) {
    try {
      for (const [k, v] of Object.entries(parseEnvFile(p))) if (!(k in DOTENV)) DOTENV[k] = v;
    } catch { /* no .env at this location — fine */ }
  }
  return DOTENV;
}

export function resolveApiKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  const k = dotenv().TYPESAFE_API_KEY;
  if (k) return k;
  return null;
}

export function loadConfig(overrides = {}) {
  const num = (name, dflt) => {
    const raw = process.env[name] ?? dotenv()[name];
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  return {
    key: "key" in overrides ? overrides.key : resolveApiKey(),
    model: process.env.TYPESAFE_MODEL || dotenv().TYPESAFE_MODEL || DEFAULTS.model,
    cap: num("TYPESAFE_DAILY_TOKEN_CAP", DEFAULTS.cap),
    timeoutMs: num("TYPESAFE_TIMEOUT_MS", DEFAULTS.timeoutMs),
    maxRetries: Math.max(0, Math.floor(num("TYPESAFE_MAX_RETRIES", DEFAULTS.maxRetries))),
    patterns: loadPatterns(),
    ledgerDir: path.join(DATA_DIR, "ledger"),
    url: SYSTEM_ONE_URL,
  };
}

// ------------------------------------------------------------------ patterns.json
function loadPatterns() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "patterns.json"), "utf8"));
    const compile = (rules, global) => {
      if (!Array.isArray(rules) || !rules.length) throw new Error("non-empty redaction and destructive regex lists required");
      return rules.map((r) => {
        const src = typeof r === "string" ? r : r?.pattern;
        if (typeof src !== "string" || !src) throw new Error("invalid regex pattern");
        const flags = [...new Set(String((typeof r === "object" && r.flags) || "").replace(/[gy]/g, "") + (global ? "g" : ""))].join("");
        return { name: (typeof r === "object" && r.name) || src.slice(0, 24), re: new RegExp(src, flags) };
      });
    };
    return { redaction: compile(raw.redaction?.regexes, true), destructive: compile(raw.destructive?.regexes, false) };
  } catch (e) {
    // Missing/invalid safety config is not evidence that an action or egress is safe.
    throw new Error(`patterns.json unavailable or invalid: ${e.message}`);
  }
}

// ------------------------------------------------------------------ helpers
const localDate = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const newCallId = () => `ts_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const byteLen = (x) => Buffer.byteLength(JSON.stringify(x) ?? "''", "utf8");

/** Canonical JSON: object keys sorted recursively — stable input for hashing. */
export function canonicalJson(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
}

/** Deep-walk a payload; replace every string VALUE matching a redaction rule
 *  with "[REDACTED]". Returns the rewritten copy + COUNT only (never content). */
export function redactDeep(x, rules) {
  let count = 0;
  const walk = (v) => {
    if (typeof v === "string") {
      let s = v;
      for (const { re } of rules) {
        const m = s.match(re);
        if (m && m.length) { count += m.length; s = s.replace(re, "[REDACTED]"); }
      }
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    return v;
  };
  return { value: walk(x), count };
}

// ------------------------------------------------------------------ ledger (append-only, one JSON line per call)
export function appendLedger(dir, record) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `${localDate()}.jsonl`), JSON.stringify(record) + "\n", "utf8");
  } catch (e) {
    log(`ledger append failed: ${e.message}`); // never fail the call because of the ledger
  }
}

export function readLedgerToday(dir) {
  const file = path.join(dir, `${localDate()}.jsonl`);
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

export function todayUsage(dir) {
  const lines = readLedgerToday(dir);
  let calls = 0, tokens_in = 0, tokens_out = 0;
  for (const l of lines) {
    if (l.tool === "ts_ask") calls++;
    if (l.usage && Number.isFinite(l.usage.input_tokens)) {
      tokens_in += l.usage.input_tokens;
      tokens_out += l.usage.output_tokens || 0;
    }
  }
  return { calls, tokens_in, tokens_out, total: tokens_in + tokens_out };
}

/** Top-line answer values only — full distributions never touch the ledger. */
function summarizeAnswers(answers) {
  const out = {};
  for (const [id, a] of Object.entries(answers ?? {})) {
    if (!a || typeof a !== "object") { out[id] = { raw: String(a) }; continue; }
    if (typeof a.noul === "number") out[id] = { noul: a.noul };
    else if (a.choice !== undefined) out[id] = { choice: a.choice, confidence: a.confidence ?? null };
    else if (a.score !== undefined) out[id] = { score: a.score, confidence: a.confidence ?? null };
    else out[id] = { keys: Object.keys(a) };
  }
  return out;
}

// ------------------------------------------------------------------ same-payload re-ask dedupe (v1.5.1; disk-persisted v1.5.2)
// In-process caches never hit for cli.mjs users (each Bash call = fresh node process —
// measured 2026-09-22: a 3x same-hash re-ask billed full tokens 3 times). The cache now
// lives in DATA_DIR/dedupe-cache.json so cross-process re-asks within the TTL hit it.
const DEDUPE_TTL_MS = 45_000;
const DEDUPE_MAX = 20;
const DEDUPE_FILE = () => path.join(DATA_DIR, "dedupe-cache.json");
function dedupeRead() {
  try {
    const m = JSON.parse(fs.readFileSync(DEDUPE_FILE(), "utf8"));
    const now = Date.now();
    const out = {};
    for (const [k, v] of Object.entries(m)) if (now - v.at < DEDUPE_TTL_MS) out[k] = v;
    return out;
  } catch { return {}; }
}
function dedupePut(key, result) {
  const m = dedupeRead();
  m[key] = { at: Date.now(), result };
  const keys = Object.keys(m).sort((a, b) => m[a].at - m[b].at);
  for (const k of keys.slice(0, Math.max(0, keys.length - DEDUPE_MAX))) delete m[k];
  try { fs.writeFileSync(DEDUPE_FILE(), JSON.stringify(m)); } catch { /* best effort */ }
}

// ------------------------------------------------------------------ circuit breaker (in-process state)
const breaker = { failures: 0, cooldownUntil: 0 };

export function breakerState(now = Date.now()) {
  if (breaker.failures >= BREAKER_THRESHOLD) {
    if (now < breaker.cooldownUntil) {
      return { state: "open", cooldown_until: new Date(breaker.cooldownUntil).toISOString() };
    }
    return { state: "half_open" }; // probe allowed; another failure reopens
  }
  return { state: "closed" };
}
function recordFailure() {
  breaker.failures++;
  if (breaker.failures >= BREAKER_THRESHOLD) breaker.cooldownUntil = Date.now() + BREAKER_COOLDOWN_MS;
}
function recordSuccess() {
  breaker.failures = 0;
  breaker.cooldownUntil = 0;
}

// ------------------------------------------------------------------ TypeSafe API call (retry 429/529 only)
async function callSystemOne(cfg, state, questions) {
  const body = JSON.stringify({ model: cfg.model, state, questions });
  for (let attempt = 0; ; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.timeoutMs);
    let res, text = "";
    try {
      res = await fetch(cfg.url, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
        body,
        signal: ac.signal,
      });
      text = await res.text(); // body read inside the same timeout window
    } catch (e) {
      const aborted = e?.name === "AbortError" || e?.cause?.name === "AbortError" || /abort/i.test(String(e?.message));
      return { ok: false, kind: aborted ? "timeout" : "network", detail: String(e?.message ?? e).slice(0, 200) };
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 || res.status === 529) {
      if (attempt < cfg.maxRetries) {
        await new Promise((r) => setTimeout(r, Math.min(4000, 500 * 2 ** attempt))); // exponential backoff
        continue;
      }
      return { ok: false, kind: "rate_limited", status: res.status, detail: text.slice(0, 200) };
    }
    if (res.status === 401) return { ok: false, kind: "auth", status: 401, detail: text.slice(0, 200) };
    if (res.status === 422) return { ok: false, kind: "validation", status: 422, detail: text.slice(0, 500) };
    if (!res.ok) return { ok: false, kind: res.status >= 500 ? "server" : "http", status: res.status, detail: text.slice(0, 200) };
    let parsed;
    try { parsed = JSON.parse(text); } catch { return { ok: false, kind: "bad_response", detail: "malformed JSON from TypeSafe" }; }
    if (!parsed || typeof parsed !== "object" || !parsed.answers || typeof parsed.answers !== "object")
      return { ok: false, kind: "bad_response", detail: "response missing answers" };
    return { ok: true, model: parsed.model ?? cfg.model, answers: parsed.answers, usage: parsed.usage ?? null };
  }
}

// ------------------------------------------------------------------ tools
export function tsPing(cfg = loadConfig()) {
  const u = todayUsage(cfg.ledgerDir);
  // zero-cost tools leave an audit trace too (v1.5.1: audits kept inferring usage from prose)
  appendLedger(cfg.ledgerDir, { ts: new Date().toISOString(), call_id: newCallId(), tool: "ts_ping", mode: "normal" });
  return {
    ok: true,
    has_key: Boolean(cfg.key),
    model: cfg.model,
    today: { calls: u.calls, tokens_in: u.tokens_in, tokens_out: u.tokens_out, cap: cfg.cap, capped: u.total >= cfg.cap },
    breaker: breakerState(),
    server_time: new Date().toISOString(),
  };
}

export async function tsAsk(args, cfg = loadConfig()) {
  const { state, questions } = args ?? {};
  if (state === undefined || state === null) throw new Error("ts_ask: state is required (string|object|array)");
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || !Object.keys(questions).length)
    throw new Error("ts_ask: questions must be a non-empty object { id: { type, instructions, criteria } }");
  const options = args.options ?? {};
  const depth = Number.isFinite(Number(options.depth)) ? Number(options.depth) : 0;
  const base = {
    tool: "ts_ask",
    battery: typeof options.battery === "string" ? options.battery : null,
    depth,
    lang: typeof options.lang === "string" ? options.lang : "auto",
  };

  // (d) recursion guard — hard error, dispatch pipeline must never nest
  if (depth > 0)
    throw new Error("ts_ask recursion guard: depth>0 — the dispatch pipeline must not be nested. Subagents must NOT call ts_ask/ts_decide; only the main agent runs the battery.");

  const degraded = (reason, extra = {}) => {
    appendLedger(cfg.ledgerDir, {
      ts: new Date().toISOString(), call_id: newCallId(), ...base,
      mode: "degraded", model: null, error: reason, ...extra,
    });
    return { mode: "degraded", reason, ...extra };
  };

  // (a) key present? — never call the API without it
  if (!cfg.key) return degraded("no_key");
  // (b) daily budget guard
  const u = todayUsage(cfg.ledgerDir);
  if (u.total >= cfg.cap) return degraded("budget_capped", { today: u, cap: cfg.cap });
  // (c) circuit breaker (half_open probes are allowed through)
  if (breakerState().state === "open") return degraded("breaker_open", { breaker: breakerState() });

  // REDACTION before egress — counts only, never content
  const rState = redactDeep(state, cfg.patterns.redaction);
  const rQuestions = redactDeep(questions, cfg.patterns.redaction);
  const redactions = rState.count + rQuestions.count;
  const state_bytes = byteLen(rState.value);
  const questions_hash = sha256(canonicalJson(questions)); // template-drift detection
  const call_id = newCallId();

  // same-payload re-ask dedupe (v1.5.1): sessions showed an ask→schema-reject→re-ask
  // handshake re-sending identical payloads 12–27s apart. Key = state+questions BOTH —
  // hashing questions alone would wrongly cache fixed-question/different-state batteries (judge).
  const dedupeKey = sha256(canonicalJson({ model: cfg.model, url: cfg.url, state: rState.value, questions: rQuestions.value }));
  const hit = dedupeRead()[dedupeKey];
  if (hit && Date.now() - hit.at < DEDUPE_TTL_MS) {
    appendLedger(cfg.ledgerDir, {
      ts: new Date().toISOString(), call_id: newCallId(), ...base,
      mode: "normal", model: hit.result.model, questions_hash, state_bytes, redactions, cached: true,
    });
    return { ...hit.result, cached: true };
  }

  const t0 = Date.now();
  const res = await callSystemOne(cfg, rState.value, rQuestions.value);
  const latency_ms = Date.now() - t0;

  if (!res.ok) {
    if (res.kind === "validation")
      throw new Error(`TypeSafe 422 validation (caller bug — fix the request body): ${res.detail}`);
    if (res.kind === "auth")
      throw new Error(`TypeSafe 401: bad API key (check TYPESAFE_API_KEY): ${res.detail}`);
    // transient service failure → breaker + degraded (v1.5.2: keep the response detail so
    // mystery 4xx/5xx bodies are diagnosable from the ledger instead of just "http 400")
    recordFailure();
    const detail = String(res.detail ?? "").slice(0, 200);
    appendLedger(cfg.ledgerDir, {
      ts: new Date().toISOString(), call_id, ...base,
      mode: "degraded", model: cfg.model, error: `${res.kind}${res.status ? ` ${res.status}` : ""}`,
      detail: detail || undefined,
      questions_hash, state_bytes, redactions, latency_ms,
    });
    return { mode: "degraded", reason: res.kind, status: res.status ?? null, detail: detail || undefined, latency_ms, redactions, call_id };
  }

  recordSuccess();
  const usage = res.usage ?? { input_tokens: 0, output_tokens: 0 };
  appendLedger(cfg.ledgerDir, {
    ts: new Date().toISOString(), call_id, ...base,
    mode: "normal", model: res.model, questions_hash, state_bytes, redactions,
    answers_summary: summarizeAnswers(res.answers), usage, latency_ms,
  });
  dedupePut(dedupeKey, { mode: "normal", model: res.model, answers: res.answers, usage, latency_ms, redactions, call_id });
  return { mode: "normal", model: res.model, answers: res.answers, usage, latency_ms, redactions, call_id };
}

export const DEFAULT_POLICY = {
  choice: { auto_min: 0.75, escalate_below: 0.5 },
  noul: { yes_min: 0.8, no_max: 0.2, escalate_lo: 0.35, escalate_hi: 0.65 },
};

export function tsDecide(args, cfg = loadConfig()) {
  const answers = args?.answers;
  if (!answers || typeof answers !== "object" || Array.isArray(answers) || !Object.keys(answers).length)
    throw new Error("ts_decide: answers object required (the answers field from ts_ask)");
  const p = args.policy ?? {};
  const policy = {
    choice: { ...DEFAULT_POLICY.choice, ...(p.choice ?? {}) },
    noul: { ...DEFAULT_POLICY.noul, ...(p.noul ?? {}) },
    per_question: p.per_question ?? {},
  };

  const per_question = {};
  let grade = "auto";
  const bump = (g) => { if (g === "escalate" || (g === "flagged" && grade === "auto")) grade = g; };

  for (const [id, a] of Object.entries(answers)) {
    const ov = policy.per_question[id] ?? {};
    const pc = { ...policy.choice, ...(ov.choice ?? {}) };
    const pn = { ...policy.noul, ...(ov.noul ?? {}) };
    let rec;
    if (a && typeof a === "object" && typeof a.noul === "number") {
      const v = a.noul;
      let band;
      if (v >= pn.yes_min) band = "yes";
      else if (v <= pn.no_max) band = "no";
      else if (v >= pn.escalate_lo && v <= pn.escalate_hi) band = "escalate"; // deadband: can't tell
      else band = v > pn.escalate_hi ? "flagged_yes" : "flagged_no";
      rec = { band, value: v };
      bump(band === "escalate" ? "escalate" : band.startsWith("flagged") ? "flagged" : "auto");
    } else {
      const v = a && typeof a === "object" && typeof a.confidence === "number" ? a.confidence : null;
      if (v === null) {
        rec = { band: "escalate", value: null, note: "no numeric confidence/noul — conservative escalate" };
        bump("escalate");
      } else {
        const band = v >= pc.auto_min ? "auto" : v >= pc.escalate_below ? "flagged" : "escalate";
        rec = { band, value: v, confidence: v };
        bump(band);
      }
    }
    per_question[id] = rec;
  }

  const log_record = {
    ts: new Date().toISOString(), call_id: newCallId(), tool: "ts_decide",
    mode: "normal", decision: grade,
    per_question: Object.fromEntries(Object.entries(per_question).map(([id, r]) => [id, r.band])),
  };
  appendLedger(cfg.ledgerDir, log_record);
  return { decision: grade, per_question, log_record };
}

export function tsSafety(args, cfg = loadConfig()) {
  const text = args?.text;
  if (typeof text !== "string" || !text) throw new Error("ts_safety: text string required");
  const matched = cfg.patterns.destructive.filter((r) => r.re.test(text)).map((r) => r.name);
  appendLedger(cfg.ledgerDir, {
    ts: new Date().toISOString(), call_id: newCallId(), tool: "ts_safety", mode: "normal",
    destructive: matched.length > 0, matched: matched.slice(0, 5),
  }); // zero-cost tool, but audits need the trace (v1.5.1)
  return {
    destructive: matched.length > 0,
    matched,
    note: "Advisory TS risk judgments never authorize destructive ops; destructive + not user-confirmed → always ask user.",
  };
}

function commandOnPath(cmd) {
  const dirs = (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":").filter(Boolean);
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      try { if (fs.existsSync(path.join(dir, cmd + ext))) return true; } catch { /* skip */ }
    }
  }
  return false;
}

export function tsFeasible(args = {}, cfg = loadConfig()) {
  let registry = args.executors;
  if (!registry) {
    try {
      registry = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "executors.json"), "utf8")).executors;
    } catch (e) {
      throw new Error(`ts_feasible: no executors arg and executors.json unreadable (looked in ${DATA_DIR}): ${e.message}`);
    }
  }
  if (!Array.isArray(registry) || !registry.length) throw new Error("ts_feasible: executors must be a non-empty array");
  // trust routing (v1.6.0, doc §IX): task data_class X may only run on executors whose
  // data_class clearance >= X. open(0) < standard(1) < restricted(2). No data_class arg → no filter
  // (backwards compatible). Executor without data_class = open (safest assumption).
  const CLASS_RANK = { open: 0, standard: 1, restricted: 2 };
  const taskClass = args.options?.data_class ? CLASS_RANK[args.options.data_class] : undefined;
  if (args.options?.data_class !== undefined && taskClass === undefined)
    throw new Error(`ts_feasible: unknown data_class "${args.options.data_class}" (open|standard|restricted)`);
  const feasible = [], infeasible = [];
  for (const e of registry) {
    if (!e || typeof e !== "object" || !e.id) continue; // skip doc/pseudo entries
    const reasons = [];
    if (taskClass !== undefined && (CLASS_RANK[e.data_class] ?? 0) < taskClass)
      reasons.push(`data_class: executor clearance ${e.data_class ?? "open(assumed)"} < task ${args.options.data_class}`);
    for (const v of e.requires?.env ?? []) {
      // executor keys may live in the environment or in this server's .env
      if (!process.env[v] && !dotenv()[v]) reasons.push(`missing env: ${v}`);
    }
    for (const c of e.requires?.command ?? []) {
      if (!commandOnPath(c)) reasons.push(`command not found on PATH: ${c}`);
    }
    if (reasons.length) infeasible.push({ id: e.id, reason: reasons.join("; ") });
    else feasible.push(e.id);
  }
  appendLedger(cfg.ledgerDir, {
    ts: new Date().toISOString(), call_id: newCallId(), tool: "ts_feasible", mode: "normal",
    data_class: args.options?.data_class ?? null,
    feasible, infeasible: infeasible.map((i) => i.id),
  }); // zero-cost tool, but audits need the trace (v1.5.1)
  return { feasible, infeasible };
}

// ------------------------------------------------------------------ skill catalog + skill suggestion (v1.4.0)
// Two-stage progressive disclosure (official skill_suggestion cookbook + win4r/jev-skill-suggester):
// stage 1 ranks the WHOLE roster in one Choice (probability distribution = ranking) + needs_skill Noul;
// stage 2 re-judges the top-k with body excerpts, and may reject all candidates.
const SKILL_CATALOG_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return { name: null, description: "", excerpt: text.trim().slice(0, 400) };
  let name = null, description = "", key = null, buf = [];
  const flush = () => { if (key === "description") description = buf.join(" ").trim(); };
  for (const line of m[1].split(/\r?\n/)) {
    const km = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (km) {
      flush();
      key = km[1];
      const v = km[2].trim();
      buf = v && v !== ">" && v !== "|" && v !== "{}" ? [v] : [];
      if (km[1] === "name" && v) name = v;
    } else if (key && /^\s+\S/.test(line)) buf.push(line.trim());
  }
  flush();
  return {
    name,
    description: description.replace(/\s+/g, " ").slice(0, 160),
    excerpt: text.slice(m[0].length).trim().slice(0, 400),
  };
}

function walkSkillDir(dir, out, depth = 0, visited = new Set()) {
  let real;
  try { real = fs.realpathSync(dir); } catch { return; }
  if (visited.has(real)) return; // symlink cycles (gstack junctions)
  visited.add(real);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
    try {
      const fm = parseFrontmatter(fs.readFileSync(path.join(dir, "SKILL.md"), "utf8"));
      const id = path.basename(dir);
      out.push({ id, name: fm.name || id, description: fm.description, excerpt: fm.excerpt, path: path.join(dir, "SKILL.md") });
    } catch { /* unreadable skill — skip */ }
    return;
  }
  if (depth >= 2) return;
  for (const e of entries) {
    // Windows junctions/symlinks (gstack skills) report as symbolic links, not dirs — follow both
    if ((e.isDirectory() || e.isSymbolicLink()) && !e.name.includes(".bak") && !e.name.startsWith(".")) {
      walkSkillDir(path.join(dir, e.name), out, depth + 1, visited);
    }
  }
}

export function skillCatalog(force = false) {
  const file = path.join(DATA_DIR, "skills-index.json");
  if (!force) {
    try {
      const st = fs.statSync(file);
      if (Date.now() - st.mtimeMs < SKILL_CATALOG_MAX_AGE_MS) return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch { /* rebuild */ }
  }
  const roots = [path.join(os.homedir(), ".zcode", "skills"), path.join(os.homedir(), ".agents", "skills")];
  const seen = new Set(), skills = [];
  for (const root of roots) {
    const found = [];
    walkSkillDir(root, found);
    for (const s of found) if (!seen.has(s.id)) { seen.add(s.id); skills.push(s); }
  }
  const index = { builtAt: new Date().toISOString(), count: skills.length, roots, skills };
  try { fs.writeFileSync(file, JSON.stringify(index, null, 2)); } catch (e) { log(`skills-index write failed: ${e.message}`); }
  return index;
}

function loadSkillExcludes() {
  try { return new Set(JSON.parse(fs.readFileSync(path.join(DATA_DIR, "skills-exclude.json"), "utf8")).excluded ?? []); }
  catch { return new Set(); }
}

export async function tsSuggestSkill(args, cfg = loadConfig()) {
  const task = String(args?.task ?? "").trim();
  if (!task) throw new Error("ts_suggest_skill: task string required");
  const opt = args?.options ?? {};

  // user-named skill → local lookup, ZERO API calls (require beats excludes: the boss spoke)
  if (opt.require) {
    const cat = skillCatalog();
    const hit = cat.skills.find((s) => s.id === opt.require || s.name === opt.require);
    return {
      mode: "normal", via: "require", api_calls: 0,
      skill: hit ? { id: hit.id, name: hit.name, path: hit.path } : null,
      reason: hit ? "user-named skill resolved by local catalog lookup (no API)" : `named skill "${opt.require}" not in catalog`,
    };
  }

  const cat = skillCatalog();
  const excl = new Set([...loadSkillExcludes(), ...(opt.exclude ?? [])]);
  let roster = cat.skills.filter((s) => !excl.has(s.id) && !excl.has(s.name));
  if (opt.allow?.length) roster = roster.filter((s) => opt.allow.includes(s.id) || opt.allow.includes(s.name));
  if (!roster.length) return { mode: "normal", skill: null, api_calls: 0, reason: "roster empty after excludes/allowlist" };
  const topK = Math.min(Math.max(1, Number(opt.top_k) || 3), Math.min(3, roster.length));
  const lang = /[\u4e00-\u9fff]/.test(task) ? "cjk" : "en";

  // Stage 1 — rank the whole roster in ONE call (Choice distribution = ranking) + needs_skill Noul
  const s1 = await tsAsk({
    state: { task, skills: roster.map((s) => ({ id: s.id, name: s.name, description: s.description })) },
    questions: {
      rank: {
        type: "choice",
        instructions: "Which of `state.skills` is the single best first-load skill for the task in `state.task`? Judge by each skill's `description`. The probability distribution is reused as a ranking.",
        criteria: Object.fromEntries(roster.map((s) => [s.id, s.description || s.name])),
      },
      needs_skill: {
        type: "noul",
        instructions: "true if this task would genuinely benefit from loading one of the listed skills' playbooks first; false if none is relevant (plain translation, small talk, tasks no listed skill covers) and doing it directly is best.",
      },
    },
    options: { battery: "skill-suggest-rank", lang },
  }, cfg);
  if (s1.mode !== "normal") return { mode: "degraded", reason: s1.reason ?? s1.error, skill: null, api_calls: 1 };

  const probs = s1.answers.rank?.probabilities ?? {};
  const ranked = roster.map((s) => ({ s, p: probs[s.id] ?? 0 })).sort((a, b) => b.p - a.p);
  const needsSkill = s1.answers.needs_skill?.noul ?? 0.5;
  const rankingTop = ranked.slice(0, topK).map((r) => ({ id: r.s.id, p: +r.p.toFixed(3) }));
  const top = ranked.slice(0, topK).map((r) => r.s);

  // Stage 2 — re-judge top-k with excerpts; may reject all (doc-sanctioned second request)
  const s2 = await tsAsk({
    state: { task, candidates: top.map((s) => ({ id: s.id, name: s.name, description: s.description, instructions_opening: s.excerpt })) },
    questions: {
      final: {
        type: "choice",
        instructions: "Which candidate skill (if any) should be loaded FIRST for `state.task`? Read each candidate's full `description` and `instructions_opening`. 'none' is a fully valid answer — never force a skill that does not fit.",
        criteria: { ...Object.fromEntries(top.map((s) => [s.id, s.description || s.name])), none: "No candidate truly fits; do the task directly." },
      },
      ...Object.fromEntries(top.map((s) => [`fit_${s.id}`, {
        type: "noul",
        instructions: `true if loading skill \`${s.name}\` first would clearly help complete \`state.task\` (its description and instructions opening match the task's needs), false otherwise.`,
      }])),
    },
    options: { battery: "skill-suggest-verify", lang },
  }, cfg);
  if (s2.mode !== "normal") return { mode: "degraded", reason: s2.reason ?? s2.error, skill: null, api_calls: 2, ranking_top: rankingTop };

  const choice = s2.answers.final?.choice ?? "none";
  const conf = s2.answers.final?.confidence ?? 0;
  // fit-led recommendation (measured 2026-09-20: rosters with several plausible generic skills
  // split the Choice distribution ~evenly, so confidence can never clear a hard gate — docs:
  // "low confidence need not invalidate a harmless preference choice"). Confidence is kept as a
  // near-tie signal only: winner by fit; if runner-up is within 0.10 fit AND conf < 0.65, surface
  // the tie instead of hiding it (the dispatch soft-line already says "ignore if it doesn't fit").
  const fits = top
    .map((s) => ({ id: s.id, fit: s2.answers[`fit_${s.id}`]?.noul ?? 0 }))
    .sort((a, b) => b.fit - a.fit);
  let skill = null, fit = null, nearTie = null, reason;
  if (choice === "none") {
    reason = "stage-2 rejected all candidates";
  } else {
    const best = fits[0], runner = fits[1];
    if (best.fit >= 0.8) {
      const s = top.find((x) => x.id === best.id);
      skill = { id: s.id, name: s.name, path: s.path };
      fit = best.fit;
      if (runner && best.fit - runner.fit <= 0.1 && conf < 0.65) {
        nearTie = runner.id;
        reason = `fit-led pick ${s.id} (fit ${best.fit.toFixed(2)}); near tie with ${runner.id} (fit ${runner.fit.toFixed(2)}, choice conf ${conf.toFixed(2)}) — soft-line allows the agent to ignore`;
      } else {
        reason = `fit ${best.fit.toFixed(2)} ≥ 0.80, choice ${choice} (conf ${conf.toFixed(2)})`;
      }
    } else {
      reason = `best candidate fit ${best.fit.toFixed(2)} < 0.80 (choice was ${choice})`;
    }
  }
  return {
    mode: "normal", skill, fit: fit === null ? null : +fit.toFixed(2), confidence: +conf.toFixed(2),
    needs_skill: +needsSkill.toFixed(2), ranking_top: rankingTop, candidates_fit: fits.map((f) => ({ id: f.id, fit: +f.fit.toFixed(2) })),
    near_tie: nearTie, api_calls: 2,
    usage: { rank: s1.usage, verify: s2.usage }, latency_ms: (s1.latency_ms ?? 0) + (s2.latency_ms ?? 0), reason,
  };
}

// ------------------------------------------------------------------ guard judge (one-call B-path verdict, v1.5.0)
// ZCode confirmed (2026-09-20 probe + 2026-09-21 full retest with spec queued) that user-level
// PreToolUse hooks DO NOT fire for subagent tool calls — the A-path hook stays shipped for
// Claude Code, but on ZCode mid-work review runs through the B-path monitor loop. This helper
// makes each poll verdict ONE call instead of a hand-assembled ask+decide.
export async function tsJudgeAction(args, cfg = loadConfig()) {
  const spec = String(args?.spec ?? "").trim();
  const action = String(args?.action ?? "").trim();
  const tool = String(args?.tool ?? "action");
  if (!spec || !action) throw new Error("ts_judge_action: spec and action strings required");
  const r = await tsAsk({
    state: { task_spec: spec, proposed_action: { tool, detail: action.slice(0, 600) } },
    questions: {
      on_spec: {
        type: "noul",
        instructions: "`state.task_spec` is the subagent's task spec; `state.proposed_action` is the action it is about to take (or just took). true = the action directly serves the spec, INCLUDING preparatory or exploratory steps clearly within scope; false = unrelated, off-topic, or outside the spec's stated scope.",
        criteria: { true: "serves the spec, directly or as a clear preparatory step within scope", false: "unrelated/off-topic/out of the spec's stated scope" },
      },
      reversible: {
        type: "noul",
        instructions: "false = the action is hard to undo (mass rewrite, deleting existing content, external side effects); true = easily undone if wrong.",
        criteria: { true: "reversible/low consequence", false: "hard to undo / large consequence" },
      },
    },
    options: { battery: "guard-judge", lang: /[\u4e00-\u9fff]/.test(spec + action) ? "cjk" : "en" },
  }, cfg);
  if (r.mode !== "normal") return { mode: "degraded", reason: r.reason ?? r.error, verdict: "inspect", directive: "Pause monitored work: Jev is unavailable. Parent inspection is required; this is not approval to proceed." };
  const onSpec = r.answers.on_spec?.noul ?? 0.5;
  const reversible = r.answers.reversible?.noul ?? 0.5;
  // same bands as ts_decide defaults: ≤0.35 off-spec, ≥0.65 on-spec, between = deadband
  const verdict = onSpec <= 0.35 ? "correct" : onSpec >= 0.65 ? "proceed" : "inspect";
  return {
    mode: "normal", verdict, directive:
      verdict === "correct" ? `STOP the subagent and send a correction (off-spec ${onSpec.toFixed(2)}${reversible < 0.4 ? ", hard to undo" : ""})`
      : verdict === "inspect" ? `Deadband (${onSpec.toFixed(2)}) — look at the action yourself before deciding`
      : "Let it continue",
    on_spec: +onSpec.toFixed(2), reversible: +reversible.toFixed(2), usage: r.usage, latency_ms: r.latency_ms, call_id: r.call_id,
  };
}

// ------------------------------------------------------------------ MCP plumbing (house pattern)
const TOOLS = [
  {
    name: "ts_ping",
    description: "Health check (no API call, no cost): has_key, model, today's token usage vs daily cap, circuit-breaker state, server time.",
    inputSchema: { type: "object", properties: {} },
    run: () => tsPing(),
  },
  {
    name: "ts_ask",
    description: "THE one generic batched TypeSafe System One ask. state (string|object|array, bounded context — NOT whole repo) + questions {id:{type:'choice'|'noul'|'score', instructions, criteria}}. Pre-flight order: no_key → budget_capped → breaker_open all return {mode:'degraded',reason} without calling the API; depth>0 is REJECTED (dispatch pipeline must not be nested — subagents must not call ts_ask). Secrets are redacted before egress (count only, never logged). 429/529 retried with backoff; 422 surfaces the validation body (caller bug). Appends a ledger line: hashes/counts only, never content.",
    inputSchema: {
      type: "object",
      properties: {
        state: { type: ["string", "object", "array"], description: "bounded task context: cwd, task spec, relevant file list (32k budget shared with questions)" },
        questions: { type: "object", description: "{ <id>: { type: 'choice'|'noul'|'score', instructions: string|object, criteria } } — choice criteria: option→description map (ALWAYS include an 'other' escape); score criteria: ordered array of ≥2 concrete level descriptions; noul criteria: optional {true,false}" },
        options: {
          type: "object",
          properties: {
            battery: { type: "string", description: "label for the ledger, e.g. 'battery1-dispatch'" },
            depth: { type: "integer", description: "must be 0 — recursion guard rejects depth>0" },
            lang: { type: "string", enum: ["auto", "en", "cjk"], description: "state language marker, logged for variance analysis" },
          },
        },
      },
      required: ["state", "questions"],
    },
    run: (a) => tsAsk(a),
  },
  {
    name: "ts_decide",
    description: "Deterministic threshold evaluation of ts_ask answers — THE enforcement point (the skill only supplies semantics). choice/score confidence: ≥0.75 auto, 0.5–0.75 flagged, <0.5 escalate. noul probability: ≥0.8 yes, ≤0.2 no, 0.35–0.65 escalate (deadband: can't tell), else flagged_yes/flagged_no. policy arg overrides per-kind or per-question (per_question: {id:{choice:…}|{noul:…}}). Appends the decision to the ledger. No API call.",
    inputSchema: {
      type: "object",
      properties: {
        answers: { type: "object", description: "the answers object from ts_ask: { id: {choice,confidence}|{score,confidence}|{noul} }" },
        policy: {
          type: "object",
          description: "optional threshold overrides: { choice:{auto_min,escalate_below}, noul:{yes_min,no_max,escalate_lo,escalate_hi}, per_question:{ <id>:{choice?|noul?} } }",
        },
      },
      required: ["answers"],
    },
    run: (a) => tsDecide(a),
  },
  {
    name: "ts_safety",
    description: "P0 #1: destructive-op detection is DETERMINISTIC code (patterns.json), never TypeSafe. Detects rm -rf, force push, git reset --hard, DROP TABLE, --purge, mkfs, Remove-Item -Recurse -Force, pipe-to-shell, etc. destructive + not user-confirmed → ALWAYS ask the user; TS risk judgments never authorize anything.",
    inputSchema: { type: "object", properties: { text: { type: "string", description: "command/plan text to scan" } }, required: ["text"] },
    run: (a) => tsSafety(a),
  },
  {
    name: "ts_feasible",
    description: "P0 #2: pre-filter the executor registry (executors.json, or pass an array) by HARD availability — requires.env vars set, requires.command found on PATH — so TypeSafe Choice only ever chooses among feasible executors. v1.6.0 trust routing: options.data_class (open|standard|restricted) additionally drops executors whose data_class clearance is below the task's sensitivity (secrets/.env/infra tasks → restricted → first-party lanes only). Hard code check > TS judgment. Returns {feasible:[ids], infeasible:[{id,reason}]}.",
    inputSchema: {
      type: "object",
      properties: {
        executors: { type: "array", description: "optional registry array; default reads executors.json" },
        options: {
          type: "object",
          properties: { data_class: { type: "string", enum: ["open", "standard", "restricted"], description: "most sensitive data the task will touch; filters executors by clearance" } },
        },
      },
    },
    run: (a) => tsFeasible(a),
  },
  {
    name: "ts_suggest_skill",
    description: "v1.4.0 skill-suggestion, two TypeSafe requests (cookbook pattern): (1) rank the WHOLE local skill catalog in one Choice (distribution = ranking) + needs_skill Noul; (2) re-judge the top-3 with SKILL.md excerpts, may reject all. Recommends at most ONE skill, only when fit ≥ 0.80 AND final confidence ≥ 0.65; 'no skill' is a first-class answer. options.require = user-named skill → local lookup, ZERO API. options.allow/exclude filter the roster; skills-exclude.json in DATA_DIR persists exclusions (excluded skills are still reachable via require).",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "the task text the dispatched subagent will execute" },
        options: {
          type: "object",
          properties: {
            require: { type: "string", description: "user explicitly named this skill — resolve locally, no API" },
            allow: { type: "array", items: { type: "string" }, description: "restrict candidates to these skill ids/names" },
            exclude: { type: "array", items: { type: "string" }, description: "drop these ids/names for this call" },
            top_k: { type: "integer", description: "candidates re-judged in stage 2 (default 3, max 3)" },
          },
        },
      },
      required: ["task"],
    },
    run: (a) => tsSuggestSkill(a),
  },
];

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") {
    return send({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: NAME, version: VERSION } } });
  }
  if (typeof method === "string" && method.startsWith("notifications/")) return;
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") {
    return send({ jsonrpc: "2.0", id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
  }
  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `unknown tool: ${params?.name}` }], isError: true } });
    try {
      const text = JSON.stringify(await tool.run(params.arguments ?? {}));
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (e) {
      return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `❌ ${e?.message ?? e}` }], isError: true } });
    }
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
}

// Compare as OS paths, not as URLs (Windows drive-letter case differs).
const IS_MAIN = process.argv[1] ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) : false;

function startServer() {
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    handle(msg).catch((e) => log(`handler: ${e?.message ?? e}`));
  });
  log(`started — data_dir=${DATA_DIR} key=${resolveApiKey() ? "resolved" : "MISSING (ts_ask will degrade with no_key)"} model=${loadConfig().model} ledger=${loadConfig().ledgerDir}`);
}

if (IS_MAIN) startServer();

export { TOOLS, handle, send, log };
