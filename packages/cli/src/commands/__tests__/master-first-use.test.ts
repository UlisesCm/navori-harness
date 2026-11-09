import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "citty";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { repoFromCwd, sessionLogPath } from "../../lib/audit/paths.ts";
import { masterCommand } from "../master.ts";
import { runMasterInit } from "../../lib/master/init.ts";
import { createCommitHelper, createGitHelper } from "../../lib/master/__tests__/test-utils.ts";

/**
 * Executable first-use scenario for the master-plan skill (spec 0039 D11).
 * Covers: R52, R53, R54, R55, R59, R70
 */

interface RunResult {
  exitCode: number | undefined;
  out: string;
  err: string;
}

const temps: string[] = [];
/** Every `navori master …` argv the scenario ran, for the skill-coverage check. */
const exercised: string[][] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-master-first-use-"));
  temps.push(cwd);
  const git = createGitHelper(cwd);
  git(["init", "-q"]);
  writeFileSync(
    join(cwd, "navori.config.json"),
    `${JSON.stringify({ name: "demo", engines: ["claude"], preset: "custom" }, null, 2)}\n`,
  );
  createCommitHelper(git)("initial");
  return cwd;
}

async function master(cwd: string, ...argv: string[]): Promise<RunResult> {
  exercised.push(argv);
  const previous = process.exitCode;
  const write = {
    out: process.stdout.write.bind(process.stdout),
    err: process.stderr.write.bind(process.stderr),
  };
  let out = "";
  let err = "";
  let exitCode: number | undefined;
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string) => ((out += chunk), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => ((err += chunk), true)) as typeof process.stderr.write;
  try {
    await runCommand(masterCommand, { rawArgs: [...argv, "--cwd", cwd] });
    exitCode = process.exitCode;
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
    process.exitCode = previous;
  }
  return { exitCode, out, err };
}

/** Opens a v1 stage through the library: the CLI no longer writes the v1 flow (spec 0063 T6). */
function initV1(cwd: string, workflow: "legacy" | "deliveries" = "legacy"): void {
  runMasterInit(cwd, workflow === "legacy" ? "mvp" : "delivery", workflow);
}

/** Every v1 writing subcommand with a representative argv. */
const REFUSED_V1_WRITES: readonly string[][] = [
  ["mode", "template"],
  ["ux", "none"],
  ["advance"],
  ["part", "P1", "--state", "hecho"],
  ["close"],
  ["close", "--abandon", "--reason", "x"],
  ["init", "mvp", "--workflow", "legacy"],
  ["init", "delivery", "--workflow", "deliveries"],
  ["delivery-slice", "--part", "P1"],
  ["delivery-baseline", "--approved-by", "user"],
  ["delivery-queue", "--delivery", "E1", "--parts", "P1", "--approved-by", "user"],
  ["delivery-revoke", "--approved-by", "user"],
  ["delivery-criterion", "--part", "P1", "--criterion", "A1"],
  ["delivery-review", "--part", "P1", "--report", "r.txt", "--envelope", "e.json"],
  ["delivery-present", "--delivery", "E1"],
  [
    "delivery-decision",
    "--delivery",
    "E1",
    "--identity",
    "a".repeat(64),
    "--decision",
    "accepted",
    "--approved-by",
    "user",
  ],
  [
    "delivery-publication",
    "--delivery",
    "E1",
    "--identity",
    "a".repeat(64),
    "--kind",
    "release",
    "--reference",
    "v1",
    "--approved-by",
    "user",
  ],
];

/** Runs a command that must succeed (no exit code set). */
async function ok(cwd: string, ...argv: string[]): Promise<RunResult> {
  const result = await master(cwd, ...argv);
  expect(result.exitCode, `${argv.join(" ")}: ${result.err}`).toBeUndefined();
  return result;
}

it("opts into deliveries only explicitly and rejects legacy commands without writes", async () => {
  const cwd = freshRepo();
  initV1(cwd, "deliveries");
  const stage = join(cwd, "specs", "_master", "01-delivery");
  const statePath = join(stage, "state.json");
  const before = readFileSync(statePath, "utf8");
  expect((await master(cwd, "mode", "template")).exitCode).toBe(1);
  expect((await master(cwd, "ux", "none")).exitCode).toBe(1);
  expect((await master(cwd, "advance")).exitCode).toBe(1);
  expect((await master(cwd, "check")).exitCode).toBe(1);
  expect((await master(cwd, "template", "issue", "--part", "P1")).exitCode).toBe(1);
  expect((await master(cwd, "close", "--abandon", "--reason", "test")).exitCode).toBe(1);
  expect((await master(cwd, "init", "--workflow", "legacy")).exitCode).toBe(1);
  expect(readFileSync(statePath, "utf8")).toBe(before);
});

