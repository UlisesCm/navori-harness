import { describe, it, expect } from "vitest";
import {
  injectManagedSection,
  removeManagedSection,
  resolveCondition,
} from "../marker.ts";

const CONTENT = "## Idioma y rol\n\n- Código inglés. Chat es-MX.\n";

describe("injectManagedSection", () => {
  it("creates block when file is empty", () => {
    const result = injectManagedSection("", "idioma-rol", CONTENT);
    expect(result.status).toBe("created");
    expect(result.output).toContain('<!-- navori:managed id="idioma-rol"');
    expect(result.output).toContain('<!-- /navori:managed id="idioma-rol" -->');
    expect(result.output).toContain("## Idioma y rol");
  });

  it("appends to existing content with separator", () => {
    const existing = "# My CLAUDE.md\n\nSome user notes.\n";
    const result = injectManagedSection(existing, "idioma-rol", CONTENT);
    expect(result.status).toBe("created");
    expect(result.output).toMatch(/Some user notes\.\n\n<!-- navori:managed/);
  });

  it("is idempotent: second call returns unchanged", () => {
    const first = injectManagedSection("", "idioma-rol", CONTENT);
    const second = injectManagedSection(first.output, "idioma-rol", CONTENT);
    expect(second.status).toBe("unchanged");
    expect(second.output).toBe(first.output);
  });

  it("detects user modification and skips overwrite", () => {
    const first = injectManagedSection("", "idioma-rol", CONTENT);
    const modified = first.output.replace("inglés", "CHANGED-BY-USER");
    const next = injectManagedSection(modified, "idioma-rol", "## Idioma y rol\n\n- New content.\n");
    expect(next.status).toBe("user-modified-skipped");
    expect(next.output).toBe(modified);
    expect(next.output).toContain("CHANGED-BY-USER");
  });

  it("updates content when user did not modify but new content differs", () => {
    const first = injectManagedSection("", "idioma-rol", CONTENT);
    const newContent = "## Idioma y rol\n\n- Updated.\n";
    const second = injectManagedSection(first.output, "idioma-rol", newContent);
    expect(second.status).toBe("updated");
    expect(second.output).toContain("- Updated.");
    expect(second.output).not.toContain("- Código inglés");
  });

  it("only touches the targeted id when multiple blocks exist", () => {
    let working = "";
    working = injectManagedSection(working, "a", "Block A\n").output;
    working = injectManagedSection(working, "b", "Block B\n").output;
    const updated = injectManagedSection(working, "a", "Block A updated\n");
    expect(updated.status).toBe("updated");
    expect(updated.output).toContain("Block A updated");
    expect(updated.output).toContain("Block B");
  });

  it("normalizes trailing whitespace in stored content", () => {
    const messy = "## Title\n\n- Item\n\n\n\n";
    const result = injectManagedSection("", "x", messy);
    expect(result.status).toBe("created");
    // Re-injecting the canonical form must be idempotent
    const second = injectManagedSection(result.output, "x", messy);
    expect(second.status).toBe("unchanged");
  });

  it("hash in marker is 8 hex chars", () => {
    const result = injectManagedSection("", "x", CONTENT);
    const match = result.output.match(/hash="([a-f0-9]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toHaveLength(8);
  });

  it("cleans an orphan open marker (no matching close) before injecting", () => {
    // The user accidentally deleted the close marker, leaving just the open
    const corrupted =
      '<!-- navori:managed id="x" hash="aaaaaaaa" -->\n\nrandom user content that does not belong\n\nmore stuff\n';
    const result = injectManagedSection(corrupted, "x", "Fresh content\n");
    expect(result.status).toBe("created");
    // Must NOT have two opens
    const openCount = (result.output.match(/<!-- navori:managed id="x"/g) ?? []).length;
    expect(openCount).toBe(1);
    // Must have the new content
    expect(result.output).toContain("Fresh content");
    // Must have a close
    expect(result.output).toContain('<!-- /navori:managed id="x" -->');
  });

  it("cleans an orphan close marker (no matching open) before injecting", () => {
    const corrupted =
      "Some pre-existing content\n\n<!-- /navori:managed id=\"y\" -->\n\nmore\n";
    const result = injectManagedSection(corrupted, "y", "Hello\n");
    expect(result.status).toBe("created");
    const closeCount = (result.output.match(/<!-- \/navori:managed id="y" -->/g) ?? []).length;
    expect(closeCount).toBe(1);
  });

  it("treats CRLF line endings as equivalent to LF (no phantom conflicts)", () => {
    // First write with LF (the canonical form the CLI uses)
    const first = injectManagedSection("", "x", "## Title\n\n- Item one\n- Item two\n");
    expect(first.status).toBe("created");

    // Simulate a Windows editor / .gitattributes converting the whole file to CRLF
    const crlfVersion = first.output.replace(/\n/g, "\r\n");

    // Re-injecting the same content must be unchanged, not flagged as user-modified
    const second = injectManagedSection(crlfVersion, "x", "## Title\n\n- Item one\n- Item two\n");
    expect(second.status).toBe("unchanged");
  });

  it("ignores partial marker strings (text containing 'navori:managed' but not as comment)", () => {
    const fake = "Plain text mentioning navori:managed in passing.\n";
    const result = injectManagedSection(fake, "x", CONTENT);
    expect(result.status).toBe("created");
    // The fake string should be preserved before the new block
    expect(result.output).toMatch(/Plain text.*\n\n<!-- navori:managed id="x"/s);
  });
});

describe("removeManagedSection", () => {
  it("removes existing block", () => {
    const withBlock = injectManagedSection("", "x", CONTENT).output;
    const removed = removeManagedSection(withBlock, "x");
    expect(removed).not.toContain("navori:managed");
    expect(removed).not.toContain("## Idioma y rol");
  });

  it("is no-op when block does not exist", () => {
    const input = "# Just text.\n";
    expect(removeManagedSection(input, "missing-id")).toBe(input);
  });

  it("preserves other blocks", () => {
    let working = "";
    working = injectManagedSection(working, "keep", "Keep me\n").output;
    working = injectManagedSection(working, "drop", "Drop me\n").output;
    const after = removeManagedSection(working, "drop");
    expect(after).toContain("Keep me");
    expect(after).not.toContain("Drop me");
    expect(after).not.toContain('id="drop"');
  });
});

describe("resolveCondition", () => {
  it("returns true for truthy nested path", () => {
    const config = { plugins: { engram: { enabled: true } } };
    expect(resolveCondition(config, "plugins.engram.enabled")).toBe(true);
  });

  it("returns false for falsy leaf", () => {
    const config = { plugins: { engram: { enabled: false } } };
    expect(resolveCondition(config, "plugins.engram.enabled")).toBe(false);
  });

  it("returns false when any segment is missing", () => {
    const config = { plugins: {} };
    expect(resolveCondition(config, "plugins.engram.enabled")).toBe(false);
  });

  it("returns false for empty config", () => {
    expect(resolveCondition({}, "anything.at.all")).toBe(false);
  });

  it("works with single-segment paths", () => {
    expect(resolveCondition({ ok: true }, "ok")).toBe(true);
    expect(resolveCondition({ ok: false }, "ok")).toBe(false);
  });
});
