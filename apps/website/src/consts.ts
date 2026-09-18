/**
 * Single source of truth for the facts the landing publishes about itself.
 *
 * Two classes of drift made this file necessary:
 *
 * 1. LINKS. Three components hardcoded `https://github.com/navori/navori`,
 *    which 404s — the repo is `UlisesCm/navori-harness`. A wrong URL copied
 *    into three files is one mistake made three times; a wrong URL here is one
 *    mistake in one place.
 *
 * 2. COUNTS. The landing claimed 8 commands, 6 presets and 6 plugins while the
 *    CLI shipped 21, 12 and 7. `/docs/<command>` stayed correct the whole time
 *    because `command-docs-inventory.test.ts` fails when a registered command
 *    has no page — the landing had no such guard, so it drifted for a quarter.
 *    `landing-inventory.test.ts` now audits INVENTORY against the real repo.
 *
 * When a count here is wrong, that test names the number and where to fix it.
 * Never "fix" the test by editing the expectation: edit the copy.
 */

/** Canonical repository. Verified reachable — the previous value was a 404. */
export const REPO_URL = "https://github.com/UlisesCm/navori-harness";

/** Published package. The binary is `navori` (renamed from `navori-ai`). */
export const NPM_URL = "https://www.npmjs.com/package/navori";

/**
 * What the repo actually ships, as of the version in `packages/cli/package.json`.
 * Every number is asserted against its real source by the inventory test:
 * commands against `index.ts`, presets/agents/skills/plugins against the
 * directories under `core-assets/`, engines against `src/engines/`.
 */
export const INVENTORY = {
  /** Subcommands registered in `packages/cli/src/index.ts`. */
  commands: 22,
  /** Stack presets under `packages/core/core-assets/presets/`. */
  presets: 12,
  /** Plugin bundles under `packages/plugins/`. */
  plugins: 7,
  /** Engine adapters under `packages/cli/src/engines/`. */
  engines: 5,
  /** Core agents under `packages/core/core-assets/agents/`. */
  agents: 8,
  /** Core skills + library skills — what a repo can end up with. */
  skills: 38,
  /** Hooks under `packages/core/core-assets/hooks/`. */
  hooks: 12,
} as const;

/** Plugin ids, in the order the toolbox section presents them. */
export const PLUGIN_IDS = [
  "acli",
  "codegraph",
  "engram",
  "gh",
  "jscpd",
  "semgrep",
  "tgrep",
] as const;

/** Engine ids, matching the directory names under `src/engines/`. */
export const ENGINE_IDS = ["claude", "codex", "agents-md", "cursor", "copilot"] as const;
