import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('isolated packaged Codex plugin boots without source checkout paths or credentials',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'typesafe-package-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const out=path.join(root,'typesafe-codex');
 let run=spawnSync(process.execPath,[path.join(repo,'scripts/package-codex.mjs'),out],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'.codex-plugin/plugin.json'),'utf8'));
 assert.equal(manifest.skills,'./skills/');assert.equal(manifest.mcpServers,'./.mcp.json');
 assert.equal(fs.existsSync(path.join(out,'.env')),false);
 assert.equal(fs.existsSync(path.join(out,'skills/typesafe-dispatch')),false);
 const env=Object.fromEntries(['SystemRoot','WINDIR','COMSPEC','PATH','PATHEXT','TMP','TEMP'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
 Object.assign(env,{HOME:root,USERPROFILE:root,TYPESAFE_DATA_DIR:path.join(root,'data')});
 const messages=[{jsonrpc:'2.0',id:1,method:'initialize',params:{}},{jsonrpc:'2.0',id:2,method:'tools/list'},
  {jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'ts_codex_health',arguments:{}}}];
 run=spawnSync(process.execPath,[path.join(out,'codex/server.mjs')],{env,input:messages.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:10000});
 assert.equal(run.status,0,run.stderr);
 const replies=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(replies[0].result.serverInfo.version,'1.9.0');
 assert.equal(replies[1].result.tools.length,8);
 const health=JSON.parse(replies[2].result.content[0].text); assert.equal(health.has_key,false);assert.equal(health.authenticated,'NOT_VERIFIED');
 assert.equal(fs.existsSync(path.join(root,'data')),false,'metadata-only boot writes no state');
 run=spawnSync(process.execPath,[path.join(repo,'scripts/package-codex.mjs'),out],{encoding:'utf8'});
 assert.notEqual(run.status,0,'packaging never overwrites an installation');
});
test('lifecycle hooks only inject context; no claim of whole-process prevention',()=>{
 for(const name of ['UserPromptSubmit','SubagentStart']){
  const r=spawnSync(process.execPath,[path.join(repo,'plugin/codex/lifecycle.mjs')],{input:JSON.stringify({hook_event_name:name,session_id:'parent'}),encoding:'utf8',timeout:5000});
  assert.equal(r.status,0);const out=JSON.parse(r.stdout);assert.equal(out.hookSpecificOutput.hookEventName,name);assert.ok(out.hookSpecificOutput.additionalContext);
 }
});
