#!/usr/bin/env node
/**
 * guard-spec.mjs — subagent-guard 嘅 spec 管理 CLI。
 *
 *   node guard-spec.mjs push 'One-line English spec; scope: /only/this/dir'   # dispatch 前推入 FIFO
 *   node guard-spec.mjs push '{"spec":"...","constraints":["..."]}'           # 完整 JSON 都得
 *   node guard-spec.mjs clean                                                # 清走 >24h 嘅 state
 *
 * Spec 一律用英文寫(Jev English-primary;中文 spec 對英文 shell 動作會誤判)。
 * FIFO claim:第一個冇 spec 嘅 subagent session 攞第一條 —— 平行 dispatch 共用
 * 同一個總 spec 嗰陣啱用;精確分配用 set(要 agentId,background dispatch 先有)。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STATE_DIR = path.join(os.homedir(), ".zcode", "typesafe-state");
const PENDING = path.join(STATE_DIR, "pending-specs.json");
const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === "push") {
    const arg = rest.join(" ").trim();
    if (!arg) throw new Error("usage: guard-spec.mjs push '<spec string or json>'");
    let entry;
    try { entry = { strikes: 0, ...JSON.parse(arg) }; } catch { entry = { spec: arg, constraints: [], strikes: 0 }; }
    if (!entry.spec) throw new Error("entry needs a spec field");
    const q = JSON.parse(fs.readFileSync(PENDING, "utf8"));
    q.push(entry);
    fs.writeFileSync(PENDING, JSON.stringify(q));
    console.log(`pushed (queue depth ${q.length}): ${String(entry.spec).slice(0, 100)}`);
  } else if (cmd === "clean") {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let removed = 0;
    for (const f of fs.readdirSync(STATE_DIR)) {
      const p = path.join(STATE_DIR, f);
      if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p); removed++; }
    }
    console.log(`cleaned ${removed} stale file(s)`);
  } else {
    throw new Error("usage: guard-spec.mjs push '<spec>' | clean");
  }
} catch (e) {
  process.stderr.write(`guard-spec: ${e?.message ?? e}\n`);
  process.exit(1);
}
