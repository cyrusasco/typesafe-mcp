#!/usr/bin/env node
/**
 * probe.mjs — TEMPORARY logging-only PreToolUse probe (never blocks).
 * Appends the raw hook payload to typesafe-mcp/state/probe.log so we can see:
 * (1) whether user-level hooks fire for SUBAGENT tool calls, (2) whether the
 * payload carries session_id (sess_subagent_* discriminator), (3) exact field names.
 * Remove after the experiment.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;

const dir = path.join(os.homedir(), "typesafe-mcp-probe");
fs.mkdirSync(dir, { recursive: true });
fs.appendFileSync(
  path.join(dir, "probe.log"),
  `${new Date().toISOString()} ${raw.trim().slice(0, 600)}\n`,
);
process.exit(0);
