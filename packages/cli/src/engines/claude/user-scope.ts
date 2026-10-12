import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { safeHomedir } from "../../lib/primitives/home.ts";

/**
 * Read-only helpers for Claude Code's USER scope (`~/.claude`). They survive the
 * retirement of the global layer (spec 0046): `doctor` still reads the personal
 * settings to report conflicts, but navori never writes there.
 */

/** The three permission buckets Claude Code understands, in a stable order. */
export const PERMISSION_KINDS = ["allow", "deny", "ask"] as const;

/**
 * Claude Code's user config dir: `CLAUDE_CONFIG_DIR` if set (that is how
 * Claude Code itself resolves it), else `~/.claude`. A relative override is
 * resolved against the cwd.
 */
export function claudeUserDir(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  if (override && override.trim().length > 0) return resolve(override.trim());
  return join(safeHomedir(), ".claude");
}

/**
 * What `<dir>/<file>` holds right now. "Absent" and "unreadable" are DIFFERENT
 * facts and this type refuses to conflate them (#497).
 */
export type SettingsRead =
  | { kind: "absent" }
  | { kind: "ok"; settings: Record<string, unknown> }
  | { kind: "parse-error"; detail: string }
  | { kind: "not-object" };

/**
 * Read a settings file. A file that exists but cannot be parsed (or does not
 * hold a JSON object) comes back as its own kind, never as an empty object.
 */
export function readSettingsFile(dir: string, fileName = "settings.json"): SettingsRead {
  const path = join(dir, fileName);
  if (!existsSync(path)) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return { kind: "parse-error", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "not-object" };
  return { kind: "ok", settings: parsed as Record<string, unknown> };
}

/**
 * The `permissions` object of a settings.json, normalized to three string lists.
 * One definition of what counts as a rule, shared by every scope that compares.
 */
export function permissionBagOf(settings: Record<string, unknown>): Record<string, string[]> {
  const perms = settings.permissions;
  const raw =
    perms && typeof perms === "object" && !Array.isArray(perms)
      ? (perms as Record<string, unknown>)
      : {};
  const bag: Record<string, string[]> = {};
  for (const kind of PERMISSION_KINDS) {
    const list = raw[kind];
    bag[kind] = Array.isArray(list) ? list.filter((e): e is string => typeof e === "string") : [];
  }
  return bag;
}
