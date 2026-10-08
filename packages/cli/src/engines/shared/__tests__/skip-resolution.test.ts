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
  attachMarkerlessResolution,
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

  // Covers: #1245
  it("#1245: a plugin file WITHOUT any marker (foreign) gets markerlessResolution from a null-existing render, never resolution", () => {
    const request = assetRequest();
    const abs = join(cwd, request.destRelPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    const mine = "user-authored file, no navori marker\n";
    writeFileSync(abs, mine);
    const [skip] = skipsFor(request);
    expect(skip?.status).toBe("user-modified-skipped");
    expect(skip?.resolution).toBeUndefined();
    expect(skip?.markerlessResolution?.basis).toBe(mine);
    // A first-ever render of the asset (existing = null): the user's text is not appended (#637).
    const fresh = skip?.markerlessResolution?.content ?? "";
    expect(fresh).toContain("plugin body v2");
    expect(fresh).not.toContain("user-authored");
    expect(fresh.split("navori:managed start")).toHaveLength(2);
    expect(readFileSync(abs, "utf-8")).toBe(mine);
  });

  // Covers: #1245
  it("#1245: a foreign file with a partial marker or a comment mention gets NO markerlessResolution", () => {
    const request = assetRequest();
    const abs = join(cwd, request.destRelPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    for (const body of [
      'mine\n<!-- navori:managed start id="other" -->\n',
      "see navori:managed docs\n",
    ]) {
      writeFileSync(abs, body);
      const [skip] = skipsFor(request);
      expect(skip?.status).toBe("user-modified-skipped");
      expect(skip?.markerlessResolution).toBeUndefined();
      expect(skip?.resolution).toBeUndefined();
    }
  });

  // Covers: #1245
  it("#1245: a symlinked foreign file gets NO markerlessResolution", () => {
    const request = assetRequest();
    const abs = join(cwd, request.destRelPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(join(cwd, "real.txt"), "mine\n");
    symlinkSync(join(cwd, "real.txt"), abs);
    const [skip] = skipsFor(request);
    expect(skip?.markerlessResolution).toBeUndefined();
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

// Covers: #1245
describe("attachMarkerlessResolution guard", () => {
  const base: SkippedFile = { path: "x", reason: "r", status: "user-modified-skipped" };
  const FRESH = '# navori:managed start id="x"\nbody\n# navori:managed end id="x"\n';
  const input = (renderFresh: () => string | null, basis = "mine\n") => {
    const absPath = join(cwd, "x");
    writeFileSync(absPath, basis);
    return { absPath, basis, resolvableReason: "R", renderFresh };
  };

  it("attaches markerlessResolution (not resolution) and replaces the reason", () => {
    const out = attachMarkerlessResolution(
      base,
      input(() => FRESH),
    );
    expect(out.resolution).toBeUndefined();
    expect(out.markerlessResolution?.content).toBe(FRESH);
    expect(out.reason).toBe("R");
  });

  it("never sets both fields: a skip that already carries one is returned unchanged", () => {
    const has: SkippedFile = { ...base, resolution: { absPath: "a", basis: "b", content: "c" } };
    expect(
      attachMarkerlessResolution(
        has,
        input(() => FRESH),
      ),
    ).toBe(has);
  });

  it("refuses a downgrade-skipped skip without rendering", () => {
    let rendered = false;
    const down: SkippedFile = { ...base, status: "downgrade-skipped" };
    const out = attachMarkerlessResolution(
      down,
      input(() => {
        rendered = true;
        return FRESH;
      }),
    );
    expect(out).toBe(down);
    expect(rendered).toBe(false);
  });

  it("refuses a basis containing navori:managed text, without rendering", () => {
    let rendered = false;
    const out = attachMarkerlessResolution(
      base,
      input(() => {
        rendered = true;
        return FRESH;
      }, '# navori:managed start id="other"\n'),
    );
    expect(out).toBe(base);
    expect(rendered).toBe(false);
  });

  it("a render throw falls back to the plain skip", () => {
    const out = attachMarkerlessResolution(
      base,
      input(() => {
        throw new Error("boom");
      }),
    );
    expect(out).toBe(base);
  });

  it("no offer when the render is null or identical to the basis", () => {
    expect(
      attachMarkerlessResolution(
        base,
        input(() => null),
      ),
    ).toBe(base);
    expect(
      attachMarkerlessResolution(
        base,
        input(() => "mine\n"),
      ),
    ).toBe(base);
  });

  it("refuses a fresh body that is not exactly one managed block (#637 duplication)", () => {
    expect(
      attachMarkerlessResolution(
        base,
        input(() => `${FRESH}${FRESH}`),
      ),
    ).toBe(base);
    expect(
      attachMarkerlessResolution(
        base,
        input(() => "no block at all\n"),
      ),
    ).toBe(base);
  });

  it("refuses a missing destination", () => {
    const out = attachMarkerlessResolution(base, {
      ...input(() => FRESH),
      absPath: join(cwd, "does-not-exist"),
    });
    expect(out).toBe(base);
  });
});
