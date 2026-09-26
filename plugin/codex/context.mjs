/**
 * Bounded, read-only context for the Codex/Jev host bridge.
 *
 * This module never discovers credentials, scans a home/cache, creates an index,
 * or makes a network request. The host supplies fresh inventory/query snapshots.
 * Their timestamps, repository identity and provenance are validated as claims,
 * not authenticated by this module. Only the selected SKILL.md bytes are checked
 * locally. Graph rows and Skill descriptions remain untrusted data, not policy.
 */
import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const MAX_JSON_BYTES = 48 * 1024;
const MAX_SKILL_BYTES = 64 * 1024;
const MAX_SKILLS = 256;
const MAX_GRAPH_RESULTS = 128;
const READ_OPERATIONS = new Set(['list_repos', 'query', 'context']);
const SECRET_KEY = /^(?:authorization|proxy_authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|cookie|set_cookie)$/i;
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class ContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ContextError';
    this.code = code;
  }
}

function fail(code, message) { throw new ContextError(code, message); }

function object(value, label, code = 'INVALID_JSON') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail(code, `${label} must be a plain JSON object`);
  }
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!Object.hasOwn(descriptor, 'value')) fail('INVALID_JSON', `${label} must not contain accessors`);
  }
  if (Object.getOwnPropertySymbols(value).length) fail('INVALID_JSON', `${label} must not contain symbol properties`);
  return value;
}

function text(value, label, max = 256, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim())) fail('INVALID_FIELD', `${label} must be text`);
  if (Buffer.byteLength(value, 'utf8') > max) fail('TEXT_TOO_LARGE', `${label} exceeds its UTF-8 text limit`);
  if (/[\u0000-\u001f\u007f]/.test(value)) fail('INVALID_FIELD', `${label} contains control characters`);
  return value;
}

function cleanString(value) {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

/** Clone JSON without invoking getters/toJSON; reject loss rather than truncate. */
function boundedJson(value, { sanitize = false, maxBytes = MAX_JSON_BYTES } = {}) {
  let count = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    if (depth > 16 || ++count > 4096) fail('INVALID_JSON', 'JSON nesting or node count exceeds its bound');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item === 'string') {
      if (Buffer.byteLength(item, 'utf8') > 8192) fail('TEXT_TOO_LARGE', 'A JSON string exceeds its UTF-8 text limit');
      return sanitize ? cleanString(item) : item;
    }
    if (typeof item !== 'object' || ancestors.has(item)) fail('INVALID_JSON', 'Evidence must contain acyclic JSON values');
    ancestors.add(item);
    let out;
    if (Array.isArray(item)) {
      // JSON arrays must be dense and have no custom properties/accessors.
      const descriptors = Object.getOwnPropertyDescriptors(item);
      if (Object.getOwnPropertySymbols(item).length || Object.keys(descriptors).length !== item.length + 1) fail('INVALID_JSON', 'Invalid JSON array');
      out = [];
      for (let i = 0; i < item.length; i++) {
        const descriptor = descriptors[i];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('INVALID_JSON', 'Invalid JSON array element');
        out.push(visit(descriptor.value, depth + 1));
      }
    } else {
      object(item, 'Evidence');
      out = {};
      for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
        if (!descriptor.enumerable || UNSAFE_KEYS.has(key) || /[\u0000-\u001f\u007f]/.test(key) || Buffer.byteLength(key) > 256) {
          fail('INVALID_JSON', 'Evidence contains an invalid property');
        }
        const child = visit(descriptor.value, depth + 1);
        out[key] = sanitize && SECRET_KEY.test(key) ? '[REDACTED]' : child;
      }
    }
    ancestors.delete(item);
    return out;
  }
  const result = visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) fail('CONTEXT_TOO_LARGE', 'JSON exceeds the 48 KiB context limit');
  return result;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('INVALID_TIMESTAMP', `${label} must be an ISO UTC timestamp`);
  }
  const parsed = Date.parse(value);
  const normalized = value.includes('.') ? value.replace(/\.(\d{1,3})Z$/, (_, fraction) => `.${fraction.padEnd(3, '0')}Z`) : value.replace(/Z$/, '.000Z');
  if (new Date(parsed).toISOString() !== normalized) fail('INVALID_TIMESTAMP', `${label} is not a valid calendar timestamp`);
  return parsed;
}

function freshness(value, now, maxAgeMs, label) {
  const at = timestamp(value, `${label}.observed_at`);
  if (at > now) fail('FUTURE_CONTEXT', `${label} claims a future observation`);
  if (now - at > maxAgeMs) fail('STALE_CONTEXT', `${label} is older than the admitted freshness window`);
  return new Date(at).toISOString();
}

