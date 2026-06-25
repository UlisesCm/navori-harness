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

  it("configure branch-base sets branchBase and re-render propagates it to gate scripts", () => {
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({ name: "bb-app", dependencies: { typescript: "^5" } }),
      "tsconfig.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    dirs.push(repo);

    expect(runCli(["init", "--recommended", "--no-render", "--cwd", repo]).status).toBe(0);
    // A gate plugin whose script interpolates {{branchBase}}.
    expect(runCli(["add", "semgrep", "--skip-install", "--yes", "--cwd", repo]).status).toBe(0);

    const r = runCli(["configure", "branch-base", "develop", "--cwd", repo]);
    expect(r.status).toBe(0);

    const config = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(config.branchBase).toBe("develop");

    expect(runCli(["render", "--apply", "--cwd", repo]).status).toBe(0);
    const gate = readFileSync(join(repo, ".claude/scripts/check-semgrep.sh"), "utf-8");
    expect(gate).toContain("develop");
    expect(gate).not.toContain("{{branchBase}}");
  });

  it("gate plugins register both a PreToolUse and a Stop hook (gates run at session close)", () => {
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({ name: "stop-app", dependencies: { typescript: "^5" } }),
      "tsconfig.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    dirs.push(repo);

    expect(runCli(["init", "--recommended", "--no-render", "--cwd", repo]).status).toBe(0);
    expect(runCli(["add", "jscpd", "--skip-install", "--yes", "--cwd", repo]).status).toBe(0);
    expect(runCli(["render", "--apply", "--cwd", repo]).status).toBe(0);

    const settings = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf-8"));
    // The gate fires both before commit/push (PreToolUse) and at session close (Stop).
    expect(JSON.stringify(settings.hooks?.PreToolUse ?? [])).toContain("check-jscpd.sh");
    expect(JSON.stringify(settings.hooks?.Stop ?? [])).toContain("check-jscpd.sh");
  });

  it("project.localSkills renders a skills-index block; doctor flags a missing file", () => {
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({ name: "ls-app", dependencies: { typescript: "^5" } }),
      "tsconfig.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    dirs.push(repo);

    expect(runCli(["init", "--recommended", "--no-render", "--cwd", repo]).status).toBe(0);

    // Declare a project-local skill the user owns (navori indexes but never writes it).
    const cfgPath = join(repo, "navori.config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    cfg.project = { ...(cfg.project ?? {}), localSkills: ["rest-nexus-workflow"] };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");

    expect(runCli(["render", "--apply", "--cwd", repo]).status).toBe(0);

    const claudeMd = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain('navori:managed id="skills-index"');
    expect(claudeMd).toContain("rest-nexus-workflow");
    expect(claudeMd).toContain("project-local");

    // doctor warns: the declared skill has no file on disk.
    expect(runCli(["doctor", "--cwd", repo]).combined).toMatch(/project-local.*sin archivo/);

    // Once the user writes the file, the warning clears.
    writeFileSync(join(repo, ".claude/skills/rest-nexus-workflow.md"), "# local skill\n", "utf-8");
    expect(runCli(["doctor", "--cwd", repo]).combined).not.toMatch(/sin archivo/);
  });

  it("renders the review-diff core skill; the reviewer references it", () => {
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({ name: "rv-app", dependencies: { typescript: "^5" } }),
      "tsconfig.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    dirs.push(repo);

    expect(runCli(["init", "--recommended", "--cwd", repo]).status).toBe(0);

    const skillPath = join(repo, ".claude/skills/review-diff.md");
    expect(existsSync(skillPath)).toBe(true);
    const skill = readFileSync(skillPath, "utf-8");
    expect(skill).toContain("CRÍTICO");
    expect(skill).not.toContain("{{"); // all placeholders interpolated

    // The reviewer agent applies the skill in its quality pass.
    const reviewer = readFileSync(join(repo, ".claude/agents/reviewer.md"), "utf-8");
    expect(reviewer).toContain("review-diff.md");
  });

  it("project.* answers render an active contexto-proyecto block of rules", () => {
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({ name: "ctx-app", dependencies: { typescript: "^5" } }),
      "tsconfig.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    dirs.push(repo);

    expect(runCli(["init", "--recommended", "--no-render", "--cwd", repo]).status).toBe(0);

    // Simulate the questionnaire answers (posture, rigor, architecture, tests).
    const cfgPath = join(repo, "navori.config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    cfg.project = {
      ...(cfg.project ?? {}),
      posture: "production",
      reviewRigor: "strict",
      architectureRule: "axios -> service -> adapter -> component",
      testsForNewCode: "always",
    };
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");

    expect(runCli(["render", "--apply", "--cwd", repo]).status).toBe(0);

    const claudeMd = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain('navori:managed id="contexto-proyecto"');
    expect(claudeMd).toContain("en producción"); // posture rule
    expect(claudeMd).toContain("axios -> service -> adapter -> component"); // architecture rule
    expect(claudeMd).toContain("65-79"); // strict rigor rule
    expect(claudeMd).not.toContain("{{"); // no raw placeholders
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
      localSkills: [],
      libraries: [],
      testRunner: "vitest",
      codeLanguage: "js",
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

  it("init --yes plain writes empty project block but never invents a qualityGate", () => {
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
    // --yes never guesses gate commands (back-compat) ...
    expect(config.qualityGate).toBeUndefined();
    // ... but it DOES write the project block with empty arrays so render emits
    // no `<not configured: project.*>` placeholders in the agents (F11).
    expect(config.project).toEqual({
      legacyPaths: [],
      criticalAreas: [],
      localSkills: [],
      libraries: [],
      codeLanguage: "ts",
    });
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

  it("preset contributes a stack managed block to CLAUDE.md (F2)", () => {
    const next = makeTmpRepo({
      "package.json": JSON.stringify({ name: "web", dependencies: { next: "^15" } }),
    });
    const nest = makeTmpRepo({
      "package.json": JSON.stringify({ name: "api", dependencies: { "@nestjs/core": "^10" } }),
    });
    dirs.push(next, nest);

    runCli(["init", "--yes", "--cwd", next]);
    runCli(["init", "--yes", "--cwd", nest]);
    const nextMd = readFileSync(join(next, "CLAUDE.md"), "utf-8");
    const nestMd = readFileSync(join(nest, "CLAUDE.md"), "utf-8");

    // Each preset injects its own stack block — no longer a baseline-only,
    // stack-agnostic CLAUDE.md identical across presets.
    expect(nextMd).toContain('id="stack-nextjs"');
    expect(nextMd).toContain("App Router");
    expect(nestMd).toContain('id="stack-nestjs"');
    expect(nextMd).not.toEqual(nestMd);
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
    // F9: the abort must point the user at the next steps, not dead-end.
    expect(r.combined).toMatch(/update/);
    expect(r.combined).toMatch(/configure/);
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

  it("add --suggest recommends engram when not enabled (spec 0003 §3.5.2)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    // --yes (not --recommended) → engram is NOT enabled.
    runCli(["init", "--yes", "--no-render", "--cwd", repo]);

    const r = runCli(["add", "--suggest", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(r.combined).toMatch(/engram/);
  });

  it("add --suggest is quiet when engram is already enabled", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    // --recommended enables engram; empty tmp repo → no stack → preset stays custom.
    runCli(["init", "--recommended", "--no-render", "--cwd", repo]);

    const r = runCli(["add", "--suggest", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(r.combined).toContain("Nada que sugerir");
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
    // The message must name the affected file AND the managed block id — not just
    // the word "conflict" — so the user knows exactly what to resolve (#6).
    expect(r.combined).toContain("conflict");
    expect(r.combined).toContain("CLAUDE.md");
    expect(r.combined).toContain("idioma-rol"); // the block that holds "Tech Lead Senior"
    expect(r.combined).toMatch(/managed block edited/);
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
    // The core managed blocks injected into CLAUDE.md by --recommended:
    // arranque-sesion, idioma-rol, formato-respuesta, tipado-fuerte,
    // operaciones-seguras, cierre-sesion, engram-protocol, plus skills-index
    // (always rendered now — it lists the always-present core skills).
    const blockIds = parsed.managedBlocks.map((m: { id: string }) => m.id).sort();
    expect(blockIds).toEqual([
      "arranque-sesion",
      "cierre-sesion",
      "engram-protocol",
      "formato-respuesta",
      "idioma-rol",
      "operaciones-seguras",
      "skills-index",
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

  it("doctor flags a preset declared in config that has no backing JSON (F15)", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    runCli(["init", "--recommended", "--cwd", repo]);

    // Point the config at a preset that does not ship — render would fall back
    // to baseline and warn; doctor must surface it as a hard issue (exit 2).
    const configPath = join(repo, "navori.config.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    config.preset = "monorepo-turbopnpm";
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const dr = runCli(["doctor", "--json", "--cwd", repo]);
    expect(dr.status).toBe(2);
    const dreport = JSON.parse(dr.stdout);
    expect(dreport.ok).toBe(false);
    expect(dreport.missingPreset).toBe("monorepo-turbopnpm");
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

    // Add deps that shift the preset to a real, shipped preset (nextjs). Using
    // a phantom candidate like nextjs-apollo would now resolve to "custom" and
    // report no drift (F1).
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({
        name: "my-app",
        dependencies: { next: "^15" },
      }),
    );

    const r = runCli(["update", "--dry-run", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(r.combined).toContain("drift detected");
    expect(r.combined).toContain("nextjs");

    const config = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(config.preset).toBe("custom"); // not changed by dry-run
  });

  it("update --yes refreshes project.libraries and materializes the library skill", () => {
    // Upgrade scenario: a config written before the library-skills layer existed
    // (no project.libraries). `update` must re-detect from deps, add them, AND
    // run the full engine so the skill file lands — not just re-render CLAUDE.md.
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({
        name: "evals-svc",
        dependencies: { express: "^4", mongoose: "^8", typescript: "^5" },
      }),
      "tsconfig.json": "{}",
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    dirs.push(repo);

    expect(runCli(["init", "--recommended", "--cwd", repo]).status).toBe(0);

    // Simulate a pre-library-skills config: strip project.libraries.
    const cfgPath = join(repo, "navori.config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8"));
    delete cfg.project.libraries;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");

    const r = runCli(["update", "--yes", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(r.combined).toContain("project.libraries");

    // Config regained the detected library skill...
    const after = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(after.project.libraries).toContain("mongoose");
    // ...and the engine materialized its skill file (the gap: update used to
    // re-render CLAUDE.md only, never the .claude/ tree).
    expect(existsSync(join(repo, ".claude/skills/mongoose.md"))).toBe(true);
    // express-mongoose stays put even though we could add a worker — no churn here.
    expect(after.preset).toBe("express-mongoose");
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

  it("init without a detected qualityGate renders prose, not a raw command placeholder (F12)", () => {
    const repo = makeTmpRepo({ "package.json": JSON.stringify({ name: "no-gate" }) });
    dirs.push(repo);

    runCli(["init", "--yes", "--cwd", repo]);
    const leader = readFileSync(join(repo, ".claude/agents/leader.md"), "utf-8");

    // Was `corre \`<not configured: qualityGate.fast>\`` — read like a command.
    expect(leader).not.toContain("<not configured: qualityGate");
    expect(leader).toContain("quality gate sin configurar");
  });

  it("'navori migrations' with no subcommand defaults to list instead of erroring (F10)", () => {
    // Was citty's bare "No command specified." Now it lists (exit 0).
    const r = runCli(["migrations"]);
    expect(r.status).toBe(0);
    expect(r.combined).not.toContain("No command specified");
  });
});

describe("CLI e2e — local presets (fase 2)", () => {
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

  it("preset init scaffolds .navori/presets/<id>/ and wires preset into config", () => {
    const repo = makeTmpRepo({ "package.json": JSON.stringify({ name: "lp-app" }) });
    dirs.push(repo);
    expect(runCli(["init", "--yes", "--cwd", repo]).status).toBe(0);

    const r = runCli(["preset", "init", "mistack", "--cwd", repo]);
    expect(r.status).toBe(0);

    expect(existsSync(join(repo, ".navori/presets/mistack/mistack.json"))).toBe(true);
    expect(existsSync(join(repo, ".navori/presets/mistack/managed/stack.md"))).toBe(true);
    expect(existsSync(join(repo, ".navori/presets/mistack/skills/mistack-example.md"))).toBe(true);

    const cfg = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(cfg.preset).toBe("mistack");
  });

  it("render --apply materializes a local preset's skill + stack block", () => {
    const repo = makeTmpRepo({ "package.json": JSON.stringify({ name: "lp-render" }) });
    dirs.push(repo);
    runCli(["init", "--yes", "--cwd", repo]);
    runCli(["preset", "init", "mistack", "--cwd", repo]);

    expect(runCli(["render", "--apply", "--cwd", repo]).status).toBe(0);

    // The example skill landed in .claude/skills/.
    expect(existsSync(join(repo, ".claude/skills/mistack-example.md"))).toBe(true);
    // The stack managed block landed in CLAUDE.md.
    const claudeMd = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(claudeMd).toContain('navori:managed id="stack-mistack"');
    expect(claudeMd).toContain("## Stack — mistack");
  });

  it("doctor recognizes a local preset (not phantom) — exit 0", () => {
    const repo = makeTmpRepo({ "package.json": JSON.stringify({ name: "lp-doctor" }) });
    dirs.push(repo);
    runCli(["init", "--yes", "--cwd", repo]);
    runCli(["preset", "init", "mistack", "--cwd", repo]);
    runCli(["render", "--apply", "--cwd", repo]);

    const r = runCli(["doctor", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(r.combined).not.toMatch(/no existe/);
  });

  it("doctor --strict flags a local preset whose extra file is missing", () => {
    const repo = makeTmpRepo({ "package.json": JSON.stringify({ name: "lp-missing" }) });
    dirs.push(repo);
    runCli(["init", "--yes", "--cwd", repo]);
    runCli(["preset", "init", "mistack", "--cwd", repo]);
    // Remove the example skill the manifest still references.
    rmSync(join(repo, ".navori/presets/mistack/skills/mistack-example.md"));

    const r = runCli(["doctor", "--strict", "--cwd", repo]);
    expect(r.status).not.toBe(0);
    expect(r.combined).toMatch(/sin archivo/);
  });

  it("preset init refuses to overwrite an existing local preset", () => {
    const repo = makeTmpRepo({ "package.json": JSON.stringify({ name: "lp-dup" }) });
    dirs.push(repo);
    runCli(["init", "--yes", "--cwd", repo]);
    expect(runCli(["preset", "init", "mistack", "--cwd", repo]).status).toBe(0);

    const second = runCli(["preset", "init", "mistack", "--cwd", repo]);
    expect(second.status).not.toBe(0);
    expect(second.combined).toMatch(/[Yy]a existe/);
  });

  it("preset init rejects the reserved id 'custom' and non-kebab ids", () => {
    const repo = makeTmpRepo({ "package.json": JSON.stringify({ name: "lp-bad" }) });
    dirs.push(repo);
    runCli(["init", "--yes", "--cwd", repo]);

    expect(runCli(["preset", "init", "custom", "--cwd", repo]).status).not.toBe(0);
    expect(runCli(["preset", "init", "BadId", "--cwd", repo]).status).not.toBe(0);
    expect(existsSync(join(repo, ".navori/presets/custom"))).toBe(false);
  });

  it("preset init without a config scaffolds and tells the user to run init", () => {
    const repo = makeTmpRepo();
    dirs.push(repo);
    const r = runCli(["preset", "init", "mistack", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect(existsSync(join(repo, ".navori/presets/mistack/mistack.json"))).toBe(true);
    expect(r.combined).toMatch(/navori init/);
  });

  it("doctor warns when a local preset shadows a bundled one of the same id", () => {
    // express + mongoose → detector picks the bundled 'express-mongoose' preset.
    const repo = makeTmpRepo({
      "package.json": JSON.stringify({
        name: "lp-override",
        dependencies: { express: "^4", mongoose: "^8" },
      }),
    });
    dirs.push(repo);
    runCli(["init", "--yes", "--cwd", repo]);
    const cfg = JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
    expect(cfg.preset).toBe("express-mongoose");

    // Scaffold a local preset with the same id → it shadows the bundled one.
    expect(runCli(["preset", "init", "express-mongoose", "--cwd", repo]).status).toBe(0);
    runCli(["render", "--apply", "--cwd", repo]);

    const r = runCli(["doctor", "--cwd", repo]);
    expect(r.combined).toMatch(/sombrea/);
  });
});
