import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #523 prevention. The bug is caused by a formatter, so the fix that removes the
 * whole class is teaching the formatter to skip the harness — not a better
 * recovery command. These pin the three things that can go wrong with that:
 * detecting prettier at all, writing the entries once, and never writing them in
 * a repo that doesn't use prettier.
 *
 * `commitWrites` snapshots under ~/.navori/backups, so safeHomedir is mocked.
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const {
  detectPrettier,
  ensurePrettierIgnore,
  prettierIgnoreEntries,
  scanPrettierIgnore,
  PRETTIERIGNORE_MANAGED_ID,
} = await import("../prettierignore-harness.ts");
const { extractManagedContent } = await import("../../../lib/marker.ts");

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-prettierignore-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

function writePackageJson(content: Record<string, unknown>): void {
  writeFileSync(join(cwd, "package.json"), JSON.stringify(content, null, 2), "utf-8");
}

/** The body of navori's managed block in `.prettierignore`, or null when there
 *  is no file / no block. */
function managedBody(): string | null {
  const path = join(cwd, ".prettierignore");
  if (!existsSync(path)) return null;
  return extractManagedContent(readFileSync(path, "utf-8"), PRETTIERIGNORE_MANAGED_ID, "shell");
}

describe("detectPrettier", () => {
  it("finds prettier as a devDependency", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    expect(detectPrettier(cwd)).toBe(true);
  });

  it("finds prettier as a runtime dependency", () => {
    writePackageJson({ name: "x", dependencies: { prettier: "3.3.3" } });
    expect(detectPrettier(cwd)).toBe(true);
  });

  it("finds a prettier config file even with no dependency declared", () => {
    writeFileSync(join(cwd, ".prettierrc"), "{}", "utf-8");
    expect(detectPrettier(cwd)).toBe(true);
  });

  it("finds prettier config inlined in package.json", () => {
    writePackageJson({ name: "x", prettier: { semi: false } });
    expect(detectPrettier(cwd)).toBe(true);
  });

  // The exact signal from #523: `"format": "prettier --write ."`. A repo can run
  // prettier through npx with neither a dependency nor a config file and still
  // rewrite CLAUDE.md.
  it("finds prettier invoked from an npm script with no dependency and no config", () => {
    writePackageJson({ name: "x", scripts: { format: "prettier --write ." } });
    expect(detectPrettier(cwd)).toBe(true);
  });

  it("finds prettier behind a package-manager exec prefix", () => {
    writePackageJson({ name: "x", scripts: { fmt: "pnpm exec prettier --check src" } });
    expect(detectPrettier(cwd)).toBe(true);
  });

  it("does NOT fire on a lookalike script (prettier-plugin-… is not prettier)", () => {
    writePackageJson({ name: "x", scripts: { build: "build-prettier-plugin-foo" } });
    expect(detectPrettier(cwd)).toBe(false);
  });

  it("returns false with no package.json and no config file", () => {
    expect(detectPrettier(cwd)).toBe(false);
  });

  it("returns false (never throws) on a malformed package.json", () => {
    writeFileSync(join(cwd, "package.json"), "{ not json", "utf-8");
    expect(detectPrettier(cwd)).toBe(false);
  });
});

describe("prettierIgnoreEntries", () => {
  it("covers the whole Claude tree, not just CLAUDE.md", () => {
    // `.claude/agents/*.md` and `.claude/skills/**` carry managed blocks too, so
    // a formatter freezes them the same way. Hardcoding ["CLAUDE.md"] would fix
    // half the class. `.mcp.json` joined the list with #557: it is generated the
    // same way, it just lives at the repo root instead of under `.claude/`.
    expect(prettierIgnoreEntries(["claude"])).toEqual([".claude/", ".mcp.json", "CLAUDE.md"]);
  });

  it("adds the Codex outputs only when codex is a configured engine", () => {
    expect(prettierIgnoreEntries(["claude", "codex"])).toContain("AGENTS.md");
    expect(prettierIgnoreEntries(["claude", "codex"])).toContain(".codex/");
    expect(prettierIgnoreEntries(["claude"])).not.toContain("AGENTS.md");
  });

  it("dedupes AGENTS.md when codex and agents-md are both configured", () => {
    const entries = prettierIgnoreEntries(["codex", "agents-md"]);
    expect(entries.filter((e) => e === "AGENTS.md")).toHaveLength(1);
  });
});

