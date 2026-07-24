import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  GLOBAL_SKILLS_CATALOG,
  listGlobalSkillIds,
  isKnownGlobalSkillId,
  globalSkillSource,
  globalSkillMarkerSource,
  resolveGlobalSkillAsset,
  globalSkillAuxFiles,
  globalSkillPromptHint,
  truncateForHint,
} from "../global-skills.ts";

describe("GLOBAL_SKILLS_CATALOG", () => {
  it("carries exactly the 6 core skills + 13 promoted skills, no more", () => {
    const ids = listGlobalSkillIds();
    expect(ids).toHaveLength(19);
    expect(new Set(ids).size).toBe(19); // no duplicate ids
  });

  it("classifies the 6 bundled core skills as core-skill", () => {
    for (const id of [
      "verify-before-done",
      "loop-back-debug",
      "review-diff",
      "pr-create",
      "ticket-intake",
      "spec-bootstrap",
    ]) {
      expect(globalSkillSource(id)).toBe("core-skill");
    }
  });

  it("classifies the 13 promoted skills as global-skill-dir", () => {
    for (const id of [
      "work-unit-commits",
      "branch-pr",
      "chained-pr",
      "pr-comments",
      "issue-creation",
      "comment-writer",
      "judgment-day",
      "cognitive-doc-design",
      "ship-docs",
      "app-ia",
      "dashboard-ia",
      "skill-creator",
      "skill-improver",
    ]) {
      expect(globalSkillSource(id)).toBe("global-skill-dir");
    }
  });

  it("never carries github-pr (absorbed into pr-create)", () => {
    expect(isKnownGlobalSkillId("github-pr")).toBe(false);
  });

  it("isKnownGlobalSkillId is false for an arbitrary id", () => {
    expect(isKnownGlobalSkillId("totally-made-up")).toBe(false);
  });
});

describe("resolveGlobalSkillAsset", () => {
  it("resolves a core-skill id to core-assets/skills/<id>.md", () => {
    const loc = resolveGlobalSkillAsset("pr-create");
    expect(loc).not.toBeNull();
    expect(loc!.entryFile).toBe("pr-create.md");
    expect(existsSync(join(loc!.dir, loc!.entryFile))).toBe(true);
  });

  it("resolves a global-skill-dir id to core-assets/global-skills/<id>/SKILL.md", () => {
    const loc = resolveGlobalSkillAsset("work-unit-commits");
    expect(loc).not.toBeNull();
    expect(loc!.entryFile).toBe("SKILL.md");
    expect(existsSync(join(loc!.dir, loc!.entryFile))).toBe(true);
    expect(loc!.dir.endsWith(join("global-skills", "work-unit-commits"))).toBe(true);
  });

  it("returns null for an unknown id", () => {
    expect(resolveGlobalSkillAsset("nope")).toBeNull();
  });

  it("every catalog entry resolves to a file that actually exists on disk", () => {
    for (const { id } of GLOBAL_SKILLS_CATALOG) {
      const loc = resolveGlobalSkillAsset(id);
      expect(loc, id).not.toBeNull();
      expect(existsSync(join(loc!.dir, loc!.entryFile)), id).toBe(true);
    }
  });
});

describe("globalSkillAuxFiles", () => {
  it("is empty for a core-skill (flat file, no siblings)", () => {
    expect(globalSkillAuxFiles("pr-create")).toEqual([]);
  });

  it("is empty for a promoted skill with no aux files (app-ia)", () => {
    expect(globalSkillAuxFiles("app-ia")).toEqual([]);
  });

  it("lists the reference doc for a promoted skill that ships one (ship-docs)", () => {
    expect(globalSkillAuxFiles("ship-docs")).toEqual([join("references", "ship-docs-playbook.md")]);
  });

  it("lists both aux files for skill-creator (assets/ + references/)", () => {
    const files = globalSkillAuxFiles("skill-creator").sort();
    expect(files).toEqual(
      [join("assets", "SKILL-TEMPLATE.md"), join("references", "skill-style-guide.md")].sort(),
    );
  });
});

describe("globalSkillMarkerSource", () => {
  it("attributes a core-skill to @navori/core", () => {
    expect(globalSkillMarkerSource("pr-create")).toBe("@navori/core");
  });

  it("attributes a promoted skill to its own source id", () => {
    expect(globalSkillMarkerSource("work-unit-commits")).toBe("@navori/global-skill-work-unit-commits");
  });
});

describe("truncateForHint", () => {
  it("returns short text unchanged", () => {
    expect(truncateForHint("short description")).toBe("short description");
  });

  it("truncates long text to ~90 chars at a word boundary with an ellipsis", () => {
    const long =
      "This is a very long description that definitely exceeds ninety characters and should be truncated cleanly";
    const out = truncateForHint(long, 90);
    expect(out.length).toBeLessThanOrEqual(91); // 90 + ellipsis char
    expect(out.endsWith("…")).toBe(true);
    expect(long.startsWith(out.slice(0, -1).trimEnd())).toBe(true);
  });
});

describe("globalSkillPromptHint", () => {
  it("reads the frontmatter description for a core skill", () => {
    const hint = globalSkillPromptHint("pr-create");
    expect(hint.length).toBeGreaterThan(0);
    expect(hint).not.toContain("{{"); // raw frontmatter text, no template noise expected
  });

  it("reads and unquotes the frontmatter description for a promoted skill", () => {
    const hint = globalSkillPromptHint("work-unit-commits");
    expect(hint.startsWith('"')).toBe(false); // JSON-quoted value gets unquoted
    expect(hint.length).toBeGreaterThan(0);
  });

  it("falls back to the id for an unknown id", () => {
    expect(globalSkillPromptHint("not-a-real-skill")).toBe("not-a-real-skill");
  });
});
