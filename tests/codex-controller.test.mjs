import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Controller } from '../plugin/codex/controller.mjs';
import { digest } from '../plugin/codex/contracts.mjs';

function fixture(t, answers = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-controller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = { project_id: 'repo', task_id: 'task', turn_id: 'turn' };
  const now = Date.now();
  const context = { project_id: 'repo', revision: 'rev', observed_at: new Date(now).toISOString(),
    skills: [{ id: 'testing', name: 'testing', path: '/fixture/SKILL.md', sha256: 'a'.repeat(64) }],
    graph: { source: 'fixture-gitnexus', revision: 'rev', results: [{ ref: 'symbol:test' }] } };
  const plan = { language: 'en', version: 1, original_intent: '修好測試', goal: 'Fix tests', revision: 'rev',
    constraints: ['No production writes'], subtasks: [{ id: 'fix', goal: 'Fix failing unit tests',
      write_scope: ['src/'], acceptance: ['Regression passes'], depends_on: [] }] };
  const capabilities = { observed_at: new Date(now).toISOString(), source: 'fixture native schema',
    models: [{ id: 'model-luna', tier: 'LUNA', efforts: ['high'] }], roles: ['worker'] };
  const calls = [];
  const ask = async (request) => { calls.push(request); return { mode: 'normal', call_id: `call-${calls.length}`,
    answers: Object.fromEntries(Object.keys(request.questions).map(k => [k, answers[k] ??
      (k === 'hardness' ? { choice: 'moderate', confidence: 0.9 } :
       k === 'assignment' ? { choice: 'route_0', confidence: 0.9 } :
       k === 'skill_testing' ? { noul: 0.9 } : { choice: 'continue', confidence: 0.9 })])) }; };
  const c = new Controller({ root, ask, now: () => now, collect: async () => context });
  return { c, key, plan, capabilities, context, calls, root };
}
async function ready(f) {
  const r = await f.c.plan({ key: f.key, plan: f.plan, capabilities: f.capabilities,
    context_input: {}, egress: { approved: true, data_class: 'open', provider: 'typesafe' } });
  return r;
}
async function running(f) {
  let r = await ready(f);
  const id = r.pending[0].id;
  await f.c.claim({ key: f.key, action_id: id });
  r = await f.c.ack({ key: f.key, action_id: id, receipt: { ok: true, native_agent_id: 'native-1', evidence_ref: 'spawn:1' } });
  await f.c.claim({ key: f.key, action_id: r.pending[0].id });
  await f.c.ack({ key: f.key, action_id: r.pending[0].id, receipt: { ok: true, native_agent_id: 'native-1', evidence_ref: 'start:1' } });
}
test('plan asks Jev for hardness, native route and Skill; spawn stays inert until explicit binding', async t => {
  const f = fixture(t); const r = await ready(f);
  assert.equal(f.calls.length, 1); assert.equal(r.pending[0].kind, 'spawn');
  assert.match(r.pending[0].message, /WAIT/);
  assert.equal(r.subtasks.fix.assignment.model_id, 'model-luna');
  assert.equal(r.subtasks.fix.assignment.tier, 'LUNA');
  assert.equal(r.subtasks.fix.skills[0].id, 'testing');
  assert.equal(r.subtasks.fix.status, 'awaiting_spawn');
});
test('missing egress, stale capabilities, unavailable Jev and unknown routes never dispatch', async t => {
  const f = fixture(t);
  await assert.rejects(f.c.plan({ key: f.key, plan: f.plan, capabilities: f.capabilities, context_input: {} }), /egress/);
  f.capabilities.observed_at = '2000-01-01T00:00:00Z';
  await assert.rejects(ready(f), /stale/);
  const g = fixture(t, { assignment: { choice: 'invented-model', confidence: 1 } });
  await assert.rejects(ready(g), /assignment/);
  const h = fixture(t); h.c.ask = async () => ({ mode: 'degraded', reason: 'no_key' });
  await assert.rejects(ready(h), /no_key/);
});
test('event correction requires exact interrupt receipt then same-child followup', async t => {
  const f = fixture(t, { disposition: { choice: 'correct', confidence: 0.95 } }); await running(f);
  const event = { id: 'e1', native_agent_id: 'native-1', subtask_id: 'fix', phase: 'post',
    kind: 'tool', summary: 'Edited outside assigned scope', evidence_refs: ['diff:1'] };
  let r = await f.c.event({ key: f.key, event });
  assert.equal(r.pending[0].kind, 'interrupt'); assert.equal(r.pending[0].native_agent_id, 'native-1');
  assert.equal(r.subtasks.fix.status, 'pause_requested');
  const n = f.calls.length; const replay = await f.c.event({ key: f.key, event });
  assert.equal(replay.pending[0].id, r.pending[0].id); assert.equal(f.calls.length, n);
  await f.c.claim({ key: f.key, action_id: r.pending[0].id });
  await assert.rejects(f.c.ack({ key: f.key, action_id: r.pending[0].id,
    receipt: { ok: true, native_agent_id: 'WRONG', evidence_ref: 'stop:1' } }), /identity/);
  r = await f.c.ack({ key: f.key, action_id: r.pending[0].id,
    receipt: { ok: true, native_agent_id: 'native-1', evidence_ref: 'stop:1' } });
  assert.equal(r.pending[0].kind, 'followup'); assert.match(r.pending[0].message, /diff:1/);
  await f.c.claim({ key: f.key, action_id: r.pending[0].id });
  await f.c.ack({ key: f.key, action_id: r.pending[0].id,
    receipt: { ok: true, native_agent_id: 'native-1', evidence_ref: 'correct:1' } });
  assert.equal((await f.c.report({ key: f.key })).subtasks.fix.corrections, 1);
});
test('no verdict-only acceptance; complete changed-file and test evidence plus parent review required', async t => {
  const f = fixture(t); await running(f);
  await f.c.event({ key: f.key, event: { id: 'progress1', native_agent_id: 'native-1', subtask_id: 'fix', phase: 'post', kind: 'test', summary: 'Ran regression', evidence_refs: ['test:raw'] } });
  await assert.rejects(f.c.complete({ key: f.key, subtask_id: 'fix', native_agent_id: 'native-1', evidence: { verdict: 'pass' } }), /evidence/);
  const evidence = { revision: 'new-rev', diff_sha256: digest('diff'), changed_files: ['src/test.js'],
    covered_files: ['src/test.js'], tests: [{ command: 'node --test', exit_code: 0, output_sha256: digest('ok') }],
    unresolved: [], evidence_refs: ['diff:full', 'test:raw'] };
  let r = await f.c.complete({ key: f.key, subtask_id: 'fix', native_agent_id: 'native-1', evidence });
  assert.equal(r.status, 'AWAITING_PARENT_REVIEW');
  assert.equal(r.live_verified, false);
  r = await f.c.finalize({ key: f.key, evidence_hash: r.evidence_hash, reviewer: 'parent', findings: [], evidence_refs: ['review:1'] });
  assert.equal(r.status, 'ACCEPTED_RECORDED_SCOPE');
});
test('state survives restart, namespaces isolated, changed replay rejected', async t => {
  const f = fixture(t); await running(f);
  const event = { id: 'evt', native_agent_id: 'native-1', subtask_id: 'fix', phase: 'pre', kind: 'progress', summary: 'Testing', evidence_refs: ['log:1'] };
  await f.c.event({ key: f.key, event });
  await assert.rejects(f.c.event({ key: f.key, event: { ...event, summary: 'Other' } }), /replay/);
  const c = new Controller({ root: f.root, ask: f.c.ask });
  assert.equal((await c.report({ key: f.key })).subtasks.fix.native_agent_id, 'native-1');
  await assert.rejects(c.report({ key: { ...f.key, task_id: 'other' } }), /ENOENT/);
});


