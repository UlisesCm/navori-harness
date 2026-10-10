import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runRender } from "../../../commands/render.ts";
import { scanOrphanedEngineOutputs } from "../../../lib/diagnose/health.ts";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { commitWrites } from "../../shared/execute-plan.ts";
import { renderPiEngine } from "../index.ts";
import { serializePiAgent, serializePiManifest, serializePiSource } from "../owned-file.ts";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-migration-"));
  dirs.push(dir);
  return dir;
}
function configFor(engines: string[]) {
  return NavoriConfigSchema.parse({
    name: "pi-migration",
    preset: "custom",
    engines,
    branchBase: "main",
    qualityGate: { fast: "bun test", full: "bun test" },
  });
}
/** Persist the config so `runRender` (the real `render --prune` path) can read it. */
function setEngines(dir: string, engines: string[]): void {
  writeFileSync(join(dir, "navori.config.json"), JSON.stringify(configFor(engines), null, 2));
}
/** Every regular file under the given roots, as `rel -> bytes`. */
function snapshot(dir: string, roots: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    const abs = join(dir, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(`${rel}/${name}`);
    } else out[rel] = readFileSync(abs, "utf-8");
  };
  for (const root of roots) walk(root);
  return out;
}
const prune = (dir: string, dryRun: boolean) => runRender(dir, { dryRun, prune: true });
// Unrelated to Pi: a non-Claude repo still gets `.claude/.gitignore` rendered and then listed as a
// Claude orphan in the same run. Out of scope for R11, so the assertions ignore it.
const pruned = (result: ReturnType<typeof runRender>): string[] =>
  (result.prunedEngineOutputs ?? []).filter((rel) => rel !== ".claude/.gitignore").sort();