describe("ensurePrettierIgnore", () => {
  it("does nothing at all in a repo with no prettier", () => {
    writePackageJson({ name: "x", devDependencies: { biome: "^2.0.0" } });
    expect(ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "es" })).toBeNull();
    // Not created, not read, not touched.
    expect(existsSync(join(cwd, ".prettierignore"))).toBe(false);
  });

  it("creates .prettierignore with the harness entries when prettier is detected", () => {
    writePackageJson({ name: "x", scripts: { format: "prettier --write ." } });
    const result = ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "es" });
    expect(result?.status).toBe("created");
    expect(managedBody()?.split("\n")).toEqual([".claude/", ".mcp.json", "CLAUDE.md"]);
  });

  it("injects the block into an existing .prettierignore without losing the user's rules", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    writeFileSync(join(cwd, ".prettierignore"), "dist\ncoverage\n", "utf-8");

    // "created" is the BLOCK's status (the file already existed) — same
    // vocabulary the `.gitignore` block uses.
    const result = ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "es" });
    expect(result?.status).toBe("created");
    const content = readFileSync(join(cwd, ".prettierignore"), "utf-8");
    expect(content).toContain("dist");
    expect(content).toContain("coverage");
    expect(managedBody()?.split("\n")).toEqual([".claude/", ".mcp.json", "CLAUDE.md"]);
  });

  it("is idempotent: a second call changes nothing and duplicates nothing", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "es" });
    const first = readFileSync(join(cwd, ".prettierignore"), "utf-8");

    const second = ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "es" });
    expect(second?.status).toBe("unchanged");
    const after = readFileSync(join(cwd, ".prettierignore"), "utf-8");
    expect(after).toBe(first);
    expect(after.split("\n").filter((l) => l.trim() === "CLAUDE.md")).toHaveLength(1);
  });

  it("writes nothing when the user's own rules already cover every entry", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    const existing = "# mine\n.claude\nCLAUDE.md\n.mcp.json\ndist\n";
    writeFileSync(join(cwd, ".prettierignore"), existing, "utf-8");

    const result = ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "es" });
    expect(result?.status).toBe("unchanged");
    expect(result?.entries).toEqual([]);
    // Untouched: no managed block bolted onto a file that already does the job.
    expect(readFileSync(join(cwd, ".prettierignore"), "utf-8")).toBe(existing);
    expect(managedBody()).toBeNull();
  });

  it("emits only the entries the user has not already covered", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    writeFileSync(join(cwd, ".prettierignore"), "CLAUDE.md\n", "utf-8");

    const result = ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "es" });
    expect(result?.entries).toEqual([".claude/", ".mcp.json"]);
    expect(managedBody()?.split("\n")).toEqual([".claude/", ".mcp.json"]);
    // No duplicate rule for what the user already wrote.
    const content = readFileSync(join(cwd, ".prettierignore"), "utf-8");
    expect(content.split("\n").filter((l) => l.trim() === "CLAUDE.md")).toHaveLength(1);
  });

  it("dryRun previews the entries and writes nothing", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    const result = ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "es", dryRun: true });
    expect(result?.status).toBe("created");
    expect(result?.entries).toEqual([".claude/", ".mcp.json", "CLAUDE.md"]);
    expect(existsSync(join(cwd, ".prettierignore"))).toBe(false);
  });

  it("preserves a hand-edited block instead of clobbering it", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "es" });

    // The user edits inside the managed block: the hash no longer matches.
    const path = join(cwd, ".prettierignore");
    writeFileSync(
      path,
      readFileSync(path, "utf-8").replace("CLAUDE.md", "CLAUDE.md\ndocs/"),
      "utf-8",
    );
    const before = readFileSync(path, "utf-8");

    const result = ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "es" });
    expect(result?.status).toBe("user-modified-skipped");
    expect(result?.skippedReason?.length).toBeGreaterThan(0);
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("backs the file up before overwriting one it did not author", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    const previous = "dist\n";
    writeFileSync(join(cwd, ".prettierignore"), previous, "utf-8");
    const result = ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "es" });
    expect(result?.status).toBe("created");
    // The file navori did NOT author existed before this write, so the render's
    // backup choke point snapshotted it.
    expect(result?.backupPath).toBeTruthy();
    // A path is not a backup. Asserting only `backupPath` stays green if the
    // snapshot captured the wrong file, an empty directory, or the content
    // written AFTER the overwrite — i.e. exactly when it stopped being
    // recoverable. What makes this a safety net is the BYTES.
    const snapshot = join(result!.backupPath!, ".prettierignore");
    expect(existsSync(snapshot)).toBe(true);
    expect(readFileSync(snapshot, "utf-8")).toBe(previous);
  });

  it("seeds the header in the repo's language when it creates the file", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "en" });
    const content = readFileSync(join(cwd, ".prettierignore"), "utf-8");
    expect(content).toContain("managed by navori");
    expect(content).not.toContain("gestionado por navori");
  });
});