test('unclaimed acknowledgment rejected; claimed replay is idempotent and conflicting replay fails', async t => {
  const f = fixture(t); const r = await ready(f); const action_id = r.pending[0].id;
  const receipt = { ok:true, native_agent_id:'native-1', evidence_ref:'spawn:1' };
  await assert.rejects(f.c.ack({key:f.key,action_id,receipt}), /claimed/);
  await f.c.claim({key:f.key,action_id});
  await assert.rejects(f.c.claim({key:f.key,action_id}), /already claimed/);
  await f.c.ack({key:f.key,action_id,receipt});
  await f.c.ack({key:f.key,action_id,receipt});
  await assert.rejects(f.c.ack({key:f.key,action_id,receipt:{...receipt,evidence_ref:'different'}}), /conflicting/);
});
test('prototype-like event id is treated as a first event and normal replay', async t => {
  const f = fixture(t); await running(f);
  const event={id:'toString',native_agent_id:'native-1',subtask_id:'fix',phase:'post',kind:'test',summary:'Ran tests',evidence_refs:['test:raw']};
  await f.c.event({key:f.key,event}); const count=f.calls.length;
  await f.c.event({key:f.key,event}); assert.equal(f.calls.length,count);
});
test('completion correction is durable and queues an interrupt instead of throwing/losing the judgement', async t => {
  const f = fixture(t); await running(f);
  await f.c.event({key:f.key,event:{id:'e',native_agent_id:'native-1',subtask_id:'fix',phase:'post',kind:'test',summary:'Tests run',evidence_refs:['test:1']}});
  f.c.ask=async()=>({mode:'normal',call_id:'negative-completion',answers:{disposition:{choice:'correct',confidence:0.99}}});
  const r=await f.c.complete({key:f.key,subtask_id:'fix',native_agent_id:'native-1',evidence:{revision:'r2',diff_sha256:digest('diff'),changed_files:['a'],covered_files:['a'],tests:[{command:'node --test',exit_code:0,output_sha256:digest('test')}],unresolved:[],evidence_refs:['raw:1']}});
  assert.equal(r.pending[0].kind,'interrupt'); assert.equal(r.subtasks.fix.status,'pause_requested');
  assert.ok(Object.values(r.events).some(e=>e.call_id==='negative-completion'&&e.verdict==='correct'));
});
test('native bridge prioritizes interrupt ahead of unrelated spawn failure', async t => {
  const {deliverPending}=await import('../plugin/codex/native-bridge.mjs');
  const f=fixture(t); await running(f);
  await f.c.store.transaction(f.key,s=>{ s.subtasks.other={id:'other',spec:{depends_on:[]},assignment:s.subtasks.fix.assignment,status:'awaiting_spawn'};
    s.pending.push({id:'other-spawn',kind:'spawn',subtask_id:'other',assignment:s.subtasks.fix.assignment,message:'WAIT'}); return s; });
  f.c.ask=async()=>({mode:'normal',call_id:'offscope',answers:{disposition:{choice:'correct',confidence:0.99}}});
  await f.c.event({key:f.key,event:{id:'e',native_agent_id:'native-1',subtask_id:'fix',phase:'post',kind:'tool',summary:'Outside scope',evidence_refs:['diff:1']}});
  const seen=[];
  await assert.rejects(deliverPending(f.c,f.key,{
    interrupt:async args=>{seen.push('interrupt:'+args.target);return {ok:true,native_agent_id:args.target,evidence_ref:'native:stop'};},
    spawn:async()=>{seen.push('spawn');throw new Error('max concurrency reached');},
    followup:async()=>{throw new Error('should not reach');}
  }),/max concurrency/);
  assert.equal(seen[0],'interrupt:native-1'); assert.equal((await f.c.report({key:f.key})).subtasks.fix.status,'paused');
});
test('unknown Jev output and unavailable monitoring stop work rather than silently proceeding', async t => {
  const f=fixture(t); await running(f); f.c.ask=async()=>({mode:'degraded',reason:'no_key'});
  const r=await f.c.event({key:f.key,event:{id:'lost',native_agent_id:'native-1',subtask_id:'fix',phase:'progress',kind:'tool',summary:'Progress',evidence_refs:['log:1']}});
  assert.equal(r.pending[0].kind,'interrupt'); assert.equal(r.events.lost.verdict,'inspect');
  assert.match(r.events.lost.reason,/no_key/);
});
test('correction limit and time budget escalate without replacing child', async t => {
  const f=fixture(t,{disposition:{choice:'correct',confidence:0.99}}); await running(f);
  await f.c.store.transaction(f.key,s=>{s.subtasks.fix.corrections=2;return s;});
  const r=await f.c.event({key:f.key,event:{id:'third',native_agent_id:'native-1',subtask_id:'fix',phase:'post',kind:'tool',summary:'Still deviates',evidence_refs:['diff:3']}});
  assert.equal(r.events.third.verdict,'escalate'); assert.equal(r.pending[0].purpose,'inspect');
});
test('dependencies wait for predecessor evidence; scopes and reserved IDs reject malformed plans', async t => {
  const f=fixture(t); f.plan.subtasks.push({id:'review',goal:'Review changes',write_scope:[],acceptance:['Review complete'],depends_on:['fix']});
  const r=await ready(f); assert.equal(r.pending.length,1); assert.equal(r.subtasks.review.status,'queued');
  const g=fixture(t);g.plan.subtasks[0].id='__proto__';await assert.rejects(ready(g),/invalid identity/);
});
test('exclusive state lock rejects concurrent mutation and is released on exceptions', async t => {
  const f=fixture(t);await ready(f);
  let release; const blocked=new Promise(r=>{release=r}); let entered;
  const started=new Promise(r=>{entered=r});
  const first=f.c.store.transaction(f.key,async s=>{entered();await blocked;return s;});await started;
  await assert.rejects(f.c.store.transaction(f.key,s=>s),/state busy/);
  release();await first;
  await assert.rejects(f.c.store.transaction(f.key,()=>{throw new Error('fixture-error');}),/fixture-error/);
  await f.c.store.transaction(f.key,s=>s);
});

