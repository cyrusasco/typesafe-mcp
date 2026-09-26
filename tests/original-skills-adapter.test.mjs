import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareOriginalSkillsAdapter, ORIGINAL_AUDIT_LINE } from '../scripts/prepare-original-skills-adapter.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const quote = x => `'${x.replace(/'/g, "''")}'`;
function fixture(t, change = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'typesafe-adapter-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.match(path.basename(root), /^typesafe-adapter-[a-zA-Z0-9]+$/);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, {recursive:true, force:true});
  });
  const sourceDir = path.join(root, 'source'); fs.mkdirSync(sourceDir);
  const invoke = path.join(sourceDir, 'Invoke-GitNexusGuardian.ps1');
  const start = path.join(sourceDir, 'Start-OriginalSkills.ps1');
  const invokeText = ["$runId = 'unchanged-snapshot-id'", '$runtimePath = $RuntimeRoot', ORIGINAL_AUDIT_LINE, '$binding = $runId', 'exit 0', ''].join('\r\n');
  fs.writeFileSync(invoke, change.invokeText ?? invokeText);
  const pins = {[invoke]:hash(fs.readFileSync(invoke))};
  for (let i=0;i<6;i++) { const file=path.join(sourceDir, `pinned-${i}.bin`); fs.writeFileSync(file, `fixture ${i}`); pins[file]=hash(fs.readFileSync(file)); }
  const startText = ["$ErrorActionPreference = 'Stop'", "$files = @'", JSON.stringify(pins), "'@ | ConvertFrom-Json -AsHashtable", "foreach ($p in $files.Keys) { if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $files[$p]) { throw 'Pinned serving artifact changed' } }", `& ${quote(invoke)} -Repository ${quote(sourceDir)} -RuntimeRoot ${quote(root)} -PreparedManifest ${quote(path.join(sourceDir,'pinned-0.bin'))}`, 'exit $LASTEXITCODE', ''].join('\r\n');
  fs.writeFileSync(start, change.startText?.(startText) ?? startText);
  const options = { start, startSha256:hash(fs.readFileSync(start)), invoke, invokeSha256:hash(fs.readFileSync(invoke)), outputDir:path.join(root,'owned-adapter') };
  return {root, sourceDir, start, invoke, pins, options, originalStart:fs.readFileSync(start), originalInvoke:fs.readFileSync(invoke)};
}

test('adapter preserves originals and all seven pins, changing only audit allocation', t => {
  const f=fixture(t); const receipt=prepareOriginalSkillsAdapter(f.options);
  assert.equal(receipt.status,'PREPARED_NOT_LAUNCHED');
  assert.equal(receipt.verified_original_pins.length,7);
  assert.deepEqual(fs.readFileSync(f.start),f.originalStart); assert.deepEqual(fs.readFileSync(f.invoke),f.originalInvoke);
  const generatedInvoke=fs.readFileSync(path.join(f.options.outputDir,'Invoke-GitNexusGuardian.ps1'),'utf8');
  const generatedStart=fs.readFileSync(path.join(f.options.outputDir,'Start-OriginalSkills.ps1'),'utf8');
  assert.equal(generatedInvoke.replace(receipt.transformation.new_audit_line,ORIGINAL_AUDIT_LINE),f.originalInvoke.toString());
  assert.match(receipt.transformation.new_audit_line,/\[Guid\]::NewGuid\(\)/);
  assert.doesNotMatch(receipt.transformation.new_audit_line,/\$runId/);
  assert.ok(generatedStart.includes(JSON.stringify(f.pins)));
  assert.ok(generatedStart.includes(f.options.startSha256));
  assert.ok(generatedStart.includes(hash(Buffer.from(generatedInvoke))));
  assert.equal(receipt.additional_pins.length,2);
  assert.equal(receipt.generated.invoke.sha256,hash(Buffer.from(generatedInvoke)));
  assert.equal(receipt.generated.start.sha256,hash(Buffer.from(generatedStart)));
});
test('generated audit expression allocates distinct launch directories under the unchanged runtime root', t => {
  const f=fixture(t); const r=prepareOriginalSkillsAdapter(f.options);
  if(process.platform !== 'win32') { assert.match(r.transformation.new_audit_line,/Join-Path \$runtimePath/); return; }
  const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const execute=()=> {
    const command=`$ErrorActionPreference='Stop'; $runtimePath=${quote(f.root)}; $runId='frozen-snapshot'; ${r.transformation.new_audit_line.trim()}; [Console]::Out.Write((@{audit=$auditPath;snapshot=$runId}|ConvertTo-Json -Compress))`;
    const x=spawnSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',timeout:15000,env:{SystemRoot:process.env.SystemRoot,HOME:f.root,USERPROFILE:f.root}});
    assert.equal(x.status,0,x.stderr); return JSON.parse(x.stdout);
  };
  const a=execute(),b=execute(); assert.notEqual(a.audit,b.audit); assert.equal(a.snapshot,'frozen-snapshot'); assert.equal(b.snapshot,a.snapshot);
  assert.ok(a.audit.startsWith(f.root+path.sep)); assert.match(a.audit,/connection-[a-f0-9]{32}[\\/]audit\.jsonl$/);
  assert.equal(fs.existsSync(path.dirname(a.audit)),false,'expression test must not create runtime state');
});
test('source SHA drift fails before output creation', t => {
  const f=fixture(t); fs.appendFileSync(f.start,'# changed');
  assert.throws(()=>prepareOriginalSkillsAdapter(f.options),/start.*hash|hash.*start/i); assert.equal(fs.existsSync(f.options.outputDir),false);
});
test('every original artifact hash is validated before generation', t => {
  const f=fixture(t); fs.appendFileSync(path.join(f.sourceDir,'pinned-4.bin'),'drift');
  assert.throws(()=>prepareOriginalSkillsAdapter(f.options),/pinned artifact.*hash|hash.*pinned artifact/i); assert.equal(fs.existsSync(f.options.outputDir),false);
});
test('existing owned-output path is never overwritten', t => {
  const f=fixture(t); fs.mkdirSync(f.options.outputDir); fs.writeFileSync(path.join(f.options.outputDir,'keep'),'user data');
  assert.throws(()=>prepareOriginalSkillsAdapter(f.options),/output.*absent|output.*exist/i); assert.equal(fs.readFileSync(path.join(f.options.outputDir,'keep'),'utf8'),'user data');
});
test('relative, traversal and network output paths are rejected', t => {
  const f=fixture(t);
  for(const outputDir of ['relative',path.join(f.root,'x')+path.sep+'..'+path.sep+'escape','\\\\server\\share\\adapter']) assert.throws(()=>prepareOriginalSkillsAdapter({...f.options,outputDir}),/absolute|traversal|network|UNC/i);
  assert.equal(fs.existsSync(f.options.outputDir),false);
});
test('ambiguous target audit line fails closed', t => {
  const f=fixture(t,{invokeText:ORIGINAL_AUDIT_LINE+'\n'+ORIGINAL_AUDIT_LINE+'\n'});
  assert.throws(()=>prepareOriginalSkillsAdapter(f.options),/exactly one.*audit/i); assert.equal(fs.existsSync(f.options.outputDir),false);
});
test('changed target audit syntax fails closed', t => {
  const f=fixture(t,{invokeText:ORIGINAL_AUDIT_LINE.replace('$runId','$other')+'\n'});
  assert.throws(()=>prepareOriginalSkillsAdapter(f.options),/exactly one.*audit/i); assert.equal(fs.existsSync(f.options.outputDir),false);
});
test('duplicate invocation fails closed', t => {
  const f=fixture(t,{startText:s=>s+s.split(/\r?\n/).find(x=>x.startsWith('& '))+'\r\n'});
  assert.throws(()=>prepareOriginalSkillsAdapter(f.options),/exactly one.*invocation/i); assert.equal(fs.existsSync(f.options.outputDir),false);
});
test('output through a directory link is rejected', t => {
  const f=fixture(t); const link=path.join(f.root,'link');
  fs.symlinkSync(f.sourceDir,link,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>prepareOriginalSkillsAdapter({...f.options,outputDir:path.join(link,'adapter')}),/reparse|symbolic|alias/i);
});
test('source identity must be present in the original seven-pin manifest', t => {
  const f=fixture(t); const other=path.join(f.sourceDir,'OtherInvoke.ps1'); fs.copyFileSync(f.invoke,other);
  assert.throws(()=>prepareOriginalSkillsAdapter({...f.options,invoke:other}),/invoke.*pin|invocation/i); assert.equal(fs.existsSync(f.options.outputDir),false);
});
test('CLI creates only a bounded prepared adapter with a receipt', t => {
  const f=fixture(t); const r=spawnSync(process.execPath,[path.join(ROOT,'scripts/prepare-original-skills-adapter.mjs'),'--start',f.start,'--start-sha256',f.options.startSha256,'--invoke',f.invoke,'--invoke-sha256',f.options.invokeSha256,'--output-dir',f.options.outputDir],{cwd:f.root,encoding:'utf8',timeout:30000});
  assert.equal(r.status,0,r.stderr); assert.equal(JSON.parse(r.stdout).status,'PREPARED_NOT_LAUNCHED');
  assert.deepEqual(fs.readdirSync(f.options.outputDir).sort(),['ADAPTER_RECEIPT.json','Invoke-GitNexusGuardian.ps1','Start-OriginalSkills.ps1']);
});
for (const suffix of ['$&', "$'"]) {
  test(`output path preserves literal JavaScript replacement token ${suffix}`, t => {
    const f=fixture(t);
    const outputDir=path.join(f.root,`owned-adapter-${suffix}`);
    const receipt=prepareOriginalSkillsAdapter({...f.options,outputDir});
    const generated=fs.readFileSync(receipt.generated.start.path,'utf8');
    const originalInvocation=f.originalStart.toString().split(/\r?\n/).find(line=>line.startsWith('& '));
    const expectedInvocation=`& ${quote(path.join(outputDir,'Invoke-GitNexusGuardian.ps1'))} `+originalInvocation.slice(`& ${quote(f.invoke)} `.length);
    assert.equal(generated.split(/\r?\n/).filter(line=>line.startsWith('& ')).length,1);
    assert.ok(generated.split(/\r?\n/).includes(expectedInvocation),'invocation must preserve the literal path');
    const adapterPins=[...generated.matchAll(/\$adapterFiles = @'\r?\n([\s\S]*?)\r?\n'@ \| ConvertFrom-Json -AsHashtable/g)];
    assert.equal(adapterPins.length,1);
    assert.deepEqual(JSON.parse(adapterPins[0][1]),Object.fromEntries(receipt.additional_pins.map(pin=>[pin.path,pin.sha256])));
    assert.deepEqual(fs.readFileSync(f.start),f.originalStart); assert.deepEqual(fs.readFileSync(f.invoke),f.originalInvoke);
  });
}
