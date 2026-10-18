# Versioned reader shared with the CLI preflight. Node builtins only; no CLI dependency.
# navori:review-edit-binding/v1
nv_review_edit_binding() {
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' 'node-unavailable'
    return 1
  fi
  node - "$@" <<'NV_REVIEW_EDIT_BINDING'
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const [hostInput, thread, role, prefixes, ...outputs] = process.argv.slice(2);
const neutral = '.navori/state/handoffs';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const slug = /^[a-z0-9][a-z0-9._-]*$/;
const hex = /^[a-f0-9]{64}$/;
const deny = (reason) => { throw new Error(reason); };
const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');
function git(cwd, ...args) {
  const r = cp.spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd, encoding: 'utf8', timeout: 2000, maxBuffer: 1048576,
  });
  if (r.status !== 0) deny('git-unavailable');
  return r.stdout.trim();
}
/** Reject lexical traversal and every symlink, including a not-yet-existing leaf's ancestors. */
function physical(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input) || input.split(/[\\/]/).includes('..')) deny('unsafe-path');
  let cursor = path.parse(input).root;
  for (const part of input.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if (fs.lstatSync(cursor).isSymbolicLink()) deny('symlink-path'); }
    catch (e) { if (!(e instanceof Error) || !('code' in e) || e.code !== 'ENOENT') throw e; }
  }
  return path.resolve(input);
}
/** Read one exact file; index/stamp reads have individual 64 KiB bounds. */
function json(file, bounded = false) {
  physical(file);
  const fd = fs.openSync(file, 'r');
  try {
    if (bounded) {
      if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).size > 65536) deny('oversized-binding');
      const buf = Buffer.alloc(65537);
      const count = fs.readSync(fd, buf, 0, buf.length, 0);
      if (count > 65536) deny('oversized-binding');
      return JSON.parse(buf.subarray(0, count).toString('utf8'));
    }
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
function checkout(cwd) {
  physical(cwd);
  return fs.realpathSync(git(cwd, 'rev-parse', '--show-toplevel'));
}
function identity(cwd) {
  return {
    checkout: checkout(cwd),
    gitDir: fs.realpathSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-dir')),
    commonDir: fs.realpathSync(git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir')),
  };
}
function registered(host, target) {
  const entries = git(host, 'worktree', 'list', '--porcelain', '-z').split('\0');
  return entries.includes(`worktree ${host}`) && entries.includes(`worktree ${target}`);
}
/** Bind one target/feature to the native event thread, current owner and two exact outputs. */
function validate(host, output) {
  physical(output);
  const match = /^(.*)\/\.navori\/state\/handoffs\/review_([^/]+)\.(md|json)$/.exec(output);
  if (!match || !slug.test(match[2])) deny('not-review-output');
  const [, target, feature] = match;
  const actual = identity(target);
  if (actual.checkout !== target || actual.commonDir !== host.commonDir ||
      !registered(host.checkout, target)) deny('unregistered-checkout');
  const state = path.join(target, neutral);
  const index = json(path.join(state, `review_${feature}.${thread}.edit.json`), true);
  if (!index || Object.keys(index).sort().join(',') !== 'feature,nonce,thread,v' ||
      index.v !== 1 || index.feature !== feature || index.thread !== thread ||
      !uuid.test(index.nonce)) deny('invalid-index');
  const stamp = json(path.join(state, `review_${feature}.${index.nonce}.begin.json`), true);
  const b = stamp.editBinding;
  const a = stamp.reviewer;
  if (!b || b.v !== 1 || b.checkout !== target || b.gitDir !== actual.gitDir ||
      b.commonDir !== actual.commonDir || b.stateDir !== neutral || typeof b.target !== 'string' ||
      !b.target || stamp.v !== 1 || stamp.alg !== 'navori-content/v1' ||
      stamp.feature !== feature || stamp.nonce !== index.nonce) deny('invalid-binding');
  if (!a || a.host !== 'codex' || !['0.162.1', '0.163.0'].includes(a.version) || a.role !== 'reviewer' ||
      a.thread !== thread || !uuid.test(a.root) || !uuid.test(a.parent) ||
      !hex.test(a.sourceHash) || checkout(a.sourceCwd) !== host.checkout) deny('wrong-native-actor');
  const owner = json(path.join(state, `ownership_${feature}.json`));
  if (!owner || owner.feature !== feature || owner.cwd !== target || owner.target !== b.target ||
      owner.handoff !== stamp.ownership || !hex.test(stamp.ownership) ||
      owner.fingerprint !== stamp.fingerprint || owner.base !== stamp.base ||
      !Array.isArray(owner.actors) || !owner.actors.length ||
      owner.actors.some((p) => p.host !== 'codex' || !['0.162.1', '0.163.0'].includes(p.version) ||
        !['implementer', 'scribe'].includes(p.role) || !uuid.test(p.thread) ||
        p.root !== a.root || p.thread === thread)) deny('ownership-mismatch');
  const handoff = path.join(state, `impl_${feature}.json`);
  physical(handoff);
  if (hash(fs.readFileSync(handoff)) !== owner.handoff) deny('handoff-changed');
  return `${target}\0${feature}`;
}
try {
  if (role !== 'reviewer' || !uuid.test(thread)) deny('native-agent-id-unavailable');
  if (!prefixes.split('\n').some((p) => {
    const prefix = p.replace(/\/$/, '');
    return prefix && `${neutral}/review_output.json`.startsWith(`${prefix}/`);
  })) deny('role-prefix-denied');
  if (!outputs.length) deny('missing-output');
  const host = identity(hostInput);
  const checked = new Set();
  for (const output of outputs) {
    physical(output);
    const match = /^(.*)\/\.navori\/state\/handoffs\/review_([^/]+)\.(md|json)$/.exec(output);
    if (!match) deny('not-review-output');
    const key = `${match[1]}\0${match[2]}`;
    if (!checked.has(key)) checked.add(validate(host, output));
  }
  process.stdout.write('bound-review-output\n');
} catch (e) {
  process.stdout.write(`${e instanceof Error ? e.message : 'invalid-binding'}\n`);
  process.exitCode = 1;
}
NV_REVIEW_EDIT_BINDING
}
