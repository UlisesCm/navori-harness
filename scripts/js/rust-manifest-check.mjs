import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expandHookIncludes } from "../../packages/cli/src/lib/render/hook-includes.ts";

const MANIFEST = "crates/ported.json";
const HISTORY = "crates/ported-history.jsonl";
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const json = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Core hooks whose managed block id is not `<hook>-base` (`engines/shared/harness-plan.ts`). */
const MANAGED_IDS = { "quality-gate-pre-commit": "qg-pre-commit-base" };

/** Command ids are space-joined paths, hook ids are the manifest keys (D1). */
function ids(manifest) {
  return [
    ...manifest.commands.map((command) => command.path.join(" ")),
    ...Object.keys(manifest.hooks),
  ];
}

const SCHEMA = 2;
const LEDGER_OPS = ["port", "unport", "activate", "deactivate"];
/** Lifecycle events do not decide whether an id is ported (only `port`/`unport` do). */
const PORTING_OPS = new Set(["port", "unport"]);
const sameSet = (a, b) => a.size === b.size && [...a].every((item) => b.has(item));

/** `requires` as sets of flags, so alternative and flag order do not count (D25). */
function requiresKey(name, command, flags) {
  if (command.requires === undefined) return undefined;
  if (!Array.isArray(command.requires) || command.requires.length === 0)
    throw new Error(`commands[${name}]: requires needs at least one alternative`);
  const key = [];
  for (const required of command.requires) {
    const set = new Set(Array.isArray(required) ? required : []);
    if (set.size === 0 || set.size !== required.length)
      throw new Error(`commands[${name}]: requires alternative must be non-empty, without repeats`);
    for (const flag of set) {
      if (!flags.includes(flag))
        throw new Error(`commands[${name}]: required flag ${flag} is not in flags`);
    }
    if (key.some((other) => sameSet(other, set)))
      throw new Error(`commands[${name}]: duplicate requires alternative`);
    key.push(set);
  }
  return key;
}

const sameKey = (a, b) =>
  a === undefined || b === undefined
    ? a === b
    : a.length === b.length && a.every((set) => b.some((other) => sameSet(set, other)));

/** The command half of `manifest.rs`'s validator: schema, paths, flags and `requires` (D25). */
export function checkCommands(manifest) {
  if (manifest.schema !== SCHEMA) throw new Error(`unsupported schema ${manifest.schema}`);
  const seen = [];
  for (const command of manifest.commands) {
    const name = (command.path ?? []).join(" ");
    if (!Array.isArray(command.path) || command.path.length === 0 || command.path.includes(""))
      throw new Error(`commands[${name}]: path needs non-empty tokens`);
    const flags = command.flags ?? [];
    for (const [index, flag] of flags.entries()) {
      if (typeof flag !== "string" || !/^(?!-|no-)[^= ]+$/.test(flag))
        throw new Error(`commands[${name}]: flag ${flag} is not normalized`);
      if (flags.indexOf(flag) !== index)
        throw new Error(`commands[${name}]: duplicate flag ${flag}`);
    }
    const engines = command.when?.engines;
    if (
      engines !== undefined &&
      (!Array.isArray(engines) || engines.length === 0 || engines.includes(""))
    )
      throw new Error(`commands[${name}]: when.engines needs engine names`);
    const path = JSON.stringify(command.path);
    const key = requiresKey(name, command, flags);
    if (seen.some((other) => other.path === path && sameKey(other.key, key)))
      throw new Error(
        `commands[${name}]: duplicate path (entries of one path must differ in requires)`,
      );
    seen.push({ path, key });
  }
}

/**
 * R79/R80: a hook leaves `shadow` only with a new `activate` line and only if the merge-base
 * already had it in `shadow`; it returns to `shadow` only with a new `deactivate` line.
 */
