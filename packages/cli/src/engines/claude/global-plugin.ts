import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getCoreRoot, readCliVersion } from "../../lib/bundled-assets.ts";
import type { NavoriConfig } from "../../lib/schema.ts";
import type { GlobalConfig } from "../../lib/global-config.ts";
import { CORE_SOURCE_ID } from "../../lib/render-plan.ts";
import { resolveHarnessPlan } from "../shared/harness-plan.ts";
import { renderManagedFile } from "../shared/render-managed-file.ts";
import {
  GLOBAL_HOOK_BASENAME,
  generateHookScript,
  globalRenderConfig,
  globalTargetDir,
} from "./global-render.ts";

/**
 * The machine-wide harness's OPERATIONAL half (Spec 0010 FB, issue #546): the
 * agents and skills a project with no navori config inherits, shipped as a
 * `@skills-dir` plugin under `~/.claude/skills/navori/`.
 *
 * WHY A PLUGIN AND NOT LOOSE FILES. Claude Code's precedence is not uniform
 * across asset kinds, and for skills it runs the opposite way from subagents:
 * a personal `~/.claude/skills/<id>/` SHADOWS the project's `.claude/skills/<id>/`.
 * Installing the 12 base skills loose would therefore have eclipsed every repo's
 * own copy — user-sections included — silently, in every project on the machine.
 * A directory carrying `.claude-plugin/plugin.json` loads as `navori@skills-dir`
 * with no marketplace and no install step, and its skills are namespaced
 * `/navori:<id>`, so both copies coexist instead of one overriding the other.
 *
 * The subagents get the §3.1 gate for free from the same mechanism, in the
 * direction that suits them: plugin agents are the LOWEST precedence, below
 * `.claude/agents/` and `~/.claude/agents/`. A repo with navori wins with its
 * own; a repo without one gets the plugin's. No walk-up, no detection.
 *
 * The baseline gate hook moves in here too (`hooks/hooks.json`), which is what
 * takes navori's hooks out of the user's `~/.claude/settings.json` — only the
 * personal `permissions` stay there.
 */

/** Plugin name; also the directory under `<claude dir>/skills/` and the `/navori:` namespace. */
export const GLOBAL_PLUGIN_NAME = "navori";

/** Plugin dir relative to the Claude config dir. */
export const GLOBAL_PLUGIN_REL = `skills/${GLOBAL_PLUGIN_NAME}`;

/** Manifest path relative to the plugin dir (the marker that makes it a plugin). */
export const PLUGIN_MANIFEST_REL = ".claude-plugin/plugin.json";

/** Hook config path relative to the plugin dir. */
export const PLUGIN_HOOKS_REL = "hooks/hooks.json";

/** The gate hook's path relative to the plugin dir. */
export const PLUGIN_HOOK_SCRIPT_REL = `hooks/${GLOBAL_HOOK_BASENAME}`;

/** Absolute path of the `@skills-dir` plugin navori installs. */
export function globalPluginDir(dir = globalTargetDir()): string {
  return join(dir, GLOBAL_PLUGIN_REL);
}

/** One file of the plugin, addressed relative to the plugin dir. */
export interface GlobalPluginFile {
  relPath: string;
  content: string;
  exec?: boolean;
}

export interface GlobalPluginPlan {
  dir: string;
  files: GlobalPluginFile[];
}

/**
 * The plugin manifest. Kept to the documented fields ONLY: `claude plugin
 * validate --strict` reports unrecognized keys, so navori's usual authorship
 * marker has no place here — the agents and skills carry theirs inside their
 * own managed blocks, and the hook carries its version+hash line.
 */
function manifest(version: string): string {
  return `${JSON.stringify(
    {
      name: GLOBAL_PLUGIN_NAME,
      version,
      description:
        "navori's machine-wide harness: agents and skills for projects with no navori config.",
      // Not decoration: `claude plugin validate --strict` warns without it, and
      // that warning is an error under the flag the FB spec validates against.
      author: { name: "navori" },
    },
    null,
    2,
  )}\n`;
}

/**
 * The plugin's hook registration. `${CLAUDE_PLUGIN_ROOT}` is how a plugin
 * addresses its own files, and the double quotes around it are the documented
 * form — the plugin dir sits under the user's home, which routinely has spaces.
 */
