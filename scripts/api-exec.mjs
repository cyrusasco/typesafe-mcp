#!/usr/bin/env node
/**
 * Explicit legacy API lane. Every request requires --data-class open|standard|restricted.
 * Checks executor clearance/availability, redacts payload strings, enforces the
 * configured daily budget and abort timeout before emitting any network request.
 * Callers must classify/minimize context first; redaction is defense in depth.
 * Native Codex agents/reviews belong to the Codex host adapter, not this script.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { loadConfig, appendLedger, tsFeasible, redactDeep } = await import(pathToFileURL(path.join(HERE, "..", "plugin", "server.mjs")).href);
const DEFAULT_SYSTEM = 'You are a reasoning executor dispatched by the typesafe-mcp pipeline. Read the task context and return ONLY a compact typed result in exactly this JSON shape: {"claims":[], "files":[], "verdict":""} — no prose narrative, no markdown fences.';
const args = process.argv.slice(2);
const [id, promptArg] = args;
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

// Reserve a conservative allowance before egress. A crash keeps the reservation;
// a stale lock fails closed instead of guessing that a prior request did not run.
// This serializes api-exec reservations, not unrelated legacy ts_ask processes.
function reserveBudget(cfg, record, inputEstimate, outputAllowance) {
  fs.mkdirSync(cfg.ledgerDir, { recursive: true });
  const lock = path.join(cfg.ledgerDir, ".api-exec-budget.lock");
  let descriptor;
  try { descriptor = fs.openSync(lock, "wx"); }
  catch { throw new Error("budget ledger busy or unavailable; inspect its ownership before retrying"); }
  try {
    const date = new Date();
    const day = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
    const file = path.join(cfg.ledgerDir, `${day}.jsonl`);
    let text = "";
    try { text = fs.readFileSync(file, "utf8"); } catch (e) { if (e.code !== "ENOENT") throw e; }
    let used = 0;
    for (const line of text.split(/\r?\n/).filter(Boolean)) {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid ledger entry");
      if (entry.usage) {
        const { input_tokens: input, output_tokens: output } = entry.usage;
        if (![input, output].every(v => Number.isFinite(v) && v >= 0)) throw new Error("invalid ledger token usage");
        used += input + output;
      }
    }
    if (used + inputEstimate + outputAllowance > cfg.cap) throw new Error("daily token budget insufficient for request plus output allowance");
    fs.appendFileSync(file, JSON.stringify({ ...record, mode: "reserved", usage: { input_tokens: inputEstimate, output_tokens: outputAllowance } }) + "\n", "utf8");
  } catch (e) { throw new Error(`budget ledger: ${e.message}`); }
  finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}

async function main() {
  if (!id || !promptArg) throw new Error("usage: api-exec.mjs <executorId> <prompt-file|-> --data-class open|standard|restricted [--model name] [--system-file f|--raw] [--timeout-ms n] [--max-output-tokens n]");
  const dataClass = flag("--data-class");
  if (!["open", "standard", "restricted"].includes(dataClass)) throw new Error("explicit --data-class open|standard|restricted required before egress");
  const cfg = loadConfig();
  const dataDir = path.dirname(cfg.ledgerDir);
  const reg = JSON.parse(fs.readFileSync(path.join(dataDir, "executors.json"), "utf8")).executors;
  const ex = reg.find((e) => e.id === id);
  if (!ex || ex.kind !== "api_exec") throw new Error(`"${id}" is not an api_exec executor`);
  const feasible = tsFeasible({ executors: [ex], options: { data_class: dataClass } }, cfg);
  if (!feasible.feasible.includes(id)) throw new Error(`executor infeasible: ${feasible.infeasible[0]?.reason ?? "unknown"}`);
  const api = ex.api ?? {};
  if (!["anthropic-messages", "openai-compatible"].includes(api.style)) throw new Error("unsupported API style");

  // Dedicated lane config only: no account/keyring or other products' settings reads.
  const dotEnvVal = (name) => {
    if (!name) return undefined;
    try {
      for (const line of fs.readFileSync(path.join(dataDir, ".env"), "utf8").split(/\r?\n/)) {
        const at = line.indexOf("=");
        if (at < 0 || line.slice(0, at).trim() !== name) continue;
        const value = line.slice(at + 1).trim();
        return /^(".*"|'.*')$/.test(value) ? value.slice(1, -1) : value;
      }
    } catch { /* absent dedicated config */ }
  };
  const envVal = (name) => name ? (process.env[name] || dotEnvVal(name)) : undefined;
  const apiKey = envVal(api.key_env);
  if (!apiKey) throw new Error(`${api.key_env} not set in this lane's environment/config`);
  const baseUrl = envVal(api.base_url_env) || api.base_url_default;
  if (!baseUrl) throw new Error(`no base_url for ${id}`);
  const parsedUrl = new URL(baseUrl);
  if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error("base_url must not include credentials, query or fragment");
  if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsedUrl.hostname))) throw new Error("API endpoint requires HTTPS or explicit loopback HTTP");
  const model = flag("--model") || api.model_name;
  if (!model) throw new Error("model required");
  const prompt = promptArg === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(promptArg, "utf8");
  if (!prompt.trim()) throw new Error("prompt required");
  const system = flag("--system-file") ? fs.readFileSync(flag("--system-file"), "utf8") : (args.includes("--raw") ? undefined : DEFAULT_SYSTEM);
  const timeoutMs = Number(flag("--timeout-ms") ?? cfg.timeoutMs);
  const maxOutput = Number(flag("--max-output-tokens") ?? 8192);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error("timeout-ms must be an integer from 1 to 120000");
  if (!Number.isInteger(maxOutput) || maxOutput < 1 || maxOutput > 32768) throw new Error("max-output-tokens must be an integer from 1 to 32768");
  const clean = redactDeep({ prompt, ...(system ? { system } : {}) }, cfg.patterns.redaction);
  // Conservative byte estimate; the ledger guard is not a billing quote.
  const inputUpperEstimate = Buffer.byteLength(JSON.stringify(clean.value), "utf8");
  if (api.context_limit_tokens && inputUpperEstimate + maxOutput > api.context_limit_tokens * 0.8) throw new Error("prompt plus output allowance exceeds 80% of executor context cap");
  const base = baseUrl.replace(/\/+$/, "");
  const anthropic = api.style === "anthropic-messages";
  const url = anthropic ? `${base}/v1/messages` : (/\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`);
  const messages = [
    ...(!anthropic && clean.value.system ? [{ role: "system", content: clean.value.system }] : []),
    { role: "user", content: clean.value.prompt },
  ];
  const payload = { model, max_tokens: maxOutput, messages, ...(anthropic && clean.value.system ? { system: clean.value.system } : {}) };
  const started = Date.now();
  const record = { ts: new Date().toISOString(), call_id: `apx_${Date.now().toString(36)}_${process.pid}`, tool: "api_exec", battery: `api-exec-${id}`, model, data_class: dataClass, redactions: clean.count, state_bytes: Buffer.byteLength(JSON.stringify(payload)) };
  reserveBudget(cfg, record, inputUpperEstimate, maxOutput);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST", signal: controller.signal, redirect: "error",
      headers: anthropic ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" } : { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    // Provider error bodies may contain supplied data or keys: never echo them.
    if (!response.ok) throw new Error(`provider HTTP ${response.status}`);
    const reply = JSON.parse(await response.text());
    const text = anthropic ? (reply.content ?? []).filter(c => c.type === "text").map(c => c.text).join("\n") : reply.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) throw new Error("provider response missing text");
    const input = anthropic ? reply.usage?.input_tokens : reply.usage?.prompt_tokens;
    const output = anthropic ? reply.usage?.output_tokens : reply.usage?.completion_tokens;
    const usage = { input_tokens: Number.isFinite(input) && input >= 0 ? input : inputUpperEstimate, output_tokens: Number.isFinite(output) && output >= 0 ? output : maxOutput };
    appendLedger(cfg.ledgerDir, { ...record, mode: "normal", actual_usage: usage, budget_accounting: "pre-egress-reservation-retained", latency_ms: Date.now() - started });
    process.stdout.write(text + "\n");
    process.stderr.write(`[api-exec] ${id}/${model} ${Date.now() - started}ms ${JSON.stringify(usage)}\n`);
  } catch (e) {
    appendLedger(cfg.ledgerDir, { ...record, mode: "degraded", error: controller.signal.aborted ? "timeout" : "provider_failure", budget_accounting: "pre-egress-reservation-retained", latency_ms: Date.now() - started });
    throw new Error(controller.signal.aborted ? "request aborted or timed out" : (/^provider HTTP \d+$/.test(e.message) ? e.message : "provider request failed or response invalid"));
  } finally { clearTimeout(timer); }
}

try { await main(); }
catch (e) { process.stderr.write(`api-exec: ${e.message}\n`); process.exitCode = 1; }
