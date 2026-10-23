import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as prompts from "@clack/prompts";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/config/schema.ts";
import {
  extractManagedContent,
  computeManagedHash,
  readMarkerAttrs,
  injectManagedSection,
} from "../../lib/render/marker.ts";
import { prepareCodexEngine, renderCodexEngine, planCodexSkills } from "../codex/index.ts";
import { OwnedPathInventory } from "../shared/owned-path-inventory.ts";
import { prepareRenderTarget } from "../../commands/render.ts";
import { prepareSyncApply, collectTargetConflicts, syncCommand } from "../../commands/sync.ts";
import { prepareClaudeEngine } from "../claude/index.ts";
import { preparePiEngine } from "../pi/index.ts";

vi.mock(import("@clack/prompts"), { spy: true });

let cwd: string;
beforeEach((): void => {
  cwd = mkdtempSync(join(tmpdir(), "codex-owned-"));
});
afterEach((): void => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

/** A single target with all script owners and plugin composition enabled. */
function mixedConfig(): NavoriConfig {
  return NavoriConfigSchema.parse({ ...config(), engines: ["claude", "codex", "pi"] });
}

/** Commit through the same seam used by root/workspace command orchestration. */
function renderMixed(cfg: NavoriConfig): void {
  const owner = prepareRenderTarget(cwd, cfg, cfg.engines, false);
  owner.finalize();
  owner.commit();
}

describe("T6 target ownership and sync preparation", (): void => {
  // Covers: R8
  it("retains the anti-rollback floor during late Pi context writes and clears it afterward", (): void => {
    const cfg = NavoriConfigSchema.parse({
      name: "floor-probe",
      preset: "custom",
      engines: ["pi"],
      harnessVersion: "999.0.0",
    });
    const meta = { version: "0.1.0", source: "@navori/core" };
    const before = injectManagedSection("", "navori-agents", "OLD", meta).output;
    const path = join(cwd, "AGENTS.md");
    writeFileSync(path, before);
    const owner = prepareSyncApply(
      [{ label: "root", cwd, repoRoot: cwd, config: cfg }],
      [],
      new Map(),
    );
    expect(readFileSync(path, "utf8")).toBe(before);
    owner.commit();
    expect(readFileSync(path, "utf8")).toBe(before);
    // The command must not leak one target's floor into the next render.
    expect(
      injectManagedSection(before, "navori-agents", "NEW", { ...meta, version: "0.2.0" }).status,
    ).toBe("updated");
  });

  // Covers: R8
  it("finalizes all three guards with one exact union before the first engine writes", (): void => {
    const cfg = mixedConfig();
    const owner = prepareRenderTarget(cwd, cfg, cfg.engines, false);
    expect(readdirSync(cwd)).toEqual([]);
    expect(() => owner.commit()).toThrow("finalized");
    const plans = owner.finalize();
    expect(readdirSync(cwd)).toEqual([]);
    const sealed = owner.inventory.requireSealed();
    for (const path of [
      "CLAUDE.md",
      "AGENTS.md",
      ".pi/agents/implementer.md",
      ".codex/agents/implementer.toml",
    ])
      expect(sealed.paths).toContain(path);
    const guards = plans
      .flatMap((plan) => plan.pending)
      .filter((write) => write.relPath.endsWith("/guard-destructive.sh"));
    expect(guards).toHaveLength(3);
    for (const guard of guards) expectGuard(guard.content, sealed.value);
    owner.commit();
    for (const guard of guards) expect(readFileSync(guard.path, "utf-8")).toBe(guard.content);
  });

  // Covers: R8
  it("keeps direct owners effect-free until sealed and retains mixed plugin targets", (): void => {
    const inventory = new OwnedPathInventory();
    const cfg = mixedConfig();
    const claude = prepareClaudeEngine(cwd, cfg, { inventory });
    const pi = preparePiEngine(cwd, cfg, { inventory });
    expect(() => claude.finalize()).toThrow("not sealed");
    expect(() => pi.finalize()).toThrow("not sealed");
    expect(readdirSync(cwd)).toEqual([]);
    inventory.seal();
    for (const owner of [claude, pi]) {
      const guard = owner
        .finalize()
        .pending.find((write) => write.relPath.endsWith("/guard-destructive.sh"))!;
      expectGuard(guard.content, inventory.requireSealed().value);
      expect(guard.content).toContain('id="tgrep-search-lane"');
    }
  });

  // Covers: R8
  it("does not commit Claude if a later Pi destination changed after selection", (): void => {
    const cfg = mixedConfig();
    const owner = prepareRenderTarget(cwd, cfg, cfg.engines, false);
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi/navori.json"), "User collision\n");
    expect(() => owner.finalize()).toThrow("Prepared destination changed");
    expect(() => owner.commit()).toThrow("finalized");
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(cwd, ".codex"))).toBe(false);
  });

  // Covers: R8
  it("registers the single eligible Pi context writer and excludes vetoed new resources", (): void => {
    const cfg = NavoriConfigSchema.parse({ ...config(), engines: ["pi"] });
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi/navori.json"), "User manifest\n");
    const owner = preparePiEngine(cwd, cfg);
    const paths = owner.inventory.seal().paths;
    expect(paths).toContain("AGENTS.md");
    expect(paths).not.toContain(".pi/navori.json");
    expect(paths).not.toContain(".pi/extensions/navori.ts");
    owner.finalize();
    owner.commit();
    expect(existsSync(join(cwd, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".pi/extensions/navori.ts"))).toBe(false);
    expect(readFileSync(join(cwd, ".pi/navori.json"), "utf-8")).toBe("User manifest\n");
  });

  // Covers: R8
  it("keeps edited Pi whole files protected while vetoing their generation", (): void => {
    const cfg = mixedConfig();
    renderMixed(cfg);
    const manifest = join(cwd, ".pi/navori.json");
    const edited = readFileSync(manifest, "utf-8").replace('"agents":', '"changedAgents":');
    writeFileSync(manifest, edited);
    const owner = prepareRenderTarget(cwd, cfg, cfg.engines, false);
    const plans = owner.finalize();
    expect(owner.inventory.requireSealed().paths).toContain(".pi/navori.json");
    expect(
      plans.flatMap((plan) => plan.pending).some((write) => write.relPath === ".pi/navori.json"),
    ).toBe(false);
    owner.commit();
    expect(readFileSync(manifest, "utf-8")).toBe(edited);
  });

  // Covers: R8
  it("refuses stale accepted preview bytes before any forced or ordinary write", (): void => {
    const cfg = mixedConfig();
    renderMixed(cfg);
    const guard = join(cwd, GUARD);
    writeFileSync(
      guard,
      readFileSync(guard, "utf-8").replace("nv_owned_paths=", "nv_edited_paths="),
    );
    const target = { cwd, config: cfg, repoRoot: cwd, label: "root" };
    const preview = prepareRenderTarget(cwd, cfg, cfg.engines, true);
    preview.finalize();
    const result = preview.commit();
    const conflicts = collectTargetConflicts({
      target,
      claude: result.claude,
      engines: result.extraEngines,
    });
    const accepted = conflicts.filter(
      (
        conflict,
      ): conflict is typeof conflict & { resolution: NonNullable<typeof conflict.resolution> } =>
        conflict.resolution !== undefined,
    );
    expect(accepted).toHaveLength(1);
    writeFileSync(guard, "Changed after preview\n");
    expect(() => prepareSyncApply([target], accepted, new Map())).toThrow("changed since preview");
    expect(readFileSync(guard, "utf-8")).toBe("Changed after preview\n");
  });

  // Covers: R8
  it.each([false, true])(
    "seals accepted acquisitions before the first guard write (interactive=%s)",
    async (interactive): Promise<void> => {
      const cfg = mixedConfig();
      renderMixed(cfg);
      const scriptRel = ".claude/scripts/guard-search-routing.sh";
      const script = join(cwd, scriptRel);
      writeFileSync(script, "User script without markers\n");
      const guardPath = join(cwd, GUARD);
      writeFileSync(
        guardPath,
        readFileSync(guardPath, "utf-8").replace("nv_owned_paths=", "nv_edited_paths="),
      );
      writeFileSync(join(cwd, "navori.config.json"), JSON.stringify(cfg));
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(prompts, "select").mockResolvedValue("accept");
      vi.spyOn(prompts, "confirm").mockResolvedValue(true);
      vi.spyOn(prompts.log, "message").mockImplementation(() => {});
      vi.spyOn(prompts.log, "warn").mockImplementation(() => {});
      await syncCommand.run?.({
        rawArgs: [],
        cmd: syncCommand,
        args: {
          _: [],
          cwd,
          ...(interactive
            ? { interactive: true }
            : { json: true, apply: true, "accept-new-files": true }),
        },
      } as unknown as Parameters<NonNullable<typeof syncCommand.run>>[0]);
      const content = readFileSync(guardPath, "utf-8");
      const body = extractManagedContent(content, "guard-destructive-base", "shell")!;
      expect(body).toContain("nv_owned_paths='");
      expect(body.includes(`\n${scriptRel}\n`)).toBe(interactive);
      expect(content).toContain('id="tgrep-search-lane"');
      expect(readMarkerAttrs(content, "guard-destructive-base", "shell")?.existingHash).toBe(
        computeManagedHash(body),
      );
      expect(readFileSync(script, "utf-8").includes("User script without markers")).toBe(
        !interactive,
      );
    },
  );
});

