#!/usr/bin/env node
/**
 * subgoal.mjs — dispatch-level subgoal dedup registry (doc §VI.B, audit-measured 5 duplicate dispatches).
 *
 *   node subgoal.mjs check   '<task spec>'            # duplicate? → reference the existing agent/task instead
 *   node subgoal.mjs register '<task spec>' --ref <agentId|label>
 *   node subgoal.mjs done    <ref>                    # mark completed (starts the done-TTL window)
 *   node subgoal.mjs list
 *
 * Semantics: identical (whitespace/case-normalized) spec that is in_flight (≤30 min old)
 * or done within the dedup TTL (default 5 min) is a DUPLICATE — do not dispatch again.
 * Registry: ~/.zcode/typesafe-state/subgoal-registry.json (best-effort, never blocks dispatch on IO error).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const FILE = path.join(os.homedir(), ".zcode", "typesafe-state", "subgoal-registry.json");
const IN_FLIGHT_TTL_MS = 30 * 60 * 1000;
const DONE_TTL_DEFAULT_MS = 5 * 60 * 1000;

const norm = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const hash = (s) => crypto.createHash("sha256").update(norm(s)).digest("hex").slice(0, 16);

const load = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return {}; } };
const save = (m) => { try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(m, null, 1)); } catch { /* best effort */ } };

const [cmd, ...rest] = process.argv.slice(2);
const flag = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };

try {
  if (cmd === "check") {
    const spec = rest.find((a) => !a.startsWith("--"));
    if (!spec) throw new Error("usage: subgoal.mjs check '<spec>'");
    const h = hash(spec);
    const m = load();
    const hit = m[h];
    if (!hit) { console.log(JSON.stringify({ duplicate: false, hash: h })); process.exit(0); }
    const age = Date.now() - hit.at;
    const dup = (hit.status === "in_flight" && age < IN_FLIGHT_TTL_MS) || (hit.status === "done" && age < (hit.done_ttl_ms ?? DONE_TTL_DEFAULT_MS));
    console.log(JSON.stringify({ duplicate: dup, hash: h, of: hit.ref ?? null, status: hit.status, age_s: Math.round(age / 1000), spec: hit.spec.slice(0, 100) }));
  } else if (cmd === "register") {
    const spec = rest.find((a) => !a.startsWith("--") && a !== flag("--ref"));
    if (!spec) throw new Error("usage: subgoal.mjs register '<spec>' --ref <agentId|label>");
    const m = load();
    m[hash(spec)] = { spec: norm(spec), ref: flag("--ref") ?? null, status: "in_flight", at: Date.now() };
    save(m);
    console.log(JSON.stringify({ registered: hash(spec), ref: m[hash(spec)].ref }));
  } else if (cmd === "done") {
    const ref = rest.find((a) => !a.startsWith("--"));
    const m = load();
    const hit = Object.entries(m).find(([h, v]) => v.ref === ref || h === ref || v.ref === flag("--ref"));
    if (!hit) throw new Error(`no registry entry for ${ref}`);
    hit[1].status = "done";
    hit[1].at = Date.now();
    save(m);
    console.log(JSON.stringify({ done: hit[0], ref: hit[1].ref }));
  } else if (cmd === "list") {
    console.log(JSON.stringify(load(), null, 1));
  } else {
    throw new Error("usage: subgoal.mjs check|register|done|list");
  }
} catch (e) {
  process.stderr.write(`subgoal: ${e?.message ?? e}\n`);
  process.exit(1);
}
