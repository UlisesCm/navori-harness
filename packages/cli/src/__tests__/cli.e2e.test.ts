import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "..", "dist", "index.js");

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  combined: string;
}

function runCli(args: string[]): CliResult {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, FORCE_COLOR: "0" },
  });
  return {
    status: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    combined: (r.stdout ?? "") + (r.stderr ?? ""),
  };
}

function makeTmpRepo(seedFiles: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-e2e-"));
  for (const [rel, content] of Object.entries(seedFiles)) {
    writeFileSync(join(dir, rel), content, "utf-8");
  }
  return dir;
}

describe("CLI e2e — happy paths", () => {
  let dirs: string[] = [];

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
    dirs = [];
  });

  it("init --recommended on empty dir writes config + renders CLAUDE.md + .claude/", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);

    const r = runCli(["init", "--recommended", "--cwd", repo]);
    expect(r.status).toBe(0);

    const configPath = join(repo, "navori.config.json");
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.name).toBe(repo.split("/").pop()?.toLowerCase());
    expect(config.engines).toEqual(["claude"]);
    expect(config.language).toBe("es");
    expect(config.plugins?.engram?.enabled).toBe(true);

    const claudeMd = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain("navori:managed id=\"idioma-rol\"");
    expect(claudeMd).toContain("navori:managed id=\"engram-protocol\"");

    // E1c: .claude/ tree now also exists
    expect(existsSync(join(repo, ".claude/agents/leader.md"))).toBe(true);
    expect(existsSync(join(repo, ".claude/agents/implementer.md"))).toBe(true);
    expect(existsSync(join(repo, ".claude/skills/verify-before-done.md"))).toBe(true);
    expect(existsSync(join(repo, ".claude/settings.json"))).toBe(true);

    const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf-8"));
    expect(settings.$navori?.managed).toBe(true);
  });

  it("init --recommended warns when no qualityGate is detected (P0-fix B1+U6)", () => {
    const repo = makeTmpRepo(); // no package.json → no qualityGate detected
    dirs.push(repo);
    const r = runCli(["init", "--recommended", "--cwd", repo]);
    expect(r.status).toBe(0);
    // Warning surfaces explicitly so the user knows about the placeholders
    expect(r.combined).toMatch(/quality gate|qualityGate/i);
    // Engine warning about the skipped hook is also propagated to the user
    expect(r.combined).toContain("quality-gate hook skipped");
    // The hook file is NOT generated in that case
    expect(existsSync(join(repo, ".claude/hooks/quality-gate-pre-commit.sh"))).toBe(false);
  });

  it("init --recommended falls back to 'pm tsc --noEmit' when TS detected without scripts", () => {
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({
        name: "ts-no-scripts",
        dependencies: { typescript: "^5" },
      }),
      "tsconfig.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    dirs.push(repo);

    const r = runCli(["init", "--recommended", "--no-render", "--cwd", repo]);
    expect(r.status).toBe(0);

    const config = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(config.qualityGate?.fast).toBe("pnpm tsc --noEmit");
    expect(config.qualityGate?.full).toBe("pnpm tsc --noEmit");
    // Surface the fallback in stdout so the user knows it wasn't detected
    expect(r.combined).toMatch(/fallback/i);
  });

  it("init --recommended writes project block with empty arrays + detected testRunner", () => {
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({
        name: "vitest-app",
        dependencies: { vitest: "^4" },
      }),
    });
    dirs.push(repo);

    const r = runCli(["init", "--recommended", "--no-render", "--cwd", repo]);
    expect(r.status).toBe(0);

    const config = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(config.project).toEqual({
      legacyPaths: [],
      criticalAreas: [],
      testRunner: "vitest",
    });
  });

  it("init --recommended on TS+test stack renders agents without <not configured> placeholders", () => {
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({
        name: "full-stack",
        dependencies: { typescript: "^5", vitest: "^4" },
      }),
      "tsconfig.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    dirs.push(repo);

    const r = runCli(["init", "--recommended", "--cwd", repo]);
    expect(r.status).toBe(0);

    // The 4 most-visible managed assets must NOT show placeholders
    for (const rel of [
      ".claude/agents/leader.md",
      ".claude/agents/implementer.md",
      ".claude/agents/reviewer.md",
      ".claude/skills/verify-before-done.md",
    ]) {
      const content = readFileSync(join(repo, rel), "utf-8");
      expect(content, `${rel} should have no <not configured> placeholders`).not.toMatch(
        /<not configured:/,
      );
    }
  });

  it("init --yes plain (without --recommended) keeps conservative no-fallback behavior", () => {
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({
        name: "ts-no-scripts",
        dependencies: { typescript: "^5" },
      }),
      "tsconfig.json": "{}",
    });
    dirs.push(repo);

    const r = runCli(["init", "--yes", "--no-render", "--cwd", repo]);
    expect(r.status).toBe(0);

    const config = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    // No qualityGate fallback for plain --yes — back-compat
    expect(config.qualityGate).toBeUndefined();
    expect(config.project).toBeUndefined();
  });

  it("init --yes detects stack from package.json", () => {
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({
        name: "@bonum/dashboard",
        dependencies: { react: "^18", vite: "^7", "@mantine/core": "^8" },
        scripts: { typecheck: "tsc --noEmit", lint: "eslint" },
      }),
    });
    dirs.push(repo);

    const r = runCli(["init", "--yes", "--cwd", repo]);
    expect(r.status).toBe(0);

    const config = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(config.name).toBe("dashboard");
    expect(config.preset).toBe("vite-react-ts-mantine");
    expect(config.qualityGate?.fast).toContain("typecheck");
  });

  it("init aborts if navori.config.json already exists", () => {
    const repo = makeTmpRepo({
      "navori.config.json": '{"name":"x","engines":["claude"],"preset":"custom"}',
    });
    dirs.push(repo);

    const r = runCli(["init", "--yes", "--cwd", repo]);
    expect(r.status).toBe(1);
    // Language-agnostic: just confirm the abort message references the config file.
    expect(r.combined).toContain("navori.config.json");
  });

  it("render is idempotent: second run reports no changes", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);

    runCli(["init", "--recommended", "--cwd", repo]);
    const first = readFileSync(join(repo, "CLAUDE.md"), "utf-8");

    // --apply exercises the write path; a second apply must be a no-op.
    const r = runCli(["render", "--apply", "--cwd", repo]);
    expect(r.status).toBe(0);

    const second = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(second).toBe(first);
    expect(r.combined).toMatch(/no changes|unchanged/);
  });

  it("render previews by default and only writes with --apply (spec 0003 §3.1.3)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);

    // Config present, nothing rendered yet.
    runCli(["init", "--recommended", "--no-render", "--cwd", repo]);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);

    // Preview (default): reports pending changes but touches no files.
    const preview = runCli(["render", "--cwd", repo]);
    expect(preview.status).toBe(0);
    expect(preview.combined).toMatch(/[Pp]review/);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);

    // --apply writes to disk.
    const applied = runCli(["render", "--apply", "--cwd", repo]);
    expect(applied.status).toBe(0);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(true);
  });

  it("init --pre-commit-hook scaffolds a doctor --strict git hook (spec 0003 §3.1.7)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });

    const r = runCli(["init", "--recommended", "--pre-commit-hook", "--cwd", repo]);
    expect(r.status).toBe(0);

    const hookPath = join(repo, ".git/hooks/pre-commit");
    expect(existsSync(hookPath)).toBe(true);
    const body = readFileSync(hookPath, "utf-8");
    expect(body).toContain("navori doctor --strict");
    expect(body).toContain("--no-verify");
  });

  it("init --recommended does not scaffold a pre-commit hook without the flag (opt-in)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    spawnSync("git", ["init"], { cwd: repo, stdio: "ignore" });

    const r = runCli(["init", "--recommended", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(existsSync(join(repo, ".git/hooks/pre-commit"))).toBe(false);
  });

  it("sync --apply --yes fails with exit 1 when user edited a .claude/ agent (P0-fix B2)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    // Edit the body of leader-base WITHOUT touching the marker line.
    const leaderPath = join(repo, ".claude/agents/leader.md");
    const tampered = readFileSync(leaderPath, "utf-8").replace(
      "Tu único trabajo es",
      "USER-EDIT — Tu único trabajo es",
    );
    writeFileSync(leaderPath, tampered, "utf-8");

    const r = runCli(["sync", "--apply", "--yes", "--cwd", repo]);
    expect(r.status).toBe(1);
    expect(r.combined).toMatch(/conflict/i);
    expect(r.combined).toContain(".claude/agents/leader.md");

    // The user edit must be preserved (sync refused to overwrite)
    const after = readFileSync(leaderPath, "utf-8");
    expect(after).toContain("USER-EDIT — Tu único trabajo es");
  });

  it("status reports a clean snapshot after init (spec 0003 §3.5.3)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    const r = runCli(["status", "--json", "--cwd", repo]);
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.ok).toBe(true);
    expect(report.claudeMdExists).toBe(true);
    expect(report.enabledPlugins).toContain("engram");
    expect(report.drift).toBe(0);
    expect(report.nextSteps).toEqual(expect.arrayContaining([expect.stringMatching(/al día/i)]));
  });

  it("bench reports percentiles over N runs (spec 0003 §3.5.4)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    const r = runCli(["bench", "--runs", "3", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(r.combined).toMatch(/p50/);
    expect(r.combined).toMatch(/p95/);
  });

  it("sync --apply --yes fails with exit 1 when user modified a managed block", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);

    runCli(["init", "--recommended", "--cwd", repo]);

    // Modify the rendered file in a way that drifts from the marker hash
    const claudeMdPath = join(repo, "CLAUDE.md");
    const content = readFileSync(claudeMdPath, "utf-8");
    writeFileSync(claudeMdPath, content.replace("Tech Lead Senior", "MI EDIT"));

    const r = runCli(["sync", "--apply", "--yes", "--cwd", repo]);
    expect(r.status).toBe(1);
    expect(r.combined).toContain("conflict");
  });

  it("doctor reports managed blocks with source + version", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    const r = runCli(["doctor", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(r.combined).toMatch(/idioma-rol.*@navori\/core/);
    expect(r.combined).toMatch(/engram-protocol.*@navori\/plugin-engram/);
  });

  it("doctor --json outputs valid pipeable JSON", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    const r = runCli(["doctor", "--json", "--cwd", repo]);
    expect(r.status).toBe(0);

    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.config.name).toBe(repo.split("/").pop()?.toLowerCase());
    // The 5 core managed blocks injected into CLAUDE.md by --recommended:
    // idioma-rol, formato-respuesta, tipado-fuerte, cierre-sesion, engram-protocol
    const blockIds = parsed.managedBlocks.map((m: { id: string }) => m.id).sort();
    expect(blockIds).toEqual([
      "cierre-sesion",
      "engram-protocol",
      "formato-respuesta",
      "idioma-rol",
      "tipado-fuerte",
    ]);
    // G1: drifts array shipped (empty after a fresh render)
    expect(Array.isArray(parsed.drifts)).toBe(true);
    expect(parsed.drifts).toHaveLength(0);
  });

  it("doctor reports corrupted settings.json + render --force regenerates (#4)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    // Break the JSON
    const settingsPath = join(repo, ".claude/settings.json");
    writeFileSync(settingsPath, "{ this is not valid json", "utf-8");

    // 1. doctor sees it — exit 2 because corrupted settings is a hard issue
    const dr = runCli(["doctor", "--json", "--cwd", repo]);
    expect(dr.status).toBe(2);
    const dreport = JSON.parse(dr.stdout);
    expect(dreport.ok).toBe(false);
    expect(dreport.corruptedSettings).toHaveLength(1);
    expect(dreport.corruptedSettings[0].path).toBe(".claude/settings.json");
    // The error message comes from JSON.parse and surfaces the position of
    // the syntax problem — verify it mentions the cause, not just any text.
    expect(dreport.corruptedSettings[0].error).toMatch(/JSON|Unexpected|token/i);

    // 2. render --apply skips the corrupted file (refuses to overwrite without --force)
    const rr = runCli(["render", "--apply", "--cwd", repo]);
    expect(rr.status).toBe(0);
    expect(rr.combined).toContain("--force");
    expect(readFileSync(settingsPath, "utf-8")).toBe("{ this is not valid json");

    // 3. render --force --apply regenerates the file from the bundle
    const fr = runCli(["render", "--force", "--apply", "--cwd", repo]);
    expect(fr.status).toBe(0);
    const regenerated = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(regenerated.$navori?.managed).toBe(true);

    // 4. doctor now reports OK
    const dr2 = runCli(["doctor", "--json", "--cwd", repo]);
    const dreport2 = JSON.parse(dr2.stdout);
    expect(dreport2.ok).toBe(true);
    expect(dreport2.corruptedSettings).toHaveLength(0);
  });

  it("doctor flags missing invariants when a load-bearing rule is gutted (spec 0003 §3.1.1)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    // Fresh render: engram declares invariants (mem_save, mem_session_summary)
    // and they are present in the output, so doctor is clean.
    const clean = JSON.parse(runCli(["doctor", "--json", "--cwd", repo]).stdout);
    expect(clean.missingInvariants).toHaveLength(0);

    // Simulate a template refactor eating the engram protocol everywhere it
    // lives in the output: CLAUDE.md and the injected sub-block in leader.md.
    for (const rel of ["CLAUDE.md", ".claude/agents/leader.md"]) {
      const path = join(repo, rel);
      const gutted = readFileSync(path, "utf-8")
        .replaceAll("mem_save", "XXX")
        .replaceAll("mem_session_summary", "YYY");
      writeFileSync(path, gutted);
    }

    const broken = runCli(["doctor", "--json", "--cwd", repo]);
    expect(broken.status).toBe(2);
    const report = JSON.parse(broken.stdout);
    expect(report.ok).toBe(false);
    const missing = report.missingInvariants
      .map((m: { invariant: string }) => m.invariant)
      .sort();
    expect(missing).toEqual(["mem_save", "mem_session_summary"]);
    expect(
      report.missingInvariants.every((m: { source: string }) => m.source === "plugin:engram"),
    ).toBe(true);
  });

  it("doctor reports content drift when user edited inside the managed block (P0-fix B3)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    // Inject text inside the leader-base managed block WITHOUT touching the
    // marker line — the marker still claims its original hash but the body
    // now differs.
    const leaderPath = join(repo, ".claude/agents/leader.md");
    const original = readFileSync(leaderPath, "utf-8");
    const tampered = original.replace(
      "# Agente Líder (Orquestador)",
      "# Agente Líder (Orquestador)\n\nINJECTED LINE BY USER",
    );
    writeFileSync(leaderPath, tampered, "utf-8");

    const r = runCli(["doctor", "--json", "--cwd", repo]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    const contentDrift = parsed.drifts.find(
      (d: { kind: string; filePath: string }) =>
        d.kind === "content" && d.filePath === ".claude/agents/leader.md",
    );
    expect(contentDrift).toBeDefined();
    expect(contentDrift.expectedHash).toMatch(/^[a-f0-9]{8}$/);
    expect(contentDrift.actualHash).toMatch(/^[a-f0-9]{8}$/);
    expect(contentDrift.expectedHash).not.toBe(contentDrift.actualHash);
  });

  it("doctor --strict exits 1 when drift is detected (CI gate)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    // Inject content drift
    const leaderPath = join(repo, ".claude/agents/leader.md");
    const original = readFileSync(leaderPath, "utf-8");
    writeFileSync(
      leaderPath,
      original.replace("# Agente Líder (Orquestador)", "# Agente Líder INJECTED"),
      "utf-8",
    );

    // Default (no --strict): exit 0 even with drift (back-compat)
    const lenient = runCli(["doctor", "--cwd", repo]);
    expect(lenient.status).toBe(0);

    // --strict: drift fails the gate
    const strict = runCli(["doctor", "--strict", "--cwd", repo]);
    expect(strict.status).toBe(1);
  });

  it("doctor --strict exits 0 on a clean repo (no drift, no issues)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    const r = runCli(["doctor", "--strict", "--cwd", repo]);
    expect(r.status).toBe(0);
  });

  it("doctor exits 2 on hard issues (corrupted settings.json) regardless of --strict", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    writeFileSync(join(repo, ".claude/settings.json"), "{ broken json", "utf-8");

    const lenient = runCli(["doctor", "--cwd", repo]);
    expect(lenient.status).toBe(2);

    const strict = runCli(["doctor", "--strict", "--cwd", repo]);
    expect(strict.status).toBe(2);
  });

  it("doctor reports version drift when an agent file is older than the bundle", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    // Tamper with leader.md: replace the version="..." attr with an older one.
    const leaderPath = join(repo, ".claude/agents/leader.md");
    const tampered = readFileSync(leaderPath, "utf-8").replace(
      /version="\d+\.\d+\.\d+"/,
      'version="0.0.0"',
    );
    writeFileSync(leaderPath, tampered, "utf-8");

    const r = runCli(["doctor", "--json", "--cwd", repo]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    const drift = parsed.drifts.find(
      (d: { filePath: string; markerId: string; kind: string }) =>
        d.filePath === ".claude/agents/leader.md" &&
        d.markerId === "leader-base" &&
        d.kind === "version",
    );
    expect(drift).toBeDefined();
    expect(drift.fromVersion).toBe("0.0.0");
    expect(drift.toVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // ok stays true — drift is informational, not an error
    expect(parsed.ok).toBe(true);
  });

  it("configure language changes the config field", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    const r = runCli(["configure", "language", "en", "--cwd", repo]);
    expect(r.status).toBe(0);

    const config = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(config.language).toBe("en");
  });

  it("update --dry-run reports drift without writing", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    // Add deps that shift the preset
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "my-app",
        dependencies: { next: "^15", "@apollo/client": "^4" },
      }),
    );

    const r = runCli(["update", "--dry-run", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(r.combined).toContain("drift detected");
    expect(r.combined).toContain("nextjs-apollo");

    const config = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(config.preset).toBe("custom"); // not changed by dry-run
  });
});