function config(): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "owned-paths",
    engines: ["codex"],
    preset: "custom",
    plugins: { engram: { enabled: true }, tgrep: { enabled: true } },
    qualityGate: { fast: "true", full: "true" },
  });
}

const GUARD = ".codex/hooks/guard-destructive.sh";

/** Check the base hash independently from plugin sub-block composition. */
function expectGuard(content: string, value: string): void {
  const body = extractManagedContent(content, "guard-destructive-base", "shell");
  expect(body).not.toBeNull();
  expect(body).toContain(`nv_owned_paths='${value}'`);
  expect(readMarkerAttrs(content, "guard-destructive-base", "shell")?.existingHash).toBe(
    computeManagedHash(body!),
  );
  expect(content).not.toContain("{{shq:navoriOwnedPaths}}");
}

describe("Codex owned destination owner seam", (): void => {
  // Covers: R8
  it("requires sealing and finalization before any write and composes the full shared union", (): void => {
    const inventory = new OwnedPathInventory();
    const prepared = prepareCodexEngine(cwd, config(), { inventory });
    expect(readdirSync(cwd)).toEqual([]);
    expect(() => prepared.commit()).toThrow("finalized");
    expect(() => prepared.finalize()).toThrow("not sealed");
    inventory.observe(".pi/extensions/navori.ts", "missing");
    inventory.observe("foreign.txt", "foreign");
    const sealed = inventory.seal();
    const final = prepared.finalize();
    expect(prepared.finalize()).toBe(final);
    expect(readdirSync(cwd)).toEqual([]);
    const guard = final.pending.find((write) => write.relPath === GUARD)!;
    expectGuard(guard.content, sealed.value);
    expect(guard.content).toContain('id="tgrep-search-lane"');
    expect(sealed.paths).toContain(".pi/extensions/navori.ts");
    expect(sealed.paths).toContain(".codex/scripts/guard-search-routing.sh");
    expect(sealed.paths).not.toContain("foreign.txt");
    expect(() => inventory.observe("late", "missing")).toThrow("sealed");
    prepared.commit();
    expect(readFileSync(join(cwd, GUARD), "utf-8")).toBe(guard.content);
  });

  // Covers: R8
  it("keeps direct preview effect-free and direct render stable on the second invocation", (): void => {
    const cfg = config();
    const preview = renderCodexEngine(cwd, cfg, { dryRun: true });
    expect(preview.written.length).toBeGreaterThan(0);
    expect(readdirSync(cwd)).toEqual([]);
    renderCodexEngine(cwd, cfg);
    const prepared = prepareCodexEngine(cwd, cfg);
    const sealed = prepared.inventory.seal();
    prepared.finalize();
    expectGuard(readFileSync(join(cwd, GUARD), "utf-8"), sealed.value);
    expect(prepared.commit().written).toEqual([]);
    expect(renderCodexEngine(cwd, cfg, { dryRun: true }).written).toEqual([]);
  });

  // Covers: R8
  it("retains main and hoisted placements, user-skill decisions and foreign exclusions", (): void => {
    const cfg = config();
    const source = planCodexSkills(cwd, cfg, { repoRoot: cwd }).skills[0]!;
    cfg.project = NavoriConfigSchema.parse({
      ...cfg,
      project: { localSkills: ["local", "foreign"] },
    }).project;
    for (const id of ["local", "foreign"]) {
      mkdirSync(join(cwd, `.claude/skills/${id}`), { recursive: true });
      writeFileSync(
        join(cwd, `.claude/skills/${id}/SKILL.md`),
        "---\nname: local\ndescription: local\n---\nLocal source\n",
      );
    }
    mkdirSync(join(cwd, ".agents/skills/foreign"), { recursive: true });
    writeFileSync(join(cwd, ".agents/skills/foreign/SKILL.md"), "User owned\n");
    mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
    writeFileSync(join(cwd, ".codex/agents/reviewer.toml"), 'name = "reviewer"\n');
    const prepared = prepareCodexEngine(cwd, cfg, {
      rootHoist: { skills: [{ id: "workspace-copy", source, config: cfg }], pruneCandidates: [] },
    });
    const paths = prepared.inventory.seal().paths;
    expect(paths).toContain(".agents/skills/workspace-copy/SKILL.md");
    expect(paths).toContain(".agents/skills/local/SKILL.md");
    expect(paths).not.toContain(".agents/skills/foreign/SKILL.md");
    expect(paths).not.toContain(".codex/agents/reviewer.toml");
    const final = prepared.finalize();
    expectGuard(final.pending.find((write) => write.relPath === GUARD)!.content, paths.join("\n"));
    expect(existsSync(join(cwd, ".agents/skills/workspace-copy"))).toBe(false);
  });

  // Covers: R8
  it("includes edited and newer owned blocks without granting overwrite permission", (): void => {
    const cfg = config();
    renderCodexEngine(cwd, cfg);
    const guardPath = join(cwd, GUARD);
    const edited = readFileSync(guardPath, "utf-8").replace("nv_owned_paths=", "nv_edited_paths=");
    writeFileSync(guardPath, edited);
    const configPath = join(cwd, ".codex/config.toml");
    writeFileSync(
      configPath,
      readFileSync(configPath, "utf-8")
        .replace(/version="[^"]+"/, 'version="999.0.0"')
        .replace("[features]", "# changed\n[features]"),
    );
    const prepared = prepareCodexEngine(cwd, cfg);
    const sealed = prepared.inventory.seal();
    expect(sealed.paths).toContain(GUARD);
    expect(sealed.paths).toContain(".codex/config.toml");
    const final = prepared.finalize();
    expect(final.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: GUARD, status: "user-modified-skipped" }),
        expect.objectContaining({ path: ".codex/config.toml", status: "downgrade-skipped" }),
      ]),
    );
    const resolution = final.skipped.find((skip) => skip.path === GUARD)?.resolution;
    expect(resolution).toBeDefined();
    expectGuard(resolution!.content, sealed.value);
    prepared.commit();
    expect(readFileSync(guardPath, "utf-8")).toBe(edited);
  });

  // Covers: R8
  it("retains workspace omissions and does not select root scripts or local pointers", (): void => {
    const cfg = config();
    const omitted = new Set(
      planCodexSkills(cwd, cfg, { repoRoot: cwd }).skills.map((skill) => skill.id),
    );
    const prepared = prepareCodexEngine(cwd, cfg, {
      repoRoot: join(cwd, ".."),
      harnessScope: "root",
      workspaceSkills: { omitted, prune: false },
    });
    expect(prepared.inventory.seal().paths).toEqual(["AGENTS.md"]);
    prepared.finalize();
    expect(readdirSync(cwd)).toEqual([]);
    prepared.commit();
    expect(readdirSync(cwd)).toEqual(["AGENTS.md"]);
  });

  // Covers: R8
  it("rejects a changed hoisted basis without writing any main plan", (): void => {
    const cfg = config();
    const source = planCodexSkills(cwd, cfg, { repoRoot: cwd }).skills[0]!;
    const prepared = prepareCodexEngine(cwd, cfg, {
      rootHoist: { skills: [{ id: "workspace-copy", source, config: cfg }], pruneCandidates: [] },
    });
    mkdirSync(join(cwd, ".agents/skills/workspace-copy"), { recursive: true });
    writeFileSync(join(cwd, ".agents/skills/workspace-copy/SKILL.md"), "Changed\n");
    prepared.inventory.seal();
    expect(() => prepared.finalize()).toThrow("Prepared destination changed");
    expect(() => prepared.commit()).toThrow("finalized");
    expect(existsSync(join(cwd, ".codex"))).toBe(false);
  });
});
