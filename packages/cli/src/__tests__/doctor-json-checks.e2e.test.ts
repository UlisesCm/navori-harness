import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * `doctor --json` used to omit four checks it printed in human mode —
 * `gateReadiness` (#368), `emptyUserSections` (#369), `interpolationArtifacts`
 * (#440) and `diskUsage` (#393) — so every automated consumer (CI, an agent
 * parsing the report) was blind to all of them. Two of the four exist precisely
 * to surface debt `render` CANNOT fix on its own, which makes "only a human
 * sees it" the worst possible audience.
 *
 * Each spec here drives the check to actually FIRE and then asserts the JSON
 * carries its real payload: a test that only checks for the key would still
 * pass against a hardcoded `[]`.
 *
 * Kept out of `cli.e2e.test.ts` on purpose: these spawn the CLI several times
 * each (the monorepo one runs the full init → render → doctor pipeline) and the
 * critical e2e path is long enough already.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "..", "dist", "index.js");

/** Throwaway HOME so `init` can't self-register into the real ~/.navori (#404). */
const E2E_HOME = mkdtempSync(join(tmpdir(), "navori-doctor-json-home-"));
afterAll(() => {
  rmSync(E2E_HOME, { recursive: true, force: true });
});

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], envOverrides: Record<string, string> = {}): CliResult {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME: E2E_HOME, FORCE_COLOR: "0", ...envOverrides },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/**
 * A repo whose declared quality gate can actually run: scripts in package.json
 * (so `init` detects a real gate instead of publishing the soft fallback) and a
 * `node_modules/` directory (so the gate does not read as `missing-deps`).
 * Without both, three of the four checks under test fire on every fixture and
 * their assertions stop distinguishing anything.
 */
function seedRunnableRepo(dir: string, name: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name,
      scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run" },
      ...extra,
    }),
    "utf-8",
  );
  mkdirSync(join(dir, "node_modules"), { recursive: true });
}

/** The parsed `doctor --json` report. Typed loosely on purpose: these specs
 *  assert over the serialized shape a CI consumer actually receives, not over
 *  the internal types the command happens to build it from. */
interface DoctorReport {
  ok: boolean;
  gateReadiness: Array<{ gate: string; detail: string; reason: string }>;
  emptyUserSections: Array<{ id: string; path: string }>;
  interpolationArtifacts: Array<{ path: string; line: number; token: string; reason: string }>;
  diskUsage: Array<{ target: string; path: string; bytes: number; thresholdBytes: number }>;
  nestedWorktrees: { eslintConfig: string; worktrees: string[] } | null;
  monorepoDrift: { added: string[]; orphan: string[]; emptyDeclared: boolean } | null;
  config: { monorepo?: { workspaces: Array<{ name: string; path: string }> } };
}

function doctorJson(repo: string, envOverrides: Record<string, string> = {}): DoctorReport {
  const r = runCli(["doctor", "--json", "--cwd", repo], envOverrides);
  // A warning-level check must never flip the exit code (#440 was explicit
  // about this), so pin it here rather than in a separate spec.
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout) as DoctorReport;
}

/** Every temp repo any test in this file creates; the hooks below build and tear
 *  them down once for the whole file. Both describes used to carry their own
 *  byte-identical copy of this trio, which tripped the jscpd gate. */
const dirs: string[] = [];

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`CLI not built at ${CLI}. Run 'pnpm build' before tests.`);
  }
});

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  dirs.length = 0;
});

