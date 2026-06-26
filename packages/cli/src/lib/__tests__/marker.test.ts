import { describe, it, expect } from "vitest";
import {
  injectManagedSection,
  removeManagedSection,
  extractManagedContent,
  reorderManagedBlocks,
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

  it("collapses an empty HTML section to one line (spec 0003 §3.2.4)", () => {
    const result = injectManagedSection("", "skills", "");
    expect(result.status).toBe("created");
    // open marker immediately followed by close marker — no blank body line
    expect(result.output).toMatch(/id="skills"[^\n]*--><!-- \/navori:managed id="skills" -->/);
    // round-trips: re-injecting empty content is a no-op
    const again = injectManagedSection(result.output, "skills", "");
    expect(again.status).toBe("unchanged");
    expect(again.output).toBe(result.output);
  });

  it("collapses an empty shell section to two lines, no blank body", () => {
    const result = injectManagedSection("", "guard", "", {}, "shell");
    expect(result.status).toBe("created");
    expect(result.output).toMatch(
      /# navori:managed start id="guard"[^\n]*\n# navori:managed end id="guard"/,
    );
    const again = injectManagedSection(result.output, "guard", "", {}, "shell");
    expect(again.status).toBe("unchanged");
    expect(again.output).toBe(result.output);
  });

  it("detects user modification and skips overwrite", () => {
    const first = injectManagedSection("", "idioma-rol", CONTENT);
    const modified = first.output.replace("inglés", "CHANGED-BY-USER");
    const next = injectManagedSection(modified, "idioma-rol", "## Idioma y rol\n\n- New content.\n");
    expect(next.status).toBe("user-modified-skipped");
    expect(next.output).toBe(modified);
    expect(next.output).toContain("CHANGED-BY-USER");
  });

  it("forceOverwrite=true overwrites a user-modified block (sync accept-new, spec 0003 §3.1.4)", () => {
    const first = injectManagedSection("", "idioma-rol", CONTENT);
    const modified = first.output.replace("inglés", "USER-EDIT");
    const newContent = "## Idioma y rol\n\n- New content.\n";

    // Default (no force): the edit is preserved.
    const skipped = injectManagedSection(modified, "idioma-rol", newContent);
    expect(skipped.status).toBe("user-modified-skipped");

    // accept-new: force overwrites the hand-edited block.
    const forced = injectManagedSection(modified, "idioma-rol", newContent, {}, "html", true);
    expect(forced.status).toBe("updated");
    expect(forced.output).toContain("- New content.");
    expect(forced.output).not.toContain("USER-EDIT");
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

  // The hash is the conflict-detection contract: it must be stable for the same
  // content (no phantom drift) and change when the body changes (real drift is
  // caught). Length alone never exercised either property (#6).
  it("hash is deterministic: identical content yields the same hash (#6)", () => {
    const hashOf = (out: string) => out.match(/hash="([a-f0-9]+)"/)![1];
    const first = injectManagedSection("", "x", CONTENT);
    const second = injectManagedSection("", "x", CONTENT);
    expect(hashOf(first.output)).toBe(hashOf(second.output));
  });

  it("hash is content-sensitive: a body change yields a different hash (#6)", () => {
    const hashOf = (out: string) => out.match(/hash="([a-f0-9]+)"/)![1];
    const base = injectManagedSection("", "x", CONTENT);
    const changed = injectManagedSection("", "x", `${CONTENT}- Extra rule.\n`);
    expect(hashOf(changed.output)).not.toBe(hashOf(base.output));
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

describe("injectManagedSection — shell commentStyle", () => {
  const SHELL_BODY = "pnpm run typecheck || exit 2\n";

  it("creates block with shell markers", () => {
    const result = injectManagedSection("#!/bin/bash\n", "qg-fast", SHELL_BODY, {}, "shell");
    expect(result.status).toBe("created");
    expect(result.output).toContain('# navori:managed start id="qg-fast"');
    expect(result.output).toContain('# navori:managed end id="qg-fast"');
    expect(result.output).toContain("pnpm run typecheck");
    // Must NOT contain HTML markers
    expect(result.output).not.toContain("<!-- navori:managed");
  });

  it("is idempotent in shell mode", () => {
    const first = injectManagedSection("#!/bin/bash\n", "qg-fast", SHELL_BODY, {}, "shell");
    const second = injectManagedSection(first.output, "qg-fast", SHELL_BODY, {}, "shell");
    expect(second.status).toBe("unchanged");
    expect(second.output).toBe(first.output);
  });

  it("detects user modification in shell mode and skips overwrite", () => {
    const first = injectManagedSection("#!/bin/bash\n", "qg-fast", SHELL_BODY, {}, "shell");
    const modified = first.output.replace("typecheck", "USER-CHANGED-CMD");
    const next = injectManagedSection(modified, "qg-fast", "echo new\n", {}, "shell");
    expect(next.status).toBe("user-modified-skipped");
    expect(next.output).toContain("USER-CHANGED-CMD");
  });

  it("updates content in shell mode when user did not modify", () => {
    const first = injectManagedSection("#!/bin/bash\n", "qg-fast", SHELL_BODY, {}, "shell");
    const newBody = "pnpm run lint && pnpm run typecheck || exit 2\n";
    const second = injectManagedSection(first.output, "qg-fast", newBody, {}, "shell");
    expect(second.status).toBe("updated");
    expect(second.output).toContain("pnpm run lint");
  });

  it("hash in shell marker is 8 hex chars", () => {
    const result = injectManagedSection("", "x", SHELL_BODY, {}, "shell");
    const match = result.output.match(/hash="([a-f0-9]+)"/);
    expect(match).not.toBeNull();
    expect(match![1]).toHaveLength(8);
  });

  it("preserves user-section after the managed block (free-form below)", () => {
    const first = injectManagedSection("#!/bin/bash\n", "qg-fast", SHELL_BODY, {}, "shell");
    const withUserAddition = first.output + "\n# user: my custom check\nbash extra.sh\n";
    const second = injectManagedSection(withUserAddition, "qg-fast", SHELL_BODY, {}, "shell");
    expect(second.status).toBe("unchanged");
    expect(second.output).toContain("# user: my custom check");
    expect(second.output).toContain("bash extra.sh");
  });

  it("CRLF in shell scripts is treated as LF (no phantom conflicts)", () => {
    const first = injectManagedSection("#!/bin/bash\n", "qg-fast", SHELL_BODY, {}, "shell");
    const crlf = first.output.replace(/\n/g, "\r\n");
    const second = injectManagedSection(crlf, "qg-fast", SHELL_BODY, {}, "shell");
    expect(second.status).toBe("unchanged");
  });

  it("cleans an orphan shell open marker before injecting", () => {
    const corrupted =
      '# navori:managed start id="x" hash="aaaaaaaa"\nrandom user content\nthat should not stay\n';
    const result = injectManagedSection(corrupted, "x", "echo fresh\n", {}, "shell");
    expect(result.status).toBe("created");
    const openCount = (result.output.match(/# navori:managed start id="x"/g) ?? []).length;
    expect(openCount).toBe(1);
    expect(result.output).toContain("echo fresh");
  });

  it("ignores text containing 'navori:managed' that is not a real marker", () => {
    const noisy = '# A comment mentioning navori:managed-something\necho hello\n';
    const result = injectManagedSection(noisy, "x", SHELL_BODY, {}, "shell");
    expect(result.status).toBe("created");
    expect(result.output).toMatch(/A comment mentioning/);
  });
});

describe("removeManagedSection — shell commentStyle", () => {
  it("removes shell block by id", () => {
    const withBlock = injectManagedSection("#!/bin/bash\n", "x", "echo hi\n", {}, "shell").output;
    const removed = removeManagedSection(withBlock, "x", "shell");
    expect(removed).not.toContain("navori:managed");
    expect(removed).not.toContain("echo hi");
  });

  it("no-op when block does not exist in shell mode", () => {
    const input = "#!/bin/bash\necho hi\n";
    expect(removeManagedSection(input, "missing", "shell")).toBe(input);
  });
});

describe("extractManagedContent — both styles", () => {
  it("returns the managed body for an html block", () => {
    const withBlock = injectManagedSection("", "x", "Hello\n", {}, "html").output;
    expect(extractManagedContent(withBlock, "x", "html")).toBe("Hello");
  });

  it("returns the managed body for a shell block", () => {
    const withBlock = injectManagedSection("", "x", "echo hi\n", {}, "shell").output;
    expect(extractManagedContent(withBlock, "x", "shell")).toBe("echo hi");
  });

  it("returns null for the wrong commentStyle (markers do not cross styles)", () => {
    const htmlBlock = injectManagedSection("", "x", "Hello\n", {}, "html").output;
    expect(extractManagedContent(htmlBlock, "x", "shell")).toBeNull();
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

describe("reorderManagedBlocks", () => {
  /** Build a doc with blocks in the given order, as injectManagedSection lays them out. */
  const build = (ids: string[]): string =>
    ids.reduce((acc, id) => injectManagedSection(acc, id, `body ${id}`).output, "");

  /** Managed-block ids in document order. */
  const order = (doc: string): string[] =>
    [...doc.matchAll(/<!-- navori:managed id="([^"]+)"/g)].map((m) => m[1]!);

  it("is a no-op when blocks are already in canonical order", () => {
    const doc = build(["a", "b", "c"]);
    const r = reorderManagedBlocks(doc, ["a", "b", "c"]);
    expect(r.reordered).toBe(false);
    expect(r.blockedByInterleaving).toBe(false);
    expect(r.output).toBe(doc); // byte-for-byte idempotent
  });

  it("moves an appended block to its canonical slot", () => {
    const doc = build(["b", "c", "a"]); // 'a' should be first
    const r = reorderManagedBlocks(doc, ["a", "b", "c"]);
    expect(r.reordered).toBe(true);
    expect(order(r.output)).toEqual(["a", "b", "c"]);
    // content of each block survives intact
    expect(extractManagedContent(r.output, "a")).toBe("body a");
  });

  it("is idempotent — re-running on the reordered output changes nothing", () => {
    const once = reorderManagedBlocks(build(["b", "c", "a"]), ["a", "b", "c"]).output;
    const twice = reorderManagedBlocks(once, ["a", "b", "c"]);
    expect(twice.reordered).toBe(false);
    expect(twice.output).toBe(once);
  });

  it("preserves a user preamble above the blocks", () => {
    const doc = "# Mi proyecto\n\n" + build(["b", "a"]);
    const r = reorderManagedBlocks(doc, ["a", "b"]);
    expect(r.output.startsWith("# Mi proyecto\n\n")).toBe(true);
    expect(order(r.output)).toEqual(["a", "b"]);
  });

  it("preserves the user-section below the blocks", () => {
    const doc = build(["b", "a"]) + "\n## Reglas del proyecto\n";
    const r = reorderManagedBlocks(doc, ["a", "b"]);
    expect(order(r.output)).toEqual(["a", "b"]);
    expect(r.output.trimEnd().endsWith("## Reglas del proyecto")).toBe(true);
  });

  it("refuses to reorder when user prose sits between blocks", () => {
    const doc = build(["a"]) + "\nNOTA DEL USUARIO\n\n" + build(["b"]);
    const r = reorderManagedBlocks(doc, ["b", "a"]);
    expect(r.reordered).toBe(false);
    expect(r.blockedByInterleaving).toBe(true);
    expect(r.output).toBe(doc); // untouched
  });

  it("no-ops on fewer than two blocks", () => {
    const doc = build(["a"]);
    expect(reorderManagedBlocks(doc, ["a", "b"]).reordered).toBe(false);
  });

  it("sorts unknown ids after known ones, keeping their relative order", () => {
    const doc = build(["x", "a", "y", "b"]); // x, y not in canonical
    const r = reorderManagedBlocks(doc, ["a", "b"]);
    expect(order(r.output)).toEqual(["a", "b", "x", "y"]);
  });
});
