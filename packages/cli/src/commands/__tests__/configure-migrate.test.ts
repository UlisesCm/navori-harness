import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `navori configure migrate` — the repair path for configs blocked by retired
 * keys (#920). Every other command enters through `readConfig`, which aborts on
 * exactly these configs, so this one reads the raw JSON.
 *
 * Two properties this file exists to pin, both in the project's critical area
 * (writes into the user's repo):
 *  - a backup is taken BEFORE the config is rewritten;
 *  - `--dry-run` does not write a single byte.
 *
 * `safeHomedir` is mocked and `NAVORI_BACKUP_ROOT` redirected so no test ever
 * reaches the developer's `~/.navori` (#404).
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/home.ts"), () => ({ safeHomedir: () => home.dir }));

vi.mock("@clack/prompts", () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(),
  select: vi.fn(),
  isCancel: () => false,
  log: {
    message: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    step: vi.fn(),
  },
}));

const { runCommand } = await import("citty");
const { configureCommand, migrateRepoConfig, migrateAllRepos } = await import("../configure.ts");

/** The shape all 17 blocked repos carry: 10 retired keys, ambiguous scout. */
const BLOCKED_CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  models: {
    leader: "opus",
    researcher: "sonnet",
    explorer: "haiku",
    ticketAudit: "sonnet",
    commitPrPilot: "haiku",
  },
  effort: {
    leader: "high",
    researcher: "medium",
    explorer: "low",
    ticketAudit: "medium",
    commitPrPilot: "low",
  },
};

let cwd: string;
let backupRoot: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-migrate-"));
  backupRoot = join(home.dir, "backups");
  process.env.NAVORI_BACKUP_ROOT = backupRoot;
});

afterEach(() => {
  delete process.env.NAVORI_BACKUP_ROOT;
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function seed(config: unknown = BLOCKED_CONFIG): void {
  writeFileSync(join(cwd, "navori.config.json"), JSON.stringify(config, null, 2), "utf-8");
}

const onDisk = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(cwd, "navori.config.json"), "utf-8")) as Record<string, unknown>;

const CHOICES = { "models.scout": "sonnet", "effort.scout": "medium" };

describe("migrateRepoConfig — one repo", () => {
  it("reports needs-decision and writes NOTHING when the scout clash is unresolved", () => {
    seed();
    const before = readFileSync(join(cwd, "navori.config.json"), "utf-8");
    const result = migrateRepoConfig(cwd, { apply: true, choices: {} });
    expect(result.status).toBe("needs-decision");
    expect(result.decisions.map((d) => d.target)).toEqual(["models.scout", "effort.scout"]);
    expect(readFileSync(join(cwd, "navori.config.json"), "utf-8")).toBe(before);
    expect(existsSync(backupRoot)).toBe(false);
  });

  it("previews without writing when apply is false", () => {
    seed();
    const before = readFileSync(join(cwd, "navori.config.json"), "utf-8");
    const result = migrateRepoConfig(cwd, { apply: false, choices: CHOICES });
    expect(result.status).toBe("would-migrate");
    expect(result.renamed.length + result.dropped.length).toBe(10);
    expect(readFileSync(join(cwd, "navori.config.json"), "utf-8")).toBe(before);
    expect(existsSync(backupRoot)).toBe(false);
  });

  it("backs the config up BEFORE rewriting it", () => {
    seed();
    const before = readFileSync(join(cwd, "navori.config.json"), "utf-8");
    const result = migrateRepoConfig(cwd, { apply: true, choices: CHOICES });

    expect(result.status).toBe("migrated");
    expect(result.backupPath).toBeDefined();
    // The snapshot holds the PRE-migration content, byte for byte.
    expect(readFileSync(join(result.backupPath!, "navori.config.json"), "utf-8")).toBe(before);

    const models = onDisk().models as Record<string, unknown>;
    expect(models).toEqual({
      orchestrator: "opus",
      scout: "sonnet",
      auditor: "sonnet",
      publisher: "haiku",
    });
  });

  it("is idempotent: a second run reports clean and takes no backup", () => {
    seed();
    migrateRepoConfig(cwd, { apply: true, choices: CHOICES });
    const taken = readdirSync(backupRoot).length;

    const second = migrateRepoConfig(cwd, { apply: true, choices: CHOICES });
    expect(second.status).toBe("clean");
    expect(readdirSync(backupRoot)).toHaveLength(taken);
  });

  it("reports an error instead of throwing on a missing or corrupt config", () => {
    expect(migrateRepoConfig(cwd, { apply: true, choices: {} }).status).toBe("error");
    writeFileSync(join(cwd, "navori.config.json"), "{ not json", "utf-8");
    const corrupt = migrateRepoConfig(cwd, { apply: true, choices: {} });
    expect(corrupt.status).toBe("error");
    expect(corrupt.error).toContain("Invalid JSON");
  });
});