function checkTransitions(before, after, added) {
  const has = (op, id) => added.some((event) => event.op === op && event.id === id);
  for (const [id, hook] of Object.entries(after.hooks)) {
    const was = before.hooks[id]?.mode;
    if (hook.mode === "active" && was !== "active") {
      if (was !== "shadow")
        throw new Error(`${id} cannot become active without shadow in the merge-base`);
      if (!has("activate", id))
        throw new Error(`${id} became active without a new activate record`);
    } else if (hook.mode === "shadow" && was === "active" && !has("deactivate", id)) {
      throw new Error(`${id} returned to shadow without a new deactivate record`);
    }
    if (has("activate", id) && !(hook.mode === "active" && was === "shadow"))
      throw new Error(`activate record for ${id} without a shadow to active transition`);
    if (has("deactivate", id) && !(hook.mode === "shadow" && was === "active"))
      throw new Error(`deactivate record for ${id} without an active to shadow transition`);
  }
}

/** Validate append-only history and require a NEW unport for every removed entry. */
export function checkHistory(before, after, previousText, currentText, now = Date.now()) {
  const lines = (text) => (text.trimEnd() === "" ? [] : text.trimEnd().split("\n"));
  const previous = lines(previousText);
  const current = lines(currentText);
  if (previous.some((line, index) => line !== current[index]))
    throw new Error("ported-history.jsonl must be append-only");
  const events = current.map((line) => JSON.parse(line));
  for (const event of events) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(event.date) ||
      !Number.isFinite(Date.parse(`${event.date}T00:00:00Z`)) ||
      !LEDGER_OPS.includes(event.op) ||
      typeof event.id !== "string" ||
      !event.id.trim() ||
      typeof event.reason !== "string" ||
      !event.reason.trim() ||
      !Number.isSafeInteger(event.pr) ||
      event.pr <= 0
    )
      throw new Error("invalid ported-history.jsonl entry");
  }
  const latestNew = new Map(events.slice(previous.length).map((event) => [event.id, event]));
  const active = new Set(ids(after));
  for (const id of ids(before)) {
    if (!active.has(id) && latestNew.get(id)?.op !== "unport")
      throw new Error(`removed ${id} without a new unport record`);
  }
  checkTransitions(before, after, events.slice(previous.length));
  const latest = new Map(
    events.filter((event) => PORTING_OPS.has(event.op)).map((event) => [event.id, event]),
  );
  for (const [id, event] of latest) {
    if ((event.op === "unport") === active.has(id))
      throw new Error(`history disagrees with manifest for ${id}`);
  }
  return [...latest.values()]
    .filter(
      (event) =>
        event.op === "unport" && now - Date.parse(`${event.date}T00:00:00Z`) > 14 * 86_400_000,
    )
    .map((event) => `${event.id} has been unported for more than 14 days`);
}