it("init without --workflow on an active v1 stage refuses and points to migrate, creating no PLAN.md", async () => {
  const cwd = freshRepo();
  initV1(cwd);
  const result = await master(cwd, "init");
  expect(result.exitCode).toBe(1);
  expect(result.err).toContain("navori master migrate");
  expect(existsSync(join(cwd, "specs", "_plan", "PLAN.md"))).toBe(false);
});

// Covers: R15 — spec 0063 T6: every v1 writing subcommand is refused and touches nothing.
it.each(REFUSED_V1_WRITES)(
  "refuses the v1 write `%s` without touching specs/_master",
  async (...argv: string[]) => {
    const cwd = freshRepo();
    initV1(cwd);
    const snapshot = (): string =>
      ["state.json", "parts.json", "STATUS.md"]
        .map((name) =>
          existsSync(stageFile(cwd, name)) ? readFileSync(stageFile(cwd, name), "utf8") : "",
        )
        .join("\n") + readFileSync(join(cwd, "specs/_master/index.json"), "utf8");
    const before = snapshot();
    const result = await master(cwd, ...argv);
    expect(result.exitCode, argv.join(" ")).toBe(1);
    expect(result.err).toContain("navori master migrate");
    expect(result.out).toBe("");
    expect(snapshot()).toBe(before);
  },
);

it("status without a v2 plan reads and does not regenerate STATUS.md", async () => {
  const cwd = freshRepo();
  initV1(cwd);
  rmSync(stageFile(cwd, "STATUS.md"));
  const result = await ok(cwd, "status");
  expect(result.out).toContain(`etapa ${STAGE}`);
  expect(existsSync(stageFile(cwd, "STATUS.md"))).toBe(false);
});

