/**
 * Workspace config drift (#326) — the check that catches a repo whose harness
 * silently fell behind its siblings.
 *
 * `workspace-defaults.ts` bakes the workspace layer into `navori.config.json` at
 * init time and never re-reads it, by design: the checked-in config is the
 * source of truth that travels with the repo. The cost of that asymmetry is that
 * a repo initialized (or hand-adopted) before a policy changed keeps the old one
 * forever, and `doctor` used to report it as perfectly healthy — every managed
 * block up to date, `render` "al día". The drift wasn't in the FILES, it was in
 * the CONFIG, and nothing looked there.
 *
 * Two comparisons, both purely informational and NEVER auto-applied (adopting a
 * change is `navori configure` / re-init, an explicit act):
 *
 *   1. config ↔ workspace defaults — the follow-up `workspace-defaults.ts`
 *      already acknowledged.
 *   2. config ↔ the MODE of the sibling repos — the one that actually catches
 *      the real case. A workspace's manifest may declare almost nothing while
 *      its repos converged on a practice nobody promoted to the manifest; against
 *      the defaults such a repo is conformant, against its five siblings it is
 *      plainly the odd one out ("5 of 6 repos enable semgrep, this one doesn't").
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readConfig, type NavoriConfig } from "./config.ts";
import { canonicalPath, loadWorkspace } from "./workspace.ts";

/** Minimum sibling repos before the mode means anything: with a single sibling
 * "the majority" is just "the other one", which is a coincidence, not a policy. */
const MIN_SIBLINGS = 2;

/** Marker for a key the config leaves undeclared, in both facts and reports. */
const UNDECLARED = "—";

export interface WorkspaceDriftItem {
  /** Config key, e.g. `branchBase` or `plugins.semgrep`. */
  key: string;
  /** This repo's value (`UNDECLARED` when absent). */
  local: string;
  /** The value it's expected to have (workspace default, or the siblings' mode). */
  expected: string;
  /** Siblings declaring `expected` — 0 for a defaults comparison. */
  agree: number;
  /** Siblings compared — 0 for a defaults comparison. */
  total: number;
}

export interface WorkspaceDriftReport {
  workspace: string;
  /** Divergences from the workspace manifest's `defaults`. */
  vsDefaults: WorkspaceDriftItem[];
  /** Divergences from what most sibling repos declare. */
  vsSiblings: WorkspaceDriftItem[];
  /** Sibling repos whose config was found and parsed. */
  siblingsRead: number;
}

/**
 * The subset of a config that's comparable across repos of a workspace. Values
 * are flattened to strings so mode-counting is a plain tally.
 *
 * `preset` is deliberately absent: sibling repos of one workspace legitimately
 * run different stacks, so preset divergence is the norm, not drift. `models`
 * and `effort` are reduced to declared / undeclared — which tiers a repo picks
 * is its own call, but a repo that declares none while every sibling does was
 * simply never updated.
 */
function configFacts(config: NavoriConfig): Map<string, string> {
  const facts = new Map<string, string>();
  facts.set("branchBase", config.branchBase);
  // The render derives prTarget ?? branchBase, so compare the EFFECTIVE value —
  // otherwise a repo that omits it looks divergent from one that spells it out.
  facts.set("prTarget", config.prTarget ?? config.branchBase);
  facts.set("commits", config.commits);
  facts.set("language", config.language);
  facts.set("engines", [...config.engines].sort().join(","));
  facts.set("models", config.models ? "declared" : UNDECLARED);
  facts.set("effort", config.effort ? "declared" : UNDECLARED);
  for (const [id, entry] of Object.entries(config.plugins ?? {})) {
    if (entry.enabled === true) facts.set(`plugins.${id}`, "enabled");
  }
  return facts;
}

/** Read a sibling repo's config, or null when it has none / it doesn't parse. */
function readRepoConfig(repoPath: string): NavoriConfig | null {
  const configPath = join(repoPath, "navori.config.json");
  if (!existsSync(configPath)) return null;
  try {
    return readConfig(configPath);
  } catch {
    // A sibling with a broken config is that repo's own doctor's problem.
    return null;
  }
}

/**
 * Divergences from the workspace manifest's `defaults`. Only declared defaults
 * are compared — an absent default states no policy, so it can't be violated.
 */