describe("doctor --json — warning-level checks", () => {
  /** A repo whose package.json declares the usual scripts, so `init` detects a
   *  real `qualityGate` instead of publishing the soft fallback ~28 times (that
   *  is a legitimate finding of the interpolation check, but a different one).
   *  `node_modules/` exists for the same reason on the gate side: without it
   *  every gate is `missing-deps`, which would mask the branch under test. */
  function seedRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "navori-doctor-json-"));
    seedRunnableRepo(dir, "doctor-json-demo");
    dirs.push(dir);
    return dir;
  }

  it("gateReadiness: a declared gate whose binary is not on PATH (#368)", () => {
    const repo = seedRepo();
    runCli(["init", "--recommended", "--cwd", repo]);

    // A gate detected from package.json is runnable here, so the check is
    // silent — a report that cried wolf would make the field worthless.
    expect(doctorJson(repo).gateReadiness).toEqual([]);

    const configPath = join(repo, "navori.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.qualityGate = {
      fast: "navori-absent-gate-bin --fast",
      full: "navori-absent-gate-bin --full",
    };
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    // One entry, not two: the scan dedups by reason+detail, and `full` names the
    // same missing binary.
    expect(doctorJson(repo).gateReadiness).toEqual([
      { gate: "fast", detail: "navori-absent-gate-bin", reason: "missing-binary" },
    ]);
  });

  it("emptyUserSections: a skill whose repo-specific half is still the template (#369)", () => {
    const repo = seedRepo();
    runCli(["init", "--recommended", "--cwd", repo]);

    // A freshly rendered skill ships its user half as scaffolding only, so the
    // check fires on the very first doctor run.
    const before = doctorJson(repo).emptyUserSections;
    expect(before).toContainEqual({
      id: "security-guidance",
      path: ".claude/skills/security-guidance/SKILL.md",
    });

    // Filling it clears the finding — this is what proves the array is computed
    // rather than a constant.
    const skill = join(repo, ".claude/skills/security-guidance/SKILL.md");
    writeFileSync(
      skill,
      `${readFileSync(skill, "utf-8")}\n- Authorization goes through requireRole([...]).\n`,
      "utf-8",
    );

    const after = doctorJson(repo).emptyUserSections;
    expect(after.map((s) => s.id)).not.toContain("security-guidance");
    expect(after.length).toBe(before.length - 1);
  });

  it("interpolationArtifacts: a token frozen in a user zone (#440)", () => {
    const repo = seedRepo();
    runCli(["init", "--recommended", "--cwd", repo]);
    expect(doctorJson(repo).interpolationArtifacts).toEqual([]);

    // The token sits AFTER the managed block, in the half `render` is
    // contractually forbidden to rewrite — so no re-render can ever clear it.
    const agent = join(repo, ".claude/agents/implementer.md");
    const token = "<not configured: project.criticalAreas>";
    const patched = `${readFileSync(agent, "utf-8")}\n- Critical areas: ${token}\n`;
    writeFileSync(agent, patched, "utf-8");
    const line = patched.split("\n").findIndex((l) => l.includes(token)) + 1;

    runCli(["render", "--apply", "--cwd", repo]);

    expect(doctorJson(repo).interpolationArtifacts).toEqual([
      { path: ".claude/agents/implementer.md", line, token, reason: "unresolved-placeholder" },
    ]);
  });

  it("diskUsage: a worktrees directory past its threshold (#393)", () => {
    const repo = seedRepo();
    runCli(["init", "--recommended", "--cwd", repo]);
    mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });

    // The threshold is 2 GiB and the scan reads `du -sk`, so the only honest way
    // to make it fire in a test is to stub the external tool — not navori's own
    // code. A `du` shim on PATH keeps the whole scan (existsSync, parsing,
    // threshold comparison, serialization) running for real.
    const shim = mkdtempSync(join(tmpdir(), "navori-du-shim-"));
    dirs.push(shim);
    const du = join(shim, "du");
    writeFileSync(du, '#!/bin/sh\necho "3145728\t$2"\n', "utf-8"); // 3 GiB in KiB
    chmodSync(du, 0o755);

    const report = doctorJson(repo, { PATH: `${shim}:${process.env.PATH ?? ""}` });
    expect(report.diskUsage).toContainEqual({
      target: "worktrees",
      path: join(repo, ".claude", "worktrees"),
      bytes: 3 * 1024 ** 3,
      thresholdBytes: 2 * 1024 ** 3,
    });
  });

  it("nestedWorktrees: an eslint repo with an installed nested worktree (#522)", () => {
    const repo = seedRepo();
    runCli(["init", "--recommended", "--cwd", repo]);

    // The worktree alone is not a finding — a repo with no eslint config has no
    // upward resolution to break. Pinning the silent side first is what makes
    // the assertion below a real one instead of a key-presence check.
    const worktree = join(repo, ".claude", "worktrees", "agent-a028");
    mkdirSync(join(worktree, "node_modules", "eslint-plugin-reactotron"), { recursive: true });
    expect(doctorJson(repo).nestedWorktrees).toBeNull();

    // Now the repo lints: eslint started inside the worktree resolves this file
    // too, finds the plugin twice and dies — and the pre-commit hook takes the
    // agent's commit with it.
    writeFileSync(join(repo, ".eslintrc.js"), "module.exports = { plugins: ['reactotron'] };\n");

    expect(doctorJson(repo).nestedWorktrees).toEqual({
      eslintConfig: ".eslintrc.js",
      worktrees: [".claude/worktrees/agent-a028"],
    });
  });
});

describe("doctor --json over a monorepo (#395)", () => {
  it("stays healthy and carries the four checks after init --scan-monorepo + render", () => {
    const repo = mkdtempSync(join(tmpdir(), "navori-doctor-json-mono-"));
    dirs.push(repo);
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages:\n  - 'apps/*'\n", "utf-8");
    seedRunnableRepo(repo, "demo-monorepo", { private: true });
    mkdirSync(join(repo, "apps", "backend"), { recursive: true });
    writeFileSync(
      join(repo, "apps", "backend", "package.json"),
      JSON.stringify({ name: "backend", dependencies: { "@medusajs/medusa": "^2.0.0" } }),
      "utf-8",
    );

    expect(runCli(["init", "--recommended", "--scan-monorepo", "--cwd", repo]).status).toBe(0);
    expect(runCli(["render", "--apply", "--cwd", repo]).status).toBe(0);

    const report = doctorJson(repo);
    expect(report.ok).toBe(true);
    expect(report.config.monorepo?.workspaces.map((w) => w.path)).toEqual(["apps/backend"]);
    // The workspace is declared AND on disk, so the monorepo shape itself is clean.
    expect(report.monorepoDrift).toEqual({ added: [], orphan: [], emptyDeclared: false });

    // The four checks are computed over the monorepo root too — `emptyUserSections`
    // carries real rows (the freshly rendered skills), which is what makes this a
    // content assertion and not a key-presence one.
    expect(report.emptyUserSections.map((s) => s.id)).toContain("security-guidance");
    expect(report.gateReadiness).toEqual([]);
    expect(report.interpolationArtifacts).toEqual([]);
    expect(report.diskUsage).toEqual([]);
  });
});
