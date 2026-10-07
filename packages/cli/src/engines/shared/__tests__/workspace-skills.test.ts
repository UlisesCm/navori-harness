import { describe, it, expect } from "vitest";
import type { NavoriConfig } from "../../../lib/config/config.ts";
import type { MonorepoWorkspace } from "../../../lib/workspace/monorepo.ts";
import type { PlannedSkill } from "../harness-plan.ts";
import {
  decideWorkspaceSkills,
  isTrimmedHarness,
  type DecideWorkspaceSkillsInput,
  type DecisionWorkspace,
} from "../workspace-skills.ts";

/**
 * Spec 0043 — the pure decision of which skills a workspace does not write.
 * Bytes are faked from the id and the config's gate, so each case isolates one
 * rule of the decision.
 */

const skill = (id: string): PlannedSkill => ({ id, assetPath: `/assets/${id}.md`, managedId: id });
const config = (gate: string): NavoriConfig =>
  ({ name: "demo", qualityGate: { fast: gate } }) as unknown as NavoriConfig;
const ws = (path: string): MonorepoWorkspace => ({ name: path, path }) as MonorepoWorkspace;

/** `vitest` interpolates the gate; every other skill renders the same anywhere. */
const render: DecideWorkspaceSkillsInput["render"] = (s, cfg) =>
  s.id === "vitest" ? `${s.id}:${cfg.qualityGate?.fast}` : s.id;

function input(over: Partial<DecideWorkspaceSkillsInput> = {}): DecideWorkspaceSkillsInput {
  const workspace: DecisionWorkspace = {
    ws: ws("apps/api"),
    config: config("root-gate"),
    skills: [skill("locate-code"), skill("vitest")],
    presetLoaded: true,
  };
  return {
    mode: "minimal",
    root: {
      config: config("root-gate"),
      skills: [skill("locate-code"), skill("vitest")],
      presetLoaded: true,
    },
    workspaces: [workspace],
    render,
    rootHas: () => true,
    ...over,
  };
}

const omittedOf = (i: DecideWorkspaceSkillsInput, path = "apps/api"): string[] =>
  [...(decideWorkspaceSkills(i).omitted.get(path) ?? [])].sort();

describe("decideWorkspaceSkills (spec 0043)", () => {
  it("omite la de bytes iguales a la raíz", () => {
    // Covers: R2
    expect(omittedOf(input())).toEqual(["locate-code", "vitest"]);
  });

  it("conserva la que interpola un `qualityGate` sobrescrito", () => {
    // Covers: R2
    const i = input();
    const own = { ...i.workspaces[0]!, config: config("own-gate") };
    expect(omittedOf({ ...i, workspaces: [own] })).toEqual(["locate-code"]);
  });

  it("conserva la que la raíz no planea", () => {
    // Covers: R2
    const i = input();
    const rootWithout = { ...i.root, skills: [skill("locate-code")] };
    expect(omittedOf({ ...i, root: rootWithout })).toEqual(["locate-code"]);
  });

  it("no omite si `rootHas` es falso", () => {
    // Covers: R2, R3
    expect(omittedOf(input({ rootHas: () => false }))).toEqual([]);
    expect(omittedOf(input({ rootHas: (name) => name === "locate-code" }))).toEqual([
      "locate-code",
    ]);
  });

  it("no omite nada si un preset no cargó", () => {
    // Covers: R2
    const i = input();
    expect(omittedOf({ ...i, workspaces: [{ ...i.workspaces[0]!, presetLoaded: false }] })).toEqual(
      [],
    );
    expect(omittedOf({ ...i, root: { ...i.root, presetLoaded: false } })).toEqual([]);
  });

  it("bajo `full` no omite nada", () => {
    // Covers: R2
    expect(decideWorkspaceSkills(input({ mode: "full" })).omitted.size).toBe(0);
  });

  it("decide cada workspace por separado", () => {
    // Covers: R2
    const i = input();
    const other: DecisionWorkspace = {
      ws: ws("apps/web"),
      config: config("web-gate"),
      skills: [skill("locate-code"), skill("vitest")],
      presetLoaded: true,
    };
    const decision = decideWorkspaceSkills({ ...i, workspaces: [...i.workspaces, other] });
    expect([...decision.omitted.get("apps/api")!].sort()).toEqual(["locate-code", "vitest"]);
    expect([...decision.omitted.get("apps/web")!]).toEqual(["locate-code"]);
  });
});

describe("isTrimmedHarness (spec 0043)", () => {
  it("`minimal` y `root` recortan; `full` no", () => {
    // Covers: R10
    expect(isTrimmedHarness("minimal")).toBe(true);
    expect(isTrimmedHarness("root")).toBe(true);
    expect(isTrimmedHarness("full")).toBe(false);
  });
});
