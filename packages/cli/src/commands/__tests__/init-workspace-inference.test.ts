import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #1054 — `navori init` without `--workspace` never looked at the workspace
 * registry (~/.navori/workspaces/), even when exactly one workspace already
 * registered the repo's path. These specs spawn the built CLI (same
 * pattern as init-missing-binaries.test.ts) so the assertions cover the real
 * `--yes`/`--full` config-write + stdout, not a re-implementation of the wiring.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "..", "..", "dist", "index.js");

interface CliResult {
  status: number;
  combined: string;
}

function runCli(args: string[], home: string): CliResult {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { HOME: home, NO_COLOR: "1", PATH: process.env.PATH ?? "" },
  });
  return { status: r.status ?? -1, combined: (r.stdout ?? "") + (r.stderr ?? "") };
}

function makeTmpRepo(name = "test-app"): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-e2e-ws-infer-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name }), "utf-8");
  return dir;
}

function writeWorkspaceManifest(home: string, name: string, repoPath: string): void {
  const dir = join(home, ".navori", "workspaces", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "workspace.json"),
    JSON.stringify({
      name,
      ticketsDir: "tickets",
      defaults: {},
      repos: [{ name: "repo", path: repoPath }],
    }),
    "utf-8",
  );
}

function readConfig(repo: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(repo, "navori.config.json"), "utf-8"));
}

