import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Lint guard (#81): the harness ships in Mexican Spanish, which uses "tú"
 * (corre / quítalo / aquí), never Rioplatense voseo (corré / quitalo / acá).
 * These forms crept into doctor/render strings and the agent user-sections;
 * this test fails the build if any come back — in rendered templates OR in the
 * CLI's own runtime strings.
 */

const HERE = dirname();
function dirname(): string {
  return resolve(fileURLToPath(import.meta.url), "..");
}

// packages/cli/src/lib/__tests__ → repo root is five levels up.
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..", "..");
const SCAN_DIRS = [
  join(REPO_ROOT, "packages/core/core-assets"),
  join(REPO_ROOT, "packages/cli/src"),
];

// Each entry: the forbidden Rioplatense form and its Mexican replacement (for
// the failure message). Matched as whole words, accent-aware, case-insensitive.
const VOSEO: Array<[string, string]> = [
  ["acá", "aquí"],
  ["corré", "corre"],
  ["quitá", "quita"],
  ["quitalo", "quítalo"],
  ["mirá", "mira"],
  ["fijate", "fíjate"],
  ["hacé", "haz"],
  ["poné", "pon"],
  ["andá", "anda / ve"],
  ["decime", "dime"],
  ["elegí", "elige"],
  ["revisá", "revisa"],
  ["agregá", "agrega"],
];

function walk(dir: string, out: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      // global-skills/ is copied VERBATIM from the maintainer's personal
      // ~/.claude/skills/ (global skills catalog, spec 0005) — it may carry
      // illustrative Spanish snippets in the maintainer's own Rioplatense
      // voice. That content is explicitly out of scope for this guard, which
      // targets the harness's OWN authored Mexican-Spanish strings/templates.
      if (entry === "__tests__" || entry === "node_modules" || entry === "global-skills") continue;
      walk(full, out);
    } else if (/\.(md|ts)$/.test(entry)) {
      out.push(full);
    }
  }
}

describe("no Rioplatense voseo in templates or runtime strings (#81)", () => {
  const files: string[] = [];
  for (const d of SCAN_DIRS) walk(d, files);

  it("scans a non-trivial number of files", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const [bad, good] of VOSEO) {
    it(`has no "${bad}" (use "${good}")`, () => {
      // Accent-aware word boundary: not flanked by another Spanish letter.
      const re = new RegExp(`(?<![a-záéíóúñ])${bad}(?![a-záéíóúñ])`, "i");
      const offenders: string[] = [];
      for (const f of files) {
        const content = readFileSync(f, "utf-8");
        content.split("\n").forEach((line, i) => {
          if (re.test(line)) offenders.push(`${f.replace(REPO_ROOT + "/", "")}:${i + 1}`);
        });
      }
      expect(offenders, `"${bad}" found → use "${good}":\n${offenders.join("\n")}`).toEqual([]);
    });
  }
});
