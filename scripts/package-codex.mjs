#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = process.argv[2];
if (!dest || !path.isAbsolute(dest) || fs.existsSync(dest)) throw new Error('Provide an absolute, absent output directory (never overwrite an installation)');
const files = [
 ['packaging/typesafe-codex/plugin.json','.codex-plugin/plugin.json'],
 ['plugin/codex/mcp.json','.mcp.json'], ['plugin/codex/hooks.json','hooks/hooks.json'],
 ['plugin/server.mjs','server.mjs'], ['plugin/patterns.json','patterns.json'],
 ['plugin/skills/typesafe-codex/SKILL.md','skills/typesafe-codex/SKILL.md'],
 ...['contracts.mjs','context.mjs','store.mjs','controller.mjs','native-bridge.mjs','server.mjs','lifecycle.mjs','PROTOCOL.md'].map(f=>[`plugin/codex/${f}`,`codex/${f}`]),
];
for (const [from] of files) if (!fs.statSync(path.join(root,from)).isFile()) throw new Error(`Missing packaging input ${from}`);
fs.mkdirSync(dest, { recursive:false });
for (const [from,to] of files) {
 const target=path.join(dest,to); fs.mkdirSync(path.dirname(target),{recursive:true}); fs.copyFileSync(path.join(root,from),target,fs.constants.COPYFILE_EXCL);
}
console.log(JSON.stringify({status:'BUILT_NOT_INSTALLED',output:dest,files:files.length}));
