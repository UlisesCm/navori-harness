import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Spec 0064 (4a) happy path against the BUILT binary: the layered `AGENTS.md`, the
 * `claude-apendice` block in `CLAUDE.md`, Pi's parent-only `.pi/navori/orchestrator.md`, and the
 * guarantee that the user's own text survives render, prune and restore.
 *
 * Assertions use stable markers (file contents, `--json` shape), never full stdout snapshots.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "..", "dist", "index.js");

/** Throwaway HOME: keeps the registry AND the backup store away from the developer's real ones. */
const E2E_HOME = mkdtempSync(join(tmpdir(), "navori-layers-home-"));
const BACKUP_ROOT = join(E2E_HOME, "backups");
const dirs: string[] = [];
afterAll(() => {
  rmSync(E2E_HOME, { recursive: true, force: true });
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  combined: string;
}

function run(args: string[]): CliResult {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME: E2E_HOME, NO_COLOR: "1", NAVORI_BACKUP_ROOT: BACKUP_ROOT },
  });
  const stdout = r.stdout ?? "";
  const stderr = r.stderr ?? "";
  return { status: r.status ?? -1, stdout, stderr, combined: stdout + stderr };
}

/** The slice of `render --json` these specs read. */
interface RenderJson {
  mode: "preview" | "apply";
  root: {
    changed: boolean;
    written: { path: string; status: string }[];
    backupPath: string | null;
  };
  extraEngines?: {
    engine: string;
    written: { path: string; status: string }[];
    backupPath: string | null;
  }[];
}

/** Every file the render planned or wrote, root Claude tree and other engines together. */
function plannedFiles(json: RenderJson): { path: string; status: string }[] {
  return [...json.root.written, ...(json.extraEngines ?? []).flatMap((e) => e.written)];
}

function statusOf(json: RenderJson, suffix: string): string | undefined {
  return plannedFiles(json).find((f) => f.path.endsWith(suffix))?.status;
}

function renderJson(repo: string, apply: boolean): RenderJson {
  const r = run(["render", ...(apply ? ["--apply"] : []), "--json", "--cwd", repo]);
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout) as RenderJson;
}

/** Init a repo, set its engines, seed optional files BEFORE the first render. */
function makeRepo(engines: string[], seed: Record<string, string> = {}): string {
  const repo = mkdtempSync(join(tmpdir(), "navori-layers-"));
  dirs.push(repo);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "layers-fixture" }), "utf-8");
  const init = run(["init", "--yes", "--no-render", "--cwd", repo]);
  expect(init.status).toBe(0);
  const cfgPath = join(repo, "navori.config.json");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
  cfg.engines = engines;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");
  for (const [rel, content] of Object.entries(seed)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content, "utf-8");
  }
  return repo;
}

const CLAUDE_USER = "MY-OWN-CLAUDE-NOTE: never touch the billing module.\n";
const AGENTS_USER = "MY-OWN-AGENTS-NOTE: deploys go through the release train.\n";