/**
 * doctor's half of the follow-up. The invariant that matters is PARITY with
 * `ensurePrettierIgnore`: doctor must warn exactly when render would write. If
 * doctor flags a gap render then refuses to close, the warning never goes away
 * and the user learns to ignore it — the failure mode that makes advisory
 * output worthless.
 */
describe("scanPrettierIgnore", () => {
  it("says nothing about a repo that does not run prettier", () => {
    writePackageJson({ name: "x" });
    expect(scanPrettierIgnore(cwd, { engines: ["claude"] })).toBeNull();
  });

  it("reports a missing block when the repo runs prettier and has no .prettierignore", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    expect(scanPrettierIgnore(cwd, { engines: ["claude"] })).toEqual({
      missing: true,
      drift: false,
    });
  });

  it("reports a missing block when the file exists without one", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    writeFileSync(join(cwd, ".prettierignore"), "dist/\ncoverage/\n", "utf-8");
    expect(scanPrettierIgnore(cwd, { engines: ["claude"] })?.missing).toBe(true);
  });

  it("stays quiet when the user's own rules already cover the harness", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    writeFileSync(join(cwd, ".prettierignore"), "CLAUDE.md\n.claude/\n.mcp.json\n", "utf-8");
    expect(scanPrettierIgnore(cwd, { engines: ["claude"] })).toEqual({
      missing: false,
      drift: false,
    });
  });

  it("reports drift when the block no longer matches the configured engines", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    // Written for claude alone, then codex is added to the config: AGENTS.md and
    // `.codex/` now carry managed blocks the block doesn't protect.
    ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "en" });
    expect(scanPrettierIgnore(cwd, { engines: ["claude", "codex"] })).toEqual({
      missing: false,
      drift: true,
    });
  });

  it("goes quiet after the write that closes the gap (parity with the writer)", () => {
    writePackageJson({ name: "x", devDependencies: { prettier: "^3.0.0" } });
    expect(scanPrettierIgnore(cwd, { engines: ["claude"] })?.missing).toBe(true);

    ensurePrettierIgnore(cwd, { engines: ["claude"] }, { lang: "en" });

    expect(scanPrettierIgnore(cwd, { engines: ["claude"] })).toEqual({
      missing: false,
      drift: false,
    });
  });
});