it("rejects an invalid workflow flag before creating the registry", async () => {
  const cwd = freshRepo();
  const config = readFileSync(join(cwd, "navori.config.json"), "utf8");
  expect((await master(cwd, "init", "delivery", "--workflow", "unknown")).exitCode).toBe(1);
  expect(existsSync(join(cwd, "specs", "_master"))).toBe(false);
  expect(readFileSync(join(cwd, "navori.config.json"), "utf8")).toBe(config);
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

const STAGE = "01-mvp";

function stageFile(cwd: string, name: string): string {
  return join(cwd, "specs", "_master", STAGE, name);
}

describe("master-plan first use — executable scenario (R59)", () => {
  // Covers: R52, R53, R54, R59
  it("walks the v1 read path: status, template, check; every write is refused", async () => {
    const cwd = freshRepo();

    // R52: first use is a normal case, not an error.
    const empty = await ok(cwd, "status", "--json");
    expect(JSON.parse(empty.out)).toMatchObject({
      stage: null,
      parts: [],
      allDone: false,
      closable: false,
    });

    initV1(cwd);
    // R54: STATUS.md exists right after init and the line does not say "ninguna".
    expect(existsSync(stageFile(cwd, "STATUS.md"))).toBe(true);
    const line = await ok(cwd, "status", "--line");
    expect(line.out).toContain("sin parte activa");
    expect(line.out).not.toContain("ninguna");

    await ok(cwd, "template", "plan");
    await ok(cwd, "template", "ux");
    await ok(cwd, "template", "parts");

    // Context phase without raw files: check refuses and says why; advance is refused.
    expect((await master(cwd, "check")).exitCode).toBe(1);
    expect((await master(cwd, "advance")).exitCode).toBe(1);
    expect(readJson(stageFile(cwd, "state.json")).phase).toBe("context");

    // R53: no parts, nothing to close, in any phase.
    const early = JSON.parse((await ok(cwd, "status", "--json")).out) as {
      allDone: boolean;
      closable: boolean;
    };
    expect(early).toMatchObject({ allDone: false, closable: false });
    expect((await master(cwd, "close")).exitCode).toBe(1);
  }, 120_000);
});

describe("master commands record CLI audit events (R55, R70)", () => {
  const saved = {
    root: process.env.NAVORI_AUDITS_ROOT,
    session: process.env.CLAUDE_CODE_SESSION_ID,
    auditHost: process.env.NAVORI_AUDIT_HOST,
    auditSession: process.env.NAVORI_AUDIT_SESSION_ID,
    codexSession: process.env.CODEX_SESSION_ID,
    codexThread: process.env.CODEX_THREAD_ID,
  };

  afterEach(() => {
    for (const [key, value] of [
      ["NAVORI_AUDITS_ROOT", saved.root],
      ["CLAUDE_CODE_SESSION_ID", saved.session],
      ["NAVORI_AUDIT_HOST", saved.auditHost],
      ["NAVORI_AUDIT_SESSION_ID", saved.auditSession],
      ["CODEX_SESSION_ID", saved.codexSession],
      ["CODEX_THREAD_ID", saved.codexThread],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  /** Points the audit root at a temp dir and creates the session log for `cwd`. */
  function startAudit(cwd: string): string {
    const root = mkdtempSync(join(tmpdir(), "navori-master-audit-"));
    temps.push(root);
    process.env.NAVORI_AUDITS_ROOT = root;
    process.env.CLAUDE_CODE_SESSION_ID = "master-events";
    process.env.NAVORI_AUDIT_HOST = "claude";
    process.env.NAVORI_AUDIT_SESSION_ID = "master-events";
    delete process.env.CODEX_SESSION_ID;
    delete process.env.CODEX_THREAD_ID;
    const log = sessionLogPath(repoFromCwd(cwd), "master-events");
    mkdirSync(dirname(log), { recursive: true, mode: 0o700 });
    writeFileSync(
      log,
      `${JSON.stringify({ event: "start", host: "claude", sessionId: "master-events", cwd })}\n`,
      { mode: 0o600 },
    );
    return log;
  }

  function cliEvents(log: string): Array<{ name: string; verdict: string }> {
    return readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; name: string; verdict: string })
      .filter((record) => record.event === "cli");
  }

  // Covers: R55, R70
  it("a refused v1 write records no CLI audit event", async () => {
    const cwd = freshRepo();
    const log = startAudit(cwd);
    initV1(cwd);
    for (const argv of [
      ["advance"],
      ["close"],
      ["part", "P1", "--accept", "A2", "--approved-by", "user"],
    ])
      expect((await master(cwd, ...argv)).exitCode, argv.join(" ")).toBe(1);
    expect(cliEvents(log)).toEqual([]);
  });
});

/** A `navori master …` form written in the skill: subcommand, optional literal positional, flags. */
interface SkillForm {
  text: string;
  sub: string;
  positional: string | null;
  flags: string[];
}

function skillForms(skill: string): SkillForm[] {
  const forms: SkillForm[] = [];
  // Delivery forms have a separate real subprocess lifecycle in master-delivery.test.ts.
  for (const match of skill.matchAll(/navori master ((?!delivery-)[a-z]+)([^`\n.;]*)/g)) {
    const rest = match[2] ?? "";
    const positional = /^ ([a-z][a-z-]*)(?= |$)/.exec(rest)?.[1] ?? null;
    forms.push({
      text: match[0].trim(),
      sub: match[1] as string,
      positional,
      flags: [...rest.matchAll(/--[a-z-]+/g)].map((m) => m[0]),
    });
  }
  return forms;
}

describe("master-plan skill forms extractor (R59)", () => {
  it("sanity: the extractor sees flags and literal positionals", () => {
    const forms = skillForms(
      'usa `navori master close --abandon --reason "x"` y `navori master template ux`',
    );
    expect(forms).toEqual([
      expect.objectContaining({
        sub: "close",
        flags: ["--abandon", "--reason"],
      }),
      expect.objectContaining({ sub: "template", positional: "ux", flags: [] }),
    ]);
  });
});

// Covers: R14
it("check --part ausente, vacío o espacios es error de uso sin check de etapa", async () => {
  const cwd = freshRepo();
  initV1(cwd);
  const before = readFileSync(stageFile(cwd, "state.json"), "utf8");
  for (const value of ["", "   "]) {
    const result = await master(cwd, "check", "--part", value);
    expect(result.exitCode).toBe(1);
    expect(result.err).toContain("--part");
    expect(result.out).toBe("");
  }
  const exclusive = await master(cwd, "check", "--part", "", "--fit");
  expect(exclusive.exitCode).toBe(1);
  expect(exclusive.err).toContain("mutually exclusive");
  expect(readFileSync(stageFile(cwd, "state.json"), "utf8")).toBe(before);
});

// Covers: R15
it("init con otro slug y etapa activa explica en stderr y sale 1", async () => {
  const cwd = freshRepo();
  initV1(cwd);
  const result = await master(cwd, "init", "other");
  expect(result.exitCode).toBe(1);
  expect(result.err).toContain("navori master migrate");
});
