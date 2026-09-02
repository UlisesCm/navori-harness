import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

/**
 * Spec 0014 (#555) — the only command in this feature that writes, and it
 * writes over a file the user typed.
 *
 * The safeguards are the product here, so they are asserted by their EFFECT and
 * not by "the function was called": the backup has to hold the previous bytes
 * (#504.1's lesson — `createBackup(cwd, [])` left a whole suite green), the
 * preview has to leave the disk alone, and every refusal has to leave the file
 * exactly as it was.
 *
 * HOME is mocked because the command resolves the store through it; the store
 * itself is read back from `NAVORI_BACKUP_ROOT`, which `vitest.setup.ts` pins
 * per spec file and `createBackup` prefers over HOME (#404).
 */

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { planAdoption, adoptCommand } = await import("../adopt.ts");
const { runCommand } = await import("citty");
const { writeConfig } = await import("../../lib/config.ts");
const { injectManagedSection } = await import("../../lib/marker.ts");
const { readCliVersion } = await import("../../lib/bundled-assets.ts");

let cwd: string;

const HAND_MADE = "# mi skill propia\n\nHaz X antes de Y.\n";
const SKILL_REL = join(".claude", "skills", "mia.md");

function write(rel: string, content: string): void {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content, "utf-8");
}

function read(rel: string): string {
  return readFileSync(join(cwd, rel), "utf-8");
}

async function adopt(...argv: string[]): Promise<void> {
  await runCommand(adoptCommand, { rawArgs: [...argv, "--cwd", cwd] });
}

/**
 * The backup store this spec file writes into. `vitest.setup.ts` pins
 * `NAVORI_BACKUP_ROOT` per file (#404), and `createBackup` prefers that env var
 * over HOME — so the store is read from there, not from the mocked home.
 */
function backupRoot(): string {
  const root = process.env.NAVORI_BACKUP_ROOT;
  if (!root) throw new Error("NAVORI_BACKUP_ROOT is unset: the suite setup did not run");
  return root;
}

/** Snapshots produced by THIS test (the store is shared by the file). */
function snapshotsOfThisRepo(): string[] {
  return readdirSync(backupRoot()).filter((name) => name.startsWith(`${basename(cwd)}-`));
}

/** Every file inside the one backup this test produced. */
function backupFiles(): Array<{ name: string; content: string }> {
  const [snapshot] = snapshotsOfThisRepo();
  const dir = join(backupRoot(), snapshot ?? "", ".claude", "skills");
  return readdirSync(dir).map((name) => ({
    name,
    content: readFileSync(join(dir, name), "utf-8"),
  }));
}

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-adopt-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-adopt-"));
  writeConfig(join(cwd, "navori.config.json"), {
    name: "demo",
    engines: ["claude"],
    preset: "custom",
  });
  write(SKILL_REL, HAND_MADE);
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

describe("adopting wraps the file, it never rewrites it (R11)", () => {
  it("keeps every original byte inside the managed block", async () => {
    await adopt(SKILL_REL, "--apply");
    const after = read(SKILL_REL);

    expect(after).toContain(HAND_MADE);
    expect(after).toContain('id="adopted-claude-skills-mia"');
    // The content is the user's; only the wrapper is navori's.
    const inner = after.slice(after.indexOf("\n") + 1, after.lastIndexOf("<!-- /navori:managed"));
    expect(inner).toBe(HAND_MADE);
  });

  it("stamps the block with this CLI's version, so the anti-rollback guard applies", async () => {
    await adopt(SKILL_REL, "--apply");
    expect(read(SKILL_REL)).toContain(`version="${readCliVersion()}"`);
  });
});

describe("preview is the default, and it touches nothing (R12)", () => {
  it("leaves the file untouched without --apply", async () => {
    await adopt(SKILL_REL);
    expect(read(SKILL_REL)).toBe(HAND_MADE);
  });

  it("plans exactly what the apply would write", () => {
    // Preview and apply answer the same question through the same code path: a
    // preview computed some other way is a preview of something else.
    const plan = planAdoption(cwd, SKILL_REL);
    expect(plan.kind).toBe("adopt");
    if (plan.kind !== "adopt") return;
    expect(plan.content).toContain(HAND_MADE);
    expect(plan.markerId).toBe("adopted-claude-skills-mia");
  });
});

describe("the backup holds the previous bytes (R13)", () => {
  it("snapshots the file before the first write", async () => {
    await adopt(SKILL_REL, "--apply");
    // Asserted on CONTENT, never on "a backup exists": an empty snapshot would
    // satisfy the weaker check and protect nothing.
    expect(backupFiles()).toEqual([{ name: "mia.md", content: HAND_MADE }]);
  });
});

describe("what is not ours to touch is refused, with its cause (R14)", () => {
  it("refuses a file that already carries a managed block", async () => {
    const managed = injectManagedSection("", "some-other-block", "rendered\n", {
      version: readCliVersion(),
      source: "@navori/core",
    }).output;
    write(join(".claude", "agents", "reviewer.md"), managed);

    const plan = planAdoption(cwd, join(".claude", "agents", "reviewer.md"));
    expect(plan).toMatchObject({ kind: "refuse", reason: "already-managed" });

    await adopt(join(".claude", "agents", "reviewer.md"), "--apply");
    expect(read(join(".claude", "agents", "reviewer.md"))).toBe(managed);
  });

  it("refuses a path outside the repo", () => {
    expect(planAdoption(cwd, join(home.dir, ".claude", "skills", "x.md"))).toMatchObject({
      kind: "refuse",
      reason: "outside-repo",
    });
  });

  it("refuses anything that is not a .md under .claude/", async () => {
    write("package.json", '{"name":"demo"}\n');
    expect(planAdoption(cwd, "package.json")).toMatchObject({
      kind: "refuse",
      reason: "not-adoptable-path",
    });

    await adopt("package.json", "--apply");
    expect(read("package.json")).toBe('{"name":"demo"}\n');
  });

  it("refuses a file that is not there", () => {
    expect(planAdoption(cwd, join(".claude", "skills", "ghost.md"))).toMatchObject({
      kind: "refuse",
      reason: "missing",
    });
  });

  it("writes nothing at all on a refusal — no backup either", async () => {
    write("package.json", "{}\n");
    await adopt("package.json", "--apply");
    expect(snapshotsOfThisRepo()).toEqual([]);
  });
});

describe("adopting twice is a no-op, not an error (R15)", () => {
  it("leaves the same bytes and reports no change", async () => {
    await adopt(SKILL_REL, "--apply");
    const afterFirst = read(SKILL_REL);

    expect(planAdoption(cwd, SKILL_REL)).toMatchObject({ kind: "noop" });
    await adopt(SKILL_REL, "--apply");
    expect(read(SKILL_REL)).toBe(afterFirst);
    // And no second snapshot: nothing changed, so there was nothing to protect.
    expect(snapshotsOfThisRepo()).toHaveLength(1);
  });
});
