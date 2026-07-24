import { describe, it, expect } from "vitest";
import {
  splitFrontmatter,
  parseFrontmatterFields,
  parseFrontmatterBlocks,
  getFrontmatterField,
  stripFrontmatter,
} from "../frontmatter.ts";

const WITH_FM = "---\nname: foo\ntype: behavior\n---\n# Body\n\ntext\n";

describe("frontmatter (spec 0003 §3.4.3, issue #11)", () => {
  it("splits frontmatter from body", () => {
    const { frontmatter, body } = splitFrontmatter(WITH_FM);
    expect(frontmatter).toBe("name: foo\ntype: behavior");
    expect(body).toBe("# Body\n\ntext\n");
  });

  it("returns the whole input as body when there is no frontmatter", () => {
    const raw = "#!/usr/bin/env sh\necho hi\n";
    const { frontmatter, body } = splitFrontmatter(raw);
    expect(frontmatter).toBe("");
    expect(body).toBe(raw);
  });

  it("parses key:value fields (last write wins)", () => {
    const fields = parseFrontmatterFields("name: foo\ntype: behavior\nmaxWords: 100");
    expect(fields).toEqual({ name: "foo", type: "behavior", maxWords: "100" });
  });

  it("ignores comment and blank lines", () => {
    const fields = parseFrontmatterFields("name: foo\n# comment\n\ndesc: bar");
    expect(fields).toEqual({ name: "foo", desc: "bar" });
  });

  it("captures an indented nested block as part of its top-level key (metadata.author shape)", () => {
    const fields = parseFrontmatterFields(
      'name: work-unit-commits\nmetadata:\n  author: gentleman-programming\n  version: "1.0"\nlicense: Apache-2.0',
    );
    expect(fields.name).toBe("work-unit-commits");
    expect(fields.metadata).toBe('  author: gentleman-programming\n  version: "1.0"');
    expect(fields.license).toBe("Apache-2.0");
  });
});

// Frontmatter with every hard shape at once: a folded block scalar
// (`description: >`), a nested map (`metadata:`), tab indentation, a
// continuation line that is itself `key: value`-shaped, a colon inside a
// value, and plain flat keys. This is the SKILL-TEMPLATE.md/skill-creator
// family of shapes that the line-based value heuristic corrupted.
const HARD_FM = [
  "name: skill-creator",
  "description: >",
  "  {Brief description of what this skill enables}.",
  "  Trigger: {When the AI should load this skill - be specific}.",
  "license: Apache-2.0",
  "metadata:",
  "\tauthor: gentleman-programming",
  '  version: "1.0"',
].join("\n");

describe("parseFrontmatterBlocks — raw-line preservation", () => {
  it("records the verbatim raw block per key (folded scalar keeps `>` on the key line)", () => {
    const { raws } = parseFrontmatterBlocks(HARD_FM);
    expect(raws.description).toBe(
      "description: >\n  {Brief description of what this skill enables}.\n  Trigger: {When the AI should load this skill - be specific}.",
    );
    expect(raws.name).toBe("name: skill-creator");
  });

  it("round-trip is a fixed point: parse→serialize→parse→serialize is byte-identical", () => {
    const s1 = Object.values(parseFrontmatterBlocks(HARD_FM).raws).join("\n");
    const s2 = Object.values(parseFrontmatterBlocks(s1).raws).join("\n");
    expect(s2).toBe(s1);
    // and for input with no comment/stray lines, serialize IS the input
    expect(s1).toBe(HARD_FM);
  });

  it("tab-indented continuation lines attach to their key's block", () => {
    const { raws, values } = parseFrontmatterBlocks(HARD_FM);
    expect(raws.metadata).toBe('metadata:\n\tauthor: gentleman-programming\n  version: "1.0"');
    expect(values.metadata).toContain("author: gentleman-programming");
  });

  it("a `key: value`-shaped continuation inside a nested block never becomes a top-level key", () => {
    const { values } = parseFrontmatterBlocks(HARD_FM);
    expect(values.author).toBeUndefined();
    expect(values.version).toBeUndefined();
    expect(values.Trigger).toBeUndefined();
  });

  it("a colon inside a flat value stays part of that value", () => {
    const { values } = parseFrontmatterBlocks("description: Trigger: new skills, agent instructions.");
    expect(values.description).toBe("Trigger: new skills, agent instructions.");
  });

  it("a blank line inside an indented block is preserved; a trailing blank before the next key is not attached", () => {
    const fm = "description: >\n  para one.\n\n  para two.\nlicense: MIT";
    const { raws } = parseFrontmatterBlocks(fm);
    expect(raws.description).toBe("description: >\n  para one.\n\n  para two.");
    expect(raws.license).toBe("license: MIT");
  });

  it("parseFrontmatterFields stays the flat values view of the same parse", () => {
    const fields = parseFrontmatterFields(HARD_FM);
    expect(fields.name).toBe("skill-creator");
    expect(fields.license).toBe("Apache-2.0");
  });
});

describe("frontmatter — field reads and stripping", () => {
  it("reads a single field, or null when absent", () => {
    const fm = "name: foo\ntype: behavior";
    expect(getFrontmatterField(fm, "type")).toBe("behavior");
    expect(getFrontmatterField(fm, "missing")).toBeNull();
  });

  it("strips frontmatter and trims the body", () => {
    expect(stripFrontmatter(WITH_FM)).toBe("# Body\n\ntext");
    expect(stripFrontmatter("no fm here\n")).toBe("no fm here");
  });

  // Issue: CRLF-saved files must strip the same as LF (Windows editors).
  it("strips CRLF frontmatter correctly", () => {
    const crlf = "---\r\nname: foo\r\ntype: behavior\r\n---\r\n# Body\r\n\r\ntext\r\n";
    const { frontmatter, body } = splitFrontmatter(crlf);
    expect(frontmatter).toBe("name: foo\r\ntype: behavior");
    expect(parseFrontmatterFields(frontmatter)).toEqual({ name: "foo", type: "behavior" });
    expect(getFrontmatterField(frontmatter, "type")).toBe("behavior");
    expect(body).toBe("# Body\r\n\r\ntext\r\n");
    expect(stripFrontmatter(crlf)).toBe("# Body\r\n\r\ntext");
  });

  // Issue: a document that OPENS with a horizontal-rule `---` (no real
  // frontmatter) must not have its first `---…---` section eaten.
  it("leaves a body that opens with a horizontal-rule --- untouched", () => {
    const hr = "---\nJust a section rule, no metadata\n---\nMore content\n";
    const { frontmatter, body } = splitFrontmatter(hr);
    expect(frontmatter).toBe("");
    expect(body).toBe(hr);
    expect(stripFrontmatter(hr)).toBe(hr.trim());
  });
});
