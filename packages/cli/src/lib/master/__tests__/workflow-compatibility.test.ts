import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCoreRoot } from "../../render/bundled-assets.ts";
import { runMasterInit } from "../init.ts";
import { readMasterStatus, writeMasterStatus } from "../status.ts";
import { runMasterClose } from "../close.ts";
import { changeMasterPart } from "../part.ts";
import { checkPart } from "../check-part.ts";
import { buildCheckContext } from "../checks.ts";
import { scanMasterPlan } from "../../diagnose/master-plan.ts";
import { readConfig } from "../../config/config.ts";
import * as renderModule from "../../../commands/render.ts";
import { masterCommand } from "../../../commands/master.ts";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(specsDir?: string): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-deliveries-d1-"));
  dirs.push(cwd);
  execFileSync("git", ["init", "-q"], { cwd });
  writeFileSync(
    join(cwd, "navori.config.json"),
    `${JSON.stringify({ name: "demo", engines: ["claude"], preset: "custom", sdd: { enabled: true, ...(specsDir ? { specsDir } : {}) } }, null, 2)}\n`,
  );
  return cwd;
}

function stage(cwd: string, specsDir = "specs"): string {
  return join(cwd, specsDir, "_master", "01-demo");
}
function json(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}
function snapshot(cwd: string): string {
  function walk(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === ".git") return [];
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) return [`${path.slice(cwd.length)} -> ${readlinkSync(path)}`];
      return entry.isDirectory()
        ? [path.slice(cwd.length), ...walk(path)]
        : [`${path.slice(cwd.length)}:${readFileSync(path, "utf8")}`];
    });
  }
  return walk(cwd).sort().join("\n");
}

describe("master-plan architect context contract", () => {
  // Covers: R5
  it("makes the canonical skill consume architectContext from status JSON without the stale name", () => {
    const skill = readFileSync(join(getCoreRoot(), "core-assets/skills/master-plan.md"), "utf8");
    expect(skill.match(/contextForArchitects/g)).toBeNull();
    expect(skill).toContain("incluye `architectContext` de `status --json`");
    expect(skill).toContain("El campo `architectContext` es la fuente de estas rutas");
    expect(skill).toContain("En `architectContext`, conserva explícitamente la lista de etapas");
  });
});

describe("master-plan inherited mode contract", () => {
  // Covers: R6
  it("inherits en-curso from init for stages >= 2 without calling mode, preserving first-stage consent", () => {
    const skill = readFileSync(join(getCoreRoot(), "core-assets/skills/master-plan.md"), "utf8");
    const notice = skill.slice(
      skill.indexOf("## Aviso de inicio"),
      skill.indexOf("## Mensaje de fase"),
    );
    const firstStage = notice.match(/Solo para la primera etapa[^.]*\./)?.[0] ?? "";
    const laterStages = notice.match(/En etapas posteriores[^.]*\./)?.[0] ?? "";

    expect(firstStage).toMatch(/primera pregunta[^.]*modo `desde-cero`, `template` o `en-curso`/);
    expect(firstStage).toContain("con la sugerencia del CLI primero y como recomendación");
    expect(firstStage).toMatch(/registra la elección con `navori master mode`/);
    expect(laterStages).toMatch(/(?:≥\s*2|>=\s*2|mayor o igual a 2)/);
    expect(laterStages).toContain("`navori master init`");
    expect(laterStages).toMatch(/hereda[^.]*automáticamente|automáticamente[^.]*hereda/);
    expect(laterStages).toContain("`en-curso`");
    expect(laterStages).toContain("sin preguntar");
    expect(laterStages).toMatch(/(?:no|nunca) invo(?:ques|car) `navori master mode`/);
    expect(laterStages).not.toMatch(/registra[^.]*`en-curso`/);
    expect(notice).toContain("Sin confirmación no escribas nada");
    expect(notice).toContain("Cada aviso requiere confirmación");
    expect(notice).toMatch(/solo después de confirmar[^.]*`navori master init <slug>`/);
  });
});

