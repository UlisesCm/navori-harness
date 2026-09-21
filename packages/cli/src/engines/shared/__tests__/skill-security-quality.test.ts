import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreRoot } from "../../../lib/bundled-assets.ts";
import { ROSTER_CORE_SKILLS, ROSTER_WORKFLOW_SKILLS } from "../roster.ts";

const coreAssets = resolve(getCoreRoot(), "core-assets");
const asset = (path: string): string => readFileSync(resolve(coreAssets, path), "utf8");
const repositoryFile = (path: string): string =>
  readFileSync(resolve(process.cwd(), "../..", path), "utf8");

describe("skills security and quality inventory", () => {
  // Covers: R1, R2, R5
  it("keeps the audited third-party guidance aligned with locked APIs and canonical gates", () => {
    const citty = asset("lib-skills/citty.md");
    const clack = asset("lib-skills/clack.md");
    const vitest = asset("lib-skills/vitest.md");
    const zod = asset("lib-skills/zod-validation.md");
    const verify = asset("skills/verify-before-done.md");
    const security = asset("skills/security-invariants.md");
    const followUp = asset("skills/follow-up-prs.md");

    expect(citty).toContain("Citty 0.1 supports only `positional`, `string`, and `boolean`");
    expect(citty).not.toContain('type: "enum"');
    expect(clack).toContain("`password`");
    expect(clack).toContain("never open a prompt when `CI` is set");
    expect(vitest).toContain(
      "Use `vi.doMock` only when a test deliberately needs a non-hoisted dynamic import",
    );
    expect(zod).toContain("`z.string()` rejects a `string[]` before transformation");
    expect(verify).toContain("if the installed CLI lacks it, use the repository-built CLI");
    expect(security).toContain("A **401** means authentication is missing or invalid");
    expect(security).toContain("A **403** means an authenticated principal lacks permission");
    expect(followUp).toContain("gh api --paginate");
    expect(followUp).toContain("external\ncheck without an Actions run id");
    expect(repositoryFile("packages/plugins/jscpd/skills/jscpd-review.md")).toContain(
      "bun run jscpd:check",
    );
    expect(repositoryFile("packages/plugins/semgrep/skills/semgrep-review.md")).toContain(
      "bun run semgrep:check",
    );
  });

  // Covers: R3, R5, R6
  it("registers the security router as a concise core skill without replacing its collaborators", () => {
    const security = asset("skills/secure-by-design.md");
    expect(ROSTER_CORE_SKILLS).toContain("secure-by-design");
    expect(security).toContain("authentication, authorization, a trust boundary");
    expect(security).toContain("`security-invariants`");
    expect(security).toContain("`review-diff`");
    expect(security).toContain("`verify-before-done`");
    expect(security).toContain("maxWords: 600");
  });

  // Covers: R4, R5, R6
  it("registers the quality workflow with a measurable evidence matrix", () => {
    const quality = asset("skills/quality-attributes.md");
    expect(ROSTER_WORKFLOW_SKILLS).toContain("quality-attributes");
    expect(quality).toContain(
      "| Attribute | Measurable criterion | Evidence source | Test | Owner |",
    );
    expect(quality).toContain("ISO/IEC 25010:2023 only as a reference model");
    expect(quality).toContain("maxWords: 450");
  });

  // Covers: R1, R7
  it("records closed-inventory provenance and reversible vendor-skill pilots", () => {
    const references = repositoryFile("docs/references/skills-security-quality.md");
    for (const id of [
      "verify-before-done",
      "debug-failure",
      "review-diff",
      "security-invariants",
      "locate-code",
      "resolve-ticket",
      "solution-design",
      "spec-bootstrap",
      "dominio",
      "follow-up-prs",
      "zod-validation",
      "vitest",
      "citty",
      "clack",
    ]) {
      expect(references).toContain(`\`${id}\``);
    }
    expect(references).toContain("security-best-practices");
    expect(references).toContain("security-threat-model");
    expect(references).toContain("Harness CLI 0.9.0 assets");
    expect(references).toContain("previous 0.8.7 entry is the audit baseline");
    expect(references).toContain("49f948faa9258a0c61caceaf225e179651397431");
    expect(references).not.toContain("openai/skills/tree/main");
    expect(references).toContain("Not installed; no roster/config/hook change");
    expect(references).toContain("rollback is no-op");
  });

  // Covers: R8
  it("keeps the release manifest, provenance, and rendered marker on 0.9.0", () => {
    const manifest = JSON.parse(repositoryFile("packages/cli/package.json")) as {
      version: string;
    };
    const references = repositoryFile("docs/references/skills-security-quality.md");
    const agents = repositoryFile("AGENTS.md");

    expect(manifest.version).toBe("0.9.0");
    expect(references).toContain("Harness CLI 0.9.0 assets");
    expect(agents).toContain('version="0.9.0"');
  });
});
