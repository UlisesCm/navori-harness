import { describe, it, expect } from "vitest";
import {
  splitFrontmatter,
  parseFrontmatterFields,
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

  it("reads a single field, or null when absent", () => {
    const fm = "name: foo\ntype: behavior";
    expect(getFrontmatterField(fm, "type")).toBe("behavior");
    expect(getFrontmatterField(fm, "missing")).toBeNull();
  });

  it("strips frontmatter and trims the body", () => {
    expect(stripFrontmatter(WITH_FM)).toBe("# Body\n\ntext");
    expect(stripFrontmatter("no fm here\n")).toBe("no fm here");
  });
});
