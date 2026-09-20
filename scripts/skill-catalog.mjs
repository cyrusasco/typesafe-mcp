#!/usr/bin/env node
/**
 * skill-catalog.mjs — build/list the local skill index for ts_suggest_skill.
 *
 *   node skill-catalog.mjs build [--force]   # rebuild skills-index.json (auto-cached 7d)
 *   node skill-catalog.mjs list              # print id — name (description head)
 *
 * Scans ~/.zcode/skills and ~/.agents/skills (SKILL.md frontmatter + 400-char
 * body excerpt). Index + skills-exclude.json live in DATA_DIR (gitignored).
 */
import { skillCatalog } from "../plugin/server.mjs";

const [cmd, ...rest] = process.argv.slice(2);
const cat = skillCatalog(rest.includes("--force"));
if (cmd === "build") {
  console.log(`catalog: ${cat.count} skills from ${cat.roots.join(" + ")} (built ${cat.builtAt})`);
} else if (cmd === "list") {
  for (const s of cat.skills) console.log(`${s.id} — ${s.name} — ${s.description.slice(0, 70)}`);
} else {
  console.log(`usage: skill-catalog.mjs build [--force] | list   (${cat.count} skills indexed)`);
  process.exit(1);
}
