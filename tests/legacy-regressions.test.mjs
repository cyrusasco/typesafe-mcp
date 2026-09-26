import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Offline subprocess fixtures: no inherited API keys, account files, or network.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fixture(t, { patterns = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "typesafe-legacy-test-"));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^typesafe-legacy-test-[A-Za-z0-9]+$/);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  for (const dir of ["plugin/hooks", "scripts", "hooks", "home", "data"])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const file of ["plugin/server.mjs", "plugin/hooks/subagent-guard.mjs", "hooks/subagent-guard.mjs", "scripts/api-exec.mjs", "scripts/review-comment.mjs", "scripts/guard-spec.mjs"])
    fs.copyFileSync(path.join(ROOT, file), path.join(root, file));
  // Source plugin imports introduced by the parent are outside this unit's scope.
  if (fs.existsSync(path.join(ROOT, "plugin/codex")))
    fs.cpSync(path.join(ROOT, "plugin/codex"), path.join(root, "plugin/codex"), { recursive: true });
  if (patterns) fs.copyFileSync(path.join(ROOT, "patterns.json"), path.join(root, "data/patterns.json"));
  fs.copyFileSync(path.join(ROOT, "executors.json"), path.join(root, "data/executors.json"));
  const capture = path.join(root, "fetch.jsonl");
  const preload = path.join(root, "offline.mjs");
  fs.writeFileSync(preload, `import fs from 'node:fs'; import net from 'node:net';
net.Socket.prototype.connect = function () { throw new Error('OFFLINE: socket denied'); };
globalThis.fetch = async (url, opts) => {
  fs.appendFileSync(process.env.CAPTURE, JSON.stringify({url: String(url), body: JSON.parse(opts.body), timeout: Boolean(opts.signal)}) + '\\n');
  if (process.env.MOCK_HANG === '1') { await new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('timeout fixture failed')), 2000); opts.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, {once:true}); }); }
  const request = JSON.parse(opts.body);
  const body = request.questions ? {model:request.model, answers:{q:{noul:0.9}}, usage:{input_tokens:1,output_tokens:1}} : {choices:[{message:{content:process.env.MOCK_REPLY ?? '{"verdict":"pass"}'}}],content:[{type:'text',text:process.env.MOCK_REPLY ?? 'ok'}],usage:{prompt_tokens:1,completion_tokens:1,input_tokens:1,output_tokens:1}};
  if (process.env.MOCK_HTTP_ERROR === '1') return {ok:false,status:400,text:async()=>'PRIVATE_PROVIDER_ERROR_MARKER'};
  return {ok:true,status:200,text:async()=>JSON.stringify(body)};
};`);
  const env = {
    SystemRoot: process.env.SystemRoot ?? "", WINDIR: process.env.WINDIR ?? "", COMSPEC: process.env.COMSPEC ?? "",
    PATH: path.dirname(process.execPath), PATHEXT: process.env.PATHEXT ?? "",
    HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    TYPESAFE_DATA_DIR: path.join(root, "data"), CAPTURE: capture,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  };
  const run = (file, args = [], options = {}) => spawnSync(process.execPath, [path.join(root, file), ...args], {
    cwd: root, encoding: "utf8", timeout: 6000, ...options, env: { ...env, ...options.env },
  });
  const evaluate = (code, options = {}) => {
    fs.writeFileSync(path.join(root, "probe.mjs"), `import * as s from './plugin/server.mjs';\n${code}`);
    return run("probe.mjs", [], options);
  };
  const calls = () => fs.existsSync(capture) ? fs.readFileSync(capture, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
  return {root, run, evaluate, calls, env};
}
const apiEnv = { DEEPSEEK_API_KEY: "SYNTHETIC_KEY", QWEN_API_KEY: "SYNTHETIC_KEY" };
const spec = ["--spec", "Implement the fixture function", "--diff", "diff --git a/a.js b/a.js\n+return 1;", "--test-result", "pass", "--data-class", "open"];

