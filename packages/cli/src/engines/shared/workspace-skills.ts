import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import type { NavoriConfig } from "../../lib/config/config.ts";
import type { MonorepoWorkspace } from "../../lib/workspace/monorepo.ts";
import {
  navoriAuthorship,
  type KeepReason,
  type NavoriAuthorship,
} from "../../lib/render/removable.ts";
import { SKILL_LISTING_CHAR_CAP } from "../../lib/assets/skill-meta.ts";
import {
  formatFrontmatterField,
  getFrontmatterField,
  parseFrontmatterFields,
  splitFrontmatter,
} from "../../lib/render/frontmatter.ts";
import { sanitizeProjectValue } from "../../lib/render/interpolate.ts";
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

export type SkillKind = "core" | "workflow" | "preset" | "library";

/** A skill the root writes on behalf of a workspace (spec 0043 R5). */
export interface HoistedSkill {
  /** Final directory name and marker id at the root: the original id or `slug-id`. */
  id: string;
  /** The planned skill as the source workspace plans it (its own `id`, not the final one). */
  source: PlannedSkill;
  /** Effective config of the source workspace — what the bytes are rendered with. */
  config: NavoriConfig;
  /** Set only for `slug-id`: the workspace name, for the description prefix. */
  workspaceName?: string;
}

export interface WorkspaceSkillDecision {
  /** Workspace path → ids of planned skills that workspace does not write. */
  omitted: ReadonlyMap<string, ReadonlySet<string>>;
  /** Skills the root adds. Only workspaces under `root` contribute. */
  hoisted: readonly HoistedSkill[];
  /**
   * Root dirs a previous hoist may have left, with what is needed to judge them
   * (see `planOmittedSkillRemoval`). Names this run still wants are already out.
   * Empty whenever a preset did not load: the plan is then incomplete.
   */
  rootPruneCandidates: readonly HoistedSkill[];
  /** Hoists skipped because the root path belongs to someone else, for the report. */
  blocked: ReadonlyArray<{
    workspace: string;
    id: string;
    reason: "foreign" | "modified" | "newer";
  }>;
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
  /** Every workspace declared in `monorepo.workspaces[]`, in config order — what slugs are made against. */
  allWorkspaces?: readonly MonorepoWorkspace[];
  kindOf: (skill: PlannedSkill) => SkillKind;
  /** Fresh bytes of one skill under one config, for ONE engine. */
  render: (skill: PlannedSkill, config: NavoriConfig) => string;
  /**
   * The root WILL hold a navori-owned skill dir with this final name after this
   * run. Answered from disk only, plus the root plan when this run renders the
   * root first.
   */
  rootHas: (finalName: string) => boolean;
  /** True when this run writes the root first, so what it hoists will be there. */
  rootRendered?: boolean;
  /** Authorship of an existing root skill dir not in the root plan. */
  rootAuthorship: (finalName: string) => "absent" | NavoriAuthorship;
}

/**
 * Decide, per workspace, which of its planned skills it must NOT write, and
 * what the root must write on its behalf.
 *
 * Rules, in order:
 *  1. Under `full` nothing is omitted or hoisted.
 *  2. A workspace whose preset did not load, or a root whose preset did not
 *     load, takes no part: its plan is incomplete, and acting on an incomplete
 *     plan is how valid skills get deleted. `rootPruneCandidates` is then empty.
 *  3. Under `minimal` a skill is omitted if and only if the root plans it with
 *     the same id, the fresh bytes are identical, and the root will hold it
 *     (`rootHas`). Id equality is not enough: a skill that interpolates a
 *     workspace's own `qualityGate` has the same id and different bytes.
 *  4. Under `root`, per workspace skill:
 *     - core/workflow: the root wins — omitted when the root holds it, however
 *       the bytes differ (no per-workspace variants, by the user's decision);
 *     - library/preset the root plans with the same bytes: omitted when held;
 *     - library/preset the root does not plan, or plans differently: hoisted.
 *       Contributions to one id that all agree, with no root version, become one
 *       skill with the original id; any other case names each `slug-id`. A final
 *       name the root already holds as someone else's goes to `blocked` and the
 *       workspace keeps its copy. A hoisted skill is omitted from its workspace
 *       only when the root will hold it.
 *     Whatever fails its guard is NOT omitted: the workspace keeps writing it.
 */
