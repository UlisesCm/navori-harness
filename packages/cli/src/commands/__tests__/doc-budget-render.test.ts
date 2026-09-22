import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { measureDocBudgetFile } from "../../lib/health.ts";

/**
 * #917 — `render` warns about the startup budget ONLY on the crossing.
 *
 * `render --all` sweeps the 30 repos of the global registry and already emits
 * backups, drift and removals; a fixed informational line there is how a
 * warning becomes wallpaper. The moment the number moved is the only moment
 * `render` owns — `doctor` is where a user goes to ASK it.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "..", "..", "dist", "index.js");
const E2E_HOME = mkdtempSync(join(tmpdir(), "navori-budget-home-"));
const dirs: string[] = [E2E_HOME];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** Both localizations of the crossing warning, so the test can't pass on locale. */
const CROSSED = /cruzó el presupuesto de arranque|crossed the startup budget/;

function runCli(args: string[]): { status: number; combined: string } {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME: E2E_HOME, NO_COLOR: "1" },
  });
  return { status: r.status ?? -1, combined: (r.stdout ?? "") + (r.stderr ?? "") };
}

describe("render startup-budget notice (#917)", () => {
  it("says nothing on a render that does not cross the budget", () => {
    const repo = mkdtempSync(join(tmpdir(), "navori-budget-render-"));
    dirs.push(repo);
    expect(runCli(["init", "--recommended", "--cwd", repo]).status).toBe(0);

    const rendered = runCli(["render", "--apply", "--cwd", repo]);
    expect(rendered.status).toBe(0);
    expect(rendered.combined).not.toMatch(CROSSED);

    // And the reason it says nothing is that there is nothing to say: a repo
    // navori just rendered is inside the ceilings navori ships.
    expect(measureDocBudgetFile(join(repo, "CLAUDE.md")).overBy).toBe(0);
  });

  it("recognises the crossing on the predicate the warning is built from", () => {
    const repo = mkdtempSync(join(tmpdir(), "navori-budget-cross-"));
    dirs.push(repo);
    expect(runCli(["init", "--recommended", "--cwd", repo]).status).toBe(0);

    const claudeMd = join(repo, "CLAUDE.md");
    const before = measureDocBudgetFile(claudeMd);
    expect(before.overBy).toBe(0);

    // Fatten a real managed block in place — the only difference between the
    // two measurements, so `overBy` moving is the crossing and nothing else.
    const filler = Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" ");
    writeFileSync(
      claudeMd,
      readFileSync(claudeMd, "utf-8").replace(
        /(<!-- navori:managed id="tipado-fuerte"[^\n]*-->\n)/,
        `$1${filler}\n`,
      ),
    );

    const after = measureDocBudgetFile(claudeMd);
    expect(after.overBy).toBeGreaterThan(0);
    expect(after.blocks.find((b) => b.id === "tipado-fuerte")?.over).toBe(true);
  });
});
