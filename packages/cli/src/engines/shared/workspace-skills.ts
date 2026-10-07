import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { NavoriConfig } from "../../lib/config/config.ts";
import type { MonorepoWorkspace } from "../../lib/workspace/monorepo.ts";
import { navoriAuthorship, type KeepReason } from "../../lib/render/removable.ts";
import type { KeptOrphan, PendingRemoval } from "./execute-plan.ts";
import type { PlannedSkill } from "./harness-plan.ts";

/**
 * Which skills each monorepo workspace writes (spec 0043). One pure decision,
 * fed by a single plan producer per engine and consumed by `render`, `sync` and
 * `doctor`, so what one previews is what another applies and what a third
 * diagnoses.
 */

/** `monorepo.workspaceHarness`, as the engines see it. */
export type WorkspaceHarness = "minimal" | "full" | "root";

/** `minimal` and `root` both trim the workspace; only `full` writes it whole. */
export function isTrimmedHarness(mode: WorkspaceHarness): boolean {
  return mode !== "full";
}

export interface WorkspaceSkillDecision {
  /** Workspace path → ids of planned skills that workspace does not write. */
  omitted: ReadonlyMap<string, ReadonlySet<string>>;
}

/** One workspace as the decision sees it: its effective config and plan. */
export interface DecisionWorkspace {
  ws: MonorepoWorkspace;
  config: NavoriConfig;
  skills: readonly PlannedSkill[];
  /** False when the declared preset failed to load — its plan is then incomplete. */
  presetLoaded: boolean;
}

export interface DecideWorkspaceSkillsInput {
  mode: WorkspaceHarness;
  root: { config: NavoriConfig; skills: readonly PlannedSkill[]; presetLoaded: boolean };
  workspaces: readonly DecisionWorkspace[];
  /** Fresh bytes of one skill under one config, for ONE engine. */
  render: (skill: PlannedSkill, config: NavoriConfig) => string;
  /**
   * The root WILL hold a navori-owned skill dir with this final name after this
   * run. Answered from disk only, plus the root plan when this run renders the
   * root first.
   */
  rootHas: (finalName: string) => boolean;
}

/**
 * Decide, per workspace, which of its planned skills it must NOT write.
 *
 * Rules, in order:
 *  1. Under `full` nothing is omitted.
 *  2. A workspace whose preset did not load, or a root whose preset did not
 *     load, omits nothing: its plan is incomplete, and acting on an incomplete
 *     plan is how valid skills get deleted.
 *  3. Under `minimal` a skill is omitted if and only if the root plans it with
 *     the same id, the fresh bytes are identical, and the root will hold it
 *     (`rootHas`). Id equality is not enough: a skill that interpolates a
 *     workspace's own `qualityGate` has the same id and different bytes.
 */
export function decideWorkspaceSkills(input: DecideWorkspaceSkillsInput): WorkspaceSkillDecision {
  const omitted = new Map<string, Set<string>>();
  if (input.mode === "full" || !input.root.presetLoaded) return { omitted };

  const rootById = new Map(input.root.skills.map((s) => [s.id, s]));
  const rootBytes = new Map<string, string>();
  const bytesOfRoot = (skill: PlannedSkill): string => {
    let bytes = rootBytes.get(skill.id);
    if (bytes === undefined) {
      bytes = input.render(skill, input.root.config);
      rootBytes.set(skill.id, bytes);
    }
    return bytes;
  };

  for (const w of input.workspaces) {
    if (!w.presetLoaded) continue;
    const ids = new Set<string>();
    for (const skill of w.skills) {
      if (input.mode !== "minimal") continue;
      const rootSkill = rootById.get(skill.id);
      if (!rootSkill || !input.rootHas(skill.id)) continue;
      if (input.render(skill, w.config) === bytesOfRoot(rootSkill)) ids.add(skill.id);
    }
    omitted.set(w.ws.path, ids);
  }
  return { omitted };
}

/** What `planOmittedSkillRemoval` decided about one skill's copies in a workspace. */
export interface OmittedSkillRemoval {
  removals: PendingRemoval[];
  kept: KeptOrphan[];
}

/**
 * Plan the removal of a workspace's copy of a skill it no longer writes, in both
 * shapes it may have (`<dir>/<id>/SKILL.md` and the legacy flat `<dir>/<id>.md`).
 *
 * ONE authorship criterion, the same for every engine (spec 0043 R3/R7): the
 * copy goes only if navori wrote it, no newer navori did, no block was edited by
 * hand, and nothing the user wrote sits outside the blocks — judged against
 * `expected` after `normalize`, so a copy rendered by an older navori (fewer
 * frontmatter keys) still reads as untouched. Anything else is kept and reported
 * with its reason. When the skill dir holds more than `SKILL.md`, only that file
 * goes and the user's siblings survive.
 */
export function planOmittedSkillRemoval(input: {
  cwd: string;
  /** Skills dir relative to `cwd`: `.claude/skills` or `.agents/skills`. */
  skillsDir: string;
  skill: { id: string; managedId: string };
  /** The skill as navori renders it fresh, sub-blocks included. */
  expected: string;
  /** Rewrites the on-disk copy the way a render now would. */
  normalize: (onDisk: string) => string;
}): OmittedSkillRemoval {
  const { cwd, skillsDir, skill } = input;
  const result: OmittedSkillRemoval = { removals: [], kept: [] };
  const dir = join(cwd, skillsDir, skill.id);
  for (const path of [join(cwd, skillsDir, `${skill.id}.md`), join(dir, "SKILL.md")]) {
    if (!lstatSync(path, { throwIfNoEntry: false })) continue;
    const verdict = omittedCopyVerdict(path, input);
    if (verdict !== "ours") {
      result.kept.push({ path: relative(cwd, path), reason: verdict });
    } else if (path === join(dir, "SKILL.md") && onlySkillFile(dir)) {
      result.removals.push({ path: dir, recursive: true, status: "removed-trimmed" });
    } else {
      result.removals.push({ path, status: "removed-trimmed" });
    }
  }
  return result;
}

function omittedCopyVerdict(
  path: string,
  input: {
    skill: { managedId: string };
    expected: string;
    normalize: (onDisk: string) => string;
  },
): "ours" | KeepReason {
  const requirePristine = { expected: input.expected, normalize: input.normalize };
  const asBlock = navoriAuthorship(path, input.skill.managedId, {
    verifyHash: true,
    requirePristine,
  });
  if (asBlock !== "ours") return asBlock;
  // The id-scoped read above only hashes the skill's own block. A plugin
  // sub-block edited by hand is a user's change too, so every block must verify.
  return navoriAuthorship(path, undefined, { verifyHash: true });
}

function onlySkillFile(dir: string): boolean {
  if (!existsSync(dir)) return false;
  const children = readdirSync(dir);
  return children.length === 1 && children[0] === "SKILL.md";
}
