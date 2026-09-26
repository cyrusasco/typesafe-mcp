#!/usr/bin/env node
/**
 * Prepare, never launch, an owned adapter for the pinned original-Skills server.
 * Only the Invoke audit-path allocation changes. The prepared snapshot run ID,
 * repository, home and every other original launcher check remain unchanged.
 * Output must be absent with an existing ordinary parent. Partial output on an
 * unexpected failure is retained for ownership review; originals are never edited.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ORIGINAL_AUDIT_LINE = '    $auditPath = Join-Path $runtimePath "evidence\\private\\gitnexus-proxy\\$runId\\audit.jsonl"';
const NEW_AUDIT_LINE = '    $auditPath = Join-Path $runtimePath ("evidence\\private\\gitnexus-proxy\\connection-" + [Guid]::NewGuid().ToString(\'N\') + "\\audit.jsonl")';
const SHA = /^[a-f0-9]{64}$/i;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const psQuote = value => `'${value.replace(/'/g, "''")}'`;
const identity = value => process.platform === 'win32' ? value.toLowerCase() : value;

export function windowsInspectionEnvironment(source = process.env) {
  // Windows PowerShell needs ordinary OS/profile/temp paths on hosted runners.
  // Do not inherit arbitrary credentials, PATH, module paths or execution hooks.
  const names = ['SystemRoot','WINDIR','SystemDrive','COMSPEC','COMPUTERNAME','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','TEMP','TMP'];
  return Object.fromEntries(names.filter(k => typeof source[k] === 'string').map(k => [k,source[k]]));
}

export function windowsInspectionShell(source = process.env, exists = fs.existsSync) {
  const modern = source.ProgramFiles && path.join(source.ProgramFiles,'PowerShell','7','pwsh.exe');
  if (modern && exists(modern)) return modern;
  return path.join(source.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
}

function absoluteLocal(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label}: invalid path text`);
  if (/^(?:\\\\|\/\/)/.test(value)) throw new Error(`${label}: network/UNC/device paths are not permitted`);
  if (!path.isAbsolute(value)) throw new Error(`${label}: absolute local path required`);
  const parts = value.replace(/\\/g, '/').split('/');
  if (parts.some(p => p === '.' || p === '..')) throw new Error(`${label}: traversal component rejected`);
  if (process.platform === 'win32' && (value.slice(2).includes(':') || parts.slice(1).some(p => /[. ]$/.test(p)))) throw new Error(`${label}: Windows path alias/stream rejected`);
  const full = path.resolve(value);
  if (full === path.parse(full).root) throw new Error(`${label}: filesystem root is not an owned target`);
  return full;
}

function pathComponents(full) {
  const root = path.parse(full).root;
  const result = [root]; let current = root;
  for (const part of full.slice(root.length).split(path.sep).filter(Boolean)) { current = path.join(current,part); result.push(current); }
  return result;
}

function assertOrdinaryPaths(paths) {
  const components = [...new Set(paths.flatMap(pathComponents))];
  for (const component of components) {
    const stat = fs.lstatSync(component);
    if (stat.isSymbolicLink()) throw new Error(`reparse/symbolic path rejected: ${component}`);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`non-ordinary path rejected: ${component}`);
    if (identity(fs.realpathSync.native(component)) !== identity(path.resolve(component))) throw new Error(`path alias rejected: ${component}`);
  }
  if (process.platform === 'win32') {
    // Node identifies symlinks/junctions; the OS attribute check additionally
    // rejects other Windows reparse tags. Paths are DATA in an environment var,
    // never interpolated into PowerShell code. This starts no serving runtime.
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error('Windows reparse inspection requires SystemRoot');
    const shell = windowsInspectionShell();
    const command = "$ErrorActionPreference='Stop'; foreach ($p in ($env:TYPESAFE_ADAPTER_PATHS | ConvertFrom-Json)) { $a=[IO.File]::GetAttributes([string]$p); if (($a -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse path rejected' } }; [Console]::Out.Write('OK')";
    const result = spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{
      encoding:'utf8',timeout:15000,maxBuffer:65536,windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...windowsInspectionEnvironment(),SystemRoot:systemRoot,WINDIR:systemRoot,TYPESAFE_ADAPTER_PATHS:JSON.stringify(components)},
    });
    if (result.status !== 0 || result.stdout !== 'OK') throw new Error(`Windows reparse inspection failed closed (exit=${result.status}, error=${result.error?.code ?? 'none'}, signal=${result.signal ?? 'none'})`);
  }
}

function fileHash(file) {
  const fd = fs.openSync(file,'r');
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('pinned artifact must be an ordinary file');
    const sha=crypto.createHash('sha256'), buf=Buffer.alloc(65536);
    for (;;) { const count=fs.readSync(fd,buf,0,buf.length,null); if (!count) break; sha.update(buf.subarray(0,count)); }
    return sha.digest('hex');
  } finally { fs.closeSync(fd); }
}
function verifyFile(file, expected, label) {
  if (typeof expected !== 'string' || !SHA.test(expected)) throw new Error(`${label}: expected SHA256 required`);
  if (fileHash(file) !== expected.toLowerCase()) throw new Error(`${label}: hash mismatch`);
}
function oneLine(text, predicate, label) {
  const lines=text.split(/\r?\n/).filter(predicate);
  if(lines.length!==1) throw new Error(`exactly one expected ${label} required`);
  return lines[0];
}
function inside(root, candidate) {
  const rel=path.relative(root,candidate);
  return rel!=='' && rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel);
}

export function prepareOriginalSkillsAdapter(options) {
  const start=absoluteLocal(options.start,'start');
  const invoke=absoluteLocal(options.invoke,'invoke');
  const outputDir=absoluteLocal(options.outputDir,'output');
  const parent=path.dirname(outputDir);
  if (fs.existsSync(outputDir)) throw new Error('output directory must be absent; no overwrite');
  assertOrdinaryPaths([start,invoke,parent]);
  if (!fs.statSync(parent).isDirectory()) throw new Error('output parent must be an existing directory');
  if (inside(outputDir,start) || inside(outputDir,invoke) || identity(outputDir)===identity(start) || identity(outputDir)===identity(invoke)) throw new Error('output overlaps original source identity');
  verifyFile(start,options.startSha256,'start'); verifyFile(invoke,options.invokeSha256,'invoke');
  if(fs.statSync(start).size>2*1024*1024 || fs.statSync(invoke).size>2*1024*1024) throw new Error('source script exceeds bounded size');
  const startBytes=fs.readFileSync(start), invokeBytes=fs.readFileSync(invoke);
  const startText=startBytes.toString('utf8'), invokeText=invokeBytes.toString('utf8');
  if (!Buffer.from(startText).equals(startBytes) || !Buffer.from(invokeText).equals(invokeBytes)) throw new Error('scripts must be losslessly UTF-8 encoded');
  if(digest(startBytes)!==options.startSha256.toLowerCase() || digest(invokeBytes)!==options.invokeSha256.toLowerCase()) throw new Error('source hash changed during inspection');
  const manifests=[...startText.matchAll(/\$files = @'\r?\n([\s\S]*?)\r?\n'@ \| ConvertFrom-Json -AsHashtable/g)];
  if(manifests.length!==1) throw new Error('exactly one original pin manifest required');
  const files=JSON.parse(manifests[0][1]);
  if(!files || Array.isArray(files) || typeof files!=='object' || Object.keys(files).length!==7) throw new Error('original manifest must contain exactly seven artifact pins');
  const rawKeys=[...manifests[0][1].matchAll(/("(?:\\.|[^"\\])*")\s*:/g)].map(m=>JSON.parse(m[1]));
  if(rawKeys.length!==7 || new Set(rawKeys.map(identity)).size!==7) throw new Error('duplicate or ambiguous artifact pins');
  const pins=Object.entries(files).map(([file,sha256])=>({path:absoluteLocal(file,'pinned artifact'),sha256}));
  if(!pins.some(p=>identity(p.path)===identity(invoke) && String(p.sha256).toLowerCase()===options.invokeSha256.toLowerCase())) throw new Error('invoke source identity must match an original manifest pin');
  const prefix=`& ${psQuote(invoke)} `;
  const invocation=oneLine(startText,line=>line.startsWith(prefix),'invocation');
  if(!invocation.includes(' -PreparedManifest ')) throw new Error('only the pinned prepared-snapshot invocation is supported');
  const runtimeArgs=[...invocation.matchAll(/ -RuntimeRoot '((?:''|[^'])*)'/g)];
  if(runtimeArgs.length!==1) throw new Error('exactly one literal RuntimeRoot required');
  const runtimeRoot=absoluteLocal(runtimeArgs[0][1].replace(/''/g,"'"),'runtime root');
  if(pins.some(p=>!inside(runtimeRoot,p.path))) throw new Error('original artifact pin escapes the declared runtime root');
  assertOrdinaryPaths([...pins.map(p=>p.path),runtimeRoot]);
  for(const pin of pins) verifyFile(pin.path,pin.sha256,'pinned artifact');
  oneLine(invokeText,line=>line===ORIGINAL_AUDIT_LINE,'audit allocation line');
  if((invokeText.match(/^\s*\$auditPath\s*=/gm)??[]).length!==1) throw new Error('exactly one expected audit allocation required');
  if(startText.includes('$adapterFiles')) throw new Error('original Start already has an adapter pin block');

  const outputInvoke=path.join(outputDir,'Invoke-GitNexusGuardian.ps1');
  const outputStart=path.join(outputDir,'Start-OriginalSkills.ps1');
  const copiedInvoke=invokeText.replace(ORIGINAL_AUDIT_LINE,NEW_AUDIT_LINE);
  const copiedInvokeSha=digest(Buffer.from(copiedInvoke));
  const additionalPins={[start]:options.startSha256.toLowerCase(),[outputInvoke]:copiedInvokeSha};
  const eol=startText.includes('\r\n')?'\r\n':'\n';
  const extra=["$adapterFiles = @'",JSON.stringify(additionalPins),"'@ | ConvertFrom-Json -AsHashtable","foreach ($p in $adapterFiles.Keys) { if ((Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLowerInvariant() -cne $adapterFiles[$p]) { throw 'Pinned adapter artifact changed' } }"].join(eol);
  const newInvocation=`& ${psQuote(outputInvoke)} `+invocation.slice(prefix.length);
  const copiedStart=startText.replace(invocation,()=>extra+eol+newInvocation);
  const receipt={
    schema:'original-skills-connection-adapter-v1',status:'PREPARED_NOT_LAUNCHED',created_at:new Date().toISOString(),
    output_dir:outputDir,runtime_root:runtimeRoot,prepared_snapshot_only:true,
    original:{start:{path:start,sha256:options.startSha256.toLowerCase()},invoke:{path:invoke,sha256:options.invokeSha256.toLowerCase()}},
    verified_original_pins:pins,additional_pins:Object.entries(additionalPins).map(([path,sha256])=>({path,sha256})),
    generated:{start:{path:outputStart,sha256:digest(Buffer.from(copiedStart))},invoke:{path:outputInvoke,sha256:copiedInvokeSha}},
    transformation:{old_audit_line:ORIGINAL_AUDIT_LINE,new_audit_line:NEW_AUDIT_LINE,audit_replacements:1,invocation_replacements:1,original_hashchecks_preserved:true,snapshot_run_id_unchanged:true},
    effects:{originals_modified:false,runtime_launched:false,existing_processes_touched:false,partial_failure_policy:'preserve owned partial output for review; never delete originals'},
  };
  // All validation precedes the exclusive directory claim. Recheck ancestry to
  // reject observable alias swaps; this is not an OS sandbox against hostile races.
  assertOrdinaryPaths([parent,...pins.map(p=>p.path),start]);
  verifyFile(start,options.startSha256,'start');
  for(const pin of pins) verifyFile(pin.path,pin.sha256,'pinned artifact');
  fs.mkdirSync(outputDir); // no recursive creation and no overwrite
  try {
    fs.writeFileSync(outputInvoke,copiedInvoke,{flag:'wx'});
    fs.writeFileSync(outputStart,copiedStart,{flag:'wx'});
    assertOrdinaryPaths([outputInvoke,outputStart]);
    verifyFile(outputInvoke,receipt.generated.invoke.sha256,'generated invoke');
    verifyFile(outputStart,receipt.generated.start.sha256,'generated start');
    verifyFile(start,options.startSha256,'start'); verifyFile(invoke,options.invokeSha256,'invoke');
    fs.writeFileSync(path.join(outputDir,'ADAPTER_RECEIPT.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  } catch(e) { throw new Error(`owned partial output retained at ${outputDir}: ${e.message}`); }
  return receipt;
}

function cli(argv) {
  const names={'--start':'start','--start-sha256':'startSha256','--invoke':'invoke','--invoke-sha256':'invokeSha256','--output-dir':'outputDir'};
  const options={};
  for(let i=0;i<argv.length;i+=2) {
    const key=names[argv[i]];
    if(!key || argv[i+1]===undefined || options[key]!==undefined) throw new Error('usage: --start ABSOLUTE --start-sha256 SHA256 --invoke ABSOLUTE --invoke-sha256 SHA256 --output-dir ABSENT_ABSOLUTE_OWNED_DIR');
    options[key]=argv[i+1];
  }
  if(Object.keys(options).length!==5) throw new Error('all five explicit source/hash/output arguments are required');
  return prepareOriginalSkillsAdapter(options);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(cli(process.argv.slice(2)),null,2)+'\n'); }
  catch(e) { process.stderr.write(`prepare-original-skills-adapter: ${e.message}\n`); process.exitCode=1; }
}
