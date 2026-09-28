import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Controller } from './controller.mjs';
import { sanitize } from './contracts.mjs';

// No installation, account discovery, inherited Claude credential fallback or CLI launch.
// Only this TypeSafe-specific data directory is used for user-entered API credentials.
const home = process.env.TYPESAFE_DATA_DIR || path.join(os.homedir(), '.codex', 'typesafe');
process.env.TYPESAFE_DATA_DIR = home;
const server = await import('../server.mjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const patternFile = path.join(here, '..', 'patterns.json');
function config() {
  // Explicit packaged immutable defaults; malformed user override still fails closed.
  let cfg;
  if (fs.existsSync(path.join(home, 'patterns.json'))) cfg = server.loadConfig();
  else {
    const raw = JSON.parse(fs.readFileSync(patternFile, 'utf8'));
    const compile = (rules, global) => rules.map(r => ({ name: r.name, re: new RegExp(r.pattern, [...new Set((r.flags || '') + (global ? 'g' : ''))].join('')) }));
    const num = (v,d) => Number.isFinite(Number(v)) && Number(v)>0 ? Number(v) : d;
    cfg = { key: server.resolveApiKey(), model: process.env.TYPESAFE_MODEL || 'jev-latest',
      ledgerDir: path.join(home, 'ledger'), cap: num(process.env.TYPESAFE_DAILY_TOKEN_CAP,200000),
      timeoutMs: num(process.env.TYPESAFE_TIMEOUT_MS,5000), maxRetries: 0,
      url: 'https://api.typesafe.ai/v1/systemone', patterns: { redaction: compile(raw.redaction.regexes,true), destructive: compile(raw.destructive.regexes,false) } };
  }
  return cfg;
}
const keySchema = { type: 'object', properties: Object.fromEntries(['project_id','task_id','turn_id'].map(k => [k,{type:'string'}])), required: ['project_id','task_id','turn_id'], additionalProperties: false };
const methods = {
  plan: ['plan','capabilities','context_input','egress'], claim: ['action_id'], ack: ['action_id','receipt'],
  event: ['event'], complete: ['subtask_id','native_agent_id','evidence'], report: [],
  finalize: ['evidence_hash','reviewer','findings','evidence_refs'],
};
const descriptions = {
  plan: 'Parent-only: submit English plan, fresh native model/Skill metadata and matching GitNexus context; explicit locally classified egress approval required. Jev chooses each route and Skills. Persists pending native actions; does not spawn them.',
  claim: 'Parent-only: persist intent BEFORE a native action. Claimed actions must not be replayed after ambiguous outcomes; reconcile evidence.',
  ack: 'Parent-only: record actual successful native action evidence and exact agent identity. Interrupt confirmation is required before same-child correction.',
  event: 'Parent-only: feed bounded progress/pre/post evidence while child runs. Jev judgement queues pause/correction; host must immediately service pending actions. Post observations are not prevention.',
  complete: 'Parent-only: submit full change coverage and passing raw test evidence references for Jev review; never accepts verdict-only reports.',
  report: 'Read scoped routing, monitoring, correction and native-receipt state. No live verification inference.',
  finalize: 'Parent-only: record independent parent review of the exact evidence hash. Does not verify the host assertions itself.',
};
export const CODEX_TOOLS = Object.entries(methods).map(([method, required]) => ({ name: `ts_codex_${method}`, description: descriptions[method],
  inputSchema: { type: 'object', properties: { key: keySchema, ...Object.fromEntries(required.map(k => [k, ['action_id','subtask_id','native_agent_id','evidence_hash','reviewer'].includes(k) ? {type:'string'} : ['findings','evidence_refs'].includes(k) ? {type:'array'} : {type:'object'}])) }, required: ['key',...required], additionalProperties: false }, method }));
export async function handleCodex(msg) {
  const reply = result => ({ jsonrpc:'2.0', id:msg.id, result });
  if (msg.id === undefined) return null;
  if (msg.method === 'initialize') return reply({ protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:'typesafe-codex',version:'1.9.0'} });
  if (msg.method === 'ping') return reply({});
  if (msg.method === 'tools/list') return reply({ tools: [
    { name:'ts_codex_health', description:'Local status only. Reports TypeSafe key presence, not values; no API or provider authentication test.', inputSchema:{type:'object',properties:{}} },
    ...CODEX_TOOLS.map(({method,...tool}) => tool) ] });
  if (msg.method !== 'tools/call') return {jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Method not found'}};
  try {
    const name = msg.params?.name;
    let result;
    if (name === 'ts_codex_health') result = { has_key: Boolean(server.resolveApiKey()), configured_only:true, authenticated:'NOT_VERIFIED', version:'1.9.0' };
    else {
      const tool = CODEX_TOOLS.find(t => t.name === name); if (!tool) throw new Error('unknown Codex tool');
      const c = new Controller({ root: process.env.TYPESAFE_CODEX_STATE_DIR || path.join(home,'codex-state'), ask: args => server.tsAsk(args, config()) });
      result = await c[tool.method](msg.params.arguments ?? {});
    }
    return reply({content:[{type:'text',text:JSON.stringify(sanitize(result))}]});
  } catch (e) { return reply({isError:true, content:[{type:'text',text:JSON.stringify({status:'BLOCKED',reason:sanitize(String(e.message))})}]}); }
}
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const input = createInterface({input:process.stdin, crlfDelay:Infinity});
  // Serialize control requests so event/ack order is not changed by RPC concurrency.
  for await (const line of input) {
    if (Buffer.byteLength(line)>128000) { process.stderr.write('request exceeds bounded input size\n'); continue; }
    try { const out = await handleCodex(JSON.parse(line)); if (out) process.stdout.write(JSON.stringify(out)+'\n'); }
    catch { process.stderr.write('invalid JSON-RPC input\n'); }
  }
}
