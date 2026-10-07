import { describe, it, expect } from "vitest";
import type { NavoriConfig } from "../../../lib/config/config.ts";
import type { MonorepoWorkspace } from "../../../lib/workspace/monorepo.ts";
import type { PlannedSkill } from "../harness-plan.ts";
import { SKILL_LISTING_CHAR_CAP } from "../../../lib/assets/skill-meta.ts";
import {
  decideWorkspaceSkills,
  hoistTransform,
  isTrimmedHarness,
  workspaceSlug,
  workspaceSlugs,
  type DecideWorkspaceSkillsInput,
  type DecisionWorkspace,
  type SkillKind,
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

const KINDS: Record<string, SkillKind> = {
  "locate-code": "core",
  "review-diff": "core",
  "resolve-ticket": "workflow",
  "nextjs-app-router": "preset",
};

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
    kindOf: (s) => KINDS[s.id] ?? "library",
    rootHas: () => true,
    rootAuthorship: () => "absent",
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
    const decision = decideWorkspaceSkills(input({ mode: "full" }));
    expect([...decision.omitted.values()].every((ids) => ids.size === 0)).toBe(true);
    expect(decision.hoisted).toEqual([]);
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

// ---------------------------------------------------------------------------
// Rule 4 — `root`.
// ---------------------------------------------------------------------------

/** A `root`-mode input: each workspace carries its own `name`, so its bytes for a lib skill differ. */
function rootInput(
  names: Record<string, string>,
  over: Partial<DecideWorkspaceSkillsInput> = {},
): DecideWorkspaceSkillsInput {
  const own: DecideWorkspaceSkillsInput["render"] = (s, cfg) =>
    s.id === "vitest" || s.id === "nextjs-app-router" || s.id === "review-diff"
      ? `${s.id}:${cfg.name}`
      : s.id;
  const workspaces: DecisionWorkspace[] = Object.entries(names).map(([path, name]) => ({
    ws: { name: path.split("/").at(-1)!, path } as MonorepoWorkspace,
    config: { name } as unknown as NavoriConfig,
    skills: [skill("review-diff"), skill("vitest"), skill("nextjs-app-router")],
    presetLoaded: true,
  }));
  return {
    mode: "root",
    root: {
      config: { name: "root" } as unknown as NavoriConfig,
      skills: [skill("review-diff")],
      presetLoaded: true,
    },
    workspaces,
    render: own,
    kindOf: (sk) => KINDS[sk.id] ?? "library",
    rootHas: () => true,
    rootAuthorship: () => "absent",
    ...over,
  };
}

const hoistedIds = (i: DecideWorkspaceSkillsInput): string[] =>
  decideWorkspaceSkills(i)
    .hoisted.map((h) => h.id)
    .sort();

describe("decideWorkspaceSkills bajo `root` (spec 0043 T6)", () => {
  it("una core/workflow nunca se sube, aunque difiera", () => {
    // Covers: R5
    const i = rootInput({ "apps/api": "api", "apps/web": "web" });
    const decision = decideWorkspaceSkills(i);
    // `review-diff` renders differently per workspace and from the root: the root wins.
    expect(decision.hoisted.map((h) => h.source.id)).not.toContain("review-diff");
    expect(decision.hoisted.map((h) => h.id)).not.toContain("review-diff");
    expect(decision.omitted.get("apps/api")!.has("review-diff")).toBe(true);
    expect(decision.omitted.get("apps/web")!.has("review-diff")).toBe(true);
  });

  it("dos workspaces con bytes iguales suben una sola con el id original", () => {
    // Covers: R6
    const i = rootInput({ "apps/api": "same", "apps/web": "same" });
    expect(hoistedIds(i)).toEqual(["nextjs-app-router", "vitest"]);
    const decision = decideWorkspaceSkills(i);
    expect(decision.omitted.get("apps/api")!.has("vitest")).toBe(true);
    expect(decision.omitted.get("apps/web")!.has("vitest")).toBe(true);
    expect(decision.hoisted.every((h) => h.workspaceName === undefined)).toBe(true);
  });

  it("con bytes distintos, cada uno sube `slug-id`", () => {
    // Covers: R6
    const i = rootInput({ "apps/api": "api", "apps/web": "web" });
    expect(hoistedIds(i)).toEqual([
      "api-nextjs-app-router",
      "api-vitest",
      "web-nextjs-app-router",
      "web-vitest",
    ]);
    const decision = decideWorkspaceSkills(i);
    expect(decision.hoisted.find((h) => h.id === "api-vitest")?.workspaceName).toBe("api");
    expect([...decision.omitted.get("apps/api")!].sort()).toEqual([
      "nextjs-app-router",
      "review-diff",
      "vitest",
    ]);
  });

  it("si la raíz la planea distinta, el aporte va con `slug-id`", () => {
    // Covers: R6
    const base = rootInput({ "apps/api": "api" });
    const i = { ...base, root: { ...base.root, skills: [skill("review-diff"), skill("vitest")] } };
    // `vitest` has a root version with other bytes, so it is `slug-id`; the one the
    // root does not plan at all keeps its id.
    expect(hoistedIds(i)).toEqual(["api-vitest", "nextjs-app-router"]);
  });

  it("un destino de la raíz sin marcador va a `blocked` y no se omite del workspace", () => {
    // Covers: R6
    const i = rootInput(
      { "apps/api": "api" },
      { rootAuthorship: (name) => (name === "vitest" ? "foreign" : "absent") },
    );
    const decision = decideWorkspaceSkills(i);
    expect(decision.blocked).toEqual([{ workspace: "api", id: "vitest", reason: "foreign" }]);
    expect(decision.hoisted.map((h) => h.id)).toEqual(["nextjs-app-router"]);
    expect(decision.omitted.get("apps/api")!.has("vitest")).toBe(false);
    expect(decision.omitted.get("apps/api")!.has("nextjs-app-router")).toBe(true);
  });

  it("sin `rootHas(finalName)` no se omite", () => {
    // Covers: R6, R3
    // `--workspace`: no root is rendered, and the root does not have the hoisted dir.
    const i = rootInput(
      { "apps/api": "api" },
      { rootRendered: false, rootHas: (name) => name === "review-diff" },
    );
    const decision = decideWorkspaceSkills(i);
    expect(decision.hoisted.map((h) => h.id).sort()).toEqual(["nextjs-app-router", "vitest"]);
    expect([...decision.omitted.get("apps/api")!]).toEqual(["review-diff"]);
    // The same run with the root rendered first: the hoisted names will be there.
    const withRoot = decideWorkspaceSkills({ ...i, rootRendered: true });
    expect(withRoot.omitted.get("apps/api")!.has("vitest")).toBe(true);
  });

  it("reordenar `workspaces[]` no cambia nombres", () => {
    // Covers: R6
    const a = rootInput({ "apps/api": "api", "apps/web": "web" });
    const b = rootInput({ "apps/web": "web", "apps/api": "api" });
    expect(hoistedIds(a)).toEqual(hoistedIds(b));
  });

  it("`@moonar/backend` da `moonar-backend` y un choque de slug cae al `path`", () => {
    // Covers: R6
    const scoped = { name: "@moonar/backend", path: "apps/backend" } as MonorepoWorkspace;
    expect(workspaceSlug(scoped, [scoped])).toBe("moonar-backend");
    const a = { name: "web", path: "apps/web" } as MonorepoWorkspace;
    const b = { name: "Web", path: "services/web-api" } as MonorepoWorkspace;
    const slugs = workspaceSlugs([a, b]);
    expect(slugs.get("apps/web")).toBe("apps-web");
    expect(slugs.get("services/web-api")).toBe("services-web-api");
    // Even the path slugs collide: a numeric suffix, in `workspaces[]` order.
    const c = { name: "web", path: "apps/web" } as MonorepoWorkspace;
    const d = { name: "web", path: "apps_web" } as MonorepoWorkspace;
    expect([...workspaceSlugs([c, d]).values()]).toEqual(["apps-web-1", "apps-web-2"]);
  });

  it("la descripción reescrita no pasa el tope", () => {
    // Covers: R6
    const long = "x".repeat(SKILL_LISTING_CHAR_CAP);
    const rewrite = hoistTransform({
      id: "api-vitest",
      source: skill("vitest"),
      config: { name: "api" } as unknown as NavoriConfig,
      workspaceName: "api",
    })!;
    const out = rewrite(
      `---\nname: vitest\ndescription: ${long}\nmetadata:\n  type: reference\n---\n\nBody\n`,
    );
    expect(out).toContain("name: api-vitest");
    expect(out).toContain("description: [api] ");
    const description = out.match(/^description: (.*)$/m)![1]!;
    expect(description.length).toBeLessThanOrEqual(SKILL_LISTING_CHAR_CAP);
    expect(out).toContain("metadata:\n  type: reference");
    expect(out.endsWith("Body\n")).toBe(true);
    expect(
      hoistTransform({ id: "vitest", source: skill("vitest"), config: {} as NavoriConfig }),
    ).toBeUndefined();
  });

  it("`rootPruneCandidates` queda vacío si un preset no cargó", () => {
    // Covers: R5
    const i = rootInput({ "apps/api": "api" });
    expect(decideWorkspaceSkills(i).rootPruneCandidates.length).toBeGreaterThan(0);
    const broken = { ...i, workspaces: [{ ...i.workspaces[0]!, presetLoaded: false }] };
    expect(decideWorkspaceSkills(broken).rootPruneCandidates).toEqual([]);
    expect(
      decideWorkspaceSkills({ ...i, root: { ...i.root, presetLoaded: false } }).rootPruneCandidates,
    ).toEqual([]);
  });

  it("los candidatos a poda excluyen lo que esta corrida sube", () => {
    // Covers: R5
    const decision = decideWorkspaceSkills(rootInput({ "apps/api": "api" }));
    const names = decision.rootPruneCandidates.map((c) => c.id);
    // `vitest` is hoisted under its own id this run, so only its `slug-id` is a leftover candidate.
    expect(names).not.toContain("vitest");
    expect(names).toContain("api-vitest");
  });
});
