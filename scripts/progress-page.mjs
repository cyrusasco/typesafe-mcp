#!/usr/bin/env node
/**
 * progress-page.mjs — render today's ledger to a static HTML progress page
 * (doc §X pattern: phone-checkable progress during long multi-agent runs).
 *
 *   node scripts/progress-page.mjs            # writes DATA_DIR/progress.html
 *
 * Read-only over the ledger; the page auto-refreshes every 15s while open.
 */
import fs from "node:fs";
import path from "node:path";
import { readLedgerToday, loadConfig } from "../plugin/server.mjs";

const cfg = loadConfig();
const rows = readLedgerToday(cfg.ledgerDir);
const asks = rows.filter((r) => r.tool === "ts_ask");
const decides = rows.filter((r) => r.tool === "ts_decide");
const tok = asks.reduce((a, r) => a + (r.usage?.input_tokens ?? 0) + (r.usage?.output_tokens ?? 0), 0);
const degraded = asks.filter((r) => r.mode === "degraded").length;
const cached = asks.filter((r) => r.cached).length;
const guardRows = asks.filter((r) => /guard|judge/.test(String(r.battery)));
const corrections = guardRows.filter((r) => {
  const s = r.answers_summary ?? {};
  return Object.values(s).some((v) => typeof v?.noul === "number" && v.noul <= 0.35);
}).length;
const decisionHisto = decides.reduce((a, r) => { a[r.decision] = (a[r.decision] ?? 0) + 1; return a; }, {});

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const line = (r) => {
  const summ = r.answers_summary ? Object.entries(r.answers_summary).map(([k, v]) =>
    `${k}=${v.choice ?? v.score ?? v.noul ?? "?"}${v.confidence !== undefined && v.confidence !== null ? "(" + v.confidence + ")" : ""}`).join(" ") : "";
  return `<tr class="${r.mode}"><td>${esc((r.ts ?? "").slice(11, 19))}</td><td>${esc(r.battery ?? r.tool)}</td><td>${esc(r.mode)}${r.cached ? "·cached" : ""}${r.detail ? "·" + esc(r.detail.slice(0, 40)) : ""}</td><td>${esc(summ).slice(0, 120)}</td><td>${r.usage ? (r.usage.input_tokens + r.usage.output_tokens) : 0}</td><td>${r.latency_ms ?? "-"}</td></tr>`;
};

const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="15"><title>typesafe-mcp progress</title><style>
body{font-family:Segoe UI,Arial,sans-serif;margin:24px;background:#f8fafc;color:#0f172a}
h1{font-size:20px;margin:0 0 4px}.sub{color:#64748b;font-size:12px;margin-bottom:16px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin-bottom:18px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:10px 16px;min-width:110px}
.card b{display:block;font-size:22px}.card span{font-size:11px;color:#64748b}
table{border-collapse:collapse;width:100%;background:#fff;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden}
th{background:#f1f5f9;font-size:11px;text-align:left;padding:6px 10px;color:#475569}
td{font-size:12px;padding:5px 10px;border-top:1px solid #f1f5f9}
tr.degraded td{background:#fef3c7}
</style></head><body>
<h1>typesafe-mcp — today's judgments</h1>
<div class="sub">${new Date().toISOString()} · auto-refresh 15s · ledger: ${esc(cfg.ledgerDir)}</div>
<div class="cards">
<div class="card"><b>${asks.length}</b><span>ts_ask calls</span></div>
<div class="card"><b>${tok.toLocaleString()}</b><span>TS tokens</span></div>
<div class="card"><b>${degraded}</b><span>degraded</span></div>
<div class="card"><b>${cached}</b><span>cache hits</span></div>
<div class="card"><b>${corrections}</b><span>guard corrections</span></div>
<div class="card"><b>${esc(Object.entries(decisionHisto).map(([k, v]) => k + ":" + v).join(" ") || "-")}</b><span>decisions</span></div>
</div>
<table><tr><th>time</th><th>battery</th><th>mode</th><th>answers</th><th>tok</th><th>ms</th></tr>
${rows.filter((r) => r.tool === "ts_ask").reverse().map(line).join("\n")}
</table></body></html>`;

const out = path.join(cfg.ledgerDir, "..", "progress.html");
fs.writeFileSync(out, html);
console.log(JSON.stringify({ written: out, asks: asks.length, tokens: tok, degraded, corrections, decisions: decisionHisto }));
