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
const child = spawn(process.execPath, [target], {
  stdio: ["inherit", "inherit", "inherit"],
});
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (err) => {
  process.stderr.write(`[typesafe-mcp] launcher failed: ${err?.message ?? err}\n`);
  process.exit(1);
});