function source(value, allowed, label) {
  object(value, label, 'INVALID_SOURCE');
  if (typeof value.name !== 'string' || !value.name.trim() || typeof value.operation !== 'string' || !allowed.includes(value.operation)) {
    fail('INVALID_SOURCE', `${label} requires a name and an admitted read-only operation`);
  }
  text(value.name, `${label}.name`);
  const cloned = boundedJson(value, { sanitize: true });
  if (Buffer.byteLength(JSON.stringify(cloned)) > 2048) fail('INVALID_SOURCE', `${label} metadata is too large`);
  return cloned;
}

function graphIdentity(graph, project_id, revision) {
  const scope = Object.hasOwn(graph, 'scope') ? graph.scope : 'project';
  if (scope !== 'project' && scope !== 'skill_corpus') fail('INVALID_GRAPH_SCOPE', 'Graph scope must be project or skill_corpus');
  if (scope === 'project') {
    if (Object.hasOwn(graph, 'corpus_id') || Object.hasOwn(graph, 'provenance_sha256')) {
      fail('GRAPH_SCOPE_MISMATCH', 'Corpus identity must not be presented as a project graph');
    }
    if (graph.project_id !== project_id || graph.revision !== revision) fail('IDENTITY_MISMATCH', 'Graph project/revision does not match this context request');
    return { scope, project_id, revision };
  }
  if (Object.hasOwn(graph, 'project_id')) fail('GRAPH_SCOPE_MISMATCH', 'A Skill corpus must have its own corpus_id, not a project_id');
  const corpus_id = text(graph.corpus_id, 'gitnexus.corpus_id');
  const corpusRevision = text(graph.revision, 'gitnexus.revision');
  if (typeof graph.provenance_sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(graph.provenance_sha256)) {
    fail('INVALID_CORPUS_PROVENANCE', 'A Skill corpus requires a 64-hex provenance_sha256');
  }
  // This is a validated host-provided provenance claim, not a verification of
  // the corpus/index bytes. Never replace its revision with the target HEAD.
  return { scope, corpus_id, revision: corpusRevision, provenance_sha256: graph.provenance_sha256 };
}

function skillName(content) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!match) fail('INVALID_SKILL_METADATA', 'SKILL.md requires YAML frontmatter');
  const names = match[1].split(/\r?\n/).filter(line => /^(?:name|"name"|'name')\s*:/.test(line));
  if (names.length !== 1 || !/^name\s*:/.test(names[0])) fail('INVALID_SKILL_METADATA', 'SKILL.md requires exactly one unquoted top-level name key');
  let value = names[0].replace(/^name\s*:\s*/, '').trim();
  try {
    if (value.startsWith('"')) value = JSON.parse(value);
    else if (value.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(value)) throw new Error();
      value = value.slice(1, -1).replace(/''/g, "'");
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
      if (/^[!&*>|[\]{}]/.test(value)) throw new Error();
    }
    return text(value, 'SKILL.md name', 256);
  } catch { fail('INVALID_SKILL_METADATA', 'SKILL.md name must be one bounded scalar'); }
}

async function verifySkill(skill) {
  const selected = text(skill.path, 'Skill path', 4096);
  if (!path.isAbsolute(selected) || path.basename(selected) !== 'SKILL.md') fail('INVALID_SKILL_PATH', 'Skill path must be an absolute SKILL.md path');
  let handle;
  try {
    const canonical = await realpath(selected);
    if (path.basename(canonical) !== 'SKILL.md') fail('INVALID_SKILL_PATH', 'The canonical target must also be SKILL.md');
    handle = await open(canonical, 'r');
    const before = await handle.stat();
    if (!before.isFile()) fail('INVALID_SKILL_PATH', 'SKILL.md must be a regular file');
    if (before.size > MAX_SKILL_BYTES) fail('SKILL_TOO_LARGE', 'SKILL.md exceeds the 64 KiB file limit');
    // Bounded read also covers a file that grows between stat and read.
    const buffer = Buffer.alloc(MAX_SKILL_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > MAX_SKILL_BYTES) fail('SKILL_TOO_LARGE', 'SKILL.md exceeds the 64 KiB file limit');
    const after = await handle.stat();
    const current = await stat(canonical);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || before.dev !== after.dev ||
        current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs || current.ino !== after.ino || current.dev !== after.dev || canonical !== await realpath(selected)) {
      fail('SKILL_CHANGED_DURING_READ', 'SKILL.md changed during observation');
    }
    const bytes = buffer.subarray(0, used);
    let body;
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('INVALID_SKILL_METADATA', 'SKILL.md is not valid UTF-8'); }
    if (skillName(body) !== skill.name) fail('SKILL_NAME_MISMATCH', 'The live Skill name does not match SKILL.md frontmatter');
    return { path: canonical, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch (error) {
    if (error instanceof ContextError) throw error;
    fail('SKILL_READ_FAILED', 'The selected SKILL.md could not be read');
  } finally { await handle?.close(); }
}

