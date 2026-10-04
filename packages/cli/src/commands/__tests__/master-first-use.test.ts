import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "citty";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { repoFromCwd, sessionLogPath } from "../../lib/audit/paths.ts";
import { getCoreRoot } from "../../lib/render/bundled-assets.ts";
import { masterCommand } from "../master.ts";
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

/** Runs a command that must succeed (no exit code set). */
async function ok(cwd: string, ...argv: string[]): Promise<RunResult> {
  const result = await master(cwd, ...argv);
  expect(result.exitCode, `${argv.join(" ")}: ${result.err}`).toBeUndefined();
  return result;
}

it("opts into deliveries only explicitly and rejects legacy commands without writes", async () => {
  const cwd = freshRepo();
  expect((await ok(cwd, "init", "delivery", "--workflow", "deliveries")).out).toContain("base D1");
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
  expect((await ok(cwd, "init")).out).toContain("base D1");
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

function setPhase(cwd: string, phase: string): void {
  const path = stageFile(cwd, "state.json");
  const state = readJson(path) as { history: unknown[] };
  writeFileSync(
    path,
    `${JSON.stringify({ ...state, phase, history: [...state.history, { phase, at: "2026-01-01" }] }, null, 2)}\n`,
  );
}

const PART = {
  id: "P1",
  title: "Build",
  objective: "Build it",
  scope: [],
  outOfScope: [],
  dependsOn: [],
  seedRequirements: [],
  inheritedFrom: null,
  state: "pendiente",
  reason: null,
  spec: null,
  issue: null,
  acceptance: [
    {
      id: "A1",
      description: "Command passes",
      method: "comando",
      command: { run: "echo ok", expected: "ok" },
      evidence: null,
    },
    {
      id: "A2",
      description: "User reviews",
      method: "manual",
      manual: { check: "review", how: "inspect" },
      evidence: null,
    },
  ],
};

describe("master-plan first use — executable scenario (R59)", () => {
  // Covers: R52, R53, R54, R59
  it("walks status -> init -> mode -> check/advance -> part --accept -> status -> close", async () => {
    const cwd = freshRepo();

    // R52: first use is a normal case, not an error.
    const empty = await ok(cwd, "status", "--json");
    expect(JSON.parse(empty.out)).toMatchObject({
      stage: null,
      parts: [],
      allDone: false,
      closable: false,
    });

    await ok(cwd, "init", "mvp");
    // R54: STATUS.md exists right after init and the line does not say "ninguna".
    expect(existsSync(stageFile(cwd, "STATUS.md"))).toBe(true);
    const line = await ok(cwd, "status", "--line");
    expect(line.out).toContain("sin parte activa");
    expect(line.out).not.toContain("ninguna");

    await ok(cwd, "mode", "template");
    expect(readJson(stageFile(cwd, "state.json")).mode).toBe("template");
    await ok(cwd, "template", "plan");
    await ok(cwd, "template", "ux");

    // Context phase without raw files: check and advance refuse, and say why.
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

    // The middle phases (context digest, plans, MASTER.md) have their own tests; seed their outcome.
    writeFileSync(
      stageFile(cwd, "parts.json"),
      `${JSON.stringify({ version: 1, parts: [PART] }, null, 2)}\n`,
    );
    setPhase(cwd, "ux");
    await ok(cwd, "ux", "none");
    // advance into executing needs a full MASTER.md (checks.test.ts covers it); seed the phase.
    setPhase(cwd, "executing");
    await master(cwd, "check", "--part", "P1");
    writeFileSync(stageFile(cwd, "context/DIGEST.md"), "# Digest\n");
    writeFileSync(stageFile(cwd, "context/CODEBASE.md"), "# Codebase\n");
    await master(cwd, "check", "--fit", "--json");
    createCommitHelper(createGitHelper(cwd))("harness and plan");

    await ok(cwd, "part", "P1", "--accept", "A1", "--command", "echo ok", "--result", "ok");
    await ok(cwd, "part", "P1", "--accept", "A2", "--approved-by", "user");
    await ok(cwd, "part", "P1", "--state", "hecho");

    const status = JSON.parse((await ok(cwd, "status", "--json")).out) as {
      allDone: boolean;
      closable: boolean;
    };
    expect(status).toMatchObject({ allDone: true, closable: true });
    await ok(cwd, "status");

    const closed = await ok(cwd, "close");
    expect(closed.out).toContain(`${STAGE}: entregada`);
    expect(existsSync(stageFile(cwd, "CLOSURE.md"))).toBe(true);
  }, 120_000);

  it("records the ux decision, abandons, and converts in their own repos", async () => {
    const ux = freshRepo();
    await ok(ux, "init", "mvp");
    setPhase(ux, "ux");
    await ok(ux, "ux", "md-json");
    expect(readJson(stageFile(ux, "state.json")).ux).toBe("md-json");

    const abandoned = freshRepo();
    await ok(abandoned, "init", "mvp");
    await ok(abandoned, "close", "--abandon", "--reason", "no longer needed");
    expect(readJson(stageFile(abandoned, "state.json")).outcome).toBe("abandonada");

    const converted = freshRepo();
    await ok(converted, "init", "mvp");
    await ok(converted, "close", "--convert", "specs/one-shot", "--reason", "single delivery");
    expect(readJson(stageFile(converted, "state.json")).outcome).toBe("convertida");
  }, 120_000);
});

describe("master commands record CLI audit events (R55, R70)", () => {
  const saved = {
    root: process.env.NAVORI_AUDITS_ROOT,
    session: process.env.CLAUDE_CODE_SESSION_ID,
  };

  afterEach(() => {
    for (const [key, value] of [
      ["NAVORI_AUDITS_ROOT", saved.root],
      ["CLAUDE_CODE_SESSION_ID", saved.session],
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
    const log = sessionLogPath(repoFromCwd(cwd), "master-events");
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, `${JSON.stringify({ event: "start" })}\n`);
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
  it("records advance (block), part --accept and close", async () => {
    const cwd = freshRepo();
    const log = startAudit(cwd);
    await ok(cwd, "init", "mvp");

    expect((await master(cwd, "advance")).exitCode).toBe(1);

    writeFileSync(
      stageFile(cwd, "parts.json"),
      `${JSON.stringify({ version: 1, parts: [PART] }, null, 2)}\n`,
    );
    setPhase(cwd, "executing");
    createCommitHelper(createGitHelper(cwd))("plan");
    await ok(cwd, "part", "P1", "--accept", "A1", "--command", "echo ok", "--result", "ok");
    await ok(cwd, "part", "P1", "--accept", "A2", "--approved-by", "user");
    await ok(cwd, "part", "P1", "--state", "hecho");
    await ok(cwd, "close");

    expect(cliEvents(log)).toEqual([
      expect.objectContaining({ name: "master-advance", verdict: "block" }),
      expect.objectContaining({ name: "master-part-accept", verdict: "allow" }),
      expect.objectContaining({ name: "master-part-accept", verdict: "allow" }),
      expect.objectContaining({ name: "master-close", verdict: "allow" }),
    ]);
  }, 120_000);

  // Covers: R55
  it("writes nothing without a session id (fail-open)", async () => {
    const cwd = freshRepo();
    const log = startAudit(cwd);
    delete process.env.CLAUDE_CODE_SESSION_ID;
    await ok(cwd, "init", "mvp");
    await ok(cwd, "close", "--abandon", "--reason", "no longer needed");
    expect(cliEvents(log)).toEqual([]);
  }, 120_000);
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
  for (const match of skill.matchAll(/navori master ([a-z]+)([^`\n.;]*)/g)) {
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

describe("master-plan skill — every `navori master …` form is exercised (R59)", () => {
  // Covers: R59
  it("extracts forms that the scenario runs at least once", () => {
    const skill = readFileSync(
      resolve(getCoreRoot(), "core-assets", "skills", "master-plan.md"),
      "utf8",
    );
    const forms = skillForms(skill);
    expect(forms.length).toBeGreaterThan(10);
    const missing = forms.filter(
      (form) =>
        !exercised.some(
          (argv) =>
            argv[0] === form.sub &&
            (form.positional === null || argv[1] === form.positional) &&
            form.flags.every((flag) => argv.includes(flag)),
        ),
    );
    expect(missing.map((f) => f.text)).toEqual([]);
  });

  it("sanity: the extractor sees flags and literal positionals", () => {
    const forms = skillForms(
      'usa `navori master close --abandon --reason "x"` y `navori master template ux`',
    );
    expect(forms).toEqual([
      expect.objectContaining({ sub: "close", flags: ["--abandon", "--reason"] }),
      expect.objectContaining({ sub: "template", positional: "ux", flags: [] }),
    ]);
  });
});
