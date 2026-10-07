import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectManagedSection } from "../../../lib/render/marker.ts";
import { readCliVersion } from "../../../lib/render/bundled-assets.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../../../lib/config/schema.ts";
import {
  attachResolution,
  collectPlan,
  type AdapterCtx,
  type EngineAdapter,
  type PlacementRequest,
  type SkippedFile,
} from "../execute-plan.ts";
import { renderAgentsMdEngine } from "../../agents-md/index.ts";
import type { HarnessPlan } from "../harness-plan.ts";

// Covers: sync-file-resolve (#1240) P1 — engines attach a resolution to a
// user-modified skip only when safe (marker present, regular file, not a
// downgrade, forced render differs from disk).

const CLI_VERSION = readCliVersion();
const EMPTY_PLAN: HarnessPlan = { agents: [], skills: [], hooks: [] };
const PLUGIN_META = { source: "@navori/plugin-demo", version: CLI_VERSION };

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-skip-resolution-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function config(): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "skip-resolution",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
  });
}

function ctx(): AdapterCtx {
  return {
    cwd,
    config: config(),
    repoRoot: cwd,
    isWorkspace: false,
    coreAssets: cwd,
    preset: null,
    plugins: [],
  };
}

function adapterFor(request: PlacementRequest): EngineAdapter {
  return {
    id: "fake",
    placeAgent: () => null,
    placeSkill: () => null,
    placeHook: () => null,
    extraFiles: () => [request],
    orphanScans: () => [],
  };
}

function skipsFor(request: PlacementRequest): SkippedFile[] {
  return collectPlan(EMPTY_PLAN, adapterFor(request), ctx(), { prune: false }).skipped;
}

