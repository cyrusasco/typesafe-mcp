import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { digest, validateKey, requireThat } from './contracts.mjs';

// Run-owned local state, not an authorization/security boundary against same-user processes.
// Cross-process lock is never stolen after a crash. Reconciliation is explicit.
export class Store {
  constructor(root) { requireThat(typeof root === 'string' && path.isAbsolute(root), 'absolute TYPESAFE_CODEX_STATE_DIR required'); this.root = root; }
  file(key) { validateKey(key); return path.join(this.root, digest([key.project_id, key.task_id, key.turn_id]) + '.json'); }
  read(key) { return JSON.parse(fs.readFileSync(this.file(key), 'utf8')); }
  async transaction(key, fn, create = false) {
    const file = this.file(key); fs.mkdirSync(this.root, { recursive: true });
    const lock = file + '.lock'; let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw new Error('state busy/uncertain: lock held; do not replay host effects'); throw e; }
    let temp;
    try {
      let state;
      if (create) { requireThat(!fs.existsSync(file), 'plan already exists; resume same turn or explicitly plan a new turn'); }
      else state = this.read(key);
      const next = await fn(state);
      temp = file + '.' + crypto.randomUUID() + '.tmp';
      const output = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(output, JSON.stringify(next)); fs.fsyncSync(output); } finally { fs.closeSync(output); }
      fs.renameSync(temp, file); temp = null;
      return structuredClone(next);
    } finally { if (temp && fs.existsSync(temp)) fs.unlinkSync(temp); fs.closeSync(fd); fs.unlinkSync(lock); }
  }
}