export function decideWorkspaceSkills(input: DecideWorkspaceSkillsInput): WorkspaceSkillDecision {
  const omitted = new Map<string, Set<string>>();
  const hoisted: HoistedSkill[] = [];
  const blocked: Array<WorkspaceSkillDecision["blocked"][number]> = [];
  const decision = (): WorkspaceSkillDecision => ({
    omitted,
    hoisted,
    rootPruneCandidates: [],
    blocked,
  });
  if (!input.root.presetLoaded) return decision();

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
  const eligible = input.workspaces.filter((w) => w.presetLoaded);
  const slugs = workspaceSlugs(input.allWorkspaces ?? input.workspaces.map((w) => w.ws));

  /** Library/preset skills to hoist, grouped by id. */
  const groups = new Map<
    string,
    Array<{ w: DecisionWorkspace; skill: PlannedSkill; bytes: string }>
  >();
  for (const w of eligible) {
    const ids = new Set<string>();
    omitted.set(w.ws.path, ids);
    for (const skill of w.skills) {
      const rootSkill = rootById.get(skill.id);
      const kind = input.kindOf(skill);
      if (input.mode === "minimal") {
        if (rootSkill && input.rootHas(skill.id)) {
          if (input.render(skill, w.config) === bytesOfRoot(rootSkill)) ids.add(skill.id);
        }
      } else if (input.mode === "root") {
        if (kind === "core" || kind === "workflow") {
          if (input.rootHas(skill.id)) ids.add(skill.id);
          continue;
        }
        const bytes = input.render(skill, w.config);
        if (rootSkill && bytes === bytesOfRoot(rootSkill)) {
          if (input.rootHas(skill.id)) ids.add(skill.id);
          continue;
        }
        const group = groups.get(skill.id) ?? [];
        group.push({ w, skill, bytes });
        groups.set(skill.id, group);
      }
    }
  }

  const held = (name: string): boolean => input.rootHas(name) || input.rootRendered === true;
  const seen = new Set<string>();
  for (const [id, group] of groups) {
    const agree = group.every((c) => c.bytes === group[0]!.bytes);
    const plain = agree && !rootById.has(id);
    for (const c of plain ? [group[0]!] : group) {
      const finalName = plain ? id : `${slugs.get(c.w.ws.path)}-${id}`;
      const source = { w: c.w, skill: c.skill };
      const verdict = rootNameVerdict(finalName, rootById, input.rootAuthorship);
      if (verdict !== "free") {
        blocked.push({ workspace: c.w.ws.name, id: finalName, reason: verdict });
        continue;
      }
      if (!seen.has(finalName)) {
        seen.add(finalName);
        hoisted.push(hoistedOf(finalName, source, plain ? undefined : c.w.ws.name));
      }
    }
    // Every workspace that contributed omits its copy, but only once the root
    // is going to hold the name it was hoisted under.
    for (const c of group) {
      const finalName = plain ? id : `${slugs.get(c.w.ws.path)}-${id}`;
      if (seen.has(finalName) && held(finalName)) omitted.get(c.w.ws.path)!.add(c.skill.id);
    }
  }

  const candidates = pruneCandidates(eligible, input, rootById, slugs, seen, blocked);
  return { omitted, hoisted, rootPruneCandidates: candidates, blocked };
}

function hoistedOf(
  id: string,
  source: { w: DecisionWorkspace; skill: PlannedSkill },
  workspaceName: string | undefined,
): HoistedSkill {
  return {
    id,
    source: source.skill,
    config: source.w.config,
    ...(workspaceName === undefined ? {} : { workspaceName }),
  };
}

/** Whether a root dir name can take a hoisted skill: free (absent or navori's own) or someone else's. */
function rootNameVerdict(
  finalName: string,
  rootById: ReadonlyMap<string, PlannedSkill>,
  rootAuthorship: DecideWorkspaceSkillsInput["rootAuthorship"],
): "free" | "foreign" | "modified" | "newer" {
  // A skill the root itself plans under that name is the root's, whatever its bytes.
  if (rootById.has(finalName)) return "foreign";
  const authorship = rootAuthorship(finalName);
  return authorship === "absent" || authorship === "ours" ? "free" : authorship;
}

/**
 * Root dirs a previous hoist may have left that this run no longer wants: every
 * name a library/preset skill of an eligible workspace could be hoisted under
 * (its original id when the root does not plan it, and `slug-id`), minus what
 * this run hoists and what the root plans. Computed from the CURRENT config
 * only — a slug from a workspace since renamed or removed cannot be found
 * without scanning directories, which is exactly what is rejected (see
 * spec 0043 NOT in scope).
 */
