import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NavoriConfig } from "../config/config.ts";
import { isVerifiedPiRuntime, MIN_PI_VERSION } from "../../engines/pi/runtime-version.ts";

/**
 * True when Pi roles silently changed behaviour: Pi is enabled, `models.codexMap` still names tiers
 * (older navori used it for Pi) and `models.piMap` is undefined. Defining `piMap` (even `{}`) silences it.
 */
export function piMapMigrationPending(config: NavoriConfig): boolean {
  return (
    config.engines.includes("pi") &&
    config.models?.piMap === undefined &&
    Object.values(config.models?.codexMap ?? {}).some((model) => model !== undefined)
  );
}

/** Shared by render and doctor; plain English like the other render warnings. */
export const PI_MAP_MIGRATION_WARNING =
  "Pi roles no longer take their model from models.codexMap: they now inherit the parent Pi model. Set models.piMap (opus/sonnet/haiku as provider/id) to pin them, or {} to keep inheriting and silence this warning.";

/**
 * Spec 0048 D4/D10: what `navori doctor` reports about the Pi runtime. Every finding is advisory and
 * best-effort (an absent `pi` binary or an unreadable settings file is "nothing to check", never an error),
 * and none of them flips doctor's `ok`: the extension itself already fails closed on them.
 */
export interface PiHealth {
  /** Installed Pi when it is below the verified floor, a prerelease or unparseable; null when verified or absent. */
  versionUnverified: { found: string; min: string } | null;
  /** `defaultTools` (project, else user) selects `powershell`. */
  powershellDefault: boolean;
  /** Project extension entries other than Navori's own, from `.pi/extensions/` and the project `extensions` setting. */
  foreignExtensions: string[];
  /** `models.codexMap` is set but `models.piMap` is not: Pi roles changed from codexMap to inheriting. */
  piMapMigration: boolean;
}

/** Parse a settings file; anything that is not a JSON object reads as "no settings". */
function readSettings(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
    ? value
    : undefined;
}

/** True when the effective tool selection turns `powershell` on (a `-powershell` entry turns it off). */
export function selectsPowershell(defaultTools: readonly string[] | undefined): boolean {
  if (defaultTools === undefined) return false;
  return defaultTools.includes("powershell") || defaultTools.includes("+powershell")
    ? !defaultTools.includes("-powershell")
    : false;
}

/**
 * Pi health for a project that enabled the engine; null otherwise. `piVersion` is injectable so the
 * probe (a spawn of `pi --version`) stays out of unit tests.
 */
export function scanPiHealth(
  cwd: string,
  config: NavoriConfig,
  piVersion: () => string | null = probePiVersion,
): PiHealth | null {
  if (!config.engines.includes("pi")) return null;
  const found = piVersion();
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const project = readSettings(join(cwd, ".pi", "settings.json"));
  const user = readSettings(join(agentDir, "settings.json"));
  // A project value overrides the user one (Pi settings precedence).
  const defaultTools = stringList(project?.defaultTools) ?? stringList(user?.defaultTools);
  const foreign: string[] = [];
  const extDir = join(cwd, ".pi", "extensions");
  if (existsSync(extDir)) {
    try {
      for (const name of readdirSync(extDir))
        if (name !== "navori.ts") foreign.push(`.pi/extensions/${name}`);
    } catch {
      // Unreadable directory: nothing to report rather than guess.
    }
  }
  for (const entry of stringList(project?.extensions) ?? []) {
    // `builtin:*` entries are Pi's own extensions, not a third party's.
    if (!entry.replace(/^[+-]/, "").startsWith("builtin:") && !foreign.includes(entry))
      foreign.push(entry);
  }
  return {
    versionUnverified:
      found !== null && !isVerifiedPiRuntime(found) ? { found, min: MIN_PI_VERSION } : null,
    powershellDefault: selectsPowershell(defaultTools),
    foreignExtensions: foreign.sort(),
    piMapMigration: piMapMigrationPending(config),
  };
}

/** `pi --version` output (the first version-looking token), or null when Pi is not on PATH. */
function probePiVersion(): string | null {
  try {
    const raw = execFileSync("pi", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000, // best-effort external probe must not hang doctor (#268)
    });
    return raw.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0] ?? null;
  } catch {
    return null;
  }
}
