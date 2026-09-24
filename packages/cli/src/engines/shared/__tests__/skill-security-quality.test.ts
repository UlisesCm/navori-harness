import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getCoreRoot } from "../../../lib/render/bundled-assets.ts";
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
      "--threshold {{shq:jscpdThreshold}}",
    );
    expect(repositoryFile("packages/plugins/semgrep/skills/semgrep-review.md")).toContain(
      "run semgrep over the diff",
    );
    expect(repositoryFile("packages/plugins/semgrep/skills/semgrep-review.md")).toContain(
      "--config=p/default --error --metrics=off",
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
    const manifest = JSON.parse(repositoryFile("packages/cli/package.json")) as {
      version: string;
    };
    expect(references).toContain(`Harness CLI ${manifest.version} assets`);
    expect(references).toContain("previous 0.8.7 entry is the audit baseline");
    expect(references).toContain("49f948faa9258a0c61caceaf225e179651397431");
    expect(references).not.toContain("openai/skills/tree/main");
    expect(references).toContain("Not installed; no roster/config/hook change");
    expect(references).toContain("rollback is no-op");
  });

  // #892 — dropping `disable-model-invocation` moved the opt-in gate from the
  // frontmatter flag into a blocking precondition in the body. This only
  // proves the guard is PRESENT in the text the host distributes, not that
  // the model obeys it — there is no unit-testable way to assert the latter
  // (same limitation as any other prose rule in CLAUDE.md).
  it("keeps spec-bootstrap's opt-in gate as a blocking precondition in the body", () => {
    const specBootstrap = asset("skills/spec-bootstrap.md");
    expect(specBootstrap).not.toContain("disable-model-invocation: true");
    expect(specBootstrap).toContain(
      "Do not write anything under `{{sdd.specsDir}}` unless the user has explicitly accepted",
    );
  });

  // #892 follow-up — `mergeFrontmatter` (engines/claude/frontmatter-merge.ts)
  // treats any frontmatter key the asset no longer declares as a user
  // addition to preserve, so a field REMOVED from the asset silently survives
  // in a self-hosted `.claude/` mirror rendered by an older asset version
  // (caught only by manual review, not by `check:render`, which uses the same
  // merge). This repo self-hosts, so its own `.claude/skills/spec-bootstrap/
  // SKILL.md` is exactly that mirror — pin it directly so this specific stale
  // key can't silently reappear. Does not fix the general class of bug (see
  // implementer's report for the follow-up issue material).
  it("keeps the self-hosted spec-bootstrap mirror free of the retired flag", () => {
    const rendered = repositoryFile(".claude/skills/spec-bootstrap/SKILL.md");
    expect(rendered).not.toContain("disable-model-invocation: true");
  });

  // Covers: R8
  //
  // Reads the expected version from `package.json` instead of a hardcoded
  // literal: `docs/references/skills-security-quality.md` is Markdown, bumped
  // by the scribe (`markdownRequests`, spec 0030's scribeOwnsMarkdown) in its
  // own commit after this one, not by the implementer that bumps the manifest
  // — a hardcoded literal here would need re-touching on every release twice,
  // once wrong until the scribe's commit lands and once again after it does.
  it("keeps the release manifest, provenance, and rendered marker in sync with the manifest version", () => {
    const manifest = JSON.parse(repositoryFile("packages/cli/package.json")) as {
      version: string;
    };
    const references = repositoryFile("docs/references/skills-security-quality.md");
    const agents = repositoryFile("AGENTS.md");

    expect(references).toContain(`Harness CLI ${manifest.version} assets`);
    expect(agents).toContain(`version="${manifest.version}"`);
  });
});