test('completion generated event never overwrites a host progress ID', async t=>{
 const f=fixture(t);await running(f);
 const event={id:'completion_3',native_agent_id:'native-1',subtask_id:'fix',phase:'post',kind:'test',summary:'Preserve raw progress',evidence_refs:['test:before']};
 await f.c.event({key:f.key,event});
 f.c.ask=async()=>({mode:'normal',call_id:'negative-completion',answers:{disposition:{choice:'correct',confidence:0.99}}});
 const r=await f.c.complete({key:f.key,subtask_id:'fix',native_agent_id:'native-1',evidence:{revision:'r2',diff_sha256:digest('diff'),changed_files:['a'],covered_files:['a'],tests:[{command:'node --test',exit_code:0,output_sha256:digest('test')}],unresolved:[],evidence_refs:['raw:1']}});
 assert.equal(r.events.completion_3.summary,'Preserve raw progress');assert.equal(Object.keys(r.events).length,2);
 await f.c.event({key:f.key,event});
});

test('expired run queues pause without another Jev request',async t=>{
 const f=fixture(t);await running(f);const calls=f.calls.length;
 await f.c.store.transaction(f.key,s=>{s.created_at-=31*60*1000;return s;});
 const r=await f.c.event({key:f.key,event:{id:'expired',native_agent_id:'native-1',subtask_id:'fix',phase:'progress',kind:'progress',summary:'Still working',evidence_refs:['log:late']}});
 assert.equal(r.events.expired.verdict,'escalate');assert.equal(r.pending[0].kind,'interrupt');assert.equal(f.calls.length,calls);
});
