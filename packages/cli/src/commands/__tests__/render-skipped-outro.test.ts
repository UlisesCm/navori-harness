import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * The render outro must not claim "up to date" over files it refused to write.
 *
 * `resultHasPendingWrites` answers "is anything pending?", and a `skipped` file
 * is NOT pending — render decided it will never touch it (hand-edited managed
 * block, or one written by a newer navori). The per-file line said so, but the
 * outro — the last line, the one everybody reads — still printed
 * `Al día — N unchanged`, i.e. "your mirror matches the core" about a mirror
 * render knowingly left stale. `navori sync` is the only thing that fixes those,
 * so the outro claiming otherwise sends the user away from the remedy.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "..", "..", "dist", "index.js");

const E2E_HOME = mkdtempSync(join(tmpdir(), "navori-outro-home-"));
afterAll(() => rmSync(E2E_HOME, { recursive: true, force: true }));

function runCli(args: string[]): { status: number; combined: string } {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME: E2E_HOME, FORCE_COLOR: "0" },
  });
  return { status: r.status ?? -1, combined: (r.stdout ?? "") + (r.stderr ?? "") };
}

/**
 * The clack outro — the LAST line of the report, the one marked `└`. Matched by
 * `includes` rather than `startsWith` because the bar carries its own ANSI color
 * prefix even under FORCE_COLOR=0.
 */
function outroLine(output: string): string {
  const line = output
    .split("\n")
    .filter((l) => l.includes("└"))
    .at(-1);
  expect(line, `no outro line in:\n${output}`).toBeDefined();
  return line as string;
}

const UP_TO_DATE = /Al día|Up to date/;
const SKIPPED_LEAD = /Con omisiones|Files skipped/;

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function seedRenderedRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "navori-outro-"));
  dirs.push(repo);
  expect(runCli(["init", "--recommended", "--cwd", repo]).status).toBe(0);
  return repo;
}

/** Edit INSIDE a managed block without fixing its hash → render skips the file. */
function handEdit(repo: string): string {
  const hook = join(repo, ".claude/hooks/guard-destructive.sh");
  expect(existsSync(hook)).toBe(true);
  writeFileSync(hook, readFileSync(hook, "utf-8").replace("set -euo pipefail", "set -eu"), "utf-8");
  return hook;
}

describe("render outro vs skipped files", () => {
  beforeAll(() => {
    if (!existsSync(CLI)) throw new Error(`CLI not built at ${CLI}. Run 'pnpm build' first.`);
  });

  it("still says 'up to date' when nothing is pending AND nothing was skipped", () => {
    // The control case: the fix must not turn the happy path into noise.
    const repo = seedRenderedRepo();

    const outro = outroLine(runCli(["render", "--apply", "--cwd", repo]).combined);

    expect(outro).toMatch(UP_TO_DATE);
    expect(outro).not.toMatch(SKIPPED_LEAD);
  });

  it("does NOT say 'up to date' when the only thing that happened is a skip", () => {
    const repo = seedRenderedRepo();
    handEdit(repo);

    const r = runCli(["render", "--apply", "--cwd", repo]);
    const outro = outroLine(r.combined);

    expect(r.status).toBe(0);
    expect(outro).not.toMatch(UP_TO_DATE);
    expect(outro).toMatch(SKIPPED_LEAD);
    // Names the count and the remedy — `render --apply` will never fix these.
    expect(outro).toMatch(/1 (archivo|file)/);
    expect(outro).toContain("navori sync");
  });

  it("reports the skip in preview mode too, not only when applying", () => {
    const repo = seedRenderedRepo();
    handEdit(repo);

    const outro = outroLine(runCli(["render", "--cwd", repo]).combined);

    expect(outro).not.toMatch(UP_TO_DATE);
    expect(outro).toMatch(SKIPPED_LEAD);
  });
});