/** Writes `body` as a managed block, then hand-edits it (hash no longer matches). */
function writeEdited(
  rel: string,
  id: string,
  body: string,
  meta: { source: string; version: string },
): string {
  const abs = join(cwd, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  const out = injectManagedSection("# keep me\n", id, body, meta, "html").output;
  const edited = out.replace(body, `${body}EDITED BY HAND\n`);
  writeFileSync(abs, edited);
  return edited;
}

describe("site: body placement (execute-plan 352, body branch)", () => {
  const request: PlacementRequest = {
    body: "new body\n",
    destRelPath: ".fake/body.md",
    managedId: "body-block",
    commentStyle: "html",
  };

  it("attaches a resolution that replaces only the block and keeps the user zone", () => {
    const edited = writeEdited(request.destRelPath, "body-block", "old body\n", {
      source: "@navori/core",
      version: CLI_VERSION,
    });
    const [skip] = skipsFor(request);
    expect(skip?.status).toBe("user-modified-skipped");
    expect(skip?.resolution?.absPath).toBe(join(cwd, request.destRelPath));
    expect(skip?.resolution?.basis).toBe(edited);
    expect(skip?.resolution?.content).toContain("new body");
    expect(skip?.resolution?.content).not.toContain("EDITED BY HAND");
    expect(skip?.resolution?.content).toContain("# keep me");
    expect(readFileSync(join(cwd, request.destRelPath), "utf-8")).toBe(edited);
  });

  it("I1: a block from a NEWER navori is downgrade-skipped and carries no resolution", () => {
    writeEdited(request.destRelPath, "body-block", "old body\n", {
      source: "@navori/core",
      version: "999.0.0",
    });
    const [skip] = skipsFor(request);
    expect(skip?.status).toBe("downgrade-skipped");
    expect(skip?.resolution).toBeUndefined();
  });

  it("I5: a symlinked destination gets no resolution", () => {
    const target = join(cwd, "real.md");
    const edited = writeEdited("real.md", "body-block", "old body\n", {
      source: "@navori/core",
      version: CLI_VERSION,
    });
    mkdirSync(join(cwd, ".fake"), { recursive: true });
    symlinkSync(target, join(cwd, request.destRelPath));
    const [skip] = skipsFor(request);
    expect(skip?.status).toBe("user-modified-skipped");
    expect(skip?.resolution).toBeUndefined();
    expect(readFileSync(target, "utf-8")).toBe(edited);
  });

  it("a markerless file is appended to, not skipped: no skip, no resolution", () => {
    const abs = join(cwd, request.destRelPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "user-authored, no marker\n");
    expect(skipsFor(request)).toEqual([]);
  });
});

describe("site: plugin asset (execute-plan 298/352, asset branch)", () => {
  function assetRequest(): PlacementRequest {
    const assetPath = join(cwd, "asset.md");
    writeFileSync(
      assetPath,
      [
        '<!-- navori:managed start id="plug-asset" -->',
        "plugin body v2",
        '<!-- navori:managed end id="plug-asset" -->',
        "",
      ].join("\n"),
    );
    return {
      assetPath,
      destRelPath: ".fake/plug.md",
      managedId: "plug-asset",
      commentStyle: "html",
      meta: PLUGIN_META,
    };
  }

  it("modified plugin file with marker -> resolution carrying the forced render", () => {
    const request = assetRequest();
    const abs = join(cwd, request.destRelPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    const seeded = injectManagedSection("", "plug-asset", "plugin body v1\n", PLUGIN_META, "html");
    const edited = seeded.output.replace("plugin body v1", "plugin body v1 EDITED");
    writeFileSync(abs, edited);
    const [skip] = skipsFor(request);
    expect(skip?.status).toBe("user-modified-skipped");
    expect(skip?.resolution?.basis).toBe(edited);
    expect(skip?.resolution?.content).toContain("plugin body v2");
    expect(skip?.resolution?.content).not.toContain("EDITED");
  });

  it("A2/scope: a plugin file WITHOUT our marker (foreign) is skipped with no resolution", () => {
    const request = assetRequest();
    const abs = join(cwd, request.destRelPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "user-authored file, no navori marker\n");
    const [skip] = skipsFor(request);
    expect(skip?.status).toBe("user-modified-skipped");
    expect(skip?.resolution).toBeUndefined();
  });

  it("I1: a plugin file from a newer navori is downgrade-skipped, no resolution", () => {
    const request = assetRequest();
    const abs = join(cwd, request.destRelPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(
      abs,
      injectManagedSection(
        "",
        "plug-asset",
        "future body\n",
        { source: "@navori/plugin-demo", version: "999.0.0" },
        "html",
      ).output,
    );
    const [skip] = skipsFor(request);
    expect(skip?.status).toBe("downgrade-skipped");
    expect(skip?.resolution).toBeUndefined();
  });
});

describe("site: prose harness (AGENTS.md)", () => {
  function renderEdited(): string {
    const cfg = { ...config(), engines: ["agents-md"], language: "es" } as NavoriConfig;
    renderAgentsMdEngine(cwd, cfg);
    const path = join(cwd, "AGENTS.md");
    const edited = readFileSync(path, "utf-8").replace("## Idioma y rol", "## EDITADO A MANO");
    writeFileSync(path, edited);
    return edited;
  }

  it("hand-edited AGENTS.md block -> resolution with basis = disk, content = pristine render", () => {
    const edited = renderEdited();
    const cfg = { ...config(), engines: ["agents-md"], language: "es" } as NavoriConfig;
    const r = renderAgentsMdEngine(cwd, cfg);
    const skip = r.skipped[0];
    expect(skip?.resolution?.absPath).toBe(join(cwd, "AGENTS.md"));
    expect(skip?.resolution?.basis).toBe(edited);
    expect(skip?.resolution?.content).toContain("## Idioma y rol");
    expect(skip?.resolution?.content).not.toContain("EDITADO A MANO");
  });

  it("I1: a newer-navori AGENTS.md is downgrade-skipped, no resolution", () => {
    const cfg = { ...config(), engines: ["agents-md"], language: "es" } as NavoriConfig;
    renderAgentsMdEngine(cwd, cfg);
    const path = join(cwd, "AGENTS.md");
    // Newer writer AND a divergent body (an identical body is a no-op, not a skip).
    writeFileSync(
      path,
      readFileSync(path, "utf-8")
        .replaceAll(CLI_VERSION, "999.0.0")
        .replace("## Idioma y rol", "## FROM THE FUTURE"),
    );
    const r = renderAgentsMdEngine(cwd, cfg);
    expect(r.skipped[0]?.status).toBe("downgrade-skipped");
    expect(r.skipped[0]?.resolution).toBeUndefined();
  });
});

describe("attachResolution guard", () => {
  const base: SkippedFile = { path: "x", reason: "r", status: "user-modified-skipped" };

  it("never attaches to a downgrade-skipped skip (and does not render)", () => {
    let rendered = false;
    const down: SkippedFile = { ...base, status: "downgrade-skipped" };
    const out = attachResolution(down, {
      absPath: join(cwd, "x"),
      basis: "a",
      render: () => {
        rendered = true;
        return "b";
      },
    });
    expect(out).toBe(down);
    expect(rendered).toBe(false);
  });

  it("C-A4: no resolution when the forced render equals the basis", () => {
    writeFileSync(join(cwd, "x"), "same");
    expect(
      attachResolution(base, { absPath: join(cwd, "x"), basis: "same", render: () => "same" })
        .resolution,
    ).toBeUndefined();
  });

  it("C-M: a throwing forced render leaves the plain skip", () => {
    writeFileSync(join(cwd, "x"), "a");
    const out = attachResolution(base, {
      absPath: join(cwd, "x"),
      basis: "a",
      render: () => {
        throw new Error("bad asset");
      },
    });
    expect(out).toBe(base);
  });

  it("a null forced render (unsafe) leaves the plain skip", () => {
    writeFileSync(join(cwd, "x"), "a");
    expect(
      attachResolution(base, { absPath: join(cwd, "x"), basis: "a", render: () => null }),
    ).toBe(base);
  });

  it("a missing destination gets no resolution", () => {
    expect(existsSync(join(cwd, "ghost"))).toBe(false);
    expect(
      attachResolution(base, { absPath: join(cwd, "ghost"), basis: "a", render: () => "b" }),
    ).toBe(base);
  });
});