describe("navori configure migrate — CLI", () => {
  it("--dry-run does not write a byte", async () => {
    seed();
    const before = readFileSync(join(cwd, "navori.config.json"), "utf-8");
    await runCommand(configureCommand, {
      rawArgs: [
        "migrate",
        "--cwd",
        cwd,
        "--dry-run",
        "--yes",
        "--scout",
        "sonnet",
        "--scout-effort",
        "medium",
      ],
    });
    expect(readFileSync(join(cwd, "navori.config.json"), "utf-8")).toBe(before);
    expect(existsSync(backupRoot)).toBe(false);
  });

  it("--yes with both flags repairs the config so readConfig loads it again", async () => {
    seed();
    await runCommand(configureCommand, {
      rawArgs: ["migrate", "--cwd", cwd, "--yes", "--scout", "sonnet", "--scout-effort", "medium"],
    });

    const { readConfig } = await import("../../lib/config.ts");
    const config = readConfig(join(cwd, "navori.config.json"));
    expect(config.models?.scout).toBe("sonnet");
    expect(config.effort?.scout).toBe("medium");
    expect(readFileSync(join(cwd, "navori.config.json"), "utf-8")).not.toMatch(
      /leader|researcher|explorer|ticketAudit|commitPrPilot/,
    );
  });

  it("--all reports every repo and writes only the ones it can resolve", async () => {
    // One repo whose effort clash has no flag, one the flag resolves, one
    // already clean, and a registry entry whose repo no longer exists.
    const repos = ["blocked", "scout-only", "clean"].map((name) => {
      const dir = join(cwd, name);
      mkdirSync(dir, { recursive: true });
      return { name, path: dir };
    });
    writeFileSync(
      join(repos[0]!.path, "navori.config.json"),
      JSON.stringify({ ...BLOCKED_CONFIG, name: "blocked" }),
      "utf-8",
    );
    writeFileSync(
      join(repos[1]!.path, "navori.config.json"),
      JSON.stringify({
        name: "scout-only",
        engines: ["claude"],
        preset: "custom",
        models: { researcher: "sonnet", explorer: "haiku" },
      }),
      "utf-8",
    );
    writeFileSync(
      join(repos[2]!.path, "navori.config.json"),
      JSON.stringify({ name: "clean", engines: ["claude"], preset: "custom" }),
      "utf-8",
    );
    mkdirSync(join(home.dir, ".navori"), { recursive: true });
    writeFileSync(
      join(home.dir, ".navori", "registry.json"),
      JSON.stringify({ repos: [...repos, { name: "gone", path: join(cwd, "gone") }] }),
      "utf-8",
    );

    const before = readFileSync(join(repos[1]!.path, "navori.config.json"), "utf-8");
    const rows = migrateAllRepos({
      apply: true,
      // Only the models side is resolved: the effort clash has no flag, so the
      // ambiguous repo must stay untouched rather than be half-guessed.
      choices: { "models.scout": "sonnet" },
    });

    expect(rows.map((r) => `${r.name}:${r.status}`)).toEqual([
      "blocked:needs-decision",
      "scout-only:migrated",
      "clean:clean",
      "gone:error",
    ]);
    // A broken repo never aborts the sweep — the clean one after it still ran.
    expect(readFileSync(join(repos[0]!.path, "navori.config.json"), "utf-8")).toContain("leader");
    expect(readFileSync(join(repos[1]!.path, "navori.config.json"), "utf-8")).not.toBe(before);
  });

  it("exits 1 without writing when --yes runs into an unresolved clash", async () => {
    seed();
    const before = readFileSync(join(cwd, "navori.config.json"), "utf-8");
    const exit = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit");
    }) as never);

    await expect(
      runCommand(configureCommand, { rawArgs: ["migrate", "--cwd", cwd, "--yes"] }),
    ).rejects.toThrow("process.exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(readFileSync(join(cwd, "navori.config.json"), "utf-8")).toBe(before);
  });
});
