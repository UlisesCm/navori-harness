import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "smol-toml";
import { afterEach, describe, expect, it } from "vitest";
import { renderCodexEngine } from "../index.ts";
import { renderClaudeEngine } from "../../claude/index.ts";
import { renderPiEngine } from "../../pi/index.ts";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { projectCodexProfiles } from "../../../lib/assets/model-profile.ts";

const dirs: string[] = [];
function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-profile-render-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, ".codex/agents"), { recursive: true });
  return cwd;
}
function read(cwd: string, path: string): string {
  return readFileSync(join(cwd, path), "utf-8");
}
const config = () =>
  NavoriConfigSchema.parse({
    name: "fixture",
    engines: ["codex"],
    preset: "custom",
    plugins: {},
    models: { orchestrator: "opus", implementer: "sonnet" },
    effort: { orchestrator: "medium", implementer: "medium" },
  });
afterEach(() => {
  for (const cwd of dirs.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("Codex profile rendering (Spec 0050 M4)", () => {
  // Covers: R9, R11, R12, R14, R16
  it("every-enabled-main-core-extra-local uses one projection and exact native identity", () => {
    const cwd = fixture();
    const preset = join(cwd, ".navori/presets/profile-fixture");
    mkdirSync(preset, { recursive: true });
    writeFileSync(
      join(preset, "profile-fixture.json"),
      JSON.stringify({
        id: "profile-fixture",
        displayName: "fixture",
        extras: {
          agents: [
            { id: "extra-agent", relPath: "extra.txt", destRelPath: "agents/extra-agent.md" },
            {
              id: "disabled-extra",
              relPath: "extra.txt",
              destRelPath: "agents/disabled.md",
              condition: "project.never",
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(preset, "extra.txt"),
      '---\nname: extra-agent\ndescription: Extra\nmodel: sonnet\neffort: medium\n---\n<!-- navori:managed id="extra-agent" -->\nExtra instructions.\n<!-- /navori:managed id="extra-agent" -->\n',
    );
    const local =
      'name = "native-local"\nmodel = "gpt-8-sol"\nmodel_reasoning_effort = "low"\ndeveloper_instructions = "User content"\n';
    writeFileSync(join(cwd, ".codex/agents/unrelated-filename.toml"), local);
    const cfg = { ...config(), preset: "profile-fixture" };
    renderCodexEngine(cwd, cfg);
    const rows = projectCodexProfiles(cwd, cfg, { catalogPath: null });
    expect(rows.map((row) => row.nativeName)).toEqual(
      expect.arrayContaining(["orchestrator", "implementer", "extra-agent", "native-local"]),
    );
    expect(rows.some((row) => row.nativeName === "disabled-extra")).toBe(false);
    expect(rows.find((row) => row.nativeName === "extra-agent")).toMatchObject({
      origin: "extra",
      role: null,
      model: { wouldRender: "gpt-6-luna" },
      effort: { wouldRender: "high" },
      rendered: { model: "gpt-6-luna", effort: "high" },
      observed: null,
    });
    expect(rows.find((row) => row.nativeName === "orchestrator")).toMatchObject({
      scope: "principal",
      hostOwned: true,
      rendered: { model: "gpt-6-sol", effort: "medium" },
      observed: null,
    });
    expect(read(cwd, ".codex/agents/unrelated-filename.toml")).toBe(local);
    expect(rows.find((row) => row.nativeName === "native-local")).toMatchObject({
      origin: "local",
      role: null,
      path: ".codex/agents/unrelated-filename.toml",
      model: { configured: "gpt-8-sol", wouldRender: "gpt-8-sol" },
    });
  });

  // Covers: R11, R12, R14, R16
  it("explicit-inheritance and configured-not-observed stay separate from rendered absence", () => {
    const cwd = fixture();
    const cfg = config();
    const before = projectCodexProfiles(cwd, cfg, { catalogPath: null });
    expect(before.find((row) => row.nativeName === "implementer")).toMatchObject({
      model: { configured: "sonnet", wouldRender: "gpt-6-luna" },
      rendered: null,
      observed: null,
    });
    renderCodexEngine(cwd, cfg);
    const inherited = projectCodexProfiles(cwd, cfg, { catalogPath: null }).find(
      (row) => row.nativeName === "reviewer",
    );
    expect(inherited).toMatchObject({
      model: { origin: "inherited", wouldRender: null },
      effort: { origin: "inherited", wouldRender: null },
      rendered: { model: null, effort: null },
      observed: null,
      application: { status: "pending" },
    });
    const main = parse(read(cwd, ".codex/config.toml"));
    expect(main.model).toBe("gpt-6-sol");
    expect(main.model_reasoning_effort).toBe("medium");
  });

  // Covers: R11, R16
  it("user-global-trust-preservation keeps local pins, outside managed content and newer main", () => {
    const cwd = fixture();
    const home = fixture();
    const global = 'model = "user-global-model"\n[projects.fixture]\ntrust_level = "trusted"\n';
    writeFileSync(join(home, ".codex/config.toml"), global);
    const cfg = config();
    renderCodexEngine(cwd, cfg);
    const project = read(cwd, ".codex/config.toml");
    writeFileSync(
      join(cwd, ".codex/config.toml"),
      project.replace('model = "gpt-6-sol"', 'model = "gpt-99-sol"') +
        '\n[projects.user]\ntrust_level = "untrusted"\n',
    );
    const pinned = 'name = "local-pin"\nmodel = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\n';
    writeFileSync(join(cwd, ".codex/agents/local.toml"), pinned);
    cfg.models = {
      ...cfg.models,
      codexProfiles: { "local-pin": { model: "gpt-8-luna", effort: "high" } },
    };
    renderCodexEngine(cwd, cfg);
    expect(read(cwd, ".codex/agents/local.toml")).toBe(pinned);
    expect(read(home, ".codex/config.toml")).toBe(global);
    expect(read(cwd, ".codex/config.toml")).toContain('model = "gpt-99-sol"');
    expect(read(cwd, ".codex/config.toml")).toContain('[projects.user]\ntrust_level = "untrusted"');
    const row = projectCodexProfiles(cwd, cfg, { catalogPath: null }).find(
      (item) => item.nativeName === "local-pin",
    );
    expect(row?.model.wouldRender).toBe("gpt-5.6-sol");
    expect(row?.diagnostics).toContain(
      "local model conflicts with project override; human decision required",
    );
    expect(row?.application.status).toBe("pending");
  });

  // Covers: R12, R16
  it("diagnoses collisions, malformed entries, unknown overrides and project escapes without reading external bytes", () => {
    const cwd = fixture();
    const external = fixture();
    writeFileSync(
      join(external, "secret.toml"),
      'name = "external-secret"\nmodel = "sensitive-content"\n',
    );
    symlinkSync(join(external, "secret.toml"), join(cwd, ".codex/agents/escape.toml"));
    writeFileSync(join(cwd, ".codex/agents/one.toml"), 'name = "duplicate"\n');
    writeFileSync(join(cwd, ".codex/agents/two.toml"), 'name = "duplicate"\n');
    writeFileSync(join(cwd, ".codex/agents/bad.toml"), 'name = "PII-private-value"\ninvalid = [');
    const cfg = config();
    cfg.models = { ...cfg.models, codexProfiles: { absent: { effort: "low" } } };
    const rows = projectCodexProfiles(cwd, cfg, { catalogPath: null });
    expect(rows.filter((row) => row.nativeName === "duplicate")).toHaveLength(2);
    expect(
      rows
        .filter((row) => row.nativeName === "duplicate")
        .every((row) => row.diagnostics.includes("duplicate native name: duplicate")),
    ).toBe(true);
    expect(rows.flatMap((row) => row.diagnostics)).toContain("native path escapes project");
    expect(JSON.stringify(rows)).not.toMatch(/external-secret|sensitive-content|PII-private-value/);
    expect(rows[0]?.diagnostics).toContain("override for unknown native name: absent");
  });

  // Covers: R11, R12, R14, R16
  it("renders independent native overrides and preserves user-owned main fields", () => {
    const cwd = fixture();
    const cfg = config();
    cfg.models = {
      ...cfg.models,
      codexProfiles: {
        orchestrator: { model: "gpt-5.6-luna", effort: "low" },
        implementer: { model: "gpt-8-sol" },
      },
    };
    renderCodexEngine(cwd, cfg);
    expect(parse(read(cwd, ".codex/config.toml"))).toMatchObject({
      model: "gpt-5.6-luna",
      model_reasoning_effort: "low",
    });
    expect(parse(read(cwd, ".codex/agents/implementer.toml"))).toMatchObject({
      model: "gpt-8-sol",
      model_reasoning_effort: "high",
    });
    const project = read(cwd, ".codex/config.toml");
    // Move main intent out of its managed block to represent user ownership.
    const user = project
      .replace('model = "gpt-5.6-luna"\n', "")
      .replace('model_reasoning_effort = "low"\n', "");
    writeFileSync(
      join(cwd, ".codex/config.toml"),
      'model = "user-main-pin"\nmodel_reasoning_effort = "max"\n' + user,
    );
    renderCodexEngine(cwd, cfg);
    expect(parse(read(cwd, ".codex/config.toml"))).toMatchObject({
      model: "user-main-pin",
      model_reasoning_effort: "max",
    });
    const row = projectCodexProfiles(cwd, cfg, { catalogPath: null })[0];
    expect(row?.model.wouldRender).toBe("gpt-5.6-luna");
    expect(row?.rendered?.model).toBe("user-main-pin");
    expect(row?.diagnostics).toContain(
      "user-owned main profile preserved; project intent requires a human decision",
    );
    expect(row?.observed).toBeNull();
  });

  // Covers: R12, R16
  it("keeps same-path user agents and diagnoses stale disabled managed agents", () => {
    const cwd = fixture();
    const cfg = config();
    renderCodexEngine(cwd, cfg);
    cfg.harness = { ...cfg.harness, auditor: false } as typeof cfg.harness;
    const user = 'name = "implementer"\nmodel = "gpt-5.6-sol"\ndeveloper_instructions = "user"\n';
    writeFileSync(join(cwd, ".codex/agents/implementer.toml"), user);
    const before = projectCodexProfiles(cwd, cfg, { catalogPath: null });
    expect(
      before
        .filter((row) => row.nativeName === "implementer")
        .every((row) => row.diagnostics.includes("duplicate native name: implementer")),
    ).toBe(true);
    expect(before.some((row) => row.nativeName === "auditor")).toBe(false);
    expect(before[0]?.diagnostics).toContain(
      "disabled or unplanned managed native agent: .codex/agents/auditor.toml",
    );
    renderCodexEngine(cwd, cfg);
    expect(read(cwd, ".codex/agents/implementer.toml")).toBe(user);
  });

  // Covers: R9, R11, R16
  it("keeps Claude and Pi profiles unchanged with Codex-only named effort overrides", () => {
    const cwd = fixture();
    const cfg = config();
    cfg.engines = ["claude", "pi"];
    cfg.models = {
      ...cfg.models,
      codexMap: { sonnet: "astra" },
      piMap: { sonnet: "anthropic/claude-sonnet-5-5" },
      codexProfiles: { implementer: { model: "gpt-9-luna", effort: "low" } },
    };
    renderClaudeEngine(cwd, cfg);
    expect(read(cwd, ".claude/agents/implementer.md")).toContain("model: sonnet");
    expect(read(cwd, ".claude/agents/implementer.md")).toContain("effort: medium");
    renderPiEngine(cwd, cfg);
    const pi = read(cwd, ".pi/agents/implementer.md");
    expect(pi).toContain('model: "anthropic/claude-sonnet-5-5"');
    expect(pi).not.toContain("astra");
    expect(pi).not.toContain("gpt-9-luna");
    expect(pi).not.toContain("thinking: high");
  });
});