function files(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, "en"))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symlink in Rust sources: ${path}`);
      return entry.isDirectory() ? files(path) : [path];
    });
}

/** D8: sorted source paths + NUL + exact bytes + NUL, including the shared runner. */
export function implementationHash(root, id) {
  if (!/^[a-z0-9_-]+$/.test(id)) throw new Error(`invalid hook id: ${id}`);
  const src = join(root, "crates/navori-hooks/src");
  const hook = join(src, "hooks", id.replaceAll("-", "_"));
  const sources = [
    ...files(hook),
    ...files(src).filter((path) => !relative(src, path).startsWith("hooks/")),
  ].sort();
  const hash = createHash("sha256");
  for (const path of sources)
    hash.update(relative(src, path)).update("\0").update(readFileSync(path)).update("\0");
  return `sha256:${hash.digest("hex")}`;
}

/** Source asset of every block id and sibling-script dependency; never a rendered mirror. */
export function assetSources(root) {
  const blocks = new Map();
  const deps = new Map();
  const register = (map, id, path) => {
    if (map.has(id)) throw new Error(`ambiguous asset id: ${id}`);
    map.set(id, path);
  };
  const core = join(root, "packages/core/core-assets");
  for (const name of readdirSync(join(core, "hooks"))) {
    if (name.endsWith(".sh")) {
      const id = name.slice(0, -3);
      register(blocks, MANAGED_IDS[id] ?? `${id}-base`, join(core, "hooks", name));
    }
  }
  if (existsSync(join(core, "scripts"))) {
    for (const path of files(join(core, "scripts"))) register(deps, relative(core, path), path);
  }
  const plugins = join(root, "packages/plugins");
  for (const name of readdirSync(plugins)) {
    const dir = join(plugins, name);
    if (!existsSync(join(dir, "plugin.json"))) continue;
    const plugin = json(join(dir, "plugin.json"));
    for (const block of plugin.hookExtensions ?? [])
      register(blocks, block.id, join(dir, block.file));
    for (const script of plugin.scripts ?? [])
      register(deps, `scripts/${script.dest}`, join(dir, script.src));
  }
  return { blocks, deps };
}

/**
 * Every recorded hash of `manifest.hooks` that no longer matches its source: block assets (with
 * includes expanded), sibling-script deps and the D8 implementation hash. Resolves blocks/deps
 * from declared core/plugin assets; never hashes rendered mirrors.
 *
 * @returns {{ id: string, kind: "blocks" | "deps" | "impl", name: string, recorded: string, expected: string }[]}
 */
export function staleHashes(root, manifest) {
  const { blocks, deps } = assetSources(root);
  const stale = [];
  for (const [id, hook] of Object.entries(manifest.hooks)) {
    if (Object.keys(hook.blocks).length === 0) throw new Error(`${id}: blocks must not be empty`);
    for (const [kind, entries, sources] of [
      ["blocks", hook.blocks, blocks],
      ["deps", hook.deps ?? {}, deps],
    ]) {
      for (const [name, recorded] of Object.entries(entries)) {
        const path = sources.get(name);
        if (!path) throw new Error(`${id}.${kind}: unknown asset ${name}`);
        const bytes =
          kind === "blocks"
            ? Buffer.from(expandHookIncludes(readFileSync(path, "utf8")))
            : readFileSync(path);
        const expected = sha256(bytes);
        if (expected !== recorded) stale.push({ id, kind, name, recorded, expected });
      }
    }
    const expected = implementationHash(root, id);
    if (expected !== hook.impl)
      stale.push({ id, kind: "impl", name: "impl", recorded: hook.impl, expected });
  }
  return stale;
}

/** Throws on the first hash of `manifest.hooks` that no longer matches its source. */
export function checkHashes(root, manifest) {
  const [first] = staleHashes(root, manifest);
  if (first === undefined) return;
  throw new Error(
    first.kind === "impl"
      ? `${first.id}.impl: hash mismatch`
      : `${first.id}.${first.kind}.${first.name}: hash mismatch`,
  );
}

export function checkManifest(root, base = "origin/migration/rust") {
  const git = (args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trimEnd();
  const mergeBase = git(["merge-base", "HEAD", base]);
  const readAtBase = (path) =>
    git(["ls-tree", "--name-only", mergeBase, "--", path])
      ? git(["show", `${mergeBase}:${path}`])
      : "";
  const before = JSON.parse(readAtBase(MANIFEST) || '{"schema":2,"commands":[],"hooks":{}}');
  const after = json(join(root, MANIFEST));
  checkCommands(after);
  const warnings = checkHistory(
    before,
    after,
    readAtBase(HISTORY),
    readFileSync(join(root, HISTORY), "utf8"),
  );
  checkHashes(root, after);
  return warnings;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    for (const warning of checkManifest(process.cwd(), process.argv[2]))
      console.warn(`::warning::${warning}`);
    console.log("rust-manifest: hashes and unport history match");
  } catch (error) {
    console.error(`rust-manifest: ${error.message}`);
    process.exitCode = 1;
  }
}