describe("CLI e2e — coexist mode", () => {
  let dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    dirs = [];
  });

  it("--yes forces coexist when existing Claude infra detected, never touching files", () => {
    const repo = makeTmpRepo({
      "CLAUDE.md": "# CLAUDE.md a mano",
    });
    dirs.push(repo);

    const r = runCli(["init", "--yes", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(r.combined).toContain("coexist");

    const claudeMd = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toBe("# CLAUDE.md a mano"); // untouched
  });
});

describe("CLI e2e — monorepo init + scan (spec 0001 fase 3)", () => {
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

  function seedMonorepo(): string {
    const repo = makeTmpRepo({
      "pnpm-workspace.yaml": `packages:\n  - 'apps/*'\n`,
      "package.json": JSON.stringify({ name: "demo-monorepo", private: true }),
    });
    const apps = join(repo, "apps");
    const fs = require("node:fs");
    fs.mkdirSync(join(apps, "backend"), { recursive: true });
    fs.mkdirSync(join(apps, "storefront"), { recursive: true });
    writeFileSync(
      join(apps, "backend/package.json"),
      JSON.stringify({
        name: "backend",
        dependencies: { "@medusajs/medusa": "^2.0.0" },
      }),
    );
    writeFileSync(
      join(apps, "storefront/package.json"),
      JSON.stringify({
        name: "storefront",
        dependencies: { next: "^15.0.0" },
      }),
    );
    return repo;
  }

  it("init --recommended writes monorepo block with empty workspaces when no --scan-monorepo", () => {
    const repo = seedMonorepo();
    dirs.push(repo);

    const r = runCli(["init", "--recommended", "--no-render", "--cwd", repo]);
    expect(r.status).toBe(0);

    const config = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(config.monorepo).toBeDefined();
    expect(config.monorepo.enabled).toBe(true);
    expect(config.monorepo.tool).toBe("pnpm");
    expect(config.monorepo.workspaces).toEqual([]);
  });

  it("init --recommended --scan-monorepo populates workspaces[] with detected presets", () => {
    const repo = seedMonorepo();
    dirs.push(repo);

    const r = runCli([
      "init",
      "--recommended",
      "--scan-monorepo",
      "--no-render",
      "--cwd",
      repo,
    ]);
    expect(r.status).toBe(0);

    const config = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(config.monorepo.workspaces).toHaveLength(2);
    const byName = Object.fromEntries(
      config.monorepo.workspaces.map((w: { name: string }) => [w.name, w]),
    );
    expect(byName.backend.path).toBe("apps/backend");
    expect(byName.backend.preset).toBe("medusa");
    expect(byName.storefront.path).toBe("apps/storefront");
    expect(byName.storefront.preset).toBe("nextjs");
  });

  it("init --scan-monorepo does not write 'monorepo' for single-app repos", () => {
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({ name: "single-app" }),
    });
    dirs.push(repo);

    const r = runCli([
      "init",
      "--recommended",
      "--scan-monorepo",
      "--no-render",
      "--cwd",
      repo,
    ]);
    expect(r.status).toBe(0);

    const config = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(config.monorepo).toBeUndefined();
  });

  it("scan --yes is a no-op when init already populated workspaces", () => {
    const repo = seedMonorepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--scan-monorepo", "--no-render", "--cwd", repo]);

    const before = readFileSync(join(repo, "navori.config.json"), "utf-8");
    const r = runCli(["scan", "--yes", "--cwd", repo]);
    expect(r.status).toBe(0);
    const after = readFileSync(join(repo, "navori.config.json"), "utf-8");
    expect(after).toBe(before);
  });

  it("scan --yes adds a new workspace when one is created after init", () => {
    const repo = seedMonorepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--scan-monorepo", "--no-render", "--cwd", repo]);

    // Add a new workspace after init
    const fs = require("node:fs");
    fs.mkdirSync(join(repo, "apps/admin"), { recursive: true });
    writeFileSync(
      join(repo, "apps/admin/package.json"),
      JSON.stringify({ name: "admin", dependencies: { astro: "^5.0.0" } }),
    );

    const r = runCli(["scan", "--yes", "--cwd", repo]);
    expect(r.status).toBe(0);

    const config = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(config.monorepo.workspaces).toHaveLength(3);
    const admin = config.monorepo.workspaces.find((w: { name: string }) => w.name === "admin");
    expect(admin.path).toBe("apps/admin");
    expect(admin.preset).toBe("astro");
  });

  it("scan fails with helpful message when navori.config.json is missing", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);

    const r = runCli(["scan", "--yes", "--cwd", repo]);
    expect(r.status).not.toBe(0);
    expect(r.combined).toContain("navori.config.json");
    expect(r.combined).toContain("navori init");
  });

  it("scan fails with helpful message when config has no 'monorepo' field", () => {
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({ name: "single-app" }),
    });
    dirs.push(repo);
    runCli(["init", "--recommended", "--no-render", "--cwd", repo]);

    const r = runCli(["scan", "--yes", "--cwd", repo]);
    expect(r.status).not.toBe(0);
    expect(r.combined).toContain("no declara 'monorepo'");
  });

  it("render --workspace acota la operación a un solo workspace", () => {
    const repo = seedMonorepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--scan-monorepo", "--no-render", "--cwd", repo]);

    const r = runCli(["render", "--workspace", "backend", "--apply", "--cwd", repo]);
    expect(r.status).toBe(0);

    // Only backend was rendered
    expect(existsSync(join(repo, "apps/backend/CLAUDE.md"))).toBe(true);
    expect(existsSync(join(repo, "apps/storefront/CLAUDE.md"))).toBe(false);
    expect(existsSync(join(repo, "CLAUDE.md"))).toBe(false);
  });

  it("render --workspace falla con mensaje claro cuando el nombre no matchea", () => {
    const repo = seedMonorepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--scan-monorepo", "--no-render", "--cwd", repo]);

    const r = runCli(["render", "--workspace", "ghost", "--cwd", repo]);
    expect(r.status).not.toBe(0);
    expect(r.combined).toContain("ghost");
    expect(r.combined).toContain("backend");
  });

  it("sync default itera root + workspaces en un monorepo", () => {
    const repo = seedMonorepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--scan-monorepo", "--cwd", repo]);

    const r = runCli(["sync", "--dry-run", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(r.combined).toContain("Plan [root]");
    expect(r.combined).toContain("Plan [workspace:backend]");
    expect(r.combined).toContain("Plan [workspace:storefront]");
  });

  it("sync --workspace acota al workspace especificado", () => {
    const repo = seedMonorepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--scan-monorepo", "--cwd", repo]);

    const r = runCli(["sync", "--workspace", "backend", "--dry-run", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(r.combined).toContain("Plan [workspace:backend]");
    expect(r.combined).not.toContain("Plan [root]");
    expect(r.combined).not.toContain("Plan [workspace:storefront]");
  });

  it("sync --workspace falla con mensaje claro cuando el nombre no matchea", () => {
    const repo = seedMonorepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--scan-monorepo", "--cwd", repo]);

    const r = runCli(["sync", "--workspace", "ghost", "--cwd", repo]);
    expect(r.status).not.toBe(0);
    expect(r.combined).toContain("ghost");
  });
});