test("TypeSafe key resolution does not inspect another product's settings", t => {
  const f = fixture(t); fs.mkdirSync(path.join(f.root, "home/.claude"));
  fs.writeFileSync(path.join(f.root, "home/.claude/settings.json"), JSON.stringify({env:{TYPESAFE_API_KEY:"SYNTHETIC_CROSS_PRODUCT_KEY"}}));
  const r = f.evaluate("console.log(JSON.stringify({key:s.resolveApiKey()}));");
  assert.equal(r.status, 0, r.stderr); assert.equal(JSON.parse(r.stdout).key, null);
});
test("missing safety patterns fail closed", t => {
  const f = fixture(t, {patterns:false});
  const r = f.evaluate("s.tsSafety({text:'rm -rf FIXTURE'});");
  assert.notEqual(r.status, 0); assert.match(r.stderr, /patterns.*(unavailable|invalid)/i); assert.equal(f.calls().length,0);
});
test("empty pattern lists fail closed", t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root,"data/patterns.json"), '{"redaction":{"regexes":[]},"destructive":{"regexes":[]}}');
  const r = f.evaluate("s.loadConfig();"); assert.notEqual(r.status,0); assert.match(r.stderr,/patterns.*(unavailable|invalid)/i);
});
test("dedupe identity includes the actual model", t => {
  const f = fixture(t);
  const r = f.evaluate("const c=s.loadConfig({key:'FAKE'}); const a={state:'safe fixture',questions:{q:{type:'noul'}}}; await s.tsAsk(a,{...c,model:'model-a'}); const b=await s.tsAsk(a,{...c,model:'model-b'}); console.log(JSON.stringify(b));");
  assert.equal(r.status,0,r.stderr); assert.equal(f.calls().length,2); assert.equal(JSON.parse(r.stdout).model,"model-b");
});
test("same-model repeated ask still uses dedupe", t => {
  const f = fixture(t);
  const r = f.evaluate("const c=s.loadConfig({key:'FAKE'}); const a={state:'safe fixture',questions:{q:{type:'noul'}}}; await s.tsAsk(a,c); console.log(JSON.stringify(await s.tsAsk(a,c)));");
  assert.equal(r.status,0,r.stderr); assert.equal(f.calls().length,1); assert.equal(JSON.parse(r.stdout).cached,true);
});
test("unavailable Jev never implies proceed for action judging", t => {
  const f=fixture(t); const r=f.evaluate("console.log(JSON.stringify(await s.tsJudgeAction({spec:'Fixture only',action:'edit fixture'})));");
  assert.equal(r.status,0,r.stderr); assert.notEqual(JSON.parse(r.stdout).directive,"proceed");
});
test("plugin guard imports correctly and blocks destructive child action", t => {
  const f=fixture(t); const r=f.run("plugin/hooks/subagent-guard.mjs",[],{input:JSON.stringify({agent_id:"child-123",session_id:"parent-uuid",tool_name:"Bash",tool_input:{command:"rm -rf FIXTURE"}})});
  assert.equal(r.status,2,r.stderr); assert.match(r.stderr,/DESTRUCTIVE/); assert.doesNotMatch(r.stderr,/ERR_MODULE_NOT_FOUND/);
});
test("root guard uses explicit agent ID instead of assuming a root session ID", t => {
  const f=fixture(t); const r=f.run("hooks/subagent-guard.mjs",[],{input:JSON.stringify({agent_id:"child-123",session_id:"parent-uuid",tool_name:"Bash",tool_input:{command:"rm -rf FIXTURE"}})});
  assert.equal(r.status,2,r.stderr); assert.match(r.stderr,/DESTRUCTIVE/);
});
test("guard-spec first-use legacy push creates state", t => {
  const f=fixture(t); const r=f.run("scripts/guard-spec.mjs",["push","Fixture only"]);
  assert.equal(r.status,0,r.stderr); const q=JSON.parse(fs.readFileSync(path.join(f.root,"home/.zcode/typesafe-state/pending-specs.json"),"utf8")); assert.equal(q[0].spec,"Fixture only");
});
test("guard-spec set binds one safe explicit agent ID; traversal rejected", t => {
  const f=fixture(t); const r=f.run("scripts/guard-spec.mjs",["set","child-123","Fixture only"]);
  assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,"home/.zcode/typesafe-state/spec-child-123.json"),"utf8")).spec,"Fixture only");
  const bad=f.run("scripts/guard-spec.mjs",["set","../outside","Fixture only"]); assert.notEqual(bad.status,0);
});
test("bound guard blocks on unavailable Jev including compound shell commands", t => {
  const f=fixture(t); assert.equal(f.run("scripts/guard-spec.mjs",["set","child-123","Fixture only"]).status,0);
  const r=f.run("plugin/hooks/subagent-guard.mjs",[],{input:JSON.stringify({agent_id:"child-123",tool_name:"Bash",tool_input:{command:"echo safe; node work.mjs"}})});
  assert.equal(r.status,2,r.stderr); assert.match(r.stderr,/unavailable|UNAVAILABLE/i); assert.equal(f.calls().length,0);
});
test("API egress requires explicit data classification", t => {
  const f=fixture(t); const r=f.run("scripts/api-exec.mjs",["deepseek-api","-"],{input:"fixture",env:apiEnv});
  assert.notEqual(r.status,0); assert.match(r.stderr,/data.class/i); assert.equal(f.calls().length,0);
});
test("API egress applies executor clearance at the last mile", t => {
  const f=fixture(t); const r=f.run("scripts/api-exec.mjs",["deepseek-api","-","--data-class","restricted"],{input:"fixture",env:apiEnv});
  assert.notEqual(r.status,0); assert.equal(f.calls().length,0);
});
test("API uses environment endpoint, redaction, timeout and output cap", t => {
  const f=fixture(t); const r=f.run("scripts/api-exec.mjs",["qwen-api","-","--data-class","open","--max-output-tokens","24"],{input:"token=FIXTURE_SECRET_MARKER",env:{...apiEnv,QWEN_BASE_URL:"https://fixture.invalid"}});
  assert.equal(r.status,0,r.stderr); const [call]=f.calls(); assert.match(call.url,/fixture\.invalid/); assert.doesNotMatch(JSON.stringify(call.body),/FIXTURE_SECRET_MARKER/); assert.equal(call.body.max_tokens,24); assert.equal(call.timeout,true);
});
test("API configured timeout aborts a hung provider", t => {
  const f=fixture(t); const r=f.run("scripts/api-exec.mjs",["deepseek-api","-","--data-class","open","--timeout-ms","50"],{input:"fixture",env:{...apiEnv,MOCK_HANG:"1"}});
  assert.notEqual(r.status,0); assert.match(r.stderr,/request aborted or timed out/i); assert.equal(f.calls().length,1);
});
test("API budget blocks before provider egress", t => {
  const f=fixture(t); const r=f.run("scripts/api-exec.mjs",["deepseek-api","-","--data-class","open"],{input:"fixture",env:{...apiEnv,TYPESAFE_DAILY_TOKEN_CAP:"1"}});
  assert.notEqual(r.status,0); assert.match(r.stderr,/budget/i); assert.equal(f.calls().length,0);
});
test("review without concrete diff and test evidence cannot accept", t => {
  const f=fixture(t); const r=f.run("scripts/review-comment.mjs",["--spec","Fixture"],{env:apiEnv});
  assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).verdict,"escalate"); assert.equal(f.calls().length,0);
});
test("codex-cli review requests native review without launching another CLI", t => {
  const f=fixture(t); const r=f.run("scripts/review-comment.mjs",[...spec,"--reviewer","codex-cli"],{env:apiEnv});
  assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).via,"native-review-required"); assert.equal(f.calls().length,0);
});
test("review rejects incomplete reviewer JSON rather than auto-accepting", t => {
  const f=fixture(t); const r=f.run("scripts/review-comment.mjs",[...spec,"--test-command","node fixture.test.mjs","--test-exit-code","0","--test-output","1 test passed"],{env:apiEnv});
  assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).verdict,"escalate"); assert.equal(f.calls().length,1); assert.equal(fs.existsSync(path.join(f.root,"rc-prompt.tmp")),false);
});
test("passing schema plus exact evidence is review-passed, not final acceptance", t => {
  const f=fixture(t); const r=f.run("scripts/review-comment.mjs",[...spec,"--test-command","node fixture.test.mjs","--test-exit-code","0","--test-output","1 test passed"],{env:{...apiEnv,MOCK_REPLY:JSON.stringify({verdict:"pass",broken_why:[],risks:[]})}});
  assert.equal(r.status,0,r.stderr); const out=JSON.parse(r.stdout); assert.equal(out.verdict,"review-passed"); assert.match(out.diff_sha256,/^[a-f0-9]{64}$/); assert.equal(f.calls().length,1); assert.equal(fs.existsSync(path.join(f.root,"rc-prompt.tmp")),false);
});
test("oversized diff fails closed instead of silently truncating", t => {
  const f=fixture(t); fs.writeFileSync(path.join(f.root,"diff.txt"),"+a".repeat(13000));
  const r=f.run("scripts/review-comment.mjs",["--spec","Fixture","--diff-file",path.join(f.root,"diff.txt"),"--test-result","pass","--data-class","open","--test-command","test","--test-exit-code","0","--test-output","pass"],{env:apiEnv});
  assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).via,"diff-too-large"); assert.equal(f.calls().length,0);
});

