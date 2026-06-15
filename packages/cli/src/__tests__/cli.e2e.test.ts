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

    const r = runCli(["render", "--cwd", repo]);
    expect(r.status).toBe(0);

    const second = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(second).toBe(first);
    expect(r.combined).toMatch(/no changes|unchanged/);
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
    expect(parsed.config.name).toBeDefined();
    expect(parsed.managedBlocks.length).toBeGreaterThanOrEqual(5);
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

    // 1. doctor sees it
    const dr = runCli(["doctor", "--json", "--cwd", repo]);
    expect(dr.status).toBe(0);
    const dreport = JSON.parse(dr.stdout);
    expect(dreport.ok).toBe(false);
    expect(dreport.corruptedSettings).toHaveLength(1);
    expect(dreport.corruptedSettings[0].path).toBe(".claude/settings.json");
    expect(dreport.corruptedSettings[0].error.length).toBeGreaterThan(0);

    // 2. plain render skips (refuses to overwrite without --force)
    const rr = runCli(["render", "--cwd", repo]);
    expect(rr.status).toBe(0);
    expect(rr.combined).toContain("--force");
    expect(readFileSync(settingsPath, "utf-8")).toBe("{ this is not valid json");

    // 3. render --force regenerates the file from the bundle
    const fr = runCli(["render", "--force", "--cwd", repo]);
    expect(fr.status).toBe(0);
    const regenerated = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(regenerated.$navori?.managed).toBe(true);

    // 4. doctor now reports OK
    const dr2 = runCli(["doctor", "--json", "--cwd", repo]);
    const dreport2 = JSON.parse(dr2.stdout);
    expect(dreport2.ok).toBe(true);
    expect(dreport2.corruptedSettings).toHaveLength(0);
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
