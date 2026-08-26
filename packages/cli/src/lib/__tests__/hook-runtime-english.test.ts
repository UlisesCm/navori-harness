import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getCoreRoot, getPluginPath, listBundledPluginIds } from "../bundled-assets.ts";

/**
 * Runtime messages of the hook scripts ship in FIXED English (#284/#295;
 * regression caught in #422). These scripts are assets copied VERBATIM into the
 * target repo — they never pass through the language layer — so a Spanish
 * string reaches every rendered repo whatever its configured `language`.
 *
 * The walk covers BOTH asset trees, because the rule does. It used to read only
 * `packages/plugins/*\/scripts/*.sh`, which left the CORE hooks —
 * `guard-destructive.sh`, `quality-gate-pre-commit.sh`,
 * `session-start-context.sh` — outside the net: they were in English by manual
 * verification, i.e. by the same means that failed in #422. A guard whose
 * coverage stops one directory short of the rule it enforces reads as coverage
 * and is not.
 *
 * The rule matches Spanish letters and words, never "non-ASCII": the scripts
 * legitimately print `▶`, `✓` and `⊘`, and a non-ASCII rule would flag those
 * forever.
 */

/** Spanish-only letters/punctuation, plus the words that actually regressed in
 * #422 (`archivo(s)`, `modificados`, `sin cambios`). Each stem is impossible
 * inside an English word, so a plain case-insensitive match suffices. */
const SPANISH: Array<[string, RegExp]> = [
  ["a Spanish letter or sign (á é í ó ú ü ñ ¿ ¡)", /[áéíóúüñ¿¡]/i],
  ['"archivo(s)"', /archivo/i],
  ['"modificado(s)"', /modificad/i],
  ['"cambios"', /cambios/i],
];

interface EmittingLine {
  /** Source path, for the failure message (assets are read from the bundle). */
  file: string;
  line: number;
  text: string;
}

/** Every `*.sh` in `dir`, reported under `label/<name>` for the failure message. */
function scriptsIn(dir: string, label: string): EmittingLine[] {
  if (!existsSync(dir)) return [];
  const out: EmittingLine[] = [];
  for (const entry of readdirSync(dir).filter((f) => f.endsWith(".sh"))) {
    readFileSync(join(dir, entry), "utf-8")
      .split("\n")
      .forEach((text, i) => {
        // A comment is not runtime output, and skipping comments keeps the
        // guard free of false positives from prose (the hooks are commented in
        // English, but they quote Spanish commit messages and PR bodies as
        // examples, which is exactly what a naive match would flag).
        if (/^\s*#/.test(text)) return;
        if (!/\b(echo|printf)\b/.test(text)) return;
        out.push({ file: `${label}/${entry}`, line: i + 1, text });
      });
  }
  return out;
}

/**
 * Every emitting line of both asset trees: the plugin scripts
 * (`packages/plugins/*\/scripts/*.sh`) and the CORE hooks
 * (`packages/core/core-assets/hooks/*.sh`). Both are copied verbatim into the
 * target repo, so both carry the same obligation.
 */
function emittingLines(): EmittingLine[] {
  const out: EmittingLine[] = [];
  for (const id of listBundledPluginIds()) {
    out.push(...scriptsIn(join(getPluginPath(id), "scripts"), `packages/plugins/${id}/scripts`));
  }
  out.push(
    ...scriptsIn(join(getCoreRoot(), "core-assets", "hooks"), "packages/core/core-assets/hooks"),
  );
  return out;
}

describe("hook scripts — runtime messages stay in English (#422)", () => {
  const lines = emittingLines();

  // Without this the whole guard passes vacuously if the asset lookup ever
  // stops resolving (renamed dir, unbuilt bundle). The core-assets half is
  // asserted BY NAME: the reason this test existed for months without covering
  // it is that nothing said out loud which trees it walks.
  it("collects the emitting lines it is meant to guard", () => {
    expect(lines.length).toBeGreaterThan(5);
    expect(new Set(lines.map((l) => l.file)).size).toBeGreaterThanOrEqual(2);

    const files = new Set(lines.map((l) => l.file));
    expect([...files].some((f) => f.startsWith("packages/plugins/"))).toBe(true);
    for (const hook of [
      "guard-destructive.sh",
      "quality-gate-pre-commit.sh",
      "session-start-context.sh",
    ]) {
      expect(files).toContain(`packages/core/core-assets/hooks/${hook}`);
    }
  });

  for (const [label, re] of SPANISH) {
    it(`has no ${label} in an echo/printf`, () => {
      const offenders = lines
        .filter((l) => re.test(l.text))
        .map((l) => `${l.file}:${l.line} → ${l.text.trim()}`);
      expect(
        offenders,
        `Hook runtime output is fixed English (#284/#295):\n${offenders.join("\n")}`,
      ).toEqual([]);
    });
  }
});
