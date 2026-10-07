import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { NavoriConfig } from "../../../lib/config/config.ts";
import type { MonorepoRenderContext } from "../../../lib/workspace/monorepo.ts";
import { extractManagedContent } from "../../../lib/render/marker.ts";
import type { HoistedSkill } from "../../shared/workspace-skills.ts";
import { planClaudeSkills, renderClaudeEngine } from "../index.ts";

/**
 * Spec 0043 T7/T8 — `workspaceHarness: "root"` in the Claude engine: the
 * workspace keeps its context file and nothing else, and the root writes what
 * the workspaces hand up.
 */

const ROOT_CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
  project: { posture: "production" },
} as unknown as NavoriConfig;

let root: string;
let ws: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "navori-root-scope-"));
  ws = join(root, "apps/web");
  mkdirSync(ws, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Every file under `dir`, relative to it, sorted. */
function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.sort();
}

const wsConfig = (over: Partial<NavoriConfig> = {}): NavoriConfig =>
  ({ ...ROOT_CONFIG, preset: "nextjs", ...over }) as unknown as NavoriConfig;

const context = (over: Partial<MonorepoRenderContext> = {}): MonorepoRenderContext => ({
  tool: "turbo",
  currentName: "web",
  currentPath: "apps/web",
  siblings: [],
  rootQualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
  ...over,
});

const contextFile = (): string => readFileSync(join(ws, "CLAUDE.md"), "utf-8");

/** The workspace under `root` with every planned skill handed up to the root. */
function renderRootScope(config: NavoriConfig, ctx = context()) {
  const planned = planClaudeSkills(ws, config, { repoRoot: root }).skills;
  return renderClaudeEngine(ws, config, {
    repoRoot: root,
    monorepoContext: ctx,
    harnessScope: "root",
    workspaceSkills: { omitted: new Set(planned.map((s) => s.id)), prune: true },
  });
}