test("invalid regular expressions are a configuration error, not safe evidence", t => {
  const f=fixture(t); fs.writeFileSync(path.join(f.root,"data/patterns.json"),JSON.stringify({redaction:{regexes:["["]},destructive:{regexes:["x"]}}));
  const r=f.evaluate("s.tsSafety({text:'fixture'});"); assert.notEqual(r.status,0); assert.match(r.stderr,/patterns.*invalid/i); assert.equal(f.calls().length,0);
});
test("explicit child without a spec is blocked, not silently claimed from FIFO", t => {
  const f=fixture(t); assert.equal(f.run("scripts/guard-spec.mjs",["push","Spec for somebody else"]).status,0);
  const r=f.run("plugin/hooks/subagent-guard.mjs",[],{input:JSON.stringify({agent_id:"child-unbound",tool_name:"Bash",tool_input:{command:"node fixture.mjs"}})});
  assert.equal(r.status,2,r.stderr); assert.match(r.stderr,/no.*binding/i); assert.equal(f.calls().length,0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root,"home/.zcode/typesafe-state/pending-specs.json"),"utf8")).length,1);
});
test("guard rejects identity path traversal before file access", t => {
  const f=fixture(t); const r=f.run("plugin/hooks/subagent-guard.mjs",[],{input:JSON.stringify({agent_id:"../outside",tool_name:"Bash",tool_input:{command:"echo fixture"}})});
  assert.equal(r.status,2,r.stderr); assert.match(r.stderr,/identity/i); assert.equal(f.calls().length,0);
});
test("guard blocks unavailable safety configuration", t => {
  const f=fixture(t,{patterns:false}); const r=f.run("plugin/hooks/subagent-guard.mjs",[],{input:JSON.stringify({agent_id:"child-123",tool_name:"Bash",tool_input:{command:"node fixture.mjs"}})});
  assert.equal(r.status,2,r.stderr); assert.match(r.stderr,/patterns unavailable/i); assert.equal(f.calls().length,0);
});
test("API omits conflicting default schema in raw reviewer mode", t => {
  const f=fixture(t); const r=f.run("scripts/api-exec.mjs",["deepseek-api","-","--data-class","open","--raw"],{input:"Return review shape",env:apiEnv});
  assert.equal(r.status,0,r.stderr); assert.equal(f.calls()[0].body.messages.length,1); assert.equal(f.calls()[0].body.messages[0].role,"user");
});
test("API error bodies are not echoed to logs", t => {
  const f=fixture(t); const r=f.run("scripts/api-exec.mjs",["deepseek-api","-","--data-class","open"],{input:"fixture",env:{...apiEnv,MOCK_HTTP_ERROR:"1"}});
  assert.notEqual(r.status,0); assert.match(r.stderr,/HTTP 400/); assert.doesNotMatch(r.stdout+r.stderr,/PRIVATE_PROVIDER_ERROR_MARKER/);
});
test("API refuses malformed data classification without provider calls", t => {
  const f=fixture(t); const r=f.run("scripts/api-exec.mjs",["deepseek-api","-","--data-class","unknown"],{input:"fixture",env:apiEnv});
  assert.notEqual(r.status,0); assert.equal(f.calls().length,0);
});
test("API refuses a corrupt budget ledger before egress", t => {
  const f=fixture(t); fs.mkdirSync(path.join(f.root,"data/ledger"));
  const d=new Date(); const date=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  fs.writeFileSync(path.join(f.root,`data/ledger/${date}.jsonl`),"not-json\n");
  const r=f.run("scripts/api-exec.mjs",["deepseek-api","-","--data-class","open"],{input:"fixture",env:apiEnv});
  assert.notEqual(r.status,0); assert.match(r.stderr,/ledger/i); assert.equal(f.calls().length,0);
});
test("review failed exit evidence causes correction without any model call", t => {
  const f=fixture(t); const r=f.run("scripts/review-comment.mjs",[...spec,"--test-command","node test.mjs","--test-exit-code","1","--test-output","failed"],{env:apiEnv});
  assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).verdict,"correct"); assert.equal(f.calls().length,0);
});
test("review standalone pass claim is insufficient test evidence", t => {
  const f=fixture(t); const r=f.run("scripts/review-comment.mjs",spec,{env:apiEnv});
  assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).via,"missing-test-evidence"); assert.equal(f.calls().length,0);
});
test("review rejects contradictory pass with blocking findings", t => {
  const f=fixture(t); const r=f.run("scripts/review-comment.mjs",[...spec,"--test-command","node test.mjs","--test-exit-code","0","--test-output","passed"],{env:{...apiEnv,MOCK_REPLY:JSON.stringify({verdict:"pass",broken_why:["The function is broken"],risks:[]})}});
  assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).verdict,"escalate"); assert.equal(f.calls().length,1);
});