const SCOUT = ".pi/agents/scout.md";

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("owned upgrade disable and other-engine preservation", () => {
  // Covers: R11
  it("keeps Pi's shared skills and AGENTS.md out of the orphan scan and the prune", () => {
    const dir = freshDir();
    setEngines(dir, ["pi"]);
    renderPiEngine(dir, configFor(["pi"]));
    const before = snapshot(dir, [".pi", ".agents", "AGENTS.md"]);
    expect(Object.keys(before).some((p) => p.startsWith(".agents/skills/"))).toBe(true);
    expect(before["AGENTS.md"]).toContain("navori:managed");

    expect(scanOrphanedEngineOutputs(dir, configFor(["pi"]))).toEqual([]);
    const result = prune(dir, false);
    expect(result.ok).toBe(true);
    expect(pruned(result)).toEqual([]);
    expect(snapshot(dir, [".pi", ".agents", "AGENTS.md"])).toEqual(before);
  });

  // Covers: R11
  it("upgrades 0040-shaped owned resources and preserves edited or colliding ones", () => {
    const dir = freshDir();
    const legacyAgents = ["scout", "implementer", "reviewer"];
    mkdirSync(join(dir, ".pi/agents"), { recursive: true });
    mkdirSync(join(dir, ".pi/extensions"), { recursive: true });
    // 0040 shape: three roles, no `model`, no `controls`, a smaller extension, no AGENTS.md.
    writeFileSync(
      join(dir, ".pi/navori.json"),
      serializePiManifest({ schemaVersion: 1, agents: legacyAgents }),
    );
    writeFileSync(
      join(dir, ".pi/extensions/navori.ts"),
      serializePiSource("export default function navori(): void {}\n"),
    );
    for (const name of legacyAgents) {
      writeFileSync(
        join(dir, `.pi/agents/${name}.md`),
        serializePiAgent({
          name,
          description: `legacy ${name}`,
          tools: ["read", "write"],
          instructions: `Legacy ${name} instructions.`,
        }),
      );
    }
    // An edited role blocks the whole generation: nothing is half-upgraded.
    const editedRepo = freshDir();
    cpSync(dir, editedRepo, { recursive: true });
    const edited = `${readFileSync(join(editedRepo, SCOUT), "utf-8")}user note\n`;
    writeFileSync(join(editedRepo, SCOUT), edited);
    const blocked = renderPiEngine(editedRepo, configFor(["pi"]));
    expect(blocked.written.some((w) => w.path.startsWith(".pi/"))).toBe(false);
    expect(readFileSync(join(editedRepo, SCOUT), "utf-8")).toBe(edited);
    expect(blocked.skipped.map((s) => s.path)).toContain(SCOUT);
    expect(readFileSync(join(editedRepo, ".pi/navori.json"), "utf-8")).not.toContain("controls");

    const result = renderPiEngine(dir, configFor(["pi"]));
    const status = (path: string) => result.written.find((w) => w.path === path)?.status;
    expect(status(".pi/navori.json")).toBe("updated");
    expect(status(".pi/extensions/navori.ts")).toBe("updated");
    expect(status(SCOUT)).toBe("updated");
    expect(status(".pi/agents/implementer.md")).toBe("updated");
    expect(status(".pi/agents/reviewer.md")).toBe("updated");
    expect(status("AGENTS.md")).toBe("created");
    expect(JSON.parse(readFileSync(join(dir, ".pi/navori.json"), "utf-8"))).toHaveProperty(
      "controls",
    );
    expect(existsSync(join(dir, ".pi/agents/scribe.md"))).toBe(false);
    // Idempotent once upgraded.
    expect(renderPiEngine(dir, configFor(["pi"])).written).toEqual([]);

    // A foreign file where the extension goes is a collision: preserved, not replaced.
    const collided = freshDir();
    mkdirSync(join(collided, ".pi/extensions"), { recursive: true });
    writeFileSync(join(collided, ".pi/extensions/navori.ts"), "// mine\n");
    const second = renderPiEngine(collided, configFor(["pi"]));
    expect(readFileSync(join(collided, ".pi/extensions/navori.ts"), "utf-8")).toBe("// mine\n");
    expect(second.skipped.map((s) => s.path)).toContain(".pi/extensions/navori.ts");
  });

  // Covers: R11
  it("disabling Pi prunes only owned .pi resources, with backup, and matches the dry run", () => {
    const dir = freshDir();
    setEngines(dir, ["pi"]);
    renderPiEngine(dir, configFor(["pi"]));
    const editedPath = join(dir, SCOUT);
    const edited = `${readFileSync(editedPath, "utf-8")}user note\n`;
    writeFileSync(editedPath, edited);
    writeFileSync(join(dir, ".pi/settings.json"), '{"mine":true}\n');
    writeFileSync(join(dir, ".pi/agents/mine.md"), "# my own agent\n");
    mkdirSync(join(dir, ".agents/skills/mine"), { recursive: true });
    writeFileSync(join(dir, ".agents/skills/mine/SKILL.md"), "my skill\n");

    setEngines(dir, ["cursor"]);
    const preview = prune(dir, true);
    expect(existsSync(join(dir, ".pi/navori.json"))).toBe(true);
    const planned = pruned(preview);
    expect(planned).toEqual(
      expect.arrayContaining([
        ".pi/navori.json",
        ".pi/extensions/navori.ts",
        ".pi/agents/implementer.md",
        ".pi/agents/reviewer.md",
        "AGENTS.md",
      ]),
    );

    const applied = prune(dir, false);
    expect(pruned(applied)).toEqual(planned);
    expect(applied.prunedBackupPath).toBeTruthy();
    for (const rel of planned) {
      expect(existsSync(join(dir, rel))).toBe(false);
      expect(existsSync(join(applied.prunedBackupPath!, rel))).toBe(true);
    }
    // Edited, foreign and user-owned content survives.
    expect(readFileSync(editedPath, "utf-8")).toBe(edited);
    expect(readFileSync(join(dir, ".pi/settings.json"), "utf-8")).toBe('{"mine":true}\n');
    expect(readFileSync(join(dir, ".pi/agents/mine.md"), "utf-8")).toBe("# my own agent\n");
    expect(readFileSync(join(dir, ".agents/skills/mine/SKILL.md"), "utf-8")).toBe("my skill\n");
    expect(applied.keptEngineOutputs).toEqual(
      expect.arrayContaining([
        { path: SCOUT, reason: "modified" },
        { path: ".pi/settings.json", reason: "foreign" },
      ]),
    );
  });

  // Covers: R11
  it("Pi+Codex to Codex keeps the Codex-owned skills and outputs byte for byte", () => {
    const dir = freshDir();
    setEngines(dir, ["codex", "pi"]);
    runRender(dir, { dryRun: false });
    const owned = [".agents", ".codex", "AGENTS.md"];
    const before = snapshot(dir, owned);
    expect(Object.keys(before).some((p) => p.startsWith(".agents/skills/"))).toBe(true);
    expect(existsSync(join(dir, ".pi/navori.json"))).toBe(true);

    setEngines(dir, ["codex"]);
    const applied = prune(dir, false);
    expect(applied.prunedEngineOutputs ?? []).not.toContainEqual(
      expect.stringMatching(/^(\.agents|\.codex|AGENTS\.md)/),
    );
    expect(snapshot(dir, owned)).toEqual(before);
    expect(existsSync(join(dir, ".pi/navori.json"))).toBe(false);
  });

  // Covers: R11
  it("Pi+Claude to Claude leaves the Claude outputs untouched", () => {
    const dir = freshDir();
    setEngines(dir, ["claude", "pi"]);
    runRender(dir, { dryRun: false });
    const owned = [".claude", "CLAUDE.md"];
    const before = snapshot(dir, owned);
    expect(Object.keys(before).length).toBeGreaterThan(0);

    setEngines(dir, ["claude"]);
    prune(dir, false);
    expect(snapshot(dir, owned)).toEqual(before);
    expect(existsSync(join(dir, ".pi/navori.json"))).toBe(false);
  });

  // Covers: R11
  it("reports completed and unfinished Pi paths when the commit fails midway", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "blocked"), "not a directory");
    expect(() =>
      commitWrites({
        pending: [
          {
            path: join(dir, ".pi/navori.json"),
            relPath: ".pi/navori.json",
            content: "{}\n",
            status: "created",
          },
          {
            path: join(dir, "blocked/second.json"),
            relPath: "blocked/second.json",
            content: "{}\n",
            status: "created",
          },
        ],
        removals: [],
        cwd: dir,
        engineLabel: "Pi Coding Agent",
      }),
    ).toThrow(/Completed: \.pi\/navori\.json; unfinished: blocked\/second\.json/);
  });
});