describe("renderClaudeEngine — workspace bajo `root` (spec 0043 T7)", () => {
  it("bajo `root` el workspace queda con `CLAUDE.md` y nada más", () => {
    // Covers: R4
    renderRootScope(wsConfig());
    expect(files(ws)).toEqual(["CLAUDE.md"]);
  });

  it("quita las copias prístinas que había y deja lo que no es de navori", () => {
    // Covers: R4, R7
    renderClaudeEngine(ws, wsConfig(), { repoRoot: root, monorepoContext: context() });
    expect(files(ws).some((f) => f.endsWith("SKILL.md"))).toBe(true);
    writeFileSync(join(ws, ".claude/skills/locate-code/SKILL.md"), "# mía, sin marcador\n");

    const r = renderRootScope(wsConfig());

    const left = files(ws).filter((f) => f.startsWith(".claude/skills/"));
    expect(left).toEqual([".claude/skills/locate-code/SKILL.md"]);
    expect(r.trimmedKept).toEqual([
      { path: ".claude/skills/locate-code/SKILL.md", reason: "foreign" },
    ]);
  });

  it("el bloque dice que las skills viven en la raíz, en es y en", () => {
    // Covers: R12
    renderRootScope(wsConfig({ language: "es" }));
    expect(contextFile()).toMatch(
      /las skills, los agentes, los hooks y la configuración viven en la raíz/i,
    );
    rmSync(ws, { recursive: true });
    mkdirSync(ws, { recursive: true });
    renderRootScope(wsConfig({ language: "en" }));
    expect(contextFile()).toMatch(/skills, agents, hooks and configuration live at the repo root/i);
  });

  it("con `qualityGate` propio, el bloque nombra sus comandos; sin él, no", () => {
    // Covers: R12
    renderRootScope(wsConfig({ qualityGate: { fast: "pnpm lint", full: "pnpm test" } }));
    const own = contextFile();
    expect(own).toContain("`pnpm lint`");
    expect(own).toContain("`pnpm test`");

    rmSync(ws, { recursive: true });
    mkdirSync(ws, { recursive: true });
    renderRootScope(wsConfig());
    const inherited = contextFile();
    expect(inherited).not.toMatch(/difiere del de la raíz/i);
    expect(inherited).toMatch(/viven en la raíz/i);
  });

  it("sin `skills-index` en el workspace", () => {
    // Covers: R12, R13
    renderClaudeEngine(ws, wsConfig(), { repoRoot: root, monorepoContext: context() });
    expect(contextFile()).toContain('id="skills-index"');
    renderRootScope(wsConfig());
    expect(contextFile()).not.toContain('id="skills-index"');
  });

  it("sin `workspaceSkills`, `root` no suelta skills por su cuenta: la guardia es de la decisión", () => {
    // Covers: R4
    renderClaudeEngine(ws, wsConfig(), {
      repoRoot: root,
      monorepoContext: context(),
      harnessScope: "root",
    });
    expect(files(ws).some((f) => f.endsWith("locate-code/SKILL.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T8 — the root writes what the workspaces hand up.
// ---------------------------------------------------------------------------

function hoisted(id: string, source: string, workspaceName?: string): HoistedSkill {
  const config = wsConfig();
  const skill = planClaudeSkills(ws, config, { repoRoot: root }).skills.find(
    (s) => s.id === source,
  );
  expect(skill, `${source} is planned for the nextjs preset`).toBeDefined();
  return { id, source: skill!, config, ...(workspaceName ? { workspaceName } : {}) };
}

const rootSkill = (id: string): string => join(root, ".claude/skills", id, "SKILL.md");
const contextBlock = (): string | null =>
  extractManagedContent(
    readFileSync(join(root, "CLAUDE.md"), "utf-8"),
    "contexto-proyecto",
    "html",
  );

describe("renderClaudeEngine — la raíz sube lo de los workspaces (spec 0043 T8)", () => {
  it("la raíz escribe lo subido y `contexto-proyecto` queda byte-idéntico", () => {
    // Covers: R5
    renderClaudeEngine(root, ROOT_CONFIG);
    const before = contextBlock();
    expect(before).not.toBeNull();

    const r = renderClaudeEngine(root, ROOT_CONFIG, {
      rootHoist: {
        skills: [hoisted("nextjs-app-router", "nextjs-app-router")],
        pruneCandidates: [],
      },
    });

    expect(existsSync(rootSkill("nextjs-app-router"))).toBe(true);
    expect(r.written.some((w) => w.path === ".claude/skills/nextjs-app-router/SKILL.md")).toBe(
      true,
    );
    expect(contextBlock()).toBe(before);
  });

  it("una `slug-id` lleva `name` y `description` reescritos", () => {
    // Covers: R6
    renderClaudeEngine(root, ROOT_CONFIG, {
      rootHoist: {
        skills: [hoisted("web-nextjs-app-router", "nextjs-app-router", "web")],
        pruneCandidates: [],
      },
    });
    const out = readFileSync(rootSkill("web-nextjs-app-router"), "utf-8");
    expect(out).toContain("name: web-nextjs-app-router");
    expect(out).toMatch(/^description: .*\[web\] /m);
    expect(out).toContain('navori:managed id="web-nextjs-app-router"');
  });

  it("el índice de la raíz lista lo subido con su nombre final", () => {
    // Covers: R5, R13
    renderClaudeEngine(root, ROOT_CONFIG, {
      rootHoist: {
        skills: [
          hoisted("nextjs-app-router", "nextjs-app-router"),
          hoisted("web-new-resource", "new-resource", "web"),
        ],
        pruneCandidates: [],
      },
    });
    const index = readFileSync(join(root, "CLAUDE.md"), "utf-8");
    expect(index).toContain("- `nextjs-app-router` — workspace");
    expect(index).toContain("- `web-new-resource` — workspace (`web`)");
  });

  it("un candidato ya no deseado se poda y uno con texto del usuario se conserva", () => {
    // Covers: R5
    const a = hoisted("nextjs-app-router", "nextjs-app-router");
    const b = hoisted("web-new-resource", "new-resource", "web");
    renderClaudeEngine(root, ROOT_CONFIG, { rootHoist: { skills: [a, b], pruneCandidates: [] } });
    writeFileSync(
      rootSkill("web-new-resource"),
      `${readFileSync(rootSkill("web-new-resource"), "utf-8")}\nMía.\n`,
    );

    // The workspaces stopped handing them up: both are candidates, neither is wanted.
    const r = renderClaudeEngine(root, ROOT_CONFIG, {
      rootHoist: { skills: [], pruneCandidates: [a, b] },
    });

    expect(existsSync(rootSkill("nextjs-app-router"))).toBe(false);
    expect(r.written).toContainEqual({
      path: ".claude/skills/nextjs-app-router",
      status: "removed-trimmed",
    });
    expect(existsSync(rootSkill("web-new-resource"))).toBe(true);
    expect(r.trimmedKept).toEqual([
      { path: ".claude/skills/web-new-resource/SKILL.md", reason: "modified" },
    ]);
  });

  it("un candidato que no es de navori no se menciona ni se toca", () => {
    // Covers: R5
    mkdirSync(join(root, ".claude/skills/nextjs-app-router"), { recursive: true });
    writeFileSync(rootSkill("nextjs-app-router"), "# mi skill\n");
    const r = renderClaudeEngine(root, ROOT_CONFIG, {
      rootHoist: {
        skills: [],
        pruneCandidates: [hoisted("nextjs-app-router", "nextjs-app-router")],
      },
    });
    expect(readFileSync(rootSkill("nextjs-app-router"), "utf-8")).toBe("# mi skill\n");
    expect(r.trimmedKept).toEqual([]);
  });
});
