import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  globalTargetDir,
  permissionBagOf,
  readExistingSettings,
} from "../engines/claude/global-render.ts";
import { globalConfigExists } from "./global-config.ts";
import { listMarkers } from "./health.ts";
import { SKILL_DIR_ENTRY } from "./skill-meta.ts";
import type { NavoriConfig } from "./config.ts";

/**
 * The harness that was already there when navori arrived (spec 0014, #555).
 *
 * Agents and skills in `~/.claude`, a hand-made `.claude/` in the repo, another
 * vendor's plugin: none of it is navori's business UNTIL a name exists on both
 * sides. Then one wins by precedence and the other goes inert — silently, which
 * is the whole defect. On the author's machine `~/.claude/skills/
 * verify-before-done.md` shadows navori's own skill of that name, user-section
 * included, and nothing says so.
 *
 * ONLY CONFLICT IS REPORTED (R1/R2). A foreign harness that coexists without
 * stepping on anything is never mentioned — without that filter doctor would
 * print the same section in every repo forever, and an advisory nobody can act
 * on is one everybody learns to skip. Same zero-footprint invariant the global
 * layer holds itself to (spec 0010 §2.4).
 *
 * Everything here is READ-ONLY and advisory: it feeds neither `HealthVerdict`
 * nor doctor's exit code (R17).
 */

export type ForeignScope = "repo" | "personal" | "plugin";
export type ForeignAssetType = "agent" | "skill";

/** Who Claude Code actually loads when both files exist. */
export type ConflictWinner = "navori" | "foreign" | "undecided";

export interface ForeignConflict {
  /**
   * Stable across runs and across machines: `<type>:<scope>:<name>` (R10). No
   * absolute paths in it — the acknowledgement list is committed, so the id has
   * to mean the same thing on the laptop next to yours.
   */
  id: string;
  type: ForeignAssetType;
  scope: ForeignScope;
  name: string;
  /** Repo-relative for `repo`, absolute for the scopes outside it. */
  foreignPath: string;
  /** Repo-relative path of navori's managed asset with the same name. */
  navoriPath: string;
  winner: ConflictWinner;
  /** Set only for a `repo` foreign file that git ignores (R6). */
  gitignored?: boolean;
  /** navori writes inside the repo and nowhere else, so only these can be adopted (R7). */
  adoptable: boolean;
  /** Owning plugin, when the foreign copy came from one. */
  pluginId?: string;
}

/** A rule navori denies that a foreign settings file allows (R3). */
export interface ForeignPermissionConflict {
  rule: string;
  /** Repo-relative for `settings.local.json`, absolute for the personal one. */
  path: string;
}

export interface ForeignHarnessReport {
  conflicts: ForeignConflict[];
  permissions: ForeignPermissionConflict[];
  /** `acknowledged` entries matching no current conflict (R9). */
  staleAcknowledged: string[];
}

export interface ForeignHarnessOptions {
  /**
   * Claude's user-level config dir. Injected by the specs so they never read
   * the developer's real `~/.claude`; production resolves it through
   * `globalTargetDir()`, which honors `CLAUDE_CONFIG_DIR`.
   */
  claudeDir?: string;
  /**
   * Whether navori's own global layer is installed. When it is, the personal
   * `settings.json` vs repo `deny` comparison belongs to `scanGlobalScope`
   * (#547) and is skipped here so one rule is never printed twice.
   */
  globalLayerInstalled?: boolean;
}

/** navori's own global plugin — its assets are navori's, never foreign. */
const NAVORI_PLUGIN_DIR = "navori";

/** Marker of a directory that Claude Code loads as a `@skills-dir` plugin. */
const PLUGIN_MANIFEST_REL = join(".claude-plugin", "plugin.json");

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** True when the file on disk carries a navori managed block. */
function isNavoris(path: string): boolean {
  return existsSync(path) && listMarkers(path).length > 0;
}

/**
 * Skill name → file that declares it, for one skills directory.
 *
 * The two layouts are read in ONE pass and the directory one wins the name: a
 * flat `x.md` beside an `x/SKILL.md` is a collision, not a replacement, and
 * letting the second overwrite the first in this map made the repo-scope
 * collision invisible — the exact shape the spec exists to catch.
 */
function skillsIn(dir: string): Map<string, string> {
  const dirs = new Map<string, string>();
  const flats = new Map<string, string>();
  for (const entry of safeReaddir(dir)) {
    const full = join(dir, entry);
    if (isDir(full)) {
      const skillMd = join(full, SKILL_DIR_ENTRY);
      if (existsSync(skillMd)) dirs.set(entry, skillMd);
    } else if (entry.endsWith(".md") && entry !== SKILL_DIR_ENTRY) {
      flats.set(entry.slice(0, -".md".length), full);
    }
  }
  return new Map([...flats, ...dirs]);
}

