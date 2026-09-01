import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NavoriConfigInput } from "../../../lib/schema.ts";

/**
 * #458, the structural half: `.gitignore` skipped the backup for months because
 * nothing enumerated the render's writes — the hole was invisible until #405
 * covered everything else. These two specs close the CLASS, not the instance.
 *
 *  1. BEHAVIORAL — run a render that rewrites the whole harness and assert that
 *     every file it destroyed is recoverable from a snapshot that same render
 *     took. Independent of which code path did the writing.
 *  2. SOURCE — enumerate the modules of the render path that call a filesystem
 *     write primitive and require each one to be the backup choke point, to
 *     route through it, or to take its own snapshot. This is the half that
 *     catches a new write site the behavioral fixture happens not to exercise.
 *
 * `safeHomedir` is mocked so nothing reaches the real `~/.navori`; the backup
 * store is redirected per spec file by `NAVORI_BACKUP_ROOT` (#404).
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { writeConfig } = await import("../../../lib/config.ts");
const { runRender } = await import("../../../commands/render.ts");
const { backupRoot } = await import("../../../lib/backup.ts");
const { EPHEMERAL_HARNESS_PATHS } = await import("../ephemeral-paths.ts");

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-render-writes-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

function config(input: Partial<NavoriConfigInput> & Pick<NavoriConfigInput, "engines">): void {
  writeConfig(join(cwd, "navori.config.json"), { name: "demo", preset: "custom", ...input });
}

/** Every file under `dir`: repo-relative path → exact content. */
function snapshotTree(
  dir: string,
  root = dir,
  out = new Map<string, string>(),
): Map<string, string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) snapshotTree(full, root, out);
    else if (entry.isFile()) out.set(relative(root, full), readFileSync(full, "utf-8"));
  }
  return out;
}

/** Ids currently in the (per-spec-file) backup store. */
function backupIds(): string[] {
  const root = backupRoot();
  return existsSync(root) ? readdirSync(root) : [];
}

/**
 * Stamp an OLDER navori version into every managed marker in the repo, leaving
 * each body byte-identical — the shape of a release restamp, and the dominant
 * real-world reason a render rewrites files (marker.ts §"content is identical
 * but metadata differs"). One render then touches everything it owns, which is
 * what makes the invariant below worth asserting.
 */
function restampEveryManagedMarker(root: string): number {
  let stamped = 0;
  for (const [rel, content] of snapshotTree(root)) {
    if (!content.includes("navori:managed")) continue;
    const older = content.replace(/version="[^"]+"/g, 'version="0.0.1"');
    if (older === content) continue;
    writeFileSync(join(root, rel), older, "utf-8");
    stamped++;
  }
  return stamped;
}

/** Ephemeral harness state is excluded from every backup on purpose (#348). */
const isEphemeral = (rel: string): boolean =>
  EPHEMERAL_HARNESS_PATHS.some((p) => rel === p || rel.startsWith(p));

describe("render — every write is covered by a backup (#458)", () => {
  it("leaves nothing it destroyed outside the snapshots it took", () => {
    config({ engines: ["claude", "codex"], gitignoreHarness: "full" });
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n# the user's own rule\n.env.local\n");
    runRender(cwd, { dryRun: false });

    expect(restampEveryManagedMarker(cwd)).toBeGreaterThan(10);

    const before = snapshotTree(cwd);
    const idsBefore = new Set(backupIds());
    runRender(cwd, { dryRun: false });
    const after = snapshotTree(cwd);
    const snapshots = backupIds()
      .filter((id) => !idsBefore.has(id))
      .map((id) => join(backupRoot(), id));

    // What this render destroyed: a pre-existing file whose bytes changed, or
    // that is gone. Deliberately NOT "what the render REPORTED" — a write the
    // report forgot to mention is exactly the failure mode under test.
    const destroyed = [...before.keys()]
      .filter((rel) => after.get(rel) !== before.get(rel))
      .filter((rel) => !isEphemeral(rel));

    // Guard against a vacuous pass: if the fixture stopped rewriting anything,
    // "nothing unbacked" would be trivially true and prove nothing.
    expect(destroyed).toContain(".gitignore");
    expect(destroyed.length).toBeGreaterThan(10);

    const unbacked = destroyed.filter(
      (rel) =>
        !snapshots.some(
          (dir) =>
            existsSync(join(dir, rel)) && readFileSync(join(dir, rel), "utf-8") === before.get(rel),
        ),
    );
    expect(unbacked).toEqual([]);
  });

  it("has no module in the render path that writes to disk without a backup", () => {
    const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

    /** The choke point itself: the one place allowed to write unconditionally. */
    const CHOKE_POINT = "engines/shared/execute-plan.ts";

    /**
     * Write sites that legitimately sit outside the render's backup contract.
     * Each entry is a decision, not a snooze: adding one means arguing why the
     * write cannot destroy repo content the user would want back.
     */
    const ALLOWED: Record<string, string> = {
      "engines/claude/global-render.ts":
        "writes the machine-global ~/.claude baseline (hook + settings), not repo content; " +
        "`navori global` has its own install/uninstall contract",
      "engines/claude/global-plugin.ts":
        "writes ~/.claude/skills/navori/, a directory navori owns end to end and uninstall " +
        "deletes whole; nothing of the repo — or of the user's own ~/.claude/skills — is in reach",
    };

    const WRITE_PRIMITIVE =
      /\b(writeFileAtomic|writeFileSync|appendFileSync|copyFileSync|cpSync|renameSync|rmSync|unlinkSync|rmdirSync)\(/;

    /** Strip line comments and JSDoc bodies: prose naming `rmSync()` is not a write. */
    const code = (text: string): string =>
      text
        .split("\n")
        .filter((line) => {
          const t = line.trimStart();
          return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
        })
        .join("\n");

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__") continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) files.push(full);
      }
    };
    walk(join(srcRoot, "engines"));
    files.push(join(srcRoot, "commands/render.ts"));

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(srcRoot, file);
      const source = code(readFileSync(file, "utf-8"));
      if (!WRITE_PRIMITIVE.test(source)) continue;
      if (rel === CHOKE_POINT || rel in ALLOWED) continue;
      // Either it routes the write through the choke point, or it takes its own
      // snapshot first (the prose engines predate `commitWrites` and do the latter).
      if (source.includes("commitWrites(") || source.includes("createBackup(")) continue;
      offenders.push(rel);
    }

    expect(
      offenders,
      `These modules write to disk during a render without any backup. Route the write through ` +
        `commitWrites() (${CHOKE_POINT}) — or, if it genuinely cannot destroy repo content, add it ` +
        `to ALLOWED here with the reason:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
