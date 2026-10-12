import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type * as BundledAssets from "../../render/bundled-assets.ts";

/**
 * Throwaway plugin packages for tests that need a plugin shape no bundled plugin
 * has any more (a gate hook, a skill sub-block, a capability probe). Pair with a
 * `vi.mock` of `bundled-assets.ts` that returns `withFakePlugins(actual, {...})`.
 */

/**
 * A plugin package in a temp dir: `plugin.json` = the base fields plus `manifest`,
 * and every `files` entry (package-relative path → content). Returns its dir.
 */
export function writeFakePlugin(
  id: string,
  manifest: Record<string, unknown> = {},
  files: Readonly<Record<string, string>> = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), `navori-fake-${id}-`));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({
      id,
      name: id,
      description: "test plugin",
      version: "0.0.1",
      managed: [],
      ...manifest,
    }),
  );
  return dir;
}

/** A plugin whose one skill sub-block injects into `injectInto`. */
export function writeFakeSkillPlugin(id: string, injectInto: string): string {
  return writeFakePlugin(
    id,
    {
      skills: [
        {
          id: `${id}-review-extension`,
          file: `skills/${id}-review.md`,
          recommendedAgent: "reviewer",
          injectInto,
        },
      ],
    },
    { [`skills/${id}-review.md`]: `## ${id} extension\n\nBody of ${id}.\n` },
  );
}

/** A plugin shipping `check-<id>.sh` plus the PreToolUse(Bash) hook that runs it. */
export function writeFakeHookPlugin(id: string): string {
  const script = `check-${id}.sh`;
  return writeFakePlugin(
    id,
    {
      scripts: [{ src: `scripts/${script}`, dest: script, exec: true }],
      hooks: [
        {
          event: "PreToolUse",
          matcher: "Bash",
          command: `bash "$CLAUDE_PROJECT_DIR/.claude/scripts/${script}"`,
          timeout: 600,
          statusMessage: `navori/${id}: check`,
        },
      ],
    },
    { [`scripts/${script}`]: "#!/usr/bin/env bash\nset -euo pipefail\nexit 0\n" },
  );
}

/** `bundled-assets` exports with `dirs` (id → package dir) resolvable as bundled plugins. */
export function withFakePlugins(
  actual: typeof BundledAssets,
  dirs: Readonly<Record<string, string>>,
): typeof BundledAssets {
  return {
    ...actual,
    getPluginPath: (id: string) => dirs[id] ?? actual.getPluginPath(id),
    bundledPluginManifestPath: (id: string) =>
      dirs[id] ? join(dirs[id], "plugin.json") : actual.bundledPluginManifestPath(id),
    listBundledPluginIds: () => [...actual.listBundledPluginIds(), ...Object.keys(dirs)],
  };
}
