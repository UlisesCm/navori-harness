import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NavoriConfigInput } from "../../../lib/config/schema.ts";

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
vi.mock(import("../../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

const { writeConfig } = await import("../../../lib/config/config.ts");
const { runRender } = await import("../../../commands/render.ts");
const { syncCommand } = await import("../../../commands/sync.ts");
const { adoptCommand } = await import("../../../commands/adopt.ts");
const { readCliVersion } = await import("../../../lib/render/bundled-assets.ts");
const { backupRoot } = await import("../../../lib/render/backup.ts");
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
 * Drift the `source=` provenance in every managed marker in the repo, leaving
 * each body byte-identical and its hash valid. A metadata difference is a real
 * change the next render writes back, so one render touches everything it owns
 * — what makes the invariant below worth asserting. (A version-only difference
 * no longer rewrites anything, #1262, so it cannot drive this fixture.)
 */
function driftEveryManagedMarker(root: string): number {
  let drifted = 0;
  for (const [rel, content] of snapshotTree(root)) {
    if (!content.includes("navori:managed")) continue;
    const changed = content.replace(/source="[^"]+"/g, 'source="@navori/drifted"');
    if (changed === content) continue;
    writeFileSync(join(root, rel), changed, "utf-8");
    drifted++;
  }
  return drifted;
}

/** Ephemeral harness state is excluded from every backup on purpose (#348). */
const isEphemeral = (rel: string): boolean =>
  EPHEMERAL_HARNESS_PATHS.some((p) => rel === p || rel.startsWith(p));

describe("render — every write is covered by a backup (#458)", () => {
  it("leaves nothing it destroyed outside the snapshots it took", () => {
    config({ engines: ["claude", "codex"], gitignoreHarness: "full" });
    writeFileSync(join(cwd, ".gitignore"), "node_modules/\n# the user's own rule\n.env.local\n");
    runRender(cwd, { dryRun: false });

    expect(driftEveryManagedMarker(cwd)).toBeGreaterThan(10);

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
    const ALLOWED: Record<string, string> = {};

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

// Covers: A2
describe("registry — harnessVersion + frozen JSON stamps (#1262)", () => {
  const configPath = (): string => join(cwd, "navori.config.json");
  const readRaw = (): Record<string, unknown> =>
    JSON.parse(readFileSync(configPath(), "utf-8")) as Record<string, unknown>;
  /** Rewrite the config in canonical form with `harnessVersion` set. */
  const setRegistry = (harnessVersion: string): void => {
    writeFileSync(configPath(), JSON.stringify({ ...readRaw(), harnessVersion }, null, 2) + "\n");
  };
  const settingsPath = (): string => join(cwd, ".claude/settings.json");
  const patchSettings = (patch: (s: Record<string, unknown>) => void): void => {
    const parsed = JSON.parse(readFileSync(settingsPath(), "utf-8")) as Record<string, unknown>;
    patch(parsed);
    writeFileSync(settingsPath(), JSON.stringify(parsed, null, 2) + "\n");
  };
  const stamp = (s: Record<string, unknown>, version: string): void => {
    (s.$navori as { version: string }).version = version;
  };
  const agentRel = ".claude/agents/reviewer.md";

  it("records the CLI version after an apply that wrote, and never on a preview", () => {
    config({ engines: ["claude"] });
    runRender(cwd, { dryRun: true });
    expect(readRaw().harnessVersion).toBeUndefined();

    runRender(cwd, { dryRun: false });
    expect(readRaw().harnessVersion).toBe(readCliVersion());
  });

  it("leaves navori.config.json byte-identical on a no-op apply", () => {
    config({ engines: ["claude"] });
    runRender(cwd, { dryRun: false });
    setRegistry("0.0.1"); // an older recorded value a no-op must NOT bump
    const before = readFileSync(configPath(), "utf-8");

    const second = runRender(cwd, { dryRun: false });
    expect(second.engineResult?.written).toEqual([]);
    expect(readFileSync(configPath(), "utf-8")).toBe(before);
  });

  it("bumps an older registry when the apply really changes something", () => {
    config({ engines: ["claude"] });
    runRender(cwd, { dryRun: false });
    setRegistry("0.0.1");
    rmSync(join(cwd, agentRel));

    runRender(cwd, { dryRun: false });
    expect(readRaw().harnessVersion).toBe(readCliVersion());
  });

  it("never lowers a newer registry", () => {
    config({ engines: ["claude"], harnessVersion: "99.0.0" });
    const first = runRender(cwd, { dryRun: false });
    expect(first.engineResult?.written.length).toBeGreaterThan(0);
    expect(readRaw().harnessVersion).toBe("99.0.0");
  });

  it("skips a non-canonical config with a warning instead of reformatting it", () => {
    config({ engines: ["claude"] });
    const indented = JSON.stringify(readRaw(), null, 4) + "\n";
    writeFileSync(configPath(), indented);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    runRender(cwd, { dryRun: false });
    const warned = stderr.mock.calls.some(([chunk]) => String(chunk).includes("harnessVersion"));
    stderr.mockRestore();
    expect(readFileSync(configPath(), "utf-8")).toBe(indented);
    expect(warned).toBe(true);
  });

  it("uses harnessVersion as a per-block floor: an older CLI cannot overwrite a block", () => {
    config({ engines: ["claude"] });
    runRender(cwd, { dryRun: false });
    const agent = join(cwd, agentRel);
    // A hand edit inside the block: without the floor the block (stamped at the
    // CLI version) reads as user-modified; only a newer floor makes it a downgrade.
    writeFileSync(
      agent,
      readFileSync(agent, "utf-8").replace(/(<!-- navori:managed [^>]*-->\n)/, "$1HAND EDIT\n"),
    );
    setRegistry("99.0.0");
    const before = readFileSync(agent, "utf-8");

    const result = runRender(cwd, { dryRun: false });
    expect(readFileSync(agent, "utf-8")).toBe(before);
    expect(
      result.engineResult?.skipped.some(
        (f) => f.path === agentRel && f.status === "downgrade-skipped",
      ),
    ).toBe(true);
  });

  it("freezes the settings.json stamp when only the CLI version moved", () => {
    config({ engines: ["claude"] });
    runRender(cwd, { dryRun: false });
    patchSettings((s) => stamp(s, "0.0.1"));
    const before = readFileSync(settingsPath(), "utf-8");

    const result = runRender(cwd, { dryRun: false });
    expect(result.engineResult?.written.map((w) => w.path)).not.toContain(".claude/settings.json");
    expect(readFileSync(settingsPath(), "utf-8")).toBe(before);
  });

  it("stamps the CLI version when the settings content really changes", () => {
    config({ engines: ["claude"] });
    runRender(cwd, { dryRun: false });
    patchSettings((s) => {
      stamp(s, "0.0.1");
      s.effortLevel = "low";
    });

    runRender(cwd, { dryRun: false });
    const after = JSON.parse(readFileSync(settingsPath(), "utf-8")) as {
      $navori: { version: string };
    };
    expect(after.$navori.version).toBe(readCliVersion());
  });

  it("does not roll settings.json back when its stamp or the floor is newer; --force does", () => {
    config({ engines: ["claude"] });
    runRender(cwd, { dryRun: false });
    patchSettings((s) => {
      stamp(s, "99.0.0");
      s.effortLevel = "low";
    });
    const before = readFileSync(settingsPath(), "utf-8");

    const skipped = runRender(cwd, { dryRun: false });
    expect(readFileSync(settingsPath(), "utf-8")).toBe(before);
    expect(
      skipped.engineResult?.skipped.some(
        (f) => f.path === ".claude/settings.json" && f.status === "downgrade-skipped",
      ),
    ).toBe(true);

    // The floor alone (stamp older, registry newer) guards it too.
    patchSettings((s) => stamp(s, "0.0.1"));
    setRegistry("99.0.0");
    const floored = readFileSync(settingsPath(), "utf-8");
    runRender(cwd, { dryRun: false });
    expect(readFileSync(settingsPath(), "utf-8")).toBe(floored);

    runRender(cwd, { dryRun: false, force: true });
    expect(readFileSync(settingsPath(), "utf-8")).not.toBe(floored);
  });

  it("sync --apply that writes records the registry", async () => {
    config({ engines: ["claude"] });
    runRender(cwd, { dryRun: false });
    setRegistry("0.0.1");
    rmSync(join(cwd, agentRel));
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await syncCommand.run?.({
      rawArgs: [],
      cmd: syncCommand,
      args: { _: [], cwd, json: true, apply: true } as never,
    });
    log.mockRestore();
    expect(readRaw().harnessVersion).toBe(readCliVersion());
  });

  it("adopt --apply records the registry", async () => {
    config({ engines: ["claude"] });
    runRender(cwd, { dryRun: false });
    setRegistry("0.0.1");
    writeFileSync(join(cwd, ".claude/agents/handmade.md"), "# my agent\n");

    await adoptCommand.run?.({
      rawArgs: [],
      cmd: adoptCommand,
      args: { _: [], cwd, path: ".claude/agents/handmade.md", apply: true } as never,
    });
    expect(readRaw().harnessVersion).toBe(readCliVersion());
  });
});
