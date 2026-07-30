import { describe, it, expect } from "vitest";
import type { NavoriConfig } from "../../../lib/config.ts";
import { tc } from "../../../lib/i18n.ts";
import { collectOmissionWarnings } from "../prose-harness.ts";

/**
 * C5 regression: engine warnings and skip-reasons must follow `config.language`.
 * Before this, a `language:"en"` repo got an English CLAUDE.md but Spanish
 * warnings. The `tc(lang).engine.*` catalog closes the leak — every key exists
 * in both locales (a missing translation is a compile error) and resolves by
 * the repo's configured language.
 */
describe("engine warning catalog (tc().engine) — C5", () => {
  it("resolves the same key to different prose per locale", () => {
    expect(tc("en").engine.qualityGateHookSkipped).toContain("not set");
    expect(tc("es").engine.qualityGateHookSkipped).toContain("no está definido");
  });

  it("interpolates version into the skip-reason in each locale", () => {
    expect(tc("en").engine.blockFromNewerNavori("1.2.3")).toContain("newer navori (1.2.3)");
    expect(tc("es").engine.blockFromNewerNavori("1.2.3")).toContain("navori más nueva (1.2.3)");
  });

  it("localizes the write-failure message with the engine label", () => {
    expect(tc("en").engine.renderFailedWriting("Codex", "AGENTS.md", "EACCES")).toBe(
      "The Codex render failed writing AGENTS.md: EACCES",
    );
    expect(tc("es").engine.renderFailedWriting(undefined, "CLAUDE.md", "ENOENT")).toBe(
      "El render falló escribiendo CLAUDE.md: ENOENT",
    );
  });
});

describe("collectOmissionWarnings follows config.language — C5", () => {
  const cfg = (language: string): NavoriConfig =>
    ({
      language,
      plugins: { gh: { enabled: true } },
      models: { reviewer: "opus" },
    }) as unknown as NavoriConfig;

  it("emits English warnings for language:'en'", () => {
    const w = collectOmissionWarnings(cfg("en")).join("\n");
    expect(w).toContain("Does not replicate Claude Code-specific infrastructure");
    expect(w).toContain("Plugin blocks omitted");
    expect(w).toContain("doesn't apply outside Claude Code");
    expect(w).not.toContain("No replica");
  });

  it("emits Spanish warnings for language:'es'", () => {
    const w = collectOmissionWarnings(cfg("es")).join("\n");
    expect(w).toContain("No replica la infraestructura específica de Claude Code");
    expect(w).toContain("Bloques de plugins omitidos");
    expect(w).toContain("no aplica fuera de Claude Code");
  });
});