function driftVsDefaults(
  facts: Map<string, string>,
  defaults: NonNullable<ReturnType<typeof loadWorkspace>>["defaults"],
): WorkspaceDriftItem[] {
  const out: WorkspaceDriftItem[] = [];
  const compare = (key: string, expected: string | undefined): void => {
    if (expected === undefined) return;
    const local = facts.get(key) ?? UNDECLARED;
    if (local !== expected) out.push({ key, local, expected, agree: 0, total: 0 });
  };

  compare("branchBase", defaults.branchBase);
  compare("prTarget", defaults.prTarget);
  compare("commits", defaults.commits);
  compare("language", defaults.language);
  compare("engines", defaults.engines ? [...defaults.engines].sort().join(",") : undefined);
  for (const [id, entry] of Object.entries(defaults.plugins ?? {})) {
    // Only a default that ENABLES a plugin is a policy worth reporting; a
    // `false` default is the absence of one (the repo may still opt in).
    if (entry.enabled === true) compare(`plugins.${id}`, "enabled");
  }
  return out;
}

/**
 * Divergences from the siblings' mode: for every key at least one sibling
 * declares, tally the values and report when a strict majority agrees on one
 * this repo doesn't have. Plugins are one-directional on purpose — "the others
 * enable semgrep, you don't" is actionable; "you enable one they don't" is a
 * local decision, not drift.
 */
function driftVsSiblings(
  facts: Map<string, string>,
  siblings: ReadonlyArray<Map<string, string>>,
): WorkspaceDriftItem[] {
  if (siblings.length < MIN_SIBLINGS) return [];
  const keys = new Set<string>();
  for (const s of siblings) for (const k of s.keys()) keys.add(k);

  const out: WorkspaceDriftItem[] = [];
  for (const key of [...keys].sort()) {
    const tally = new Map<string, number>();
    for (const s of siblings) {
      const value = s.get(key) ?? UNDECLARED;
      tally.set(value, (tally.get(value) ?? 0) + 1);
    }
    let expected = UNDECLARED;
    let agree = 0;
    for (const [value, count] of tally) {
      if (count > agree) {
        expected = value;
        agree = count;
      }
    }
    // Strict majority only, and never "the majority declares nothing".
    if (expected === UNDECLARED || agree * 2 <= siblings.length) continue;
    const local = facts.get(key) ?? UNDECLARED;
    if (local === expected) continue;
    out.push({ key, local, expected, agree, total: siblings.length });
  }
  return out;
}

/**
 * Config drift of this repo against its workspace (#326). Returns null when the
 * repo declares no workspace, the manifest is missing (`scanWorkspaceLink`
 * already reports that), or nothing diverged.
 *
 * Sibling configs are read from the machine-local registry, so the sibling half
 * is best-effort by nature: a repo the registry points at a stale path simply
 * doesn't count. `siblingsRead` says how many actually did.
 */
export function scanWorkspaceDrift(cwd: string, config: NavoriConfig): WorkspaceDriftReport | null {
  const name = config.workspace;
  if (!name) return null;
  let ws;
  try {
    ws = loadWorkspace(name);
  } catch {
    return null; // unreadable manifest — scanWorkspaceLink reports it
  }
  if (!ws) return null;

  const here = canonicalPath(cwd);
  const siblings: Array<Map<string, string>> = [];
  for (const repo of ws.repos) {
    if (canonicalPath(repo.path) === here) continue;
    const sibling = readRepoConfig(repo.path);
    if (sibling) siblings.push(configFacts(sibling));
  }

  const facts = configFacts(config);
  const vsDefaults = driftVsDefaults(facts, ws.defaults);
  const vsSiblings = driftVsSiblings(facts, siblings).filter(
    // A key already reported against the defaults doesn't need a second row
    // saying the same thing with a different justification.
    (item) => !vsDefaults.some((d) => d.key === item.key),
  );
  const deduped = dropDerivedPrTarget([...vsDefaults, ...vsSiblings]);
  if (deduped.length === 0) return null;
  return {
    workspace: name,
    vsDefaults: deduped.filter((d) => vsDefaults.includes(d)),
    vsSiblings: deduped.filter((d) => vsSiblings.includes(d)),
    siblingsRead: siblings.length,
  };
}

/**
 * Drop the `prTarget` row when it merely echoes the `branchBase` one. Both facts
 * fall back to `branchBase`, so a repo that branches off `main` where everyone
 * else uses `develop` diverges on BOTH keys with identical values — two rows
 * stating one fact. The `branchBase` row is the cause and survives; a prTarget
 * that diverges on its own (decoupled from branchBase) still gets its row.
 */
function dropDerivedPrTarget(items: WorkspaceDriftItem[]): WorkspaceDriftItem[] {
  const branchBase = items.find((i) => i.key === "branchBase");
  if (!branchBase) return items;
  return items.filter(
    (i) =>
      i.key !== "prTarget" || i.local !== branchBase.local || i.expected !== branchBase.expected,
  );
}
