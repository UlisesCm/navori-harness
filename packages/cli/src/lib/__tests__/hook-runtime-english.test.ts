import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getPluginPath, listBundledPluginIds } from "../bundled-assets.ts";

/**
 * Runtime messages of the plugin hook scripts ship in FIXED English
 * (#284/#295; regression caught in #422). These scripts are assets copied
 * VERBATIM into the target repo — they never pass through the language layer —
 * so a Spanish string reaches every rendered repo whatever its configured
 * `language`.
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

/**
 * Every line of every `packages/plugins/*\/scripts/*.sh` that writes output
 * (`echo` / `printf`), comments excluded — a comment is not runtime output, and
 * skipping them keeps the guard free of false positives from prose.
 */
function emittingLines(): EmittingLine[] {
  const out: EmittingLine[] = [];
  for (const id of listBundledPluginIds()) {
    const dir = join(getPluginPath(id), "scripts");
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir).filter((f) => f.endsWith(".sh"))) {
      const source = `packages/plugins/${id}/scripts/${entry}`;
      readFileSync(join(dir, entry), "utf-8")
        .split("\n")
        .forEach((text, i) => {
          if (/^\s*#/.test(text)) return;
          if (!/\b(echo|printf)\b/.test(text)) return;
          out.push({ file: source, line: i + 1, text });
        });
    }
  }
  return out;
}

describe("plugin hook scripts — runtime messages stay in English (#422)", () => {
  const lines = emittingLines();

  // Without this the whole guard passes vacuously if the asset lookup ever
  // stops resolving (renamed dir, unbuilt bundle).
  it("collects the emitting lines it is meant to guard", () => {
    expect(lines.length).toBeGreaterThan(5);
    expect(new Set(lines.map((l) => l.file)).size).toBeGreaterThanOrEqual(2);
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
