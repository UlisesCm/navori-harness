import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeUserDir } from "../../engines/claude/user-scope.ts";
import { safeHomedir } from "../primitives/home.ts";

/** The kinds of leftover the retired global layer (spec 0046) may have left on a machine. */
export type GlobalLeftoverKind = "manifest" | "plugin" | "legacy-hook" | "launch-agent";

/** One leftover: what it is and its resolved path (no trailing slash). */
export interface GlobalLeftover {
  kind: GlobalLeftoverKind;
  path: string;
}

/** `lstat`, so a broken symlink still counts as present. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** True only when `<dir>/.claude-plugin/plugin.json` parses with `name === "navori"`. */
function isNavoriPlugin(dir: string): boolean {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf-8"),
    );
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).name === "navori"
    );
  } catch {
    return false;
  }
}

/**
 * Find what the retired global layer left behind. Read-only: `lstat` for
 * existence, and the single read is the plugin candidate's `plugin.json`, so a
 * user's own skill named `navori` is never reported. An unusable HOME yields `[]`.
 */
export function scanGlobalLayerLeftovers(opts?: {
  home?: string;
  claudeDir?: string;
}): GlobalLeftover[] {
  let home: string;
  let claudeDir: string;
  try {
    home = opts?.home ?? safeHomedir();
    claudeDir = opts?.claudeDir ?? claudeUserDir();
  } catch {
    return [];
  }
  const found: GlobalLeftover[] = [];
  const manifest = join(home, ".navori", "global.json");
  if (present(manifest)) found.push({ kind: "manifest", path: manifest });
  const plugin = join(claudeDir, "skills", "navori");
  if (present(plugin) && isNavoriPlugin(plugin)) found.push({ kind: "plugin", path: plugin });
  const hook = join(claudeDir, "hooks", "navori-global-baseline.sh");
  if (present(hook)) found.push({ kind: "legacy-hook", path: hook });
  const plist = join(home, "Library", "LaunchAgents", "com.navori.audit-collect.plist");
  if (present(plist)) found.push({ kind: "launch-agent", path: plist });
  return found;
}