// Covers: R14
it("routes default legacy and deliveries explicitly after readonly status using supported commands", () => {
  const skill = readFileSync(join(getCoreRoot(), "core-assets/skills/master-plan.md"), "utf8");
  const route = skill.slice(
    skill.indexOf("## Ruteo de etapa"),
    skill.indexOf("## Aviso de inicio"),
  );
  const status = route.indexOf("navori master status --json");
  expect(status).toBeGreaterThanOrEqual(0);
  const branch = route.slice(status);
  expect(branch).toMatch(/legacy[^\n]*(?:defecto|ausente)|(?:defecto|ausente)[^\n]*legacy/);
  expect(branch).toContain('`workflow: "deliveries"`');
  expect(branch).toMatch(/(?:solo|únicamente)[^\n]*delivery-/);
  for (const command of [
    "delivery-check",
    "delivery-baseline",
    "delivery-queue",
    "delivery-slice",
    "delivery-criterion",
    "delivery-review",
    "delivery-present",
    "delivery-decision",
    "delivery-publication",
  ])
    expect(branch).toContain(`navori master ${command}`);
  const commands = [...skill.matchAll(/navori master (delivery-[a-z-]+)/g)].map(
    (match) => match[1],
  );
  expect(
    commands.every((command) => Object.hasOwn(masterCommand.subCommands ?? {}, command!)),
  ).toBe(true);
  expect(route).toContain("no escribas ni cambies configuración");
  expect(branch).toMatch(/(?:consentimiento|confirmación|aprobación)/);
  expect(branch).toMatch(/(?:no|sin)[^\n]*(?:legacy|fases)/);
});

