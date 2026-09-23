import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { measureDocBudgetFile } from "../../lib/diagnose/health.ts";

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

  /**
   * The crossing warning, end to end, on the real output of `render --apply`.
   *
   * Crossing it needs a render that WRITES more than the ceilings allow, and no
   * navori-shipped asset can do that — the gate exists so they can't. A LOCAL
   * preset shadowing a bundled one is the supported feature that can: it keeps
   * the bundled block id (`stack-medusa`, so the block stays BUDGETED at 81
   * words) while the body comes from the repo's own `.navori/presets/`. That is
   * a real user-reachable path, not a doctored fixture.
   */
  it("warns on the render that crosses the budget, naming the file", () => {
    const repo = mkdtempSync(join(tmpdir(), "navori-budget-cross-"));
    dirs.push(repo);
    expect(runCli(["init", "--recommended", "--cwd", repo]).status).toBe(0);

    const claudeMd = join(repo, "CLAUDE.md");
    expect(measureDocBudgetFile(claudeMd).overBy).toBe(0);

    const presetDir = join(repo, ".navori/presets/medusa");
    mkdirSync(join(presetDir, "managed"), { recursive: true });
    writeFileSync(
      join(presetDir, "medusa.json"),
      JSON.stringify({
        id: "medusa",
        displayName: "Local medusa override",
        extends: "core",
        extras: { managed: [{ id: "stack-medusa", relPath: "managed/stack.md" }] },
      }),
    );
    writeFileSync(
      join(presetDir, "managed", "stack.md"),
      `## Stack\n\n${Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" ")}\n`,
    );
    const configPath = join(repo, "navori.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    writeFileSync(configPath, JSON.stringify({ ...config, preset: "medusa" }, null, 2));

    const crossed = runCli(["render", "--apply", "--cwd", repo]);
    expect(crossed.status).toBe(0);
    expect(crossed.combined).toMatch(CROSSED);
    // The file is named because a monorepo render writes more than one.
    expect(crossed.combined).toContain("CLAUDE.md");
    expect(measureDocBudgetFile(claudeMd).overBy).toBeGreaterThan(0);

    // ...and ONLY on the crossing: the next render finds it already over and
    // says nothing, which is the property that keeps `render --all` readable.
    const again = runCli(["render", "--apply", "--cwd", repo]);
    expect(again.status).toBe(0);
    expect(again.combined).not.toMatch(CROSSED);
  });

  /**
   * A monorepo renders one `CLAUDE.md` PER WORKSPACE, each with its own
   * effective config, so a root-only snapshot left exactly those files with no
   * signal (#917 review, point 4). The warning names the file for this reason.
   */
  it("covers a monorepo workspace, not just the root CLAUDE.md", () => {
    const repo = mkdtempSync(join(tmpdir(), "navori-budget-ws-"));
    dirs.push(repo);
    mkdirSync(join(repo, "apps/web"), { recursive: true });
    expect(runCli(["init", "--recommended", "--cwd", repo]).status).toBe(0);

    const presetDir = join(repo, ".navori/presets/medusa");
    mkdirSync(join(presetDir, "managed"), { recursive: true });
    writeFileSync(
      join(presetDir, "medusa.json"),
      JSON.stringify({
        id: "medusa",
        displayName: "Local medusa override",
        extends: "core",
        extras: { managed: [{ id: "stack-medusa", relPath: "managed/stack.md" }] },
      }),
    );
    writeFileSync(
      join(presetDir, "managed", "stack.md"),
      `## Stack\n\n${Array.from({ length: 4000 }, (_, i) => `w${i}`).join(" ")}\n`,
    );

    // The workspace carries the fat preset; the ROOT does not, so only the
    // workspace crosses and the warning has to name it to be actionable.
    const configPath = join(repo, "navori.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          ...config,
          monorepo: {
            enabled: true,
            tool: "pnpm",
            workspaces: [{ name: "web", path: "apps/web", preset: "medusa" }],
          },
        },
        null,
        2,
      ),
    );

    const crossed = runCli(["render", "--apply", "--cwd", repo]);
    expect(crossed.status).toBe(0);
    expect(crossed.combined).toMatch(CROSSED);
    expect(crossed.combined).toContain("apps/web/CLAUDE.md");
    expect(measureDocBudgetFile(join(repo, "apps/web/CLAUDE.md")).overBy).toBeGreaterThan(0);
    expect(measureDocBudgetFile(join(repo, "CLAUDE.md")).overBy).toBe(0);
  });
});
