#!/usr/bin/env node
/**
 * mcp-launcher.mjs — thin stdio passthrough launcher (plugin root -> server).
 *
 * The server ships INSIDE this plugin (./server.mjs), so the launcher is fully
 * self-contained: it spawns ${HERE}/server.mjs with inherited stdio. ZCode only
 * ever sees a path INSIDE the plugin root, keeping manifest path validation
 * happy, and a cache-copy install works with no external references.
 *
 * Operational data (ledger/, .env, executors.json, patterns.json) is resolved
 * by the server itself at runtime: TYPESAFE_DATA_DIR → parent dir when it
 * contains executors.json → this plugin dir (shipped defaults).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "server.mjs");
if (!fs.existsSync(target)) {
  process.stderr.write(`[typesafe-mcp] launcher: ${target} not found — plugin install is broken/incomplete\n`);
  process.exit(1);
}

// v1.5.2 — early-exit retry: if the server dies within 3s of spawn (observed cause:
// the source dir was being live-edited and momentarily contained a broken file —
// 17x "Connection closed" in ZCode logs 2026-09-21T16:11–18:21Z), respawn up to 3
// times with 1s backoff. ZCode does not auto-reconnect a dropped MCP server, so
// surviving a transient breakage here saves the whole session's tool surface.
const MAX_TRIES = 3;
function attempt(n) {
  const startedAt = Date.now();
  const child = spawn(process.execPath, [target], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  child.on("error", (err) => {
    process.stderr.write(`[typesafe-mcp] launcher failed: ${err?.message ?? err}\n`);
    process.exit(1);
  });
  child.on("exit", (code) => {
    const early = Date.now() - startedAt < 3000; // startup crash, not a normal lifetime
    if (code !== 0 && early && n < MAX_TRIES) {
      process.stderr.write(`[typesafe-mcp] launcher: server exited early (code ${code}), retry ${n + 1}/${MAX_TRIES} in 1s\n`);
      setTimeout(() => attempt(n + 1), 1000);
      return;
    }
    process.exit(code ?? 0);
  });
}
attempt(1);
