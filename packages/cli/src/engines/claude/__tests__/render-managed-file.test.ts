import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderManagedFile } from "../render-managed-file.ts";
import { getCoreRoot } from "../../../lib/bundled-assets.ts";
import type { NavoriConfig } from "../../../lib/config.ts";

const CONFIG = {
  name: "test",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm typecheck", full: "pnpm test" },
  models: { leader: "opus" },
} as unknown as NavoriConfig;

let dir: string;
let assetPath: string;
let shellAssetPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rmf-test-"));
  // HTML asset (agent-like)
  assetPath = join(dir, "leader.md");
  writeFileSync(
    assetPath,
    `---
name: leader
description: Orquestador.
tools: Read, Bash
model: {{models.leader}}
---

# Agente Líder

Pre-flight: {{qualityGate.fast}}

<!-- navori:user-section -->
## Reglas del proyecto

<!-- user: fill me -->
`,
    "utf-8",
  );

  // Shell asset (hook-like — no frontmatter)
  shellAssetPath = join(dir, "qg.sh");
  writeFileSync(
    shellAssetPath,
    `#!/usr/bin/env bash
set -euo pipefail
{{qualityGate.fast}}

# navori:user-section
# user: add checks
`,
    "utf-8",
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const META = { source: "@navori/core", version: "0.0.1" };

describe("renderManagedFile — first render (html, frontmatter)", () => {
  it("emits frontmatter + open marker + interpolated body + close marker + user template", () => {
    const r = renderManagedFile({
      assetPath,
      existingContent: null,
      managedId: "leader-base",
      meta: META,
      config: CONFIG,
    });
    expect(r.status).toBe("created");
    expect(r.content).toMatch(/^---\nname: leader\n/);
    // {{models.leader}} resolved → "opus"; line stays
    expect(r.content).toContain("model: opus");
    // managed body interpolated
    expect(r.content).toContain("Pre-flight: pnpm typecheck");
    // markers present
    expect(r.content).toContain('<!-- navori:managed id="leader-base"');
    expect(r.content).toContain('<!-- /navori:managed id="leader-base" -->');
    // user template included
    expect(r.content).toContain("## Reglas del proyecto");
  });

  it("drops `model:` line when models.X is unset (frontmatter mode)", () => {
    const cfgNoModel = { ...CONFIG, models: {} } as NavoriConfig;
    const r = renderManagedFile({
      assetPath,
      existingContent: null,
      managedId: "leader-base",
      meta: META,
      config: cfgNoModel,
    });
    // frontmatter no longer has model: line
    expect(r.content.split("\n---")[0]).not.toMatch(/^model:/m);
    // and the YAML is still well-formed (closing --- present)
    expect(r.content).toMatch(/^---\n[\s\S]+\n---\n/);
  });
});

describe("renderManagedFile — re-render idempotency", () => {
  it("second render with same config is unchanged", () => {
    const first = renderManagedFile({
      assetPath,
      existingContent: null,
      managedId: "leader-base",
      meta: META,
      config: CONFIG,
    });
    const second = renderManagedFile({
      assetPath,
      existingContent: first.content,
      managedId: "leader-base",
      meta: META,
      config: CONFIG,
    });
    expect(second.status).toBe("unchanged");
    expect(second.content).toBe(first.content);
  });

  it("preserves user-section edits across re-renders", () => {
    const first = renderManagedFile({
      assetPath,
      existingContent: null,
      managedId: "leader-base",
      meta: META,
      config: CONFIG,
    });
    const edited = first.content.replace("<!-- user: fill me -->", "MY CUSTOM RULES");
    const second = renderManagedFile({
      assetPath,
      existingContent: edited,
      managedId: "leader-base",
      meta: META,
      config: CONFIG,
    });
    expect(second.content).toContain("MY CUSTOM RULES");
  });

  it("detects user modification of managed body and skips overwrite", () => {
    const first = renderManagedFile({
      assetPath,
      existingContent: null,
      managedId: "leader-base",
      meta: META,
      config: CONFIG,
    });
    const tampered = first.content.replace("Pre-flight: pnpm typecheck", "USER-TAMPERED");
    const second = renderManagedFile({
      assetPath,
      existingContent: tampered,
      managedId: "leader-base",
      meta: META,
      config: CONFIG,
    });
    expect(second.status).toBe("user-modified-skipped");
    expect(second.content).toContain("USER-TAMPERED");
  });
});

describe("renderManagedFile — real core agents render array placeholders (#89)", () => {
  const config = {
    ...CONFIG,
    project: {
      legacyPaths: ["src/legacy", "vendor/old"],
      criticalAreas: ["src/auth", "src/billing"],
    },
  } as unknown as NavoriConfig;

  it("implementer.md renders project.legacyPaths (not empty)", () => {
    const r = renderManagedFile({
      assetPath: resolve(getCoreRoot(), "core-assets/agents/implementer.md"),
      existingContent: null,
      managedId: "implementer-base",
      meta: META,
      config,
    });
    const line = r.content.split("\n").find((l) => l.includes("Paths legacy donde NO aplican"));
    expect(line).toBeTruthy();
    expect(line).toContain("src/legacy, vendor/old");
  });

  it("leader.md renders project.legacyPaths and criticalAreas (not empty)", () => {
    const r = renderManagedFile({
      assetPath: resolve(getCoreRoot(), "core-assets/agents/leader.md"),
      existingContent: null,
      managedId: "leader-base",
      meta: META,
      config,
    });
    expect(r.content).toContain("Carpetas legacy con reglas distintas: src/legacy, vendor/old");
    expect(r.content).toContain("Áreas críticas que requieren review extra: src/auth, src/billing");
  });
});

describe("renderManagedFile — shell (hook without frontmatter)", () => {
  it("emits markers around interpolated body with shell comment style", () => {
    const r = renderManagedFile({
      assetPath: shellAssetPath,
      existingContent: null,
      managedId: "qg-base",
      meta: META,
      config: CONFIG,
    });
    expect(r.status).toBe("created");
    expect(r.content).toContain("#!/usr/bin/env bash");
    expect(r.content).toContain('# navori:managed start id="qg-base"');
    expect(r.content).toContain('# navori:managed end id="qg-base"');
    expect(r.content).toContain("pnpm typecheck");
    expect(r.content).toContain("# user: add checks");
  });
});
