#!/usr/bin/env node
/**
 * api-exec.mjs — one-command invoke for api_exec lanes (v1.7.0).
 *
 *   node scripts/api-exec.mjs <executorId> <prompt-file|-> [--model name] [--system-file f] [--raw]
 *
 * Reads the executor's api spec from executors.json (style/base_url/key_env/model),
 * wraps the prompt in the purpose-built protocol by default (§2.8: return ONLY a
 * compact typed result — claims[]/files[]/verdict, no prose; --raw skips the wrapper),
 * calls the endpoint (anthropic-messages or openai-compatible), prints the text,
 * and appends a ledger line (battery api-exec-<id>). Context cap from the registry
 * (qwen 256k): prompts estimated above the cap are refused before egress.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const server = await import(pathToFileURL(path.join(ROOT, "plugin", "server.mjs")).href);
const { loadConfig, appendLedger } = server;

const DEFAULT_SYSTEM = 'You are a reasoning executor dispatched by the typesafe-mcp pipeline. Read the task context and return ONLY a compact typed result in exactly this JSON shape: {"claims":[], "files":[], "verdict":""} — no prose narrative, no markdown fences.';

const args = process.argv.slice(2);
const [id, promptArg] = args;
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const raw = args.includes("--raw");

if (!id || !promptArg) {
  process.stderr.write("usage: api-exec.mjs <executorId> <prompt-file|-> [--model name] [--system-file f] [--raw]\n");
  process.exit(1);
}

const cfg = loadConfig();
const reg = JSON.parse(fs.readFileSync(path.join(path.dirname(cfg.ledgerDir), "executors.json"), "utf8")).executors;
const ex = reg.find((e) => e.id === id);
if (!ex || ex.kind !== "api_exec") { process.stderr.write(`api-exec: "${id}" is not an api_exec executor\n`); process.exit(1); }
const api = ex.api ?? {};
// key resolution: process.env → DATA_DIR/.env (inline dotenv parse)
const dotEnvVal = (n) => {
  try {
    for (const l of fs.readFileSync(path.join(path.dirname(cfg.ledgerDir), ".env"), "utf8").split(/\r?\n/)) {
      const m = new RegExp("^" + n + "=(.*)$").exec(l.trim());
      if (m) return m[1].trim();
    }
  } catch { /* none */ }
  return undefined;
};
const apiKey = process.env[api.key_env] || dotEnvVal(api.key_env);
if (!apiKey) { process.stderr.write(`api-exec: ${api.key_env} not set (env or typesafe-mcp/.env)\n`); process.exit(1); }
const baseUrl = dotEnvVal(api.base_url_env) || api.base_url_default;
if (!baseUrl) { process.stderr.write(`api-exec: no base_url for ${id}\n`); process.exit(1); }
const model = flag("--model") || api.model_name;
const prompt = promptArg === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(promptArg, "utf8");

// context cap guard (rough estimate ~3 chars/token)
const cap = api.context_limit_tokens;
if (cap && prompt.length / 3 > cap * 0.8) {
  process.stderr.write(`api-exec: prompt ~${Math.round(prompt.length / 3)} tokens exceeds 80% of the ${cap} context cap for ${id}\n`);
  process.exit(1);
}
const system = args.includes("--system-file") ? fs.readFileSync(flag("--system-file"), "utf8") : (raw ? undefined : DEFAULT_SYSTEM);

const t0 = Date.now();
let res, text = "", usage = null;
if (api.style === "anthropic-messages") {
  res = await fetch(baseUrl.replace(/\/+$/, "") + "/v1/messages", {
    method: "POST",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model, max_tokens: 8192, ...(system ? { system } : {}), messages: [{ role: "user", content: prompt }] }),
  });
  const body = await res.text();
  if (!res.ok) { process.stderr.write(`api-exec: HTTP ${res.status} — ${body.slice(0, 300)}\n`); process.exit(2); }
  const j = JSON.parse(body);
  text = (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  usage = { input_tokens: j.usage?.input_tokens ?? 0, output_tokens: j.usage?.output_tokens ?? 0 };
} else {
  // openai-compatible
  const base = baseUrl.replace(/\/+$/, "");
  const url = /\/v\d+$/.test(base) ? base + "/chat/completions" : base + "/v1/chat/completions";
  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: prompt });
  res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages }),
  });
  const body = await res.text();
  if (!res.ok) { process.stderr.write(`api-exec: HTTP ${res.status} — ${body.slice(0, 300)}\n`); process.exit(2); }
  const j = JSON.parse(body);
  text = j.choices?.[0]?.message?.content ?? "";
  usage = { input_tokens: j.usage?.prompt_tokens ?? 0, output_tokens: j.usage?.completion_tokens ?? 0 };
}
const latency_ms = Date.now() - t0;
appendLedger(cfg.ledgerDir, {
  ts: new Date().toISOString(), call_id: `apx_${Date.now().toString(36)}`, tool: "api_exec",
  battery: `api-exec-${id}`, mode: "normal", model, state_bytes: Buffer.byteLength(prompt), usage, latency_ms,
});
process.stdout.write(text + "\n");
process.stderr.write(`[api-exec] ${id}/${model} ${latency_ms}ms ${JSON.stringify(usage)}\n`);