describe("AGENTS.md layers e2e (spec 0064 4a)", () => {
  it("fixture A (claude + agents-md): preview writes nothing, apply keeps user text, restore returns CLAUDE.md", () => {
    const repo = makeRepo(["claude", "agents-md"]);
    // First render so the preview below compares against a repo that already carries a
    // rendered CLAUDE.md; the file is then rewritten by hand into its pre-4a shape.
    const first = renderJson(repo, true);
    expect(first.mode).toBe("apply");
    const claudePath = join(repo, "CLAUDE.md");
    const original = readFileSync(claudePath, "utf-8");
    expect(original).toContain("claude-apendice");

    // Reset to the pre-4a shape (no appendix, own text appended outside any block), drop AGENTS.md.
    const legacy = original.replace(
      /<!-- navori:managed id="claude-apendice"[\s\S]*?<!-- \/navori:managed id="claude-apendice" -->\n?/,
      "",
    );
    expect(legacy).not.toContain('id="claude-apendice"');
    writeFileSync(claudePath, legacy.trimEnd() + "\n\n" + CLAUDE_USER, "utf-8");
    rmSync(join(repo, "AGENTS.md"));

    const beforePreview = readFileSync(claudePath, "utf-8");
    const preview = renderJson(repo, false);
    expect(preview.mode).toBe("preview");
    expect(statusOf(preview, "AGENTS.md")).toBe("created");
    expect(statusOf(preview, "CLAUDE.md")).toBe("updated");
    // Preview touches nothing.
    expect(readFileSync(claudePath, "utf-8")).toBe(beforePreview);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);

    const apply = run(["render", "--apply", "--cwd", repo]);
    expect(apply.status).toBe(0);
    const after = readFileSync(claudePath, "utf-8");
    expect(after).toContain(CLAUDE_USER.trim());
    expect(after).toContain('id="claude-apendice"');
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);

    // Idempotent: nothing left to do.
    const again = renderJson(repo, true);
    expect(again.root.changed).toBe(false);
    expect(
      plannedFiles(again).filter((f) => f.status !== "unchanged" && f.status !== "up-to-date"),
    ).toEqual([]);

    // Restore the backup taken by the apply: CLAUDE.md returns to the pre-apply content.
    // The apply prints the backup it took (under the sandboxed HOME); its basename is the id.
    const backupPath = apply.combined.match(new RegExp(`${BACKUP_ROOT}/\\S+`))?.[0];
    expect(backupPath).toBeTruthy();
    const id = (backupPath as string).replace(/\/+$/, "").split("/").pop() as string;
    const restore = run(["backup", "restore", id, "--yes", "--cwd", repo]);
    expect(restore.status).toBe(0);
    expect(readFileSync(claudePath, "utf-8")).toBe(beforePreview);
  });

  it("fixture B (claude + pi + agents-md): AGENTS.md keeps user text and stays engine-neutral", () => {
    const repo = makeRepo(["claude", "pi", "agents-md"], { "AGENTS.md": AGENTS_USER });
    const apply = run(["render", "--apply", "--cwd", repo]);
    expect(apply.status).toBe(0);

    const agents = readFileSync(join(repo, "AGENTS.md"), "utf-8");
    expect(agents).toContain(AGENTS_USER.trim());
    expect(agents).not.toContain("Role: orchestrator");
    expect(agents).not.toContain(".claude/");
    expect(agents).not.toContain("CLAUDE.md");
    expect(existsSync(join(repo, ".pi/navori/orchestrator.md"))).toBe(true);
  });

  it("prune to cursor keeps the user text of AGENTS.md", () => {
    const repo = makeRepo(["claude", "agents-md"], { "AGENTS.md": AGENTS_USER });
    expect(run(["render", "--apply", "--cwd", repo]).status).toBe(0);
    expect(readFileSync(join(repo, "AGENTS.md"), "utf-8")).toContain(AGENTS_USER.trim());

    const cfgPath = join(repo, "navori.config.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as Record<string, unknown>;
    cfg.engines = ["claude", "cursor"];
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), "utf-8");

    const pruned = run(["render", "--apply", "--prune", "--cwd", repo]);
    expect(pruned.status).toBe(0);
    // The managed layers are gone; the user's own text is not.
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(true);
    const left = readFileSync(join(repo, "AGENTS.md"), "utf-8");
    expect(left).toContain(AGENTS_USER.trim());
    expect(left).not.toContain('id="navori-agents"');
  });

  it("without agents-md, CLAUDE.md keeps its current shape", () => {
    const repo = makeRepo(["claude"]);
    expect(run(["render", "--apply", "--cwd", repo]).status).toBe(0);
    expect(existsSync(join(repo, "AGENTS.md"))).toBe(false);
    const claude = readFileSync(join(repo, "CLAUDE.md"), "utf-8");
    expect(claude).toContain("navori:managed");
    expect(claude).toContain("## Idioma y rol");
    // Claude's own file still carries the shared blocks inline plus the Claude-only appendix.
    expect(claude).toContain('id="claude-apendice"');
  });
});
