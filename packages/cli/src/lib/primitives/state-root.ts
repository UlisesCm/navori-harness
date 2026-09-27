/** Checkout-contained runtime-state root selection for plans, handoffs, and receipts. */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export const FEATURE_SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const NEUTRAL_DIR = ".navori/state/handoffs";
const LEGACY_DIRS = [".claude/progress", ".codex/progress"] as const;

export interface StateRootOptions {
  cwd: string;
  feature: string;
  dir?: string;
}
export interface StateRoot {
  cwd: string;
  dir: string;
  path: string;
  kind: "neutral" | "legacy" | "explicit";
}

export function validateFeatureSlug(feature: string): void {
  if (!FEATURE_SLUG.test(feature))
    throw new Error(`invalid feature slug: ${JSON.stringify(feature)}`);
}

function hasSymlinkAncestor(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return true;
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

/** Rejects every lexical symlink component before Git resolves the requested checkout. */
function assertNoCwdSymlinks(cwd: string): string {
  const requested = resolve(cwd);
  let current: string = sep;
  for (const part of requested.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink())
      throw new Error(`symlinked --cwd is not allowed: ${cwd}`);
  }
  return requested;
}

/** Resolves a physical Git checkout, rejecting a symlinked invocation path. */
export function checkoutRoot(cwd: string): string {
  const requested = assertNoCwdSymlinks(cwd);
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: requested,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) throw new Error(`--cwd is not a Git checkout: ${cwd}`);
  const top = result.stdout.trim();
  const canonical = realpathSync(top);
  const physicalRequested = realpathSync(requested);
  const rel = relative(canonical, physicalRequested);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`--cwd is outside its Git checkout: ${cwd}`);
  }
  return canonical;
}

function containedDir(root: string, value: string): { path: string; dir: string } {
  if (!isAbsolute(value) && value.split(/[\\/]/u).includes("..")) {
    throw new Error(`state directory contains traversal: ${value}`);
  }
  const path = isAbsolute(value) ? resolve(value) : resolve(root, value);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`state directory escapes checkout: ${value}`);
  }
  if (hasSymlinkAncestor(root, path))
    throw new Error(`state directory contains a symlink: ${value}`);
  return { path, dir: rel || "." };
}

function receiptMatches(root: StateRoot, name: string, feature: string): boolean {
  const path = stateArtifactPath(root, name);
  if (!existsSync(path)) return false;
  return /^# navori-receipt v\d+ feature=(\S+)/.exec(readFileSync(path, "utf8"))?.[1] === feature;
}

function rootMatches(root: StateRoot, feature: string): boolean {
  if (!existsSync(root.path) || lstatSync(root.path).isSymbolicLink()) return false;
  const names = [
    `workplan_${feature}.json`,
    `workplan_${feature}.md`,
    `impl_${feature}.json`,
    `impl_${feature}.md`,
    `review_${feature}.md`,
    `workplan_${feature}.gate.jsonl`,
  ];
  if (names.some((name) => existsSync(stateArtifactPath(root, name)))) return true;
  return (
    receiptMatches(root, "receipt.txt", feature) ||
    receiptMatches(root, "receipt.consumed.txt", feature)
  );
}

/** Selects one root once per invocation. Neutral wins; legacy is only a one-release read fallback. */
export function resolveStateRoot(options: StateRootOptions): StateRoot {
  validateFeatureSlug(options.feature);
  const cwd = checkoutRoot(options.cwd);
  if (options.dir !== undefined) {
    const selected = containedDir(cwd, options.dir);
    return { cwd, ...selected, kind: "explicit" };
  }
  const neutral = containedDir(cwd, NEUTRAL_DIR);
  if (rootMatches({ cwd, ...neutral, kind: "neutral" }, options.feature))
    return { cwd, ...neutral, kind: "neutral" };
  const legacy = LEGACY_DIRS.map((dir) => ({
    cwd,
    ...containedDir(cwd, dir),
    kind: "legacy" as const,
  })).filter((root) => rootMatches(root, options.feature));
  if (legacy.length > 1) {
    throw new Error(
      `multiple legacy state roots match feature "${options.feature}"; pass --dir explicitly`,
    );
  }
  if (legacy.length === 1) return legacy[0]!;
  return { cwd, ...neutral, kind: "neutral" };
}

/** Creates a state directory one component at a time and rechecks for symlink replacement. */
export function ensureStateDirectory(root: StateRoot): void {
  const rel = relative(root.cwd, root.path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`state directory escapes checkout: ${root.path}`);
  }
  let current = root.cwd;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) mkdirSync(current);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`state directory contains an unsafe component: ${current}`);
    }
  }
  if (hasSymlinkAncestor(root.cwd, root.path))
    throw new Error(`state directory contains a symlink: ${root.path}`);
}

/** Validates a final state artifact before any read/write forms the path. */
export function stateArtifactPath(root: StateRoot, name: string): string {
  if (basename(name) !== name || name.includes("\\") || name.includes("/")) {
    throw new Error(`invalid state artifact name: ${JSON.stringify(name)}`);
  }
  const path = resolve(root.path, name);
  const rel = relative(root.path, path);
  if (
    rel === ".." ||
    rel.startsWith(`..${sep}`) ||
    isAbsolute(rel) ||
    hasSymlinkAncestor(root.cwd, path)
  ) {
    throw new Error(`state artifact escapes checkout: ${name}`);
  }
  return path;
}

/** Writes one state artifact with an exclusive temporary file and containment rechecks. */
export function writeStateFileAtomic(root: StateRoot, name: string, content: string): void {
  const temporaryName = `.${name}.tmp-${process.pid}`;
  let temporary: string | undefined;
  let created = false;
  try {
    ensureStateDirectory(root);
    const destination = stateArtifactPath(root, name);
    temporary = stateArtifactPath(root, temporaryName);
    const fd = openSync(temporary, "wx", 0o644);
    created = true;
    try {
      ensureStateDirectory(root);
      stateArtifactPath(root, temporaryName);
      stateArtifactPath(root, name);
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    ensureStateDirectory(root);
    stateArtifactPath(root, temporaryName);
    stateArtifactPath(root, name);
    renameSync(temporary, destination);
  } catch (cause: unknown) {
    if (created && temporary !== undefined) rmSync(temporary, { force: true });
    throw cause;
  }
}
