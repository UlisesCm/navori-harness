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
    // `bench` left the default CLI behind a flag in `dev` (#1502) and stays with the TS (#1503).
    commands: ["audit", "receipt", "gate", "tools"],
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
      // Shares guard-destructive's PII partials; ported as step 1c of the 0.13 plan.
      "pii-egress-guard",
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
 * Spec 0060 D48 (R20 of 0062): subcommands and flags that stay delegated to the frozen TS after the
 * cutover, each with a one-line reason. An entry without `flags` delegates the whole subcommand
 * (its exact path: a child is not covered); with `flags`, only those flags of a subcommand the
 * manifest declares. `subtree: true` covers the path and every subcommand under it (compared by
 * whole segments, so `master` does not cover `masterx`); it cannot be combined with `flags`.
 * `unless` records a runtime delegation of a subcommand the manifest declares: it delegates only
 * when none of those flags is present (e.g. `restore` without `--yes` asks with clack's prompt).
 * Such an entry excuses neither the subcommand nor its flags in `cutover:check`; when the manifest
 * gates the subcommand with `requires` of single flags and `unless` names exactly those flags, it
 * excuses the `requires` finding (the invocations left to the TS are the prompt). It cannot be
 * combined with `flags` or `subtree`.
 * Entries arrive by PR and the cross review validates them (F46).
 * @typedef {{ path: string[], flags?: string[], subtree?: boolean, unless?: string[], reason: string }} Delegation
 */

/**
 * Throws when an entry mixes `subtree` with `flags`: a subtree has no per-flag meaning.
 * @param {ReadonlyArray<Delegation>} list
 */
export function validateDelegation(list) {
  for (const entry of list) {
    if (entry.subtree === true && entry.flags !== undefined)
      throw new Error(
        `PERMANENT_DELEGATION entry "${entry.path.join(" ")}" sets subtree and flags: a subtree covers every flag, drop one of them`,
      );
    if (entry.unless !== undefined && (entry.flags !== undefined || entry.subtree === true))
      throw new Error(
        `PERMANENT_DELEGATION entry "${entry.path.join(" ")}" sets unless with flags or subtree: a runtime delegation only names the flags that keep it native`,
      );
  }
}

/** @type {ReadonlyArray<Delegation>} */
export const PERMANENT_DELEGATION = [
  { path: ["master"], subtree: true, reason: "master plan v2 vive en TS por diseño (#1503, 0063)" },
  { path: ["codex"], subtree: true, reason: "Codex queda en TS por delegación y no bloquea el corte (#1503)" },
  { path: ["workspace"], subtree: true, reason: "workspace congelado en TS (#1503)" },
  { path: ["ticket"], subtree: true, reason: "ticket congelado en TS (#1503)" },
  { path: ["registry"], subtree: true, reason: "registry congelado en TS; su port de #1473 no entra (#1503)" },
  {
    path: ["doctor"],
    flags: ["json"],
    reason:
      "el JSON de doctor incluye datos de origen del entrypoint de Node (invokedCli, entrypointSha256, host.node/host.bun) que el binario no puede reproducir sin falsearlos; --json se queda en TS por decisión de Ulises (17 nov)",
  },
  {
    path: ["backup", "restore"],
    unless: ["yes"],
    reason:
      "prompt interactivo de clack: sin --yes el TS confirma con p.confirm; con --yes es nativo (T24, decisión de Ulises del 18 nov, #262)",
  },
  {
    path: ["migrations", "restore"],
    unless: ["yes"],
    reason:
      "prompt interactivo de clack: sin --yes el TS confirma con p.confirm; con --yes es nativo (T24, decisión de Ulises del 18 nov, #262)",
  },
  {
    path: ["sync"],
    unless: ["apply", "yes", "dry-run", "json", "accept-new", "keep-mine", "accept-new-files"],
    reason:
      "prompt interactivo de clack: sin una de esas banderas el TS pregunta con p.select/p.confirm; con una es nativo (mismo motivo que restore, T24; decisión de Ulises del 22 nov)",
  },
  {
    path: ["remove"],
    unless: ["yes"],
    reason:
      "prompt interactivo de clack: sin --yes el TS confirma con p.confirm; con --yes es nativo (mismo motivo que restore, T24; decisión de Ulises del 22 nov)",
  },
];
validateDelegation(PERMANENT_DELEGATION);

/**
 * Amendment of R20 (0062): hooks that keep their shell body in every engine after the cutover,
 * outside the manifest. Their Rust leaves the binary (#1503); `cutover:check` does not count them
 * as missing nor their unport as open. Any other hook or unport still blocks. An entry whose reason
 * says "diferido" stays in shell for 0.13 only and is revisited after it (its issue tracks it).
 * @type {ReadonlyArray<{ hook: string, reason: string }>}
 */
export const PERMANENT_SHELL_HOOKS = [
  { hook: "master-plan-context", reason: "master plan frozen in dev; permanent delegation (#1503)" },
  { hook: "master-accept-confirm", reason: "master plan frozen in dev; permanent delegation (#1503)" },
  { hook: "audit-mode-trigger", reason: "audit frozen in dev; permanent delegation (#1503)" },
  { hook: "audit-mode-close", reason: "audit frozen in dev; permanent delegation (#1503)" },
  { hook: "stop-verify-reminder", reason: "frozen behind its flag in dev (#1503)" },
  { hook: "role-guard", reason: "Codex only, frozen; its Rust leaves the binary (#1503)" },
  { hook: "engram-write-guard", reason: "Codex only, frozen; its Rust leaves the binary (#1503)" },
  {
    hook: "managed-drift-watch",
    reason:
      "advisory and cheap (~15 ms); a port would duplicate the render's managed-block hash in a critical area (0.13 cutover, point 9)",
  },
  {
    hook: "worktree-reclaim",
    reason:
      "SessionEnd, bound by gh and git; deletes worktrees in the user's repo, so a port is risk without gain (0.13 cutover, point 9)",
  },
  {
    hook: "routing-watch",
    reason:
      "diferido después de 0.13; routing-watch corre en cada Bash/Edit/Write/Agent (~76 ms) y portarlo exige paridad byte a byte con lib/plan/evidence.ts; revisar con los datos de R17 (#1701)",
  },
  {
    hook: "bash-outcome-watch",
    reason:
      "diferido después de 0.13; comparte con routing-watch el parcial bash-outcome, que exige paridad byte a byte con lib/plan/evidence.ts; revisar con los datos de R17 (#1701)",
  },
];

/** Reason shared by the commands the 0.13.0 cutover leaves on the frozen TS until they are ported. */
const NOT_PORTED = "sin portar en 0.13.0; se porta por demanda (inventario post-0.13)";
/** Reason shared by the hooks that leave 0.13.0 in shadow. */
const NO_CLAUDE_TRAFFIC = "sin tráfico de Claude en la ventana R81; se activan en 0.13.x";

/**
 * Amendment of R20 and T10 (0062; decision of 23 Nov 2026, 16:30): what the 0.13.0 cutover leaves
 * on the frozen TS (`commands`, with the semantics of {@link Delegation}) or in shadow (`hooks`)
 * for now, each with its reason. Unlike `PERMANENT_DELEGATION` it is debt that gets ported or
 * activated in 0.13.x or later: `cutover:check` does not block on it but lists it apart
 * (`transitional`). It is data on purpose: the close of the R81 window edits `hooks` (keeps the
 * Claude-only hooks without traffic, drops the ones it activates) without touching T10.
 * An entry may not repeat a permanent one.
 * @type {{ commands: ReadonlyArray<Delegation>, hooks: ReadonlyArray<{ hook: string, reason: string }> }}
 */
export const TRANSITIONAL_DELEGATION = {
  commands: [
    { path: ["add"], reason: NOT_PORTED },
    { path: ["configure"], subtree: true, reason: NOT_PORTED },
    { path: ["gate"], reason: `${NOT_PORTED}; probe y foreign ya son nativos` },
    { path: ["init"], reason: NOT_PORTED },
    { path: ["receipt"], subtree: true, reason: NOT_PORTED },
    { path: ["refresh"], reason: NOT_PORTED },
    { path: ["update"], reason: NOT_PORTED },
    { path: ["tools"], reason: `${NOT_PORTED}; notice y session-context ya son nativos` },
    {
      path: ["tools", "rust-shadow"],
      subtree: true,
      reason: "journal de la sombra; se borra en 0.14 después de activar routing-watch y bash-outcome-watch (orden post-0.13)",
    },
    {
      path: ["audit"],
      unless: ["arm", "disarm"],
      reason:
        "solo --arm y --disarm son nativos; el resto de audit no entra en 0.13 (decisión del 22 nov) y sus cuatro modos de hooks se portan con los hooks que los llaman (inventario post-0.13)",
    },
    {
      path: ["audit"],
      flags: [
        "all-repos",
        "by-engine",
        "capture-child",
        "collect",
        "compare",
        "consume-arm",
        "copy-to",
        "days",
        "include-human-content",
        "out",
        "published-from",
        "record-metadata",
        "repo",
        "rollout",
        "root",
        "root-session",
        "session",
        "since",
        "snapshot",
        "start",
        "stop",
        "until",
      ],
      reason: "modos de audit sin portar (decisión del 22 nov; inventario post-0.13)",
    },
    { path: ["render"], flags: ["all", "prune", "verbose", "workspace"], reason: NOT_PORTED },
    { path: ["sync"], flags: ["interactive", "workspace"], reason: NOT_PORTED },
  ],
  hooks: [
    { hook: "plan-gate", reason: NO_CLAUDE_TRAFFIC },
    { hook: "general-purpose-confirm", reason: NO_CLAUDE_TRAFFIC },
    { hook: "session-start-context", reason: NO_CLAUDE_TRAFFIC },
    { hook: "model-advisor", reason: NO_CLAUDE_TRAFFIC },
    { hook: "pii-egress-guard", reason: NO_CLAUDE_TRAFFIC },
    { hook: "subagent-stop-handoff", reason: NO_CLAUDE_TRAFFIC },
  ],
};
validateTransitional(TRANSITIONAL_DELEGATION);

/**
 * Throws when a transitional entry is malformed, lacks a reason or repeats a permanent one: debt
 * and a permanent decision never share an entry.
 * @param {{ commands: ReadonlyArray<Delegation>, hooks: ReadonlyArray<{ hook: string, reason: string }> }} list
 */
export function validateTransitional(list) {
  validateDelegation(list.commands);
  for (const entry of list.commands) {
    const key = entry.path.join(" ");
    if (typeof entry.reason !== "string" || entry.reason.trim() === "")
      throw new Error(`TRANSITIONAL_DELEGATION entry "${key}" has no reason`);
    const repeated =
      entry.flags === undefined
        ? entry.unless === undefined && permanentlyDelegated(entry.path, undefined)
        : entry.flags.some((flag) => permanentlyDelegated(entry.path, flag));
    if (repeated) throw new Error(`TRANSITIONAL_DELEGATION entry "${key}" repeats PERMANENT_DELEGATION`);
  }
  for (const entry of list.hooks) {
    if (typeof entry.reason !== "string" || entry.reason.trim() === "")
      throw new Error(`TRANSITIONAL_DELEGATION hook "${entry.hook}" has no reason`);
    if (permanentShellHook(entry.hook))
      throw new Error(`TRANSITIONAL_DELEGATION hook "${entry.hook}" repeats PERMANENT_SHELL_HOOKS`);
  }
}

/**
 * Whether `PERMANENT_SHELL_HOOKS` (or `list`) keeps hook `id` in shell for good.
 * @param {string} id
 * @param {ReadonlyArray<{ hook: string, reason: string }>} [list]
 */
export function permanentShellHook(id, list = PERMANENT_SHELL_HOOKS) {
  return list.some((entry) => entry.hook === id);
}

/**
 * Whether `PERMANENT_DELEGATION` (or `list`) covers a subcommand, or one of its flags. An
 * `unless` entry never covers anything: it only records a runtime delegation.
 * @param {string[]} path
 * @param {string} [flag]
 * @param {ReadonlyArray<Delegation>} [list]
 */
export function permanentlyDelegated(path, flag, list = PERMANENT_DELEGATION) {
  validateDelegation(list);
  const key = path.join(" ");
  return list.some(
    (entry) =>
      entry.unless === undefined &&
      (entry.subtree === true
        ? entry.path.length <= path.length && entry.path.every((segment, i) => path[i] === segment)
        : entry.path.join(" ") === key) &&
      (entry.flags === undefined || (flag !== undefined && entry.flags.includes(flag))),
  );
}

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
 * Positional args are not flags: the manifest selects by option names (D3), never by positionals.
 * @param {unknown} root
 * @returns {Promise<Array<{ path: string[], flags: string[] }>>}
 */
export async function commandInventory(root) {
  /** @type {Array<{ path: string[], flags: string[] }>} */
  const found = [];
  async function walk(command, path) {
    const args = (await resolveValue(command.args)) ?? {};
    const flags = Object.entries(args)
      .filter(([, def]) => def?.type !== "positional")
      .map(([name]) => name)
      .sort();
    if (path.length > 0) found.push({ path, flags });
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