/**
 * Each source is {name, operation, ...hostProvenance}. Skill source operation is
 * skills/list; graph operation is query or context. Default/explicit project
 * scope requires the exact target project_id/revision. A skill_corpus scope
 * instead requires its own corpus_id/revision/provenance_sha256 and must omit
 * project_id. Its evidence is about that frozen Skill corpus, never target code
 * coverage, Skill availability, or a permission grant. Empty inventories remain
 * empty. Host provenance claims are not independently authenticated here.
 * maxAgeMs is bounded to one hour and defaults to five minutes.
 */
export async function collectContext(input) {
  object(input, 'Context input');
  object(input.liveSkills, 'liveSkills');
  object(input.gitnexus, 'gitnexus');
  if (!Array.isArray(input.liveSkills.skills)) fail('INVALID_FIELD', 'liveSkills.skills must be an array');
  if (!Array.isArray(input.gitnexus.results)) fail('INVALID_FIELD', 'gitnexus.results must be an array');
  if (input.liveSkills.skills.length > MAX_SKILLS) fail('TOO_MANY_SKILLS', 'The live inventory exceeds 256 candidates');
  if (input.gitnexus.results.length > MAX_GRAPH_RESULTS) fail('TOO_MANY_GRAPH_RESULTS', 'The graph snapshot exceeds 128 results');
  const maxAgeMs = input.maxAgeMs ?? 300000;
  if (!Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || maxAgeMs > 3600000) fail('INVALID_FIELD', 'maxAgeMs must be between one millisecond and one hour');
  const now = input.now === undefined ? Date.now() : typeof input.now === 'number' ? input.now : timestamp(input.now, 'now');
  if (!Number.isSafeInteger(now) || now < 0 || now > 8640000000000000) fail('INVALID_TIMESTAMP', 'now is outside the supported time range');
  const project_id = text(input.project_id, 'project_id');
  const revision = text(input.revision, 'revision');
  // Preserve identity/path bytes. Sanitize only the emitted metadata, after the
  // raw payload has passed bounds, so redaction cannot hide an oversized input.
  const snapshots = boundedJson({ liveSkills: input.liveSkills, gitnexus: input.gitnexus });
  const { liveSkills, gitnexus } = snapshots;
  const identity = graphIdentity(gitnexus, project_id, revision);
  const skillsObserved = freshness(liveSkills.observed_at, now, maxAgeMs, 'liveSkills');
  const graphObserved = freshness(gitnexus.observed_at, now, maxAgeMs, 'gitnexus');
  const skillsSource = source(liveSkills.source, ['skills/list'], 'liveSkills.source');
  const graphSource = source(gitnexus.source, ['query', 'context'], 'gitnexus.source');
  const ids = new Set(), names = new Set();
  // Validate the full candidate set before any local file read.
  for (const skill of liveSkills.skills) {
    object(skill, 'Skill');
    text(skill.id, 'Skill id');
    text(skill.name, 'Skill name');
    text(skill.description, 'Skill description', 2048, true);
    if (skill.available !== true) fail('SKILL_UNAVAILABLE', 'Every admitted Skill must be explicitly available');
    if (ids.has(skill.id)) fail('DUPLICATE_SKILL_ID', 'The live inventory repeats a Skill ID');
    if (names.has(skill.name)) fail('AMBIGUOUS_SKILL_NAME', 'The live inventory has an ambiguous Skill name');
    ids.add(skill.id); names.add(skill.name);
    if (skill.owner !== undefined) text(skill.owner, 'Skill owner', 512);
    if (skill.source !== undefined) object(skill.source, 'Skill source');
  }
  const skills = [];
  const canonicalPaths = new Set();
  for (const skill of liveSkills.skills) {
    const local = await verifySkill(skill);
    const pathKey = process.platform === 'win32' ? local.path.toLowerCase() : local.path;
    if (canonicalPaths.has(pathKey)) fail('DUPLICATE_SKILL_PATH', 'Multiple Skill IDs resolve to one canonical file');
    canonicalPaths.add(pathKey);
    skills.push({ id: skill.id, name: skill.name, ...local, description: cleanString(skill.description), owner: skill.owner === undefined ? null : cleanString(skill.owner),
      ...(skill.source !== undefined ? { source: boundedJson(skill.source, { sanitize: true }) } : {}),
    });
  }
  const result = {
    project_id, revision, observed_at: new Date(now).toISOString(), skills,
    graph: { ...identity, source: graphSource, observed_at: graphObserved, results: boundedJson(gitnexus.results, { sanitize: true }) },
    provenance: {
      snapshot_authenticity: 'host-provided-unverified', skill_files: 'locally-read-sha256', graph_trust: 'data-only', graph_authority: 'no-permission-grant',
      skills_observed_at: skillsObserved, skills_source: skillsSource, sanitization: 'known-secret-patterns-only',
    },
  };
  return boundedJson(result);
}

