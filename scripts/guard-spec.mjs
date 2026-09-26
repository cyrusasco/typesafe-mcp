#!/usr/bin/env node
/**
 * guard-spec.mjs — subagent-guard 嘅 spec 管理 CLI。
 *
 *   node guard-spec.mjs push 'One-line English spec; scope: /only/this/dir'   # dispatch 前推入 FIFO
 *   node guard-spec.mjs push '{"spec":"...","constraints":["..."]}'           # 完整 JSON 都得
 *   node guard-spec.mjs set <agentId> '<spec string or json>'                 # explicit binding
 *   node guard-spec.mjs clean                                                # 清走 >24h 嘅 state
 *
 * Spec 一律用英文寫(Jev English-primary;中文 spec 對英文 shell 動作會誤判)。
 * FIFO is a legacy sequential-dispatch compatibility path, not safe identity
 * binding for concurrent agents. Use explicit set; Codex uses its scoped adapter.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const STATE_DIR = path.join(os.homedir(), ".zcode", "typesafe-state");
const PENDING = path.join(STATE_DIR, "pending-specs.json");
const [cmd, ...rest] = process.argv.slice(2);
const entryFrom = (text) => {
  let entry;
  try { entry = JSON.parse(text); } catch { entry = { spec: text, constraints: [] }; }
  if (!entry || typeof entry !== "object" || typeof entry.spec !== "string" || !entry.spec.trim()) throw new Error("entry needs a non-empty spec string");
  if (entry.constraints !== undefined && (!Array.isArray(entry.constraints) || !entry.constraints.every(v => typeof v === "string"))) throw new Error("constraints must be strings");
  return { spec: entry.spec, constraints: entry.constraints ?? [], strikes: 0 };
};
const writeAtomic = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { flag: "wx" });
  try { fs.renameSync(tmp, file); } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
};

try {
  if (cmd === "push") {
    const arg = rest.join(" ").trim();
    if (!arg) throw new Error("usage: guard-spec.mjs push '<spec string or json>'");
    const entry = entryFrom(arg);
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const q = fs.existsSync(PENDING) ? JSON.parse(fs.readFileSync(PENDING, "utf8")) : [];
    if (!Array.isArray(q)) throw new Error("legacy queue must be an array");
    q.push(entry);
    writeAtomic(PENDING, q);
    console.log(`pushed (queue depth ${q.length}): ${String(entry.spec).slice(0, 100)}`);
  } else if (cmd === "set") {
    const [agentId, ...words] = rest;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(agentId ?? "")) throw new Error("agentId must be a safe explicit identifier");
    const entry = entryFrom(words.join(" ").trim());
    fs.mkdirSync(STATE_DIR, { recursive: true });
    writeAtomic(path.join(STATE_DIR, `spec-${agentId}.json`), { ...entry, agent_id: agentId });
    console.log(`bound spec to ${agentId}`);
  } else if (cmd === "clean") {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const cutoff = Date.now() - 24 * 3600 * 1000;
    let removed = 0;
    for (const f of fs.readdirSync(STATE_DIR)) {
      const p = path.join(STATE_DIR, f);
      if (!/^(spec-[A-Za-z0-9_-]+|pending-specs)\.json$/.test(f)) continue;
      const st = fs.lstatSync(p);
      if (st.isFile() && !st.isSymbolicLink() && st.mtimeMs < cutoff) { fs.unlinkSync(p); removed++; }
    }
    console.log(`cleaned ${removed} stale file(s)`);
  } else {
    throw new Error("usage: guard-spec.mjs set <agentId> '<spec>' | push '<spec>' (legacy sequential only) | clean");
  }
} catch (e) {
  process.stderr.write(`guard-spec: ${e?.message ?? e}\n`);
  process.exit(1);
}
