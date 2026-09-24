import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listKnownPluginIds, loadPlugin } from "../config/plugins.ts";

/**
 * #1025 (bug 2) — a plugin's `invariants[]` is a promise about the rendered
 * output ("navori doctor fails when any disappears", per its own JSDoc in
 * `plugins.ts`), but nothing checked that the promise held against the
 * ASSETS THE PLUGIN ITSELF SHIPS. `semgrep`'s invariant ("run semgrep over
 * the diff") rode in `managed/semgrep-protocol.md` until #615 moved the
 * doctrine into `skills/semgrep-review.md` (`managed: []` on purpose since
 * then) — and #887 rewrote that skill's prose without keeping the literal,
 * so the invariant stopped appearing anywhere navori renders, silently,
 * with no test catching it.
 *
 * This is the missing cross-check: for every known plugin, every declared
 * invariant string must appear verbatim in at least one of its emitted
 * assets (`managed[]` + `skills[]`) — the same set `loadPlugin` resolves for
 * rendering. It also guards the collateral #887 introduced: a plugin skill
 * that cites a `bun run <x>:check` script only `navori-harness`'s own
 * `package.json` defines is a broken instruction in every consumer repo,
 * which has no such script — the portable command is the plugin's own
 * rendered gate script (`bash .claude/scripts/check-<tool>.sh`).
 */

/** Every asset path a plugin renders: its managed blocks plus its skills. */
function emittedAssetContents(pluginId: string): string[] {
  const { managedAssets, skillAssets } = loadPlugin(pluginId);
  return [...managedAssets, ...skillAssets].map((entry) => readFileSync(entry.absPath, "utf-8"));
}

describe("plugin invariants appear verbatim in the plugin's own rendered assets (#1025)", () => {
  for (const pluginId of listKnownPluginIds()) {
    const { manifest } = loadPlugin(pluginId);
    if (manifest.invariants.length === 0) continue;

    it(`${pluginId}: every declared invariant is covered by at least one emitted asset`, () => {
      const contents = emittedAssetContents(pluginId);
      for (const invariant of manifest.invariants) {
        const covered = contents.some((text) => text.includes(invariant));
        expect(
          covered,
          `plugin '${pluginId}' declares invariant "${invariant}" but no managed[]/skills[] ` +
            "asset contains it verbatim — the promise navori doctor relies on is broken",
        ).toBe(true);
      }
    });
  }

  it("no plugin skill/managed asset cites a navori-harness-only `bun run <x>:check` script", () => {
    const offenders: string[] = [];
    for (const pluginId of listKnownPluginIds()) {
      for (const text of emittedAssetContents(pluginId)) {
        const match = text.match(/bun run [\w-]+:check/);
        if (match) offenders.push(`${pluginId}: "${match[0]}"`);
      }
    }
    expect(
      offenders,
      "these scripts only exist in navori-harness's own package.json, not in a consumer " +
        "repo — cite the plugin's rendered gate script instead (bash .claude/scripts/check-<tool>.sh)",
    ).toEqual([]);
  });
});