describe("init workspace inference — e2e (#1054)", () => {
  let dirs: string[] = [];

  beforeEach(() => {
    if (!existsSync(CLI)) {
      throw new Error(`CLI not built at ${CLI}. Run 'bun run build' before tests.`);
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

  // Covers: A2 (0 matches — no workspace registers the repo)
  it("init --yes writes no workspace when nothing registers the repo path", () => {
    const home = mkdtempSync(join(tmpdir(), "navori-e2e-ws-home-"));
    const repo = makeTmpRepo();
    dirs.push(home, repo);

    const r = runCli(["init", "--yes", "--no-render", "--cwd", repo], home);

    expect(r.status).toBe(0);
    expect(readConfig(repo).workspace).toBeUndefined();
  });

  // Covers: A2 (1 match, --yes applies it)
  it("init --yes infers and writes the single matching workspace", () => {
    const home = mkdtempSync(join(tmpdir(), "navori-e2e-ws-home-"));
    const repo = makeTmpRepo();
    dirs.push(home, repo);
    writeWorkspaceManifest(home, "auto-ws", repo);

    const r = runCli(["init", "--yes", "--no-render", "--cwd", repo], home);

    expect(r.status).toBe(0);
    expect(readConfig(repo).workspace).toBe("auto-ws");
    // Shown in the detection summary, labelled with its provenance.
    expect(r.combined).toContain("auto-ws");
  });

  // Covers: A2 (1 match, --full applies it too)
  it("init --full infers and writes the single matching workspace", () => {
    const home = mkdtempSync(join(tmpdir(), "navori-e2e-ws-home-"));
    const repo = makeTmpRepo();
    dirs.push(home, repo);
    writeWorkspaceManifest(home, "auto-ws", repo);

    const r = runCli(["init", "--full", "--no-render", "--cwd", repo], home);

    expect(r.status).toBe(0);
    expect(readConfig(repo).workspace).toBe("auto-ws");
  });

  // Covers: A2 (2+ matches — warn, write nothing)
  it("init --yes warns and writes no workspace when the repo is registered in 2+ workspaces", () => {
    const home = mkdtempSync(join(tmpdir(), "navori-e2e-ws-home-"));
    const repo = makeTmpRepo();
    dirs.push(home, repo);
    writeWorkspaceManifest(home, "bonum", repo);
    writeWorkspaceManifest(home, "personal", repo);

    const r = runCli(["init", "--yes", "--no-render", "--cwd", repo], home);

    expect(r.status).toBe(0);
    expect(readConfig(repo).workspace).toBeUndefined();
    expect(r.combined).toContain("bonum");
    expect(r.combined).toContain("personal");
  });

  // Covers: A2 (explicit --workspace always wins over inference)
  it("an explicit --workspace wins even when a different workspace would be inferred", () => {
    const home = mkdtempSync(join(tmpdir(), "navori-e2e-ws-home-"));
    const repo = makeTmpRepo();
    dirs.push(home, repo);
    writeWorkspaceManifest(home, "auto-ws", repo);
    mkdirSync(join(home, ".navori", "workspaces", "explicit-ws"), {
      recursive: true,
    });
    writeFileSync(
      join(home, ".navori", "workspaces", "explicit-ws", "workspace.json"),
      JSON.stringify({ name: "explicit-ws", ticketsDir: "tickets", defaults: {}, repos: [] }),
      "utf-8",
    );

    const r = runCli(
      ["init", "--yes", "--no-render", "--cwd", repo, "--workspace", "explicit-ws"],
      home,
    );

    expect(r.status).toBe(0);
    expect(readConfig(repo).workspace).toBe("explicit-ws");
  });
});

/**
 * Interactive prefill (#1054): the wizard's free-text "workspace" prompt must
 * start from the inferred name instead of empty, so accepting the default
 * (Enter) links the repo without the user having to remember/retype the name.
 * Runs `initCommand.run` in-process with `@clack/prompts` mocked — spawning a
 * real interactive TTY session isn't exercised anywhere else in this suite —
 * and `safeHomedir` mocked to a fixture home the same way workspace tests do.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock(import("../../lib/primitives/home.ts"), () => ({ safeHomedir: () => home.dir }));

const CANCEL = Symbol("cancel");
const promptMocks = vi.hoisted(() => ({
  intro: vi.fn(),
  outro: vi.fn(),
  cancel: vi.fn(),
  note: vi.fn(),
  confirm: vi.fn(),
  multiselect: vi.fn(),
  text: vi.fn(),
  select: vi.fn(),
  log: { warn: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), message: vi.fn() },
}));
vi.mock("@clack/prompts", () => ({
  ...promptMocks,
  isCancel: (v: unknown) => v === CANCEL,
}));

describe("init workspace inference — interactive prefill (#1054)", () => {
  let repoDir: string;

  beforeEach(() => {
    home.dir = mkdtempSync(join(tmpdir(), "navori-ws-infer-home-"));
    repoDir = mkdtempSync(join(tmpdir(), "navori-ws-infer-repo-"));
    writeFileSync(join(repoDir, "package.json"), JSON.stringify({ name: "test-app" }), "utf-8");
    const wsDir = join(home.dir, ".navori", "workspaces", "auto-ws");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      join(wsDir, "workspace.json"),
      JSON.stringify({
        name: "auto-ws",
        ticketsDir: "tickets",
        defaults: {},
        repos: [{ name: "repo", path: repoDir }],
      }),
      "utf-8",
    );

    promptMocks.confirm.mockReset().mockResolvedValue(false);
    promptMocks.multiselect.mockReset().mockResolvedValue(["workspace"]);
    promptMocks.text.mockReset().mockResolvedValue(CANCEL);
    promptMocks.select.mockReset();
    promptMocks.note.mockReset();
  });

  afterEach(() => {
    rmSync(home.dir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  // Covers: A2 (interactive prefill)
  it("prefills the workspace text prompt with the inferred name", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called");
    });

    const { initCommand } = await import("../init.ts");
    await expect(
      // any justified: citty's CommandDef["run"] context type isn't exported
      // in a form usable to build a minimal test invocation; only `args` is read.
      (initCommand.run as unknown as (ctx: { args: Record<string, unknown> }) => Promise<void>)({
        args: { cwd: repoDir, lang: "en", render: false },
      }),
    ).rejects.toThrow("process.exit called");

    expect(promptMocks.text).toHaveBeenCalledWith(
      expect.objectContaining({ defaultValue: "auto-ws", placeholder: "auto-ws" }),
    );

    exitSpy.mockRestore();
  });
});
