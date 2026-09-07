import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig, writeConfig } from "../../lib/config.ts";
import { detectProject } from "../../lib/detect.ts";
import { runRender } from "../render.ts";
import {
  aggregateRender,
  applyDiffs,
  deadProgressKeys,
  diffConfig,
  refreshWorkspaceScopes,
  mergeLibraryMigrations,
  gateVerdict,
  unconfiguredEngines,
} from "../update.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-update-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("deadProgressKeys (#79)", () => {
  it("lists the removed progress keys the config still carries", () => {
    expect(
      deadProgressKeys({
        progress: { dir: "progress", checkpointsDir: "cp", archiveAfterDays: 30 },
      }),
    ).toEqual(["checkpointsDir", "archiveAfterDays"]);
  });

  it("returns [] when progress is clean or absent", () => {
    expect(deadProgressKeys({ progress: { dir: "progress" } })).toEqual([]);
    expect(deadProgressKeys({})).toEqual([]);
    expect(deadProgressKeys({ progress: "nonsense" })).toEqual([]);
  });
});

describe("refreshWorkspaceScopes — re-home per-workspace library skills (#80 migration)", () => {
  function writePkg(path: string, pkg: object): void {
    mkdirSync(join(cwd, path), { recursive: true });
    writeFileSync(join(cwd, path, "package.json"), JSON.stringify(pkg));
  }

  it("re-homes a workspace-only lib onto its config entry and returns true", () => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - 'apps/*'\n`);
    writePkg("apps/api", { name: "api", dependencies: { mongoose: "^8" } });
    // Legacy-style config: aggregated lib on the root, workspace entry has none.
    const raw: Record<string, unknown> = {
      project: { libraries: ["mongoose"] },
      monorepo: { enabled: true, tool: "pnpm", workspaces: [{ name: "api", path: "apps/api" }] },
    };

    const changed = refreshWorkspaceScopes(raw, cwd);

    expect(changed).toBe(true);
    const ws = (raw.monorepo as { workspaces: Array<Record<string, unknown>> }).workspaces[0]!;
    expect(ws.libraries).toEqual(["mongoose"]);
  });

  it("is a no-op (returns false) when workspaces are already correctly scoped", () => {
    writeFileSync(join(cwd, "pnpm-workspace.yaml"), `packages:\n  - 'apps/*'\n`);
    writePkg("apps/api", { name: "api", dependencies: { mongoose: "^8" } });
    const raw: Record<string, unknown> = {
      monorepo: {
        enabled: true,
        tool: "pnpm",
        workspaces: [{ name: "api", path: "apps/api", libraries: ["mongoose"] }],
      },
    };

    expect(refreshWorkspaceScopes(raw, cwd)).toBe(false);
  });

  it("returns false for a non-monorepo config", () => {
    expect(refreshWorkspaceScopes({ project: { libraries: ["zod-validation"] } }, cwd)).toBe(false);
  });
});

describe("mergeLibraryMigrations (#90)", () => {
  const mig = (legacy: string, preferred: string, domain = "http") => ({
    legacy,
    preferred,
    domain,
  });
  const legacies = (ms: Array<{ legacy: string }>) => ms.map((m) => m.legacy).sort();

  it("adopts a NEW detected pair (moment→dayjs added after init auto-populated axios→ky)", () => {
    // The scenario that used to freeze: config was auto-populated by init, then
    // the user adds new deps. The new pair MUST be adopted, and it's NOT flagged
    // as a manual override.
    const current = [mig("axios", "ky")];
    const detected = [mig("axios", "ky"), mig("moment", "dayjs")];
    const { merged, changedOverrides } = mergeLibraryMigrations(current, detected);
    expect(legacies(merged)).toEqual(["axios", "moment"]);
    expect(merged.find((m) => m.legacy === "moment")).toEqual(mig("moment", "dayjs"));
    expect(changedOverrides).toEqual([]);
  });

  it("preserves a hand-edited successor (real override) and flags it", () => {
    // User changed the successor for axios; detection still suggests ky.
    const current = [mig("axios", "got")];
    const detected = [mig("axios", "ky")];
    const { merged, changedOverrides } = mergeLibraryMigrations(current, detected);
    expect(merged).toEqual([mig("axios", "got")]); // user's choice wins
    expect(changedOverrides).toEqual([mig("axios", "got")]);
  });

  it("keeps a config pair whose legacy is no longer detected (remembered rule)", () => {
    const current = [mig("axios", "ky")];
    const { merged, changedOverrides } = mergeLibraryMigrations(current, []);
    expect(merged).toEqual([mig("axios", "ky")]);
    expect(changedOverrides).toEqual([]); // not a change — detection simply lost it
  });

  it("does NOT flag an override when config matches detection, order-independent", () => {
    const current = [mig("moment", "dayjs"), mig("axios", "ky")];
    const detected = [mig("axios", "ky"), mig("moment", "dayjs")];
    const { merged, changedOverrides } = mergeLibraryMigrations(current, detected);
    expect(legacies(merged)).toEqual(["axios", "moment"]);
    expect(changedOverrides).toEqual([]);
  });

  it("adopts detection wholesale when config is empty (fresh repo)", () => {
    const { merged, changedOverrides } = mergeLibraryMigrations([], [mig("axios", "ky")]);
    expect(merged).toEqual([mig("axios", "ky")]);
    expect(changedOverrides).toEqual([]);
  });

  it("combines a real override AND a new adoption in one pass", () => {
    const current = [mig("axios", "got")]; // override
    const detected = [mig("axios", "ky"), mig("moment", "dayjs")]; // conflict + new
    const { merged, changedOverrides } = mergeLibraryMigrations(current, detected);
    expect(legacies(merged)).toEqual(["axios", "moment"]);
    expect(merged.find((m) => m.legacy === "axios")).toEqual(mig("axios", "got"));
    expect(changedOverrides).toEqual([mig("axios", "got")]);
  });
});

/**
 * #345 — `project.libraries` is DERIVED: detection owns it, the user doesn't.
 * The contrast with the suite above is the point — `libraryMigrations` preserves
 * a manual edit, this field replaces it — so the chosen semantics is pinned here
 * and a future change to it has to be deliberate instead of accidental.
 */
describe("project.libraries — a DERIVED field, replaced not merged (#345)", () => {
  function seedRepo(libraries: string[]): string {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({ name: "demo", dependencies: { mongoose: "^8" } }),
    );
    const configPath = join(cwd, "navori.config.json");
    writeConfig(configPath, {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      project: { libraries },
    });
    return configPath;
  }

  it("reports the drift and drops a hand-added id detection does not reproduce", () => {
    const configPath = seedRepo(["mongoose", "hand-added-skill"]);
    const detected = detectProject(cwd);
    expect(detected.libraries).toEqual(["mongoose"]);

    const diffs = diffConfig(readConfig(configPath), detected);
    const libDiff = diffs.find((d) => d.field === "project.libraries");
    // The user does SEE the removal (it's in the drift list) — it just doesn't survive.
    expect(libDiff, "no project.libraries diff was emitted").toBeDefined();
    expect(libDiff!.before).toContain("hand-added-skill");
    expect(libDiff!.after).not.toContain("hand-added-skill");

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    applyDiffs(raw, detected, diffs);
    expect((raw.project as { libraries: string[] }).libraries).toEqual(["mongoose"]);
  });

  it("emits no drift when the config already matches detection (sync, not rewrite)", () => {
    const configPath = seedRepo(["mongoose"]);
    const diffs = diffConfig(readConfig(configPath), detectProject(cwd));
    expect(diffs.find((d) => d.field === "project.libraries")).toBeUndefined();
  });
});

/**
 * #588 — a quality gate is a DECISION, not a derived field. `update` used to
 * replace it whenever detection spelled it differently, which in the field would
 * have cut a five-step gate down to one and traded a repo's own lint script for
 * a generic one. It may now only ADD steps the config lacks.
 */
describe("qualityGate — only adopted when the repo GAINED steps (#588)", () => {
  it("gateVerdict keeps a config gate that already covers detection", () => {
    expect(gateVerdict("npm run compile && npm run lint", "npm run compile")).toBe("keep");
  });

  it("gateVerdict keeps an incomparable gate (neither covers the other)", () => {
    expect(gateVerdict("bash .claude/scripts/lint-staged.sh", "npm run lint")).toBe("keep");
    // The pnpm→npm rewrite `services--streaming` would have suffered.
    expect(gateVerdict("pnpm run lint && pnpm run test", "npm run lint && npm run test")).toBe(
      "keep",
    );
  });

  it("gateVerdict adopts when detection is a strict superset, or there is no gate", () => {
    expect(
      gateVerdict("npm run lint && npm run test", "npm run tc && npm run lint && npm run test"),
    ).toBe("adopt");
    expect(gateVerdict(undefined, "npm run lint")).toBe("adopt");
    expect(gateVerdict("   ", "npm run lint")).toBe("adopt");
  });

  it("gateVerdict keeps the same steps spelled differently instead of churning", () => {
    expect(gateVerdict("npm run lint  &&  npm run test", "npm run test && npm run lint")).toBe(
      "keep",
    );
  });

  /** package.json scripts detection composes into `compile && lint && test:unit`. */
  function seedGateRepo(gate: { fast: string; full: string } | undefined): string {
    writeFileSync(
      join(cwd, "package.json"),
      JSON.stringify({
        name: "demo",
        scripts: { compile: "tsc", lint: "eslint .", "test:unit": "vitest run" },
      }),
    );
    const configPath = join(cwd, "navori.config.json");
    writeConfig(configPath, {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      ...(gate ? { qualityGate: gate } : {}),
    });
    return configPath;
  }

  it("emits no gate diff for the stricter gate detection would have degraded", () => {
    // The bonum-webapp shape: the config gate is detection's plus cypress+build.
    const configPath = seedGateRepo({
      fast: "npm run compile && npm run lint && npm run test:unit",
      full: "npm run compile && npm run lint && npm run test:unit && npm run cypress && npm run build",
    });
    const diffs = diffConfig(readConfig(configPath), detectProject(cwd));
    expect(diffs.filter((d) => d.field.startsWith("qualityGate"))).toEqual([]);
  });

  it("adopts a gate for a repo that declares none", () => {
    const configPath = seedGateRepo(undefined);
    const detected = detectProject(cwd);
    const diffs = diffConfig(readConfig(configPath), detected);
    expect(diffs.filter((d) => d.field.startsWith("qualityGate"))).toHaveLength(2);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    applyDiffs(raw, detected, diffs);
    expect(raw.qualityGate).toEqual(detected.qualityGate);
  });

  /**
   * The latent bug the per-field rule exposed: `applyDiffs` assigned the WHOLE
   * detected `qualityGate` object for either diff, so adopting `full` dragged
   * `fast` along — including a `fast` that `gateVerdict` had just ruled "keep".
   */
  it("applies fast and full independently, never as one object", () => {
    const configPath = seedGateRepo({
      // `fast` is stricter than detection's ("npm run compile") → keep.
      // `full` is a strict subset of detection's → adopt.
      fast: "npm run compile && npm run lint",
      full: "npm run compile && npm run lint",
    });
    const detected = detectProject(cwd);
    const diffs = diffConfig(readConfig(configPath), detected);
    expect(diffs.map((d) => d.field).filter((f) => f.startsWith("qualityGate"))).toEqual([
      "qualityGate.full",
    ]);

    const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    applyDiffs(raw, detected, diffs);
    expect(raw.qualityGate).toEqual({
      fast: "npm run compile && npm run lint", // untouched
      full: detected.qualityGate!.full, // adopted
    });
  });
});

/**
 * #588 — engine output on disk cannot tell "you have this" from "you had this
 * and removed it", so `update` reports it instead of proposing to add it back.
 */
describe("engines — reported, never diffed (#588)", () => {
  function seedEnginesRepo(): string {
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    writeFileSync(join(cwd, "AGENTS.md"), "# team doc, not navori's\n");
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "demo" }));
    const configPath = join(cwd, "navori.config.json");
    writeConfig(configPath, { name: "demo", engines: ["claude"], preset: "custom" });
    return configPath;
  }

  it("emits no engines diff for output left by a dropped engine", () => {
    const configPath = seedEnginesRepo();
    const detected = detectProject(cwd);
    // Detection does see them — that is precisely the input we refuse to act on.
    expect(detected.existingEngines).toEqual(expect.arrayContaining(["codex", "agents-md"]));
    expect(
      diffConfig(readConfig(configPath), detected).find((d) => d.field === "engines"),
    ).toBeUndefined();
  });

  it("still reports them, so the discovery is not lost", () => {
    const configPath = seedEnginesRepo();
    expect(unconfiguredEngines(readConfig(configPath), detectProject(cwd))).toEqual(
      expect.arrayContaining(["codex", "agents-md"]),
    );
  });

  it("says nothing when every detected engine is already configured", () => {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ name: "demo" }));
    mkdirSync(join(cwd, ".codex"), { recursive: true });
    const configPath = join(cwd, "navori.config.json");
    writeConfig(configPath, { name: "demo", engines: ["claude", "codex"], preset: "custom" });
    expect(unconfiguredEngines(readConfig(configPath), detectProject(cwd))).toEqual([]);
  });
});

describe("aggregateRender — monorepo fidelity (#79 crítico 3)", () => {
  function seedMonorepo(): void {
    mkdirSync(join(cwd, "apps/backend"), { recursive: true });
    mkdirSync(join(cwd, "apps/web"), { recursive: true });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "monorepo-pnpm",
      qualityGate: { fast: "pnpm -w lint", full: "pnpm -w test" },
      monorepo: {
        enabled: true,
        tool: "pnpm",
        workspaces: [
          { name: "backend", path: "apps/backend" },
          { name: "web", path: "apps/web" },
        ],
      },
    });
  }

  it("surfaces pending writes for the root AND every workspace (not just root)", () => {
    seedMonorepo();
    // Preview of a fresh repo: everything is pending "created".
    const preview = runRender(cwd, true);
    const agg = aggregateRender(preview);

    const scopes = new Set(agg.writes.map((w) => w.scope));
    expect(scopes.has("root")).toBe(true);
    expect(scopes.has("backend")).toBe(true);
    expect(scopes.has("web")).toBe(true);
    // Each workspace contributes its own CLAUDE.md write.
    for (const scope of ["root", "backend", "web"]) {
      expect(agg.writes.some((w) => w.scope === scope && w.path === "CLAUDE.md")).toBe(true);
    }
  });

  it("aggregates non-Claude engine writes too (AGENTS.md at root + workspaces)", () => {
    mkdirSync(join(cwd, "apps/backend"), { recursive: true });
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude", "agents-md"],
      preset: "monorepo-pnpm",
      monorepo: {
        enabled: true,
        tool: "pnpm",
        workspaces: [{ name: "backend", path: "apps/backend" }],
      },
    });
    const agg = aggregateRender(runRender(cwd, true));
    expect(agg.writes.some((w) => w.path === "AGENTS.md" && w.scope.startsWith("root"))).toBe(true);
    expect(agg.writes.some((w) => w.path === "AGENTS.md" && w.scope.startsWith("backend"))).toBe(
      true,
    );
  });
});

describe("anti-retroceso end-to-end via runRender (#79 crítico 1)", () => {
  it("preserves a CLAUDE.md block written by a newer navori and reports the downgrade", () => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
    });
    // First render materializes the tree with the current version markers.
    runRender(cwd, false);
    const claudeMdPath = join(cwd, "CLAUDE.md");
    const before = readFileSync(claudeMdPath, "utf-8");

    // Simulate a teammate on a newer navori: bump a core block's version marker
    // far ahead and change its body.
    const bumped = before
      .replace(/(id="idioma-rol"[^>]*version=")[^"]+(")/, "$199.0.0$2")
      .replace(
        /(<!-- navori:managed id="idioma-rol"[\s\S]*?-->\n)[\s\S]*?(\n<!-- \/navori:managed id="idioma-rol")/,
        "$1CONTENIDO DE UNA NAVORI MÁS NUEVA$2",
      );
    writeFileSync(claudeMdPath, bumped);

    const result = runRender(cwd, false);
    const agg = aggregateRender(result);

    // The downgrade is reported…
    expect(agg.downgrades.some((d) => d.id === "idioma-rol")).toBe(true);
    // …and the newer content was preserved on disk, not clobbered.
    const after = readFileSync(claudeMdPath, "utf-8");
    expect(after).toContain("CONTENIDO DE UNA NAVORI MÁS NUEVA");
    expect(after).toContain('version="99.0.0"');
  });
});