function hooksJson(): string {
  return `${JSON.stringify(
    {
      hooks: {
        SessionStart: [
          {
            matcher: "startup|resume|compact",
            hooks: [
              {
                type: "command",
                command: `"\${CLAUDE_PLUGIN_ROOT}"/${PLUGIN_HOOK_SCRIPT_REL}`,
                timeout: 15,
                statusMessage: "navori: global baseline",
              },
            ],
          },
        ],
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * Compute every file of the plugin without writing any of them.
 *
 * Agents and skills go through the SAME `renderManagedFile` the repo render
 * uses, so they keep their managed markers and their user zones: an edit a user
 * makes below the marker in `~/.claude/skills/navori/skills/<id>/SKILL.md`
 * survives the next `global render` exactly as it does in a repo. `existingDir`
 * is read for that reason — a fresh render and a re-render are different
 * operations.
 */
export function planGlobalPlugin(
  config: GlobalConfig,
  baseline: string,
  dir = globalTargetDir(),
): GlobalPluginPlan {
  const pluginDir = globalPluginDir(dir);
  const version = readCliVersion();
  const meta = { source: CORE_SOURCE_ID, version };
  const renderConfig = globalRenderConfig(config);
  const coreAssets = resolve(getCoreRoot(), "core-assets");
  // `preset` is null on purpose: a preset is a repo's choice, read from its
  // `navori.config.json` — the scope this plugin exists to serve has none.
  const harness = resolveHarnessPlan(renderConfig, coreAssets, null, { includeLeader: true });

  const files: GlobalPluginFile[] = [
    { relPath: PLUGIN_MANIFEST_REL, content: manifest(version) },
    { relPath: PLUGIN_HOOKS_REL, content: hooksJson() },
    {
      relPath: PLUGIN_HOOK_SCRIPT_REL,
      content: generateHookScript(baseline, version),
      exec: true,
    },
  ];

  for (const agent of harness.agents) {
    files.push({
      relPath: `agents/${agent.id}.md`,
      content: renderAsset(pluginDir, `agents/${agent.id}.md`, agent.assetPath, agent.managedId, {
        meta,
        config: renderConfig,
      }),
    });
  }
  for (const skill of harness.skills) {
    files.push({
      relPath: `skills/${skill.id}/SKILL.md`,
      content: renderAsset(
        pluginDir,
        `skills/${skill.id}/SKILL.md`,
        skill.assetPath,
        skill.managedId,
        { meta, config: renderConfig },
      ),
    });
  }

  return { dir: pluginDir, files };
}

function renderAsset(
  pluginDir: string,
  relPath: string,
  assetPath: string,
  managedId: string,
  ctx: { meta: { source: string; version: string }; config: NavoriConfig },
): string {
  const dest = join(pluginDir, relPath);
  return renderManagedFile({
    assetPath,
    existingContent: existsSync(dest) ? readFileSync(dest, "utf-8") : null,
    managedId,
    meta: ctx.meta,
    config: ctx.config,
    commentStyle: "html",
    fallbackScope: "global",
  }).content;
}

/** Files of the plan that are absent or differ on disk. Empty ⇒ the plugin is current. */
export function pluginDrift(plan: GlobalPluginPlan): string[] {
  const drifted: string[] = [];
  for (const file of plan.files) {
    const dest = join(plan.dir, file.relPath);
    if (!existsSync(dest) || readFileSync(dest, "utf-8") !== file.content) {
      drifted.push(file.relPath);
    }
  }
  return drifted;
}

/** True iff a plugin manifest is on disk — what makes Claude Code load the dir at all. */
export function pluginInstalled(dir = globalTargetDir()): boolean {
  return existsSync(join(globalPluginDir(dir), PLUGIN_MANIFEST_REL));
}

/** Write the plan. Returns the relative paths actually written. */
export function applyGlobalPlugin(plan: GlobalPluginPlan): string[] {
  const written: string[] = [];
  for (const file of plan.files) {
    const dest = join(plan.dir, file.relPath);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.content);
    if (file.exec) chmodSync(dest, 0o755);
    written.push(file.relPath);
  }
  return written;
}

/**
 * Remove the plugin: the whole `~/.claude/skills/navori/` directory, and only
 * it. There is no marketplace to uninstall from — deleting the directory IS the
 * uninstall — and every sibling under `~/.claude/skills/` is the user's own.
 *
 * The parent `skills/` dir is removed only when navori's departure leaves it
 * empty, so a user who had no skills of their own gets their home back exactly
 * as it was (Spec 0010 FB, test 4).
 */
export function removeGlobalPlugin(dir = globalTargetDir()): boolean {
  const pluginDir = globalPluginDir(dir);
  if (!existsSync(pluginDir)) return false;
  rmSync(pluginDir, { recursive: true, force: true });
  const skillsDir = join(dir, "skills");
  try {
    if (readdirSync(skillsDir).length === 0) rmSync(skillsDir, { recursive: true, force: true });
  } catch {
    // The parent is gone or unreadable; the plugin removal already succeeded.
  }
  return true;
}