// Deliberately small, closed JSON Schema subset. Unsupported schema features are
// errors, not guessed argument contracts. The host passes exact advertised tool
// metadata and exact arguments; no repo/query field names are fabricated here.
const SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'description', 'title', 'default', '$schema']);

function schemaCheck(schema, value, depth = 0) {
  object(schema, 'Tool inputSchema', 'UNSUPPORTED_TOOL_SCHEMA');
  if (depth > 12 || Object.keys(schema).some(key => !SCHEMA_KEYS.has(key))) fail('UNSUPPORTED_TOOL_SCHEMA', 'Tool inputSchema uses an unsupported feature');
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const matches = type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (types.some(type => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type))) fail('UNSUPPORTED_TOOL_SCHEMA', 'Tool inputSchema needs an explicit supported type');
  if (!types.some(matches)) fail('INVALID_TOOL_ARGUMENTS', 'Tool argument does not match its advertised type');
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value)))) fail('INVALID_TOOL_ARGUMENTS', 'Tool argument is outside its advertised enum');
  if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) fail('INVALID_TOOL_ARGUMENTS', 'Tool argument does not match its advertised const');
  if (value === null) return;
  if (typeof value === 'number' && (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum)) fail('INVALID_TOOL_ARGUMENTS', 'Numeric tool argument is outside its advertised bounds');
  if (typeof value === 'string' && (schema.minLength !== undefined && [...value].length < schema.minLength || schema.maxLength !== undefined && [...value].length > schema.maxLength)) fail('INVALID_TOOL_ARGUMENTS', 'Text tool argument is outside its advertised bounds');
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) fail('INVALID_TOOL_ARGUMENTS', 'Array tool argument is outside its advertised bounds');
    if (!schema.items) fail('UNSUPPORTED_TOOL_SCHEMA', 'Array arguments require an explicit item schema');
    for (const item of value) schemaCheck(schema.items, item, depth + 1);
  } else if (typeof value === 'object') {
    object(schema.properties ?? {}, 'Tool schema properties', 'UNSUPPORTED_TOOL_SCHEMA');
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(key => typeof key !== 'string'))) fail('UNSUPPORTED_TOOL_SCHEMA', 'Invalid tool required-property schema');
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail('INVALID_TOOL_ARGUMENTS', 'A required tool argument is absent');
    for (const [key, child] of Object.entries(value)) {
      // More restrictive than additionalProperties:true on purpose: the helper
      // only admits named properties with explicit advertised schemas.
      if (!Object.hasOwn(schema.properties ?? {}, key)) fail('INVALID_TOOL_ARGUMENTS', 'An unadvertised tool argument was supplied');
      schemaCheck(schema.properties[key], child, depth + 1);
    }
  }
}

/**
 * Optional host callback bridge, not a GitNexus transport or live attestation.
 * call(toolName, args) is injected by the native host. It may only be invoked for
 * an explicitly advertised list_repos/query/context read with checked arguments.
 * The caller remains responsible for its permission boundary and recording live
 * observation timestamps/revision/index identity in the supplied snapshot.
 */
export async function queryGitNexus({ call, tools, operation, toolName, args }) {
  if (typeof call !== 'function' || !Array.isArray(tools)) fail('INVALID_TOOL_METADATA', 'An injected call and live tool metadata are required');
  if (!READ_OPERATIONS.has(operation)) fail('UNSUPPORTED_GRAPH_OPERATION', 'Only list_repos, query and context are admitted');
  text(toolName, 'GitNexus tool name');
  if (toolName !== operation && !toolName.endsWith(`__${operation}`)) fail('INVALID_TOOL_METADATA', 'The explicit tool name does not match the selected operation');
  const admitted = boundedJson(tools).filter(tool => tool?.name === toolName);
  if (admitted.length !== 1) fail('INVALID_TOOL_METADATA', 'Exactly one matching advertised tool is required');
  const tool = admitted[0];
  if (tool.annotations?.readOnlyHint !== true || ![undefined, false].includes(tool.annotations?.destructiveHint)) fail('UNSUPPORTED_GRAPH_OPERATION', 'Tool metadata does not explicitly admit a non-destructive read');
  const argumentsCopy = boundedJson(args);
  object(argumentsCopy, 'Tool arguments', 'INVALID_TOOL_ARGUMENTS');
  schemaCheck(tool.inputSchema, argumentsCopy);
  const response = await call(toolName, argumentsCopy);
  // Bound the raw response first, then sanitize. No truncation or fallback.
  return boundedJson(boundedJson(response), { sanitize: true });
}
