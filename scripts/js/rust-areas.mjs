import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Spec 0060 D40/D41 (R77, R78): the one inventory of CLI subcommands, flags and hooks, and the
 * area each belongs to. The per-area tests and `cutover:check` read these functions; there is no
 * second list.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Phase-4 areas (D40) plus `prior`: what phases 1-3 port. */
export const AREAS = {
  E1: {
    commands: ["spec", "master", "handoff", "plan", "dominio"],
    hooks: [
      "general-purpose-confirm",
      "comment-draft-confirm",
      "pr-publisher-confirm",
      "master-plan-context",
      "master-accept-confirm",
      "implementer-no-markdown",
      "role-guard",
      "engram-write-guard",
    ],
  },
  E2: {
    commands: ["audit", "receipt", "gate", "bench", "tools"],
    hooks: [
      "audit-mode-trigger",
      "audit-mode-close",
      "bash-outcome-watch",
      "routing-watch",
      "stop-verify-reminder",
    ],
  },
  E3: {
    commands: [
      "init",
      "add",
      "configure",
      "update",
      "refresh",
      "scan",
      "doctor",
      "status",
      "workspace",
      "registry",
      "ticket",
      "backup",
      "migrations",
      "preset",
      "codex",
    ],
    hooks: ["managed-drift-watch", "worktree-reclaim"],
  },
  prior: {
    commands: ["render", "sync", "remove", "adopt"],
    hooks: [
      "guard-destructive",
      "subagent-no-background",
      "quality-gate-pre-commit",
      "plan-gate",
      "session-start-context",
      "subagent-stop-handoff",
      "model-advisor",
    ],
  },
};

/**
 * Area of a command path (by its root) or of a hook id. Fails on anything without an area, so a
 * subcommand or hook that arrives from `dev` cannot slip past the inventory (D40).
 * @param {{ command?: string[], hook?: string }} item
 * @returns {keyof typeof AREAS}
 */
export function areaOf({ command, hook }) {
  for (const [area, owned] of Object.entries(AREAS)) {
    if (command !== undefined && owned.commands.includes(command[0])) return area;
    if (hook !== undefined && owned.hooks.includes(hook)) return area;
  }
  const what = command !== undefined ? `command ${command.join(" ")}` : `hook ${hook}`;
  throw new Error(`${what} has no area in scripts/js/rust-areas.mjs (spec 0060 D40)`);
}

/** citty values may be plain, functions or promises. */
async function resolveValue(value) {
  const resolved = typeof value === "function" ? value() : value;
  return await resolved;
}

/**
 * Every command node under `root` (the citty `main` of `cli.ts`) with its own flags, depth-first.
 * @param {unknown} root
 * @returns {Promise<Array<{ path: string[], flags: string[] }>>}
 */
export async function commandInventory(root) {
  /** @type {Array<{ path: string[], flags: string[] }>} */
  const found = [];
  async function walk(command, path) {
    const args = (await resolveValue(command.args)) ?? {};
    if (path.length > 0) found.push({ path, flags: Object.keys(args).sort() });
    const subCommands = (await resolveValue(command.subCommands)) ?? {};
    for (const name of Object.keys(subCommands).sort()) {
      await walk(await resolveValue(subCommands[name]), [...path, name]);
    }
  }
  await walk(root, []);
  return found;
}

/**
 * Hook ids of `core-assets/hooks`. Plugin hook extensions are blocks of these hooks, hashed in
 * the manifest entry of the hook that hosts them.
 * @param {string} [root]
 * @returns {string[]}
 */
export function hookInventory(root = REPO_ROOT) {
  return readdirSync(join(root, "packages/core/core-assets/hooks"))
    .filter((name) => name.endsWith(".sh"))
    .map((name) => name.slice(0, -3))
    .sort();
}

/**
 * The manifest without the entries of `areas` (R78: an area must stand without the others).
 * @param {{ commands: Array<{ path: string[] }>, hooks: Record<string, unknown> }} manifest
 * @param {string[]} areas
 */
export function withoutAreas(manifest, areas) {
  return {
    ...manifest,
    commands: manifest.commands.filter(
      (entry) => !areas.some((area) => AREAS[area].commands.includes(entry.path[0])),
    ),
    hooks: Object.fromEntries(
      Object.entries(manifest.hooks).filter(([id]) => !areas.some((area) => AREAS[area].hooks.includes(id))),
    ),
  };
}

/**
 * What an area still lacks in the manifest: command paths, flags of declared paths, and hooks.
 * @param {keyof typeof AREAS} area
 * @param {{ commands: Array<{ path: string[], flags?: string[] }>, hooks: Record<string, unknown> }} manifest
 * @param {Array<{ path: string[], flags: string[] }>} commands
 * @param {string[]} hooks
 */
export function areaInventoryCheck(area, manifest, commands, hooks) {
  const declared = new Map(manifest.commands.map((entry) => [entry.path.join(" "), entry.flags ?? []]));
  const mine = commands.filter((entry) => areaOf({ command: entry.path }) === area);
  return {
    commands: mine.filter((entry) => !declared.has(entry.path.join(" "))).map((entry) => entry.path.join(" ")),
    flags: mine.flatMap((entry) => {
      const flags = declared.get(entry.path.join(" "));
      return flags === undefined ? [] : entry.flags.filter((flag) => !flags.includes(flag)).map((flag) => `${entry.path.join(" ")} --${flag}`);
    }),
    hooks: hooks.filter((id) => areaOf({ hook: id }) === area && !(id in manifest.hooks)),
  };
}
