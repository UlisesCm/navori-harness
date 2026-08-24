import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { NavoriConfig } from "../../../lib/config.ts";

/**
 * #405: `commitWrites` used to snapshot the engine's whole tree (`CLAUDE.md`,
 * all of `.claude/`, `navori.config.json`, `.mcp.json`) whenever a render
 * touched anything — ~370 KB per repo to protect a one-byte edit. Since a
 * release restamps the `version=` of every managed block, EVERY asset comes back
 * "updated" and a rollout to N repos paid that toll N times.
 *
 * The backup must now be proportional: exactly the files this render overwrites
 * or deletes, which is also exactly what it can destroy.
 *
 * createBackup writes under the backup store, redirected by `NAVORI_BACKUP_ROOT`
 * (per spec file); `safeHomedir` is mocked too so nothing else reaches the real
 * `~/.navori`.
 */
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../../lib/home.ts", () => ({ safeHomedir: () => home.dir }));

const { renderClaudeEngine } = await import("../../claude/index.ts");

const CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
} as unknown as NavoriConfig;

let cwd: string;

beforeEach(() => {
  home.dir = mkdtempSync(join(tmpdir(), "navori-home-"));
  cwd = mkdtempSync(join(tmpdir(), "navori-backup-proportional-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home.dir, { recursive: true, force: true });
});

/** Every file under `dir`, as repo-relative paths, sorted. */
function listFiles(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, root));
    else if (entry.isFile()) out.push(relative(root, full));
  }
  return out.sort();
}

/**
 * Stamp an OLDER navori version into a rendered file's managed marker, leaving
 * its body byte-identical. That is exactly the shape of a release restamp: the
 * canonical content matches, only the metadata drifts, so the file comes back
 * `updated` and enters `pending` (marker.ts §"Content is identical but metadata
 * differs"). The dominant real-world backup trigger, reduced to one file.
 */
function restampOlder(path: string): void {
  const before = readFileSync(path, "utf-8");
  const after = before.replace(/version="[^"]+"/, 'version="0.0.1"');
  expect(after).not.toBe(before);
  writeFileSync(path, after, "utf-8");
}

describe("commitWrites — backup proportional al cambio (#405)", () => {
  it("snapshots only the file the render rewrites, not the `.claude` tree", () => {
    renderClaudeEngine(cwd, CONFIG); // seed a rendered harness

    restampOlder(join(cwd, ".claude/agents/reviewer.md"));

    const second = renderClaudeEngine(cwd, CONFIG);
    expect(second.written.map((w) => w.path)).toEqual([".claude/agents/reviewer.md"]);
    expect(second.backupPath).not.toBeNull();

    // The whole point: the snapshot is the diff, not the tree. A listing (not an
    // existsSync per path) so any extra file the backup grows fails the assert.
    expect(listFiles(second.backupPath as string)).toEqual([".claude/agents/reviewer.md"]);
  });

  it("snapshots a file it is about to DELETE, so a prune stays recoverable", () => {
    renderClaudeEngine(cwd, CONFIG);

    // A legacy FLAT skill twin (`.claude/skills/<id>.md`) from a repo onboarded
    // before the directory form: the next render prunes it (#166). Copied from
    // the rendered directory form so it carries navori's own marker — the only
    // shape the prune is allowed to touch.
    const skillId = readdirSync(join(cwd, ".claude/skills"), { withFileTypes: true }).find((e) =>
      e.isDirectory(),
    )?.name;
    expect(skillId).toBeDefined();
    const flatTwin = `.claude/skills/${skillId}.md`;
    copyFileSync(join(cwd, `.claude/skills/${skillId}/SKILL.md`), join(cwd, flatTwin));

    const second = renderClaudeEngine(cwd, CONFIG);
    expect(second.written).toEqual([{ path: flatTwin, status: "removed-condition-false" }]);
    expect(listFiles(second.backupPath as string)).toEqual([flatTwin]);
  });

  it("takes no backup on a first render — creating files destroys nothing", () => {
    const first = renderClaudeEngine(cwd, CONFIG);
    expect(first.written.length).toBeGreaterThan(0);
    expect(first.backupPath).toBeNull();
  });
});
