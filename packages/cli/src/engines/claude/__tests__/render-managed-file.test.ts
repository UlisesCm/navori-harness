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
let nestedFmAssetPath: string;
let foldedFmAssetPath: string;
let orphanFmAssetPath: string;
let continuationVarFmAssetPath: string;

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

  // HTML asset with a nested `metadata:` frontmatter block (global skills
  // catalog shape — promoted skills carry `metadata: { author, version }`).
  nestedFmAssetPath = join(dir, "nested-fm.md");
  writeFileSync(
    nestedFmAssetPath,
    `---
name: work-unit-commits
description: "Plan commits as reviewable work units."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

Body text.
`,
    "utf-8",
  );

  // HTML asset with a FOLDED BLOCK SCALAR description (`description: >`) plus
  // a nested map — the SKILL-TEMPLATE.md shape that the old line-based
  // heuristic corrupted (bare `>` pushed to its own line, then dropped).
  foldedFmAssetPath = join(dir, "folded-fm.md");
  writeFileSync(
    foldedFmAssetPath,
    `---
name: template-skill
description: >
  {Brief description of what this skill enables}.
  Trigger: {When the AI should load this skill - be specific}.
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## When to Use

Body text.
`,
    "utf-8",
  );

  // HTML asset whose `metadata:` value is an unresolved placeholder, with
  // indented continuation lines under it — the reviewer's exact repro for
  // the block-level omission bug: a line-level drop of ONLY the
  // `metadata: {{var}}` line left `author`/`version` as orphans that
  // `parseFrontmatterBlocks` misattached to the preceding key (`name`).
  orphanFmAssetPath = join(dir, "orphan-fm.md");
  writeFileSync(
    orphanFmAssetPath,
    `---
name: skill-creator
metadata: {{models.leader}}
  author: gentleman-programming
  version: "1.0"
license: Apache-2.0
---

Body text.
`,
    "utf-8",
  );

  // HTML asset with a placeholder INSIDE a continuation line (not on the key
  // line itself) — the key line has no placeholder to omit, so this exercises
  // ordinary interpolation reaching into a nested block's continuation lines.
  continuationVarFmAssetPath = join(dir, "continuation-var-fm.md");
  writeFileSync(
    continuationVarFmAssetPath,
    `---
name: work-unit-commits
metadata:
  author: gentleman-programming
  version: {{models.leader}}
license: Apache-2.0
---

Body text.
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

describe("renderManagedFile — nested frontmatter block round-trips (global skills catalog)", () => {
  it("first render keeps a nested `metadata:` block intact (author + version)", () => {
    const r = renderManagedFile({
      assetPath: nestedFmAssetPath,
      existingContent: null,
      managedId: "work-unit-commits",
      meta: META,
      config: CONFIG,
    });
    expect(r.status).toBe("created");
    expect(r.content).toContain("metadata:");
    expect(r.content).toContain("  author: gentleman-programming");
    expect(r.content).toContain('  version: "1.0"');
  });

  it("a second render (unchanged source) is idempotent and keeps the nested block", () => {
    const first = renderManagedFile({
      assetPath: nestedFmAssetPath,
      existingContent: null,
      managedId: "work-unit-commits",
      meta: META,
      config: CONFIG,
    });
    const second = renderManagedFile({
      assetPath: nestedFmAssetPath,
      existingContent: first.content,
      managedId: "work-unit-commits",
      meta: META,
      config: CONFIG,
    });
    expect(second.status).toBe("unchanged");
    expect(second.content).toContain("  author: gentleman-programming");
  });

  it("asset wins: a hand-edited nested block is restored from the source on rerender", () => {
    const first = renderManagedFile({
      assetPath: nestedFmAssetPath,
      existingContent: null,
      managedId: "work-unit-commits",
      meta: META,
      config: CONFIG,
    });
    const tampered = first.content.replace("gentleman-programming", "someone-else");
    const second = renderManagedFile({
      assetPath: nestedFmAssetPath,
      existingContent: tampered,
      managedId: "work-unit-commits",
      meta: META,
      config: CONFIG,
    });
    expect(second.content).toContain("gentleman-programming");
    expect(second.content).not.toContain("someone-else");
  });
});

describe("renderManagedFile — block-level omission of unresolved frontmatter keys", () => {
  it("drops the WHOLE `metadata:` block (key + continuations) when its value is unresolved, leaving neighboring keys untouched", () => {
    const cfgNoModel = { ...CONFIG, models: {} } as NavoriConfig;
    const r = renderManagedFile({
      assetPath: orphanFmAssetPath,
      existingContent: null,
      managedId: "skill-creator",
      meta: META,
      config: cfgNoModel,
    });
    const fmBlock = r.content.split("\n---")[0]!;
    // The whole metadata block is gone — no orphaned continuation lines.
    expect(fmBlock).not.toContain("metadata:");
    expect(fmBlock).not.toContain("author: gentleman-programming");
    expect(fmBlock).not.toContain('version: "1.0"');
    // Neighboring keys are untouched — the orphan lines must not have been
    // reattached to `name` (the bug) or swallowed `license`.
    expect(fmBlock).toContain("name: skill-creator");
    expect(fmBlock).not.toMatch(/name: skill-creator\n\s+author/);
    expect(r.content).toContain("license: Apache-2.0");
  });

  it("keeps the `metadata:` block when its value resolves", () => {
    const r = renderManagedFile({
      assetPath: orphanFmAssetPath,
      existingContent: null,
      managedId: "skill-creator",
      meta: META,
      config: CONFIG,
    });
    expect(r.content).toContain("metadata: opus\n  author: gentleman-programming\n  version: \"1.0\"");
    expect(r.content).toContain("name: skill-creator");
    expect(r.content).toContain("license: Apache-2.0");
  });

  it("interpolates a resolved placeholder inside a continuation line (not just the key line)", () => {
    const r = renderManagedFile({
      assetPath: continuationVarFmAssetPath,
      existingContent: null,
      managedId: "work-unit-commits",
      meta: META,
      config: CONFIG,
    });
    expect(r.content).toContain("metadata:\n  author: gentleman-programming\n  version: opus");
  });
});

describe("renderManagedFile — folded block scalar round-trips (raw-line preservation)", () => {
  it("first render keeps `description: >` VERBATIM (indicator on the key line, indented lines intact)", () => {
    const r = renderManagedFile({
      assetPath: foldedFmAssetPath,
      existingContent: null,
      managedId: "template-skill",
      meta: META,
      config: CONFIG,
    });
    expect(r.status).toBe("created");
    expect(r.content).toContain(
      "description: >\n  {Brief description of what this skill enables}.\n  Trigger: {When the AI should load this skill - be specific}.",
    );
    expect(r.content).toContain("metadata:\n  author: gentleman-programming");
  });

  it("render N+1 is a fixed point: second and third renders report unchanged, byte-identical", () => {
    const first = renderManagedFile({
      assetPath: foldedFmAssetPath,
      existingContent: null,
      managedId: "template-skill",
      meta: META,
      config: CONFIG,
    });
    const second = renderManagedFile({
      assetPath: foldedFmAssetPath,
      existingContent: first.content,
      managedId: "template-skill",
      meta: META,
      config: CONFIG,
    });
    expect(second.status).toBe("unchanged");
    expect(second.content).toBe(first.content);
    const third = renderManagedFile({
      assetPath: foldedFmAssetPath,
      existingContent: second.content,
      managedId: "template-skill",
      meta: META,
      config: CONFIG,
    });
    expect(third.status).toBe("unchanged");
    expect(third.content).toBe(first.content);
  });

  it("migration: a destination corrupted by the OLD serializer converges — one `updated` render, then unchanged", () => {
    const good = renderManagedFile({
      assetPath: foldedFmAssetPath,
      existingContent: null,
      managedId: "template-skill",
      meta: META,
      config: CONFIG,
    });
    // Simulate the OLD flattening serializer's ACTUAL damage for this shape
    // (verified against the pre-fix code): the line-based heuristic pushed
    // the bare `>` folded-scalar indicator onto its own line, then dropped
    // that line on the next parse — so ONLY the `>` is lost off the
    // `description:` key line. The description's continuation lines survive
    // untouched, and `metadata:` (a nested map with no same-line value)
    // round-trips fully intact, author/version included — the old
    // serializer never touched it.
    const corrupted = good.content.replace("description: >\n", "description:\n");
    expect(corrupted).not.toBe(good.content); // the substitution actually fired
    // The genuine damage is narrow: only the key line changes.
    expect(corrupted).toContain("  {Brief description of what this skill enables}.");
    expect(corrupted).toContain("  Trigger: {When the AI should load this skill - be specific}.");
    expect(corrupted).toContain("metadata:\n  author: gentleman-programming\n  version: \"1.0\"");

    const repair = renderManagedFile({
      assetPath: foldedFmAssetPath,
      existingContent: corrupted,
      managedId: "template-skill",
      meta: META,
      config: CONFIG,
    });
    expect(repair.status).toBe("updated");
    expect(repair.content).toContain("description: >");
    expect(repair.content).toContain("metadata:\n  author: gentleman-programming");

    const settled = renderManagedFile({
      assetPath: foldedFmAssetPath,
      existingContent: repair.content,
      managedId: "template-skill",
      meta: META,
      config: CONFIG,
    });
    expect(settled.status).toBe("unchanged");
  });

  it("migration: recovers from synthetic worst-case corruption (metadata flattened to empty, description continuation dropped) — not a shape the old serializer actually produced, but a defense-in-depth check", () => {
    const good = renderManagedFile({
      assetPath: foldedFmAssetPath,
      existingContent: null,
      managedId: "template-skill",
      meta: META,
      config: CONFIG,
    });
    // Hand-crafted worst case, NOT real old-serializer output: nested
    // metadata block collapsed to a bare empty `metadata:` line and the
    // folded-scalar indicator lost off the description along with a
    // continuation line. Kept as a stress test of the merge/repair path
    // beyond what migration would ever actually hand it.
    const corrupted = good.content.replace(
      /description: >\n {2}\{Brief[^\n]*\n {2}Trigger[^\n]*\nlicense: Apache-2\.0\nmetadata:\n {2}author: gentleman-programming\n {2}version: "1\.0"/,
      "description:\n  {Brief description of what this skill enables}.\nlicense: Apache-2.0\nmetadata: ",
    );
    expect(corrupted).not.toBe(good.content); // the substitution actually fired

    const repair = renderManagedFile({
      assetPath: foldedFmAssetPath,
      existingContent: corrupted,
      managedId: "template-skill",
      meta: META,
      config: CONFIG,
    });
    expect(repair.status).toBe("updated");
    expect(repair.content).toContain("description: >");
    expect(repair.content).toContain("metadata:\n  author: gentleman-programming");

    const settled = renderManagedFile({
      assetPath: foldedFmAssetPath,
      existingContent: repair.content,
      managedId: "template-skill",
      meta: META,
      config: CONFIG,
    });
    expect(settled.status).toBe("unchanged");
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
