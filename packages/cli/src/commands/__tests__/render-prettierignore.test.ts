import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NavoriConfigInput } from "../../lib/schema.ts";

/**
 * Follow-up to #523. That fix taught the formatter to skip the harness, but
 * wired the prevention into `init` ALONE — so it only ever reached repos
 * onboarded after it shipped. Every already-onboarded repo (the one that
 * motivated the issue among them) stayed exactly as exposed as before, and
 * neither `render` nor `doctor` could see the gap.
 *
 * These pin the rule, not the wiring: after a render, a repo that runs prettier
 * is protected — and one that doesn't run it is left alone.
 *
 * createBackup writes under ~/.navori/backups, so safeHomedir is mocked.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { writeConfig } = await import("../../lib/config.ts");
const { runRender, countRenderStatuses, resultHasPendingWrites, countSkippedFiles } = await import(
  "../render.ts"
);
const { extractManagedContent } = await import("../../lib/marker.ts");
const { renderCommand } = await import("../render.ts");
const { runCommand } = await import("citty");

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-render-prettierignore-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

function config(input: Partial<NavoriConfigInput> & Pick<NavoriConfigInput, "engines">): void {
  writeConfig(join(cwd, "navori.config.json"), { name: "demo", preset: "custom", ...input });
}

/**
 * The repo that #523 came from: `"format": "prettier --write ."` and no
 * dependency, no config file. Detection has to catch it through the script or
 * the whole prevention misses the exact shape that caused the bug.
 */
function repoRunsPrettier(): void {
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "demo", scripts: { format: "prettier --write ." } }, null, 2),
    "utf-8",
  );
}

/** navori's managed block inside `.prettierignore`, or null when absent. */
function block(): string | null {
  const path = join(cwd, ".prettierignore");
  if (!existsSync(path)) return null;
  return extractManagedContent(readFileSync(path, "utf-8"), "prettierignore-harness", "shell");
}

describe("render reconciles the harness .prettierignore (#523 follow-up)", () => {
  it("protects an already-onboarded repo the init-only fix could never reach", () => {
    // The state of every repo onboarded before #523 shipped: harness in place,
    // prettier running, nothing telling it to skip CLAUDE.md.
    repoRunsPrettier();
    config({ engines: ["claude"] });

    const result = runRender(cwd, { dryRun: false });

    expect(result.ok).toBe(true);
    expect(result.prettierignore?.status).toBe("created");
    // The point of the block is CLAUDE.md, whose managed hashes the formatter
    // invalidates. `.claude/` matters just as much: its agents and skills carry
    // managed blocks too.
    expect(block()).toContain("CLAUDE.md");
    expect(block()).toContain(".claude/");
  });

  it("installs no opinion in a repo that does not run prettier", () => {
    config({ engines: ["claude"] });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "demo" }), "utf-8");

    const result = runRender(cwd, { dryRun: false });

    expect(result.prettierignore ?? null).toBeNull();
    expect(existsSync(join(cwd, ".prettierignore"))).toBe(false);
  });

  it("previews without writing", () => {
    repoRunsPrettier();
    config({ engines: ["claude"] });

    const result = runRender(cwd, { dryRun: true });

    expect(result.prettierignore?.status).toBe("created");
    expect(existsSync(join(cwd, ".prettierignore"))).toBe(false);
  });

  it("counts as a pending write and lands in the render summary (#519)", () => {
    config({ engines: ["claude"] });
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "demo" }), "utf-8");

    // Two previews of the SAME repo, differing only in whether it runs
    // prettier — nothing is written in preview, so the `.prettierignore` line is
    // the one variable between them. Comparing a preview against a post-apply
    // run instead would move 40 other files from `created` to `unchanged` and
    // measure the render, not this file.
    const withoutPrettier = countRenderStatuses(runRender(cwd, { dryRun: true })).created ?? 0;
    repoRunsPrettier();
    const preview = runRender(cwd, { dryRun: true });
    const withPrettier = countRenderStatuses(preview).created ?? 0;

    expect(withPrettier - withoutPrettier).toBe(1);
    // A render whose only pending write is this file must not report "up to
    // date": the outro reads `resultHasPendingWrites` to decide that sentence.
    expect(resultHasPendingWrites(preview)).toBe(true);
  });

  it("is idempotent — a second render leaves the block alone", () => {
    repoRunsPrettier();
    config({ engines: ["claude"] });

    runRender(cwd, { dryRun: false });
    const first = readFileSync(join(cwd, ".prettierignore"), "utf-8");
    const second = runRender(cwd, { dryRun: false });

    expect(second.prettierignore?.status).toBe("unchanged");
    expect(readFileSync(join(cwd, ".prettierignore"), "utf-8")).toBe(first);
  });

  it("does nothing when the user's own rules already cover the harness", () => {
    repoRunsPrettier();
    config({ engines: ["claude"] });
    writeFileSync(join(cwd, ".prettierignore"), "CLAUDE.md\n.claude/\n", "utf-8");

    const result = runRender(cwd, { dryRun: false });

    expect(result.prettierignore?.status).toBe("unchanged");
    expect(result.prettierignore?.entries).toEqual([]);
    // Their file is theirs: no managed block bolted on top of rules that
    // already do the job.
    expect(block()).toBeNull();
    expect(readFileSync(join(cwd, ".prettierignore"), "utf-8")).toBe("CLAUDE.md\n.claude/\n");
  });

  it("preserves a hand-edited block and reports it as a skip", () => {
    repoRunsPrettier();
    config({ engines: ["claude"] });
    runRender(cwd, { dryRun: false });

    const path = join(cwd, ".prettierignore");
    writeFileSync(
      path,
      `${readFileSync(path, "utf-8")}\n`.replace("CLAUDE.md", "docs/**"),
      "utf-8",
    );
    const edited = readFileSync(path, "utf-8");

    const result = runRender(cwd, { dryRun: false });

    expect(result.prettierignore?.status).toBe("user-modified-skipped");
    expect(readFileSync(path, "utf-8")).toBe(edited);
    // A refusal to write is not a pending write; it travels on the skip channel.
    expect(countSkippedFiles(result)).toBe(1);
    expect(countRenderStatuses(result)["user-modified-skipped"]).toBeUndefined();
  });

  it("publishes the outcome in --json", async () => {
    repoRunsPrettier();
    config({ engines: ["claude"] });

    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      lines.push(String(msg));
    });
    try {
      await runCommand(renderCommand, { rawArgs: ["--cwd", cwd, "--json"] });
    } finally {
      spy.mockRestore();
    }

    const payload = JSON.parse(lines.at(-1) as string) as {
      prettierignore: { path: string; status: string; entries: string[] } | null;
    };
    expect(payload.prettierignore?.path).toBe(".prettierignore");
    expect(payload.prettierignore?.status).toBe("created");
    expect(payload.prettierignore?.entries).toContain("CLAUDE.md");
  });
});