/** Agent name → file, for one agents directory. */
function agentsIn(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of safeReaddir(dir)) {
    if (!entry.endsWith(".md")) continue;
    found.set(entry.slice(0, -".md".length), join(dir, entry));
  }
  return found;
}

/**
 * The `@skills-dir` plugins installed under `<claudeDir>/skills/`, minus
 * navori's own. A directory is a plugin when it carries the manifest Claude
 * Code looks for; anything else there is a personal skill.
 */
function foreignPlugins(claudeDir: string): string[] {
  const skillsDir = join(claudeDir, "skills");
  return safeReaddir(skillsDir)
    .filter((name) => name !== NAVORI_PLUGIN_DIR)
    .filter((name) => existsSync(join(skillsDir, name, PLUGIN_MANIFEST_REL)))
    .sort();
}

/** Whether git ignores a repo-relative path. Unknown (`false`) outside a repo. */
function gitIgnores(cwd: string, relPath: string): boolean {
  const result = spawnSync("git", ["check-ignore", "--quiet", "--", relPath], {
    cwd,
    stdio: "ignore",
  });
  return result.status === 0;
}

function conflictId(type: ForeignAssetType, scope: ForeignScope, name: string): string {
  return `${type}:${scope}:${name}`;
}

/**
 * navori's managed assets in this repo, by name.
 *
 * The managed marker is the discriminant, never the file name — the rule #547
 * settled. In a healthy navori repo every agent exists in two scopes BY DESIGN,
 * so a same-named file proves nothing on its own; what marks an asset as
 * navori's is that navori wrote it.
 */
function navoriInventory(cwd: string): {
  agents: Map<string, string>;
  skills: Map<string, string>;
} {
  const agents = new Map<string, string>();
  for (const [name, path] of agentsIn(join(cwd, ".claude", "agents"))) {
    if (isNavoris(path)) agents.set(name, join(".claude", "agents", `${name}.md`));
  }
  const skills = new Map<string, string>();
  for (const [name, path] of skillsIn(join(cwd, ".claude", "skills"))) {
    if (!isNavoris(path)) continue;
    skills.set(name, path.slice(cwd.length + 1));
  }
  return { agents, skills };
}

/**
 * Two files declaring the same skill INSIDE the repo — a flat `<name>.md` next
 * to navori's `<name>/SKILL.md`.
 *
 * The only same-scope collision that can exist: one path holds one file, so a
 * hand-made agent and a managed agent can never share `.claude/agents/x.md`.
 * The two skill layouts CAN coexist, and which of them Claude Code loads is not
 * documented — so the verdict is `undecided` and the report says exactly that
 * instead of inventing a winner (R4).
 */
function repoSkillCollisions(cwd: string, navori: Map<string, string>): ForeignConflict[] {
  const out: ForeignConflict[] = [];
  const skillsDir = join(cwd, ".claude", "skills");
  for (const [name, navoriPath] of navori) {
    const flat = join(skillsDir, `${name}.md`);
    const flatRel = join(".claude", "skills", `${name}.md`);
    // The managed asset is the directory one, so a flat file of the same name is
    // necessarily somebody else's.
    if (!navoriPath.endsWith(SKILL_DIR_ENTRY) || !existsSync(flat) || isNavoris(flat)) continue;
    const conflict: ForeignConflict = {
      id: conflictId("skill", "repo", name),
      type: "skill",
      scope: "repo",
      name,
      foreignPath: flatRel,
      navoriPath,
      winner: "undecided",
      adoptable: true,
    };
    if (gitIgnores(cwd, flatRel)) conflict.gitignored = true;
    out.push(conflict);
  }
  return out;
}

/**
 * Personal assets that collide with navori's, and the precedence that decides
 * them — which is NOT uniform, and for skills runs the opposite way (R5):
 *
 *   - agents: the repo's `.claude/agents/` wins over `~/.claude/agents/`;
 *   - skills: `~/.claude/skills/` wins over the repo's, because across levels
 *     "enterprise overrides personal, and personal overrides project".
 *
 * A single rule would name the wrong winner half the time, which is worse than
 * saying nothing: the reader acts on the name.
 */
