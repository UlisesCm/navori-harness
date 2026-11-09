import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderAgentsMdEngine } from "../../agents-md/index.ts";
import { renderPiEngine } from "../index.ts";
import { serializePiManifest, serializePiOrchestrator } from "../owned-file.ts";
import { load } from "./fixtures/load-extension.ts";

/** Spec 0064: the orchestrator doctrine reaches the parent process only, and its absence is never silent. */
const ORCHESTRATOR = ".pi/navori/orchestrator.md";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { listed: boolean; file?: string }): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-pi-orchestrator-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, ".pi/navori"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi/navori.json"),
    serializePiManifest({
      schemaVersion: 2,
      agents: [],
      controls: { planTiers: false, masterPlan: false, scribeOwnsMarkdown: false },
      hooks: [],
      ownedPaths: options.listed ? [".pi/navori.json", ORCHESTRATOR] : [".pi/navori.json"],
      permissionRules: { ask: [], deny: [] },
    }),
  );
  if (options.file !== undefined) writeFileSync(join(cwd, ORCHESTRATOR), options.file);
  return cwd;
}

async function start(
  cwd: string,
  env: Record<string, string>,
): Promise<{ sections: Record<string, string>; notices: string[] }> {
  // A child process registers no before_agent_start handler at all: nothing can inject there.
  const handler = load({ env }).get("before_agent_start") ?? (() => undefined);
  const notices: string[] = [];
  const event = { messageType: "user", systemPromptOptions: { sections: { keep: "x" } } };
  const ctx = {
    cwd,
    ui: { notify: (message: string, type?: string) => notices.push(`${type}: ${message}`) },
  };
  await expect(Promise.resolve(handler(event, ctx))).resolves.not.toThrow();
  await handler(event, ctx);
  return { sections: event.systemPromptOptions.sections, notices };
}

describe("who carries the orchestrator layer with claude+pi+agents-md (spec 0064)", () => {
  const HEADINGS = [
    "## Planning tiers — classified, never chosen",
    "## Master plan — explicit request only",
    "## Session startup",
    "## Role: orchestrator",
  ];

  it("only the parent's file carries it; AGENTS.md, which children also read, has none", () => {
    const config = NavoriConfigSchema.parse({
      name: "orch",
      engines: ["claude", "pi", "agents-md"],
      preset: "custom",
      branchBase: "main",
      language: "en",
      harness: { planTiers: true, masterPlan: true },
    });
    const cwd = mkdtempSync(join(tmpdir(), "navori-pi-layer-"));
    dirs.push(cwd);
    renderPiEngine(cwd, config);
    renderAgentsMdEngine(cwd, config);

    const orchestrator = readFileSync(join(cwd, ORCHESTRATOR), "utf-8");
    const agents = readFileSync(join(cwd, "AGENTS.md"), "utf-8");
    for (const heading of HEADINGS) {
      expect(orchestrator, heading).toContain(heading);
      expect(agents, heading).not.toContain(heading);
    }
  });
});

describe("orchestrator doctrine injection (spec 0064)", () => {
  it("the parent gets the file body, without the ownership header, as a named section", async () => {
    const cwd = fixture({ listed: true, file: serializePiOrchestrator("## Orchestrator rules") });
    const { sections, notices } = await start(cwd, { NAVORI_PI_CHILD_DEPTH: "" });
    expect(sections).toEqual({ keep: "x", "navori-orchestrator": "## Orchestrator rules" });
    expect(notices).toEqual([]);
  });

  it("a child never gets it, nor a warning", async () => {
    const cwd = fixture({ listed: true, file: serializePiOrchestrator("## Orchestrator rules") });
    const { sections, notices } = await start(cwd, { NAVORI_PI_CHILD_DEPTH: "1" });
    expect(sections).toEqual({ keep: "x" });
    expect(notices).toEqual([]);
  });

  it("a missing file in the parent warns visibly once and neither throws nor adds a section", async () => {
    const cwd = fixture({ listed: true });
    const { sections, notices } = await start(cwd, { NAVORI_PI_CHILD_DEPTH: "" });
    expect(sections).toEqual({ keep: "x" });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^warning: .*\.pi\/navori\/orchestrator\.md.*navori render --apply/);
  });

  it("a symlinked file is treated as missing", async () => {
    const cwd = fixture({ listed: true });
    writeFileSync(join(cwd, "elsewhere.md"), serializePiOrchestrator("## Elsewhere"));
    symlinkSync(join(cwd, "elsewhere.md"), join(cwd, ORCHESTRATOR));
    const { sections, notices } = await start(cwd, { NAVORI_PI_CHILD_DEPTH: "" });
    expect(sections).toEqual({ keep: "x" });
    expect(notices).toHaveLength(1);
  });

  it("without a manifest entry (another engine owns AGENTS.md) nothing is injected or warned", async () => {
    const cwd = fixture({ listed: false });
    const { sections, notices } = await start(cwd, { NAVORI_PI_CHILD_DEPTH: "" });
    expect(sections).toEqual({ keep: "x" });
    expect(notices).toEqual([]);
  });
});