function pruneCandidates(
  eligible: readonly DecisionWorkspace[],
  input: DecideWorkspaceSkillsInput,
  rootById: ReadonlyMap<string, PlannedSkill>,
  slugs: ReadonlyMap<string, string>,
  wanted: ReadonlySet<string>,
  blocked: ReadonlyArray<{ id: string }>,
): HoistedSkill[] {
  const out = new Map<string, HoistedSkill>();
  for (const w of eligible) {
    for (const skill of w.skills) {
      const kind = input.kindOf(skill);
      if (kind === "core" || kind === "workflow") continue;
      const names = [
        { name: skill.id, workspaceName: undefined },
        { name: `${slugs.get(w.ws.path)}-${skill.id}`, workspaceName: w.ws.name },
      ];
      for (const { name, workspaceName } of names) {
        if (rootById.has(name) || wanted.has(name) || blocked.some((b) => b.id === name)) continue;
        if (!out.has(name)) out.set(name, hoistedOf(name, { w, skill }, workspaceName));
      }
    }
  }
  return [...out.values()];
}

/** `@moonar/backend` → `moonar-backend`: lowercase, runs outside `[a-z0-9]` become one `-`. */
function slugOf(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The slug each workspace is hoisted under, keyed by workspace path.
 *
 * From the name; when two workspaces give the same slug, both fall back to the
 * slug of their `path`; if even those collide, a numeric suffix is appended in
 * `monorepo.workspaces[]` order. Depends only on names and paths, never on
 * which skill is being hoisted, so reordering the list renames nothing.
 */
export function workspaceSlugs(all: readonly MonorepoWorkspace[]): Map<string, string> {
  const count = (slugs: string[]): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const slug of slugs) counts.set(slug, (counts.get(slug) ?? 0) + 1);
    return counts;
  };
  const byName = all.map((w) => slugOf(w.name) || slugOf(w.path) || "workspace");
  const nameCounts = count(byName);
  const picked = all.map((w, i) =>
    (nameCounts.get(byName[i]!) ?? 0) > 1 ? slugOf(w.path) || byName[i]! : byName[i]!,
  );
  const pickedCounts = count(picked);
  const used = new Map<string, number>();
  const out = new Map<string, string>();
  all.forEach((w, i) => {
    const slug = picked[i]!;
    if ((pickedCounts.get(slug) ?? 0) <= 1) {
      out.set(w.path, slug);
      return;
    }
    const n = (used.get(slug) ?? 0) + 1;
    used.set(slug, n);
    out.set(w.path, `${slug}-${n}`);
  });
  return out;
}

/** `slug-id` for a workspace, as `workspaceSlugs` names it. */
export function workspaceSlug(ws: MonorepoWorkspace, all: readonly MonorepoWorkspace[]): string {
  return workspaceSlugs(all).get(ws.path) ?? slugOf(ws.name);
}

/**
 * The asset-text rewrite that turns a workspace's skill into the root's
 * `slug-id` variant: `name` becomes the final name (the command comes from
 * `name`, not the directory) and `description` gains the workspace as a prefix,
 * trimmed so name + description stay inside Claude Code's listing cap. Returns
 * `undefined` for a skill hoisted under its original id, which needs no rewrite.
 */
export function hoistTransform(h: HoistedSkill): ((text: string) => string) | undefined {
  const workspaceName = h.workspaceName;
  if (workspaceName === undefined) return undefined;
  const prefix = `[${sanitizeProjectValue(workspaceName)}] `;
  return (text) => {
    const { frontmatter, body } = splitFrontmatter(text);
    if (frontmatter === "") return text;
    const fields = parseFrontmatterFields(frontmatter);
    const original = getFrontmatterField(frontmatter, "description") ?? "";
    const whenToUse = getFrontmatterField(frontmatter, "when_to_use") ?? "";
    const room = Math.max(0, SKILL_LISTING_CHAR_CAP - whenToUse.length - prefix.length);
    const description =
      original.length > room ? `${original.slice(0, Math.max(0, room - 1))}…` : original;
    const next: Record<string, string> = {
      ...fields,
      name: h.id,
      description: prefix + description,
    };
    const rebuilt = Object.entries(next)
      .map(([key, value]) => formatFrontmatterField(key, value))
      .join("\n");
    return `---\n${rebuilt}\n---\n${body}`;
  };
}

/** The planned skill the root writes for a hoisted one: the final name is both dir and marker id. */
export function hoistedPlannedSkill(h: HoistedSkill): PlannedSkill {
  return { id: h.id, assetPath: h.source.assetPath, managedId: h.id };
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
