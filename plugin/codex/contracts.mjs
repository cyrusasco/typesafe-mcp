import crypto from 'node:crypto';

export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function requireThat(value, reason) { if (!value) throw new Error(reason); }
export function text(value, label, max = 4000) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= max, `${label}: nonempty string <=${max} required`);
  return value;
}
export function id(value, label = 'id') { text(value, label, 160); requireThat(/^[a-zA-Z0-9_.:-]+$/.test(value) && !['__proto__','constructor','prototype'].includes(value), `${label}: invalid identity`); return value; }
// Native host task paths are opaque routing identities, never filesystem keys.
export function nativeId(value) {
  text(value, 'native identity', 512);
  const parts = value.startsWith('/') ? value.slice(1).split('/') : [value];
  requireThat(parts.every(p => /^[a-zA-Z0-9_.:-]+$/.test(p) && !['.','..','__proto__','constructor','prototype'].includes(p)), 'native identity: invalid identity');
  return value;
}
export function bounded(value, label, max = 48000) { requireThat(Buffer.byteLength(JSON.stringify(value)) <= max, `${label}: size budget exceeded; provide a smaller complete scope`); }
export function fresh(value, now, label) {
  const at = Date.parse(value); requireThat(Number.isFinite(at) && at <= now + 30000 && now - at <= 300000, `${label}: stale or invalid observation`);
}
export function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) =>
    [k, /^(authorization|cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(k) ? '[REDACTED]' : sanitize(v)]));
  if (typeof value === 'string') return value
    .replace(/\b(Bearer\s+)[\w.+\/-]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-|ghp_|github_pat_)[a-zA-Z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/((?:API_KEY|ACCESS_TOKEN|PASSWORD|SECRET)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
  return value;
}
export function validateKey(key) { for (const k of ['project_id', 'task_id', 'turn_id']) id(key?.[k], k); return key; }
export function validatePlan(plan) {
  bounded(plan, 'plan', 16000); requireThat(plan?.language === 'en', 'plan language must be en (parent supplies English translation)');
  requireThat(Number.isInteger(plan.version) && plan.version > 0, 'plan version required');
  text(plan.original_intent, 'original_intent'); text(plan.goal, 'goal'); text(plan.revision, 'revision');
  requireThat(Array.isArray(plan.constraints), 'constraints required'); plan.constraints.forEach(x => text(x, 'constraint'));
  requireThat(Array.isArray(plan.subtasks) && plan.subtasks.length > 0 && plan.subtasks.length <= 12, '1..12 subtasks required');
  const seen = new Set();
  for (const s of plan.subtasks) {
    id(s.id); requireThat(!seen.has(s.id), 'duplicate subtask'); seen.add(s.id); text(s.goal, 'subtask goal');
    requireThat(Array.isArray(s.write_scope) && Array.isArray(s.acceptance) && s.acceptance.length > 0, 'scope and acceptance required');
    [...s.write_scope, ...s.acceptance].forEach(x => text(x, 'scope/acceptance'));
    requireThat(Array.isArray(s.depends_on) && s.depends_on.every(x => seen.has(x) && x !== s.id), 'dependencies must reference earlier subtasks (topological order)');
  }
}
export function routesFrom(cap, now) {
  fresh(cap?.observed_at, now, 'capabilities'); text(cap.source, 'capability source');
  requireThat(Array.isArray(cap.models) && cap.models.length > 0 && Array.isArray(cap.roles) && cap.roles.length > 0, 'live models/roles required');
  const routes = []; const seen = new Set();
  for (const m of cap.models) {
    id(m.id, 'model'); text(m.tier, 'tier', 40); requireThat(Array.isArray(m.efforts) && m.efforts.length, 'supported efforts required');
    for (const effort of m.efforts) for (const role of cap.roles) {
      id(effort); id(role);
      const key = `${m.id}/${effort}/${role}`; requireThat(!seen.has(key), 'duplicate route'); seen.add(key);
      routes.push({ id: `route_${routes.length}`, model_id: m.id, tier: m.tier, reasoning_effort: effort, role,
        ...(m.description === undefined ? {} : { model_description: text(m.description, 'host model description', 512) }) });
    }
  }
  requireThat(routes.length <= 192, 'reduce relevant live model/effort/role candidates to <=192 combinations');
  return routes;
}
export function choice(answers, key, allowed) {
  const a = answers?.[key]; requireThat(allowed.includes(a?.choice) && Number.isFinite(a.confidence) && a.confidence >= 0.75 && a.confidence <= 1,
    `Jev ${key}: unknown choice or insufficient confidence; parent inspection required`); return a.choice;
}
export function validateEvidence(e) {
  const hash = h => typeof h === 'string' && /^[a-f0-9]{64}$/.test(h);
  requireThat(e && hash(e.diff_sha256) && typeof e.revision === 'string' && e.revision.length > 0, 'evidence: diff hash and revision required');
  bounded(e, 'evidence');
  requireThat(Array.isArray(e.changed_files) && Array.isArray(e.covered_files) &&
    e.changed_files.every(f => typeof f === 'string' && e.covered_files.includes(f)) &&
    new Set(e.changed_files).size === e.changed_files.length, 'evidence: full changed-file coverage required');
  requireThat(Array.isArray(e.tests) && e.tests.length > 0 && e.tests.every(t => typeof t.command === 'string' && t.command.trim() && t.exit_code === 0 && hash(t.output_sha256)), 'evidence: passing test commands, exits and raw output hashes required');
  requireThat(Array.isArray(e.unresolved) && e.unresolved.length === 0, 'evidence: unresolved work');
  requireThat(Array.isArray(e.evidence_refs) && e.evidence_refs.length > 0 && e.evidence_refs.every(x => typeof x === 'string' && x.trim()), 'evidence: artifact references required');
}
