import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../config/schema.ts";
import { projectCodexProfiles, type CodexHostProfileEvidence } from "../../assets/model-profile.ts";
import { inspectCodexCatalog } from "../model-catalog.ts";

const dirs: string[] = [];
function fixture(): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-profile-selection-"));
  dirs.push(cwd);
  return cwd;
}
const config = () =>
  NavoriConfigSchema.parse({
    name: "fixture",
    engines: ["codex"],
    preset: "custom",
    models: { orchestrator: "sonnet" },
    effort: { orchestrator: "medium" },
  });
const provenance = {
  source: "host-catalog-event",
  context: "test-native-context",
  checkedAt: "2026-10-13T12:00:00Z",
  validUntil: "2026-10-13T13:00:00Z",
};
afterEach(() => {
  for (const cwd of dirs.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

describe("Codex selection metadata (Spec 0050 M4)", () => {
  // Covers: R10, R14, R15
  it("freshness-unknown reports a candidate rather than current availability", () => {
    const cwd = fixture();
    const path = join(cwd, "catalog.json");
    writeFileSync(
      path,
      JSON.stringify({
        timestamp: "2099-01-01",
        source: "self-declared",
        models: [{ slug: "gpt-9-luna" }],
      }),
    );
    const row = projectCodexProfiles(cwd, config(), { catalogPath: path })[0];
    expect(row).toMatchObject({
      model: { wouldRender: "gpt-9-luna", effectiveObserved: null },
      effort: { wouldRender: "high" },
      catalog: { status: "unknown" },
      rendered: null,
      observed: null,
      application: { status: "pending" },
    });
    expect(row?.application.remedy).toContain("new native Codex context");
    expect(
      inspectCodexCatalog(
        path,
        { ...provenance, context: "other" },
        provenance.context,
        new Date("2026-10-13T12:30:00Z"),
      ).status,
    ).toBe("unknown");
  });

  // Covers: R15
  it("valid-but-obsolete-catalog needs a bound timestamp/source/context and never uses mtime", () => {
    const cwd = fixture();
    const path = join(cwd, "catalog.json");
    writeFileSync(path, JSON.stringify({ models: [{ slug: "gpt-6-luna" }] }));
    expect(
      inspectCodexCatalog(path, provenance, provenance.context, new Date("2026-10-13T14:00:00Z"))
        .status,
    ).toBe("obsolete");
    expect(
      inspectCodexCatalog(path, provenance, provenance.context, new Date("2026-10-13T12:30:00Z"))
        .status,
    ).toBe("current");
    expect(
      inspectCodexCatalog(path, { ...provenance, checkedAt: "future?" }, provenance.context).status,
    ).toBe("unknown");
    expect(inspectCodexCatalog(path).status).toBe("unknown");
  });

  // Covers: R15, R16
  it.each(["{", '{"models":{}}', '{"models":[{"slug":"unknown-protocol"}]}'])(
    "malformed-catalog %s retains a degraded candidate",
    (contents) => {
      const cwd = fixture();
      const path = join(cwd, "catalog.json");
      writeFileSync(path, contents);
      const row = projectCodexProfiles(cwd, config(), { catalogPath: path })[0];
      expect(row).toMatchObject({
        catalog: { status: "degraded" },
        model: { wouldRender: "gpt-6-luna" },
        observed: null,
      });
    },
  );

  // Covers: R15, R16
  it("offline-catalog preserves explicit pins without claiming support", () => {
    const cwd = fixture();
    const cfg = config();
    cfg.models = {
      ...cfg.models,
      codexProfiles: { orchestrator: { model: "gpt-99-sol", effort: "max" } },
    };
    const row = projectCodexProfiles(cwd, cfg, { catalogPath: null })[0];
    expect(row).toMatchObject({
      catalog: { status: "degraded" },
      model: { wouldRender: "gpt-99-sol", source: "pin" },
      effort: { wouldRender: "max" },
      observed: null,
      application: { status: "pending" },
    });
  });

  // Covers: R14, R18
  it.each(["unsupported-effort", "unsupported-model", "rejected"] as const)(
    "%s keeps the exact requested pair pending with a concrete remedy",
    (selection) => {
      const cwd = fixture();
      const evidence: CodexHostProfileEvidence = {
        nativeName: "orchestrator",
        context: "native-fixture",
        evidenceRef: "captured-fixture-event",
        requestedModel: "gpt-6-luna",
        requestedEffort: "high",
        selection,
      };
      const row = projectCodexProfiles(cwd, config(), {
        catalogPath: null,
        context: "native-fixture",
        hostEvidence: [evidence],
      })[0];
      expect(row).toMatchObject({
        model: { wouldRender: "gpt-6-luna" },
        effort: { wouldRender: "high" },
        observed: null,
        application: { status: "pending" },
      });
      expect(row?.diagnostics).toContain(`native host ${selection}; selection stopped`);
      expect(row?.application.remedy).toContain("no automatic substitution");
    },
  );

  // Covers: R14, R18
  it("only projects supplied host-linked observation and retains configured/observed mismatch", () => {
    const cwd = fixture();
    const evidence: CodexHostProfileEvidence = {
      nativeName: "orchestrator",
      context: "native-fixture",
      evidenceRef: "captured-fixture-event",
      requestedModel: "gpt-6-luna",
      requestedEffort: "high",
      selection: "observed",
      model: "gpt-6-sol",
      effort: "medium",
    };
    const row = projectCodexProfiles(cwd, config(), {
      catalogPath: null,
      context: "native-fixture",
      hostEvidence: [evidence],
    })[0];
    expect(row?.model.wouldRender).toBe("gpt-6-luna");
    expect(row?.observed).toMatchObject({
      model: "gpt-6-sol",
      effort: "medium",
      evidenceRef: "captured-fixture-event",
    });
    for (const bad of [
      { ...evidence, context: "unbound" },
      { ...evidence, evidenceRef: "" },
      { ...evidence, requestedEffort: "low" },
    ]) {
      expect(
        projectCodexProfiles(cwd, config(), {
          catalogPath: null,
          context: "native-fixture",
          hostEvidence: [bad],
        })[0]?.observed,
      ).toBeNull();
    }
  });
});
