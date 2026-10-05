import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderNonClaudeEngines } from "../../../commands/render.ts";
import { commitWrites } from "../../shared/execute-plan.ts";
import { renderPiEngine } from "../index.ts";
import { ownsPiManifest, serializePiManifest } from "../owned-file.ts";

const dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-render-"));
  dirs.push(dir);
  return dir;
}
const config = NavoriConfigSchema.parse({
  name: "pi-test",
  preset: "custom",
  engines: ["pi"],
  branchBase: "main",
  qualityGate: { fast: "bun test", full: "bun test" },
});

afterEach(async () => {
  const { rmSync } = await import("node:fs");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Pi render base", () => {
  it.each([undefined, "dev"])(
    "renders the PR target independently from the main fork point: %s",
    (prTarget: string | undefined): void => {
      const cwd = freshDir();
      renderPiEngine(cwd, { ...config, prTarget });
      const target = prTarget ?? "main";
      const reviewer = readFileSync(join(cwd, ".pi/agents/reviewer.md"), "utf-8");
      const implementer = readFileSync(join(cwd, ".pi/agents/implementer.md"), "utf-8");
      expect(reviewer).toContain(`git fetch origin ${target} --quiet`);
      expect(reviewer).toContain(`HEAD..origin/${target}`);
      expect(reviewer).toContain(`git diff "origin/${target}"`);
      expect(
        reviewer.split(`navori receipt sign --feature <feature> --target ${target} `),
      ).toHaveLength(3);
      expect(reviewer).toContain(`--target ${target} --dir .navori/state/handoffs --json`);
      expect(implementer).toContain(`git diff --stat origin/${target}...HEAD`);
      expect(existsSync(join(cwd, ".pi/agents/publisher.md"))).toBe(false);
    },
  );

  // Covers: R6
  it("preserves dangling symlinks at the Pi root and managed destinations", () => {
    const root = freshDir();
    symlinkSync(join(root, "missing-pi"), join(root, ".pi"));
    expect(() => renderPiEngine(root, config)).toThrow(/parent is a symlink/);
    expect(lstatSync(join(root, ".pi")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, "missing-pi"))).toBe(false);

    const second = freshDir();
    mkdirSync(join(second, ".pi"));
    symlinkSync(join(second, "outside.json"), join(second, ".pi/navori.json"));
    const result = renderPiEngine(second, config);
    expect(result.skipped.some((entry) => entry.path === ".pi/navori.json")).toBe(true);
    expect(lstatSync(join(second, ".pi/navori.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(second, "outside.json"))).toBe(false);
  });

  // Covers: R1, R3
  it("leaves the shared skill root to Codex when both engines are configured", () => {
    const dir = freshDir();
    const both = { ...config, engines: ["codex", "pi"] as ("codex" | "pi")[] };
    expect(
      renderPiEngine(dir, both, { dryRun: true }).written.some((entry) =>
        entry.path.startsWith(".agents/skills/"),
      ),
    ).toBe(false);
  });

  // Covers: R1, R6
  it("registers Pi as opt-in and dry-runs the same destination without mutation", () => {
    const dir = freshDir();
    const preview = renderNonClaudeEngines(dir, config, ["pi"], true);
    expect(preview[0]?.written).toEqual(
      expect.arrayContaining([
        { path: ".pi/navori.json", status: "created" },
        { path: ".pi/extensions/navori.ts", status: "created" },
        { path: ".pi/agents/implementer.md", status: "created" },
        { path: ".pi/agents/reviewer.md", status: "created" },
        { path: ".pi/agents/scout.md", status: "created" },
      ]),
    );
    expect(
      preview[0]?.written.some(
        (entry) => entry.path === ".agents/skills/verify-before-done/SKILL.md",
      ),
    ).toBe(true);
    expect(existsSync(join(dir, ".pi/navori.json"))).toBe(false);
    const applied = renderNonClaudeEngines(dir, config, ["pi"], false);
    expect(applied[0]?.written).toEqual(preview[0]?.written);
    expect(ownsPiManifest(readFileSync(join(dir, ".pi/navori.json"), "utf-8"))).toBe(true);
    expect(renderPiEngine(dir, config).written).toEqual([]);
  });

  // Covers: R6
  it("preserves a colliding or edited manifest and never emits invalid JSON comments", () => {
    const dir = freshDir();
    const path = join(dir, ".pi/navori.json");
    renderPiEngine(dir, config);
    const original = readFileSync(path, "utf-8");
    expect(JSON.parse(original)).toHaveProperty("_navori.hash");
    expect(original).not.toContain("<!--");
    expect(original).not.toContain("// navori:");
    const edited = original.replace('"agents": [', '"agents": ["user", ');
    writeFileSync(path, edited);
    const result = renderPiEngine(dir, config);
    expect(result.written).toEqual([]);
    expect(result.skipped[0]?.status).toBe("user-modified-skipped");
    expect(readFileSync(path, "utf-8")).toBe(edited);
    expect(ownsPiManifest(original.replace('  "_navori"', '    "_navori"'))).toBe(false);
  });

  // Covers: R6
  it("backs up a valid previous manifest before replacing it", () => {
    const dir = freshDir();
    renderPiEngine(dir, config);
    const path = join(dir, ".pi/navori.json");
    const previous = serializePiManifest({ schemaVersion: 1, agents: ["scout"] });
    writeFileSync(path, previous);
    const result = renderPiEngine(dir, config);
    expect(result.written).toEqual([{ path: ".pi/navori.json", status: "updated" }]);
    expect(result.backupPath).not.toBeNull();
    expect(readFileSync(join(result.backupPath!, ".pi/navori.json"), "utf-8")).toBe(previous);
  });

  // Covers: R6
  it("serializes deterministically and rejects tampered ownership", () => {
    const a = serializePiManifest({ schemaVersion: 1, agents: ["reviewer", "scout"] });
    const b = serializePiManifest({ schemaVersion: 1, agents: ["scout", "reviewer"] });
    expect(a).toBe(b);
    expect(ownsPiManifest(a)).toBe(true);
    expect(ownsPiManifest(a.replace('"id": "pi-runtime"', '"id": "someone-else"'))).toBe(false);
  });

  // Covers: R18
  it("resolves navori:if markers in every rendered Pi agent", () => {
    const dir = freshDir();
    // `scribeOwnsMarkdown` on, so the agents carry the conditional spans that used to stay raw.
    renderNonClaudeEngines(
      dir,
      NavoriConfigSchema.parse({ ...config, harness: { scribeOwnsMarkdown: true } }),
      ["pi"],
      false,
    );
    const names = readdirSync(join(dir, ".pi/agents")).filter((f) => f.endsWith(".md"));
    expect(names.length).toBeGreaterThan(2);
    for (const name of names) {
      const body = readFileSync(join(dir, ".pi/agents", name), "utf-8");
      expect({ file: `.pi/agents/${name}`, raw: body.includes("navori:if") }).toEqual({
        file: `.pi/agents/${name}`,
        raw: false,
      });
    }
  });

  // Covers: R6
  it("reports completed and unfinished paths after a non-transactional commit failure", () => {
    const dir = freshDir();
    const first = join(dir, ".pi/first.json");
    const blocker = join(dir, "blocked");
    writeFileSync(blocker, "not a directory");
    expect(() =>
      commitWrites({
        pending: [
          { path: first, relPath: ".pi/first.json", content: "{}\n", status: "created" },
          {
            path: join(blocker, "second.json"),
            relPath: "blocked/second.json",
            content: "{}\n",
            status: "created",
          },
        ],
        removals: [],
        cwd: dir,
        engineLabel: "Pi Coding Agent",
      }),
    ).toThrow(/Completed: \.pi\/first\.json; unfinished: blocked\/second\.json/);
    expect(readFileSync(first, "utf-8")).toBe("{}\n");
  });
});