function personalCollisions(
  claudeDir: string,
  navori: { agents: Map<string, string>; skills: Map<string, string> },
): ForeignConflict[] {
  const out: ForeignConflict[] = [];
  for (const [name, path] of agentsIn(join(claudeDir, "agents"))) {
    const navoriPath = navori.agents.get(name);
    if (!navoriPath) continue;
    out.push({
      id: conflictId("agent", "personal", name),
      type: "agent",
      scope: "personal",
      name,
      foreignPath: path,
      navoriPath,
      winner: "navori",
      adoptable: false,
    });
  }
  for (const [name, path] of skillsIn(join(claudeDir, "skills"))) {
    // A plugin directory is not a personal skill; its skills are namespaced.
    if (existsSync(join(claudeDir, "skills", name, PLUGIN_MANIFEST_REL))) continue;
    const navoriPath = navori.skills.get(name);
    if (!navoriPath) continue;
    out.push({
      id: conflictId("skill", "personal", name),
      type: "skill",
      scope: "personal",
      name,
      foreignPath: path,
      navoriPath,
      winner: "foreign",
      adoptable: false,
    });
  }
  return out;
}

/**
 * Agents shipped by somebody else's `@skills-dir` plugin that this repo makes
 * inert. Their SKILLS are deliberately absent: a plugin skill is invoked
 * `/<plugin>:<skill>`, so by construction it collides with nothing (R5).
 */
function pluginCollisions(claudeDir: string, navoriAgents: Map<string, string>): ForeignConflict[] {
  const out: ForeignConflict[] = [];
  for (const pluginId of foreignPlugins(claudeDir)) {
    const dir = join(claudeDir, "skills", pluginId, "agents");
    for (const [name, path] of agentsIn(dir)) {
      const navoriPath = navoriAgents.get(name);
      if (!navoriPath) continue;
      out.push({
        id: conflictId("agent", "plugin", name),
        type: "agent",
        scope: "plugin",
        name,
        foreignPath: path,
        navoriPath,
        winner: "navori",
        adoptable: false,
        pluginId,
      });
    }
  }
  return out;
}

/**
 * Rules navori's `settings.json` denies that a foreign settings file allows
 * (R3). A `deny` that something else allows is a guard that does not guard.
 *
 * Two sources, and the personal one is skipped when navori's global layer is
 * installed: `scanGlobalScope` already compares exactly that pair (#547), and
 * printing one rule in two sections teaches the reader that the sections
 * overlap rather than that the rule is doubly broken.
 */
function permissionContradictions(
  cwd: string,
  claudeDir: string,
  globalLayerInstalled: boolean,
): ForeignPermissionConflict[] {
  const repoRead = readExistingSettings(join(cwd, ".claude"));
  if (repoRead.kind !== "ok") return [];
  const denied = new Set(permissionBagOf(repoRead.settings).deny ?? []);
  if (denied.size === 0) return [];

  const out: ForeignPermissionConflict[] = [];
  const sources: Array<{ dir: string; file: string; label: string; skip: boolean }> = [
    {
      dir: join(cwd, ".claude"),
      file: "settings.local.json",
      label: join(".claude", "settings.local.json"),
      skip: false,
    },
    {
      dir: claudeDir,
      file: "settings.json",
      label: join(claudeDir, "settings.json"),
      skip: globalLayerInstalled,
    },
  ];
  for (const source of sources) {
    if (source.skip) continue;
    const read = readExistingSettings(source.dir, source.file);
    if (read.kind !== "ok") continue;
    for (const rule of permissionBagOf(read.settings).allow ?? []) {
      if (denied.has(rule)) out.push({ rule, path: source.label });
    }
  }
  return out;
}

/** Ids the repo declared as assumed, so they stop being reported (R8). */
function acknowledgedIds(config: NavoriConfig): string[] {
  return config.project?.foreignHarness?.acknowledged ?? [];
}

/**
 * The foreign harness seen from this repo. `null` means "nothing to compare
 * against": no Claude output rendered here, or no usable HOME — an environment
 * problem is not doctor's to crash on.
 */
export function scanForeignHarness(
  cwd: string,
  config: NavoriConfig,
  options: ForeignHarnessOptions = {},
): ForeignHarnessReport | null {
  if (!config.engines.includes("claude")) return null;
  let claudeDir: string;
  try {
    claudeDir = options.claudeDir ?? globalTargetDir();
  } catch {
    return null; // HomeError: the honest answer is "I cannot know"
  }

  const navori = navoriInventory(cwd);
  const globalLayerInstalled = options.globalLayerInstalled ?? globalConfigExists();
  const all = [
    ...repoSkillCollisions(cwd, navori.skills),
    ...personalCollisions(claudeDir, navori),
    ...pluginCollisions(claudeDir, navori.agents),
  ].sort((a, b) => a.id.localeCompare(b.id));

  const acknowledged = new Set(acknowledgedIds(config));
  const conflicts = all.filter((conflict) => !acknowledged.has(conflict.id));
  const live = new Set(all.map((conflict) => conflict.id));
  const staleAcknowledged = [...acknowledged].filter((id) => !live.has(id)).sort();

  return {
    conflicts,
    permissions: permissionContradictions(cwd, claudeDir, globalLayerInstalled),
    staleAcknowledged,
  };
}