describe("deliveries D1 foundation", () => {
  it("persists selection in registry2, resumes without flag, and preserves MASTER bytes", () => {
    const cwd = repo();
    expect(runMasterInit(cwd, "demo", "deliveries").workflow).toBe("deliveries");
    expect(json(join(cwd, "specs", "_master", "index.json"))).toMatchObject({
      version: 2,
      stages: [{ workflow: "deliveries" }],
    });
    expect(json(join(stage(cwd), "state.json"))).toMatchObject({
      version: 2,
      workflow: "deliveries",
      phase: "context",
    });
    expect(existsSync(join(stage(cwd), "parts.json"))).toBe(false);
    expect(readMasterStatus(cwd)).toMatchObject({
      workflow: "deliveries",
      allDone: false,
      closable: false,
      nextPhase: null,
    });
    const master = join(stage(cwd), "MASTER.md");
    const bytes = "# Manual\n\n## Entrega en partes\n\nHuman text.\n";
    writeFileSync(master, bytes);
    writeMasterStatus(cwd);
    expect(readFileSync(master, "utf8")).toBe(bytes);
    expect(runMasterInit(cwd, undefined).workflow).toBe("deliveries");
    expect(
      scanMasterPlan(cwd, readConfig(join(cwd, "navori.config.json"))).some(
        (d) => d.kind === "deliveries-pending",
      ),
    ).toBe(true);
  });

  it("retries render after both throw and ok:false with persisted config flag", () => {
    const cwd = repo();
    const realRender = renderModule.runRender;
    const mock = vi.spyOn(renderModule, "runRender");
    mock.mockImplementationOnce(() => {
      throw new Error("interrupted render");
    });
    expect(() => runMasterInit(cwd, "demo", "deliveries")).toThrow(/interrupted render/);
    expect(json(join(cwd, "navori.config.json"))).toMatchObject({ harness: { masterPlan: true } });
    const stateBefore = readFileSync(join(stage(cwd), "state.json"), "utf8");
    mock.mockImplementationOnce(
      () => ({ ok: false, reason: "injected render failure" }) as ReturnType<typeof realRender>,
    );
    expect(() => runMasterInit(cwd, undefined)).toThrow(/injected render failure/);
    expect(readFileSync(join(stage(cwd), "state.json"), "utf8")).toBe(stateBefore);
    mock.mockImplementationOnce((...args) => realRender(...args));
    expect(runMasterInit(cwd, undefined).workflow).toBe("deliveries");
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("resumes after the first durable index2 write without a workflow flag", () => {
    const cwd = repo();
    const root = join(cwd, "specs", "_master");
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "index.json"),
      JSON.stringify({
        version: 2,
        stages: [
          {
            number: 1,
            slug: "demo",
            dir: "01-demo",
            state: "activa",
            openedAt: "2026-01-01",
            closedAt: null,
            spec: null,
            workflow: "deliveries",
          },
        ],
      }),
    );
    expect(runMasterInit(cwd, undefined).workflow).toBe("deliveries");
    expect(json(join(stage(cwd), "state.json"))).toMatchObject({
      version: 2,
      workflow: "deliveries",
    });
  });

  it("rejects mismatched pairs, invalid state and unexpected parts without writes", () => {
    const cwd = repo();
    runMasterInit(cwd, "demo", "deliveries");
    const path = join(stage(cwd), "state.json");
    const valid = readFileSync(path, "utf8");
    for (const state of [
      { ...json(path), version: 1, workflow: undefined },
      { ...json(path), version: 9 },
      { invalid: true },
    ]) {
      writeFileSync(path, JSON.stringify(state));
      const before = snapshot(cwd);
      expect(() => runMasterInit(cwd, undefined)).toThrow();
      expect(() => writeMasterStatus(cwd)).toThrow();
      expect(snapshot(cwd)).toBe(before);
    }
    writeFileSync(path, valid);
    writeFileSync(join(stage(cwd), "parts.json"), JSON.stringify({ version: 1, parts: [] }));
    const before = snapshot(cwd);
    expect(() => runMasterInit(cwd, undefined)).toThrow(/parts.json/);
    // R26: status no longer throws; it names the invalid parts.json as a blocker.
    expect(readMasterStatus(cwd)).toMatchObject({
      workflow: "deliveries",
      blockers: [expect.stringContaining("parts.json inválido")],
    });
    expect(snapshot(cwd)).toBe(before);
  });

  it("keeps a registry2 legacy stage at version2 and rejects legacy entry with state2", () => {
    const cwd = repo();
    runMasterInit(cwd, "demo");
    const indexPath = join(cwd, "specs", "_master", "index.json");
    writeFileSync(indexPath, JSON.stringify({ ...json(indexPath), version: 2 }));
    const statePath = join(stage(cwd), "state.json");
    const stateBytes = readFileSync(statePath, "utf8");
    runMasterInit(cwd, undefined);
    expect(json(indexPath).version).toBe(2);
    expect(readFileSync(statePath, "utf8")).toBe(stateBytes);
    writeFileSync(
      statePath,
      JSON.stringify({ ...json(statePath), version: 2, workflow: "deliveries" }),
    );
    const before = snapshot(cwd);
    expect(() => runMasterInit(cwd, undefined)).toThrow();
    expect(() => readMasterStatus(cwd)).toThrow();
    expect(snapshot(cwd)).toBe(before);
  });

  it("blocks legacy public operations by entry even with valid state1", () => {
    const cwd = repo();
    runMasterInit(cwd, "demo", "deliveries");
    writeFileSync(
      join(stage(cwd), "state.json"),
      JSON.stringify({
        version: 1,
        phase: "context",
        mode: null,
        signal: json(join(stage(cwd), "state.json")).signal,
        history: [],
      }),
    );
    const before = snapshot(cwd);
    expect(() => buildCheckContext(cwd)).toThrow(/deliveries/);
    expect(checkPart(cwd, "P1")).toEqual([expect.stringContaining("deliveries")]);
    expect(() => changeMasterPart(cwd, "P1", { state: "hecho" })).toThrow(/deliveries/);
    expect(() => runMasterClose(cwd, { abandon: true, reason: "test" })).toThrow(/deliveries/);
    expect(() => runMasterClose(cwd, { convert: "specs/demo", reason: "test" })).toThrow(
      /deliveries/,
    );
    expect(snapshot(cwd)).toBe(before);
  });

  it("rejects outside and symlinked paths before creating any master files", () => {
    const outside = mkdtempSync(join(tmpdir(), "navori-d1-outside-"));
    dirs.push(outside);
    for (const specsDir of [outside, "../escape"]) {
      const cwd = repo(specsDir);
      const before = snapshot(cwd);
      expect(() => runMasterInit(cwd, "demo", "deliveries")).toThrow(/outside repository/);
      expect(snapshot(cwd)).toBe(before);
    }
    const cwd = repo();
    mkdirSync(join(cwd, "specs"));
    symlinkSync(outside, join(cwd, "specs", "_master"));
    const before = snapshot(cwd);
    expect(() => runMasterInit(cwd, "demo", "deliveries")).toThrow();
    expect(snapshot(cwd)).toBe(before);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("supports an in-repo specsDir and rejects a symlinked stage on resume", () => {
    const cwd = repo("planning/specs");
    runMasterInit(cwd, "demo", "deliveries");
    expect(existsSync(join(stage(cwd, "planning/specs"), "state.json"))).toBe(true);

    const resumed = repo();
    const external = mkdtempSync(join(tmpdir(), "navori-d1-stage-outside-"));
    dirs.push(external);
    const master = join(resumed, "specs", "_master");
    mkdirSync(master, { recursive: true });
    writeFileSync(
      join(master, "index.json"),
      JSON.stringify({
        version: 2,
        stages: [
          {
            number: 1,
            slug: "demo",
            dir: "01-demo",
            state: "activa",
            openedAt: "2026-01-01",
            closedAt: null,
            spec: null,
            workflow: "deliveries",
          },
        ],
      }),
    );
    symlinkSync(external, join(master, "01-demo"));
    const before = snapshot(resumed);
    expect(() => runMasterInit(resumed, undefined)).toThrow(/outside repository/);
    expect(snapshot(resumed)).toBe(before);
    expect(readdirSync(external)).toEqual([]);
  });
});

describe("master-plan skill alignment with the CLI", () => {
  // Covers: R17
  it("el skill indica check --part P<n>, commit antes de --accept, template parts, status tras marcar tareas y evidenceBlockers antes de cerrar", () => {
    const skill = readFileSync(join(getCoreRoot(), "core-assets/skills/master-plan.md"), "utf8");
    expect(skill).toContain("`navori master check --part P<n>`");
    expect(skill).toContain(
      "tras hacer commit del código probado, con `navori master part P<n> --accept",
    );
    expect(skill).toContain("`navori master template parts`");
    expect(skill).toContain(
      "Tras marcar tareas de la spec, genera o actualiza `STATUS.md` con `navori master status`",
    );
    expect(skill).toContain("`closable` verdadero y `evidenceBlockers` vacío");
    expect(skill).toContain("o hay `evidenceBlockers`");
    expect(skill).toContain("o después solo si no hay partes");
  });

  // Covers: R46
  it("master-plan lista los subcomandos que mutan, la apertura deliveries y delivery-revoke", () => {
    const skill = readFileSync(
      join(getCoreRoot(), "core-assets/skills/master-plan.md"),
      "utf8",
    ).replace(/\s+/g, " ");
    for (const sub of [
      "init",
      "ux",
      "mode",
      "advance",
      "part",
      "close",
      "delivery-baseline",
      "delivery-queue",
      "delivery-slice",
      "delivery-criterion",
      "delivery-review",
      "delivery-present",
      "delivery-decision",
      "delivery-publication",
      "delivery-revoke",
    ]) {
      expect(skill, `falta \`navori master ${sub}\``).toContain(`\`navori master ${sub}\``);
    }
    expect(skill).toContain("`navori master init <slug> --workflow deliveries`");
    expect(skill).toContain("`navori master delivery-revoke` solo");
  });
});
