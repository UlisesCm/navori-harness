import { describe, it, expect } from "vitest";
import {
  injectManagedSection,
  removeManagedSection,
  extractManagedContent,
  reorderManagedBlocks,
  resolveCondition,
  splitUserSection,
  emitUserSection,
  USER_SECTION_START,
  USER_SECTION_END,
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

  it("meta-only update (same content, newer version) preserves the document tail", () => {
    // Regression: on a version bump where a block's content is byte-identical,
    // injectManagedSection took a fast meta-only path that rebuilt the doc up to
    // the block's close marker but DROPPED everything after it — truncating all
    // later blocks and user prose. On `render --all --apply` this silently
    // deleted content. The tail must survive.
    const existing = [
      '<!-- navori:managed id="a" version="0.2.20" source="@navori/core" -->',
      "content A",
      '<!-- /navori:managed id="a" -->',
      "",
      '<!-- navori:managed id="b" version="0.2.20" source="@navori/core" -->',
      "content B",
      '<!-- /navori:managed id="b" -->',
      "",
      "user prose at the very end",
      "",
    ].join("\n");
    const result = injectManagedSection(
      existing,
      "a",
      "content A",
      { source: "@navori/core", version: "0.2.22" },
      "html",
    );
    expect(result.status).toBe("updated");
    expect(result.output).toContain('id="b"');
    expect(result.output).toContain("content B");
    expect(result.output).toContain("user prose at the very end");
    // The updated block carries the new version; nothing after it is lost.
    expect(result.output).toContain('version="0.2.22"');
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
    const next = injectManagedSection(
      modified,
      "idioma-rol",
      "## Idioma y rol\n\n- New content.\n",
    );
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
    const corrupted = 'Some pre-existing content\n\n<!-- /navori:managed id="y" -->\n\nmore\n';
    const result = injectManagedSection(corrupted, "y", "Hello\n");
    expect(result.status).toBe("created");
    const closeCount = (result.output.match(/<!-- \/navori:managed id="y" -->/g) ?? []).length;
    expect(closeCount).toBe(1);
  });

  // #265 — a VALID block plus one stray extra close (the typical hand-edit) must
  // survive: `slice(-0)` used to mark every open for removal when orphanOpens
  // was 0, destroying the good block and appending a duplicate.
  it("keeps a valid block when a stray extra close sits below it (#265)", () => {
    const valid = injectManagedSection("", "foo", "important user-preserved content\n").output;
    // The user, editing by hand, left an extra unmatched close further down.
    const corrupted = `${valid}\nsome prose\n\n<!-- /navori:managed id="foo" -->\n`;
    const result = injectManagedSection(corrupted, "foo", "important user-preserved content\n");
    // The good block is untouched (content + hash still match) — never re-created.
    expect(result.status).toBe("unchanged");
    // Exactly one open and one close survive — no duplicate appended.
    const openCount = (result.output.match(/<!-- navori:managed id="foo"/g) ?? []).length;
    const closeCount = (result.output.match(/<!-- \/navori:managed id="foo" -->/g) ?? []).length;
    expect(openCount).toBe(1);
    expect(closeCount).toBe(1);
    // The user content stays INSIDE the managed region, not stranded as prose.
    expect(extractManagedContent(result.output, "foo")).toBe("important user-preserved content");
    // Prose below the block is preserved.
    expect(result.output).toContain("some prose");
  });

  // #265 secondary — an orphan close BETWEEN two valid pairs must be the one
  // removed, not the last close (which belongs to the second pair). The old
  // "strip closes from the end" logic corrupted the trailing block instead.
  it("removes the middle orphan close, not a valid trailing one (#265)", () => {
    const blockA =
      '<!-- navori:managed id="dup" hash="aaaaaaaa" -->\nbody one\n<!-- /navori:managed id="dup" -->';
    const blockB =
      '<!-- navori:managed id="dup" hash="bbbbbbbb" -->\nbody two\n<!-- /navori:managed id="dup" -->';
    const orphanClose = '<!-- /navori:managed id="dup" -->';
    const corrupted = `${blockA}\n\n${orphanClose}\n\n${blockB}\n`;
    const result = injectManagedSection(corrupted, "dup", "body one\n");
    // Both valid pairs survive: two opens, two closes (the middle orphan gone).
    const openCount = (result.output.match(/<!-- navori:managed id="dup"/g) ?? []).length;
    const closeCount = (result.output.match(/<!-- \/navori:managed id="dup" -->/g) ?? []).length;
    expect(openCount).toBe(2);
    expect(closeCount).toBe(2);
    // The trailing block's body was not corrupted by removing its close.
    expect(result.output).toContain("body two");
    expect(result.output).toContain("body one");
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

  // #77 — a brand-new block must land after the LAST managed block, not at the
  // end of the file, so user prose below the managed region never ends up
  // interleaved between blocks (which would block reorderManagedBlocks forever).
  describe("new block insertion with trailing user prose (#77)", () => {
    it("inserts the new block after the last managed block, before user prose", () => {
      const base =
        injectManagedSection("", "a", "Block A\n").output + "\n## Mis notas\n\n- nota propia\n";
      const result = injectManagedSection(base, "b", "Block B\n");
      expect(result.status).toBe("created");
      // Block B sits between block A and the prose.
      expect(result.output).toMatch(/id="a".*Block B.*## Mis notas/s);
      expect(result.output.indexOf('id="b"')).toBeLessThan(result.output.indexOf("## Mis notas"));
      // Prose survives verbatim at the end.
      expect(result.output.trimEnd().endsWith("- nota propia")).toBe(true);
    });

    it("keeps the managed region contiguous so reorderManagedBlocks is not blocked", () => {
      const base = injectManagedSection("", "b", "Block B\n").output + "\nprosa del usuario\n";
      const withNew = injectManagedSection(base, "a", "Block A\n").output;
      const r = reorderManagedBlocks(withNew, ["a", "b"]);
      expect(r.blockedByInterleaving).toBe(false);
      expect(r.reordered).toBe(true);
      expect(r.output.trimEnd().endsWith("prosa del usuario")).toBe(true);
    });

    it("is idempotent: re-injecting after insertion reports unchanged", () => {
      const base = injectManagedSection("", "a", "Block A\n").output + "\nuser tail\n";
      const first = injectManagedSection(base, "b", "Block B\n");
      const second = injectManagedSection(first.output, "b", "Block B\n");
      expect(second.status).toBe("unchanged");
      expect(second.output).toBe(first.output);
    });

    it("appends at the end when the file has no managed blocks (current behavior)", () => {
      const existing = "# Doc\n\nSolo prosa.\n";
      const result = injectManagedSection(existing, "a", "Block A\n");
      expect(result.status).toBe("created");
      expect(result.output.startsWith("# Doc\n\nSolo prosa.\n")).toBe(true);
      expect(result.output.trimEnd().endsWith('<!-- /navori:managed id="a" -->')).toBe(true);
    });

    it("shell style: new block also lands after the last managed block", () => {
      const base =
        injectManagedSection("#!/bin/bash\n", "a", "echo a\n", {}, "shell").output +
        "\n# user: custom tail\n";
      const result = injectManagedSection(base, "b", "echo b\n", {}, "shell");
      expect(result.status).toBe("created");
      expect(result.output.indexOf('end id="b"')).toBeLessThan(
        result.output.indexOf("# user: custom tail"),
      );
    });
  });

  describe("anti-retroceso / downgrade guard (#79)", () => {
    // A block on disk written by a NEWER navori than the one injecting.
    const newer = injectManagedSection("", "idioma-rol", "NEW body from 0.3.0\n", {
      source: "@navori/core",
      version: "0.3.0",
    }).output;

    it("preserves a block written by a newer version instead of overwriting it", () => {
      const result = injectManagedSection(newer, "idioma-rol", "OLD body from 0.2.9\n", {
        source: "@navori/core",
        version: "0.2.9",
      });
      expect(result.status).toBe("downgrade-skipped");
      expect(result.details?.downgrade).toBe(true);
      expect(result.output).toBe(newer); // byte-for-byte untouched
      expect(result.output).toContain("NEW body from 0.3.0");
      expect(result.output).not.toContain("OLD body from 0.2.9");
    });

    it("does not stamp the version down when content is identical", () => {
      const sameContent = injectManagedSection(newer, "idioma-rol", "NEW body from 0.3.0\n", {
        source: "@navori/core",
        version: "0.2.9",
      });
      // Nothing written, and the newer version marker stays on disk.
      expect(sameContent.output).toBe(newer);
      expect(sameContent.output).toContain('version="0.3.0"');
    });

    it("still overwrites on downgrade when forceOverwrite is set (sync accept-new)", () => {
      const forced = injectManagedSection(
        newer,
        "idioma-rol",
        "OLD body from 0.2.9\n",
        { source: "@navori/core", version: "0.2.9" },
        "html",
        true,
      );
      expect(forced.status).toBe("updated");
      expect(forced.output).toContain("OLD body from 0.2.9");
    });

    it("upgrades normally when the incoming version is newer", () => {
      const upgraded = injectManagedSection(newer, "idioma-rol", "NEWER body 0.4.0\n", {
        source: "@navori/core",
        version: "0.4.0",
      });
      expect(upgraded.status).toBe("updated");
      expect(upgraded.details?.downgrade).toBe(false);
      expect(upgraded.output).toContain("NEWER body 0.4.0");
    });
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
    const noisy = "# A comment mentioning navori:managed-something\necho hello\n";
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

describe("splitUserSection / emitUserSection", () => {
  const managedDoc = (ids: string[]) =>
    ids
      .map(
        (id) =>
          `<!-- navori:managed id="${id}" hash="h" -->\nbody ${id}\n<!-- /navori:managed id="${id}" -->`,
      )
      .join("\n\n");

  it("returns userBody=null and hadMarkers=false for a managed doc with no user zone", () => {
    const doc = managedDoc(["a", "b"]);
    const r = splitUserSection(doc);
    expect(r.userBody).toBeNull();
    expect(r.hadMarkers).toBe(false);
    expect(r.managed).toBe(doc);
  });

  it("extracts the body between explicit markers and reports hadMarkers", () => {
    const doc = `${managedDoc(["a"])}\n\n${USER_SECTION_START}\n\n## Domain\n\n- rule\n\n${USER_SECTION_END}\n`;
    const r = splitUserSection(doc);
    expect(r.hadMarkers).toBe(true);
    expect(r.userBody).toBe("## Domain\n\n- rule");
    expect(r.managed).not.toContain("## Domain");
    expect(r.managed).not.toContain(USER_SECTION_START);
  });

  it("auto-migrates trailing prose from a pre-markers repo", () => {
    const doc = `${managedDoc(["a", "b"])}\n\n## My rules\n\n- keep me\n`;
    const r = splitUserSection(doc);
    expect(r.hadMarkers).toBe(false);
    expect(r.userBody).toBe("## My rules\n\n- keep me");
  });

  it("captures prose appended BELOW the end marker too (merges with the body)", () => {
    const doc = `${managedDoc(["a"])}\n\n${USER_SECTION_START}\n\n## In\n\n${USER_SECTION_END}\n\n## Below\n`;
    const r = splitUserSection(doc);
    expect(r.userBody).toContain("## In");
    expect(r.userBody).toContain("## Below");
  });

  it("never swallows a managed block sitting BELOW the user-section (no data loss)", () => {
    // Corruption case: a managed block was hand-moved below the zone. Anchoring
    // on the LAST managed block keeps both blocks in `managed` — the trailing
    // one is never lifted into the user body and frozen as a literal duplicate.
    const doc = `${managedDoc(["a"])}\n\n${USER_SECTION_START}\n\n## Domain\n\n${USER_SECTION_END}\n\n${managedDoc(["z"])}`;
    const r = splitUserSection(doc);
    expect(r.managed).toContain('id="a"');
    expect(r.managed).toContain('id="z"');
    expect(r.managed).toContain("## Domain"); // prose stays in place (reorder flags interleaving)
    expect(r.userBody).toBeNull();
  });

  it("does not swallow a managed block between stray/duplicate user markers", () => {
    // Two user-start markers with a managed block between the first and the end.
    const doc =
      `${managedDoc(["a"])}\n\n${USER_SECTION_START}\n\nnote\n\n` +
      `${managedDoc(["b"])}\n\n${USER_SECTION_START}\n\ntail\n\n${USER_SECTION_END}\n`;
    const r = splitUserSection(doc);
    // block b must remain a real managed block, never frozen as literal prose.
    expect(r.managed).toContain('id="b"');
    expect(r.userBody).toBe("tail");
  });

  it("preserves a marker token the user quotes inline in their own prose", () => {
    const doc =
      `${managedDoc(["a"])}\n\n${USER_SECTION_START}\n\n` +
      `Los bloques abren con \`${USER_SECTION_START}\` en su propia línea.\n\n${USER_SECTION_END}\n`;
    const r = splitUserSection(doc);
    expect(r.userBody).toContain(`\`${USER_SECTION_START}\` en su propia línea`);
  });

  // #285 case 1 — a managed block QUOTED inside a fenced code block in the user
  // zone must not become the anchor; otherwise splitUserSection swept the real
  // user zone into `managed` and emit injected a second user-start.
  it("does not anchor on a managed block quoted inside a fence (#285)", () => {
    const doc =
      `${managedDoc(["a"])}\n\n${USER_SECTION_START}\n\n` +
      "Real notes.\n\n" +
      "```md\n" +
      '<!-- navori:managed id="example-doc" hash="h" -->\nexample body\n<!-- /navori:managed id="example-doc" -->\n' +
      "```\n\n" +
      `End of our real notes.\n\n${USER_SECTION_END}\n`;
    const r = splitUserSection(doc);
    // The real block 'a' anchors the split — the fenced example is not managed.
    expect(r.managed).toContain('id="a"');
    expect(r.managed).not.toContain("example body");
    // The fenced example + surrounding prose land in the user body verbatim.
    expect(r.userBody).toContain("Real notes.");
    expect(r.userBody).toContain("example body");
    expect(r.userBody).toContain("End of our real notes.");
    // Emit is idempotent: exactly one user-start, and re-splitting recovers it.
    const emitted = emitUserSection(r.managed, r.userBody);
    const startCount = (emitted.match(/<!-- navori:user-start -->/g) ?? []).length;
    expect(startCount).toBe(1);
    expect(splitUserSection(emitted).userBody).toBe(r.userBody);
  });

  // #285 case 2 — user-zone marker lines quoted on their OWN line inside a fence
  // must be kept verbatim; only the real structural markers outside the fence
  // are stripped. Line-exact filtering used to drop them, losing documentation.
  it("preserves marker lines quoted inside a fenced code block (#285)", () => {
    const doc =
      `${managedDoc(["a"])}\n\n${USER_SECTION_START}\n\n` +
      "Los marcadores se ven así:\n\n" +
      "```md\n" +
      `${USER_SECTION_START}\n${USER_SECTION_END}\n` +
      "```\n\n" +
      `${USER_SECTION_END}\n`;
    const r = splitUserSection(doc);
    // Both fenced marker lines survive, wrapped in their fence.
    expect(r.userBody).toContain(`\`\`\`md\n${USER_SECTION_START}\n${USER_SECTION_END}\n\`\`\``);
    // The REAL structural markers (outside the fence) are gone: only the fenced
    // user-start line remains.
    const fencedStarts = r.userBody!.split("\n").filter((l) => l.trim() === USER_SECTION_START);
    expect(fencedStarts).toHaveLength(1);
  });

  it("emitUserSection wraps the body after the managed region", () => {
    const managed = managedDoc(["a"]);
    const out = emitUserSection(managed, "## Domain\n\n- rule");
    expect(out).toContain(USER_SECTION_START);
    expect(out).toContain(USER_SECTION_END);
    expect(out.indexOf("## Domain")).toBeGreaterThan(out.indexOf(USER_SECTION_START));
    // round-trips: splitting the emitted doc recovers the same body
    expect(splitUserSection(out).userBody).toBe("## Domain\n\n- rule");
  });

  it("emitUserSection with null body writes a placeholder that splits back to null", () => {
    const out = emitUserSection(managedDoc(["a"]), null);
    expect(out).toContain(USER_SECTION_START);
    expect(splitUserSection(out).userBody).toBeNull();
    expect(splitUserSection(out).hadMarkers).toBe(true);
  });

  it("split→emit→split is a fixed point for a real domain body", () => {
    const doc = `${managedDoc(["a", "b"])}\n\n${USER_SECTION_START}\n\n## D\n\n- r\n\n${USER_SECTION_END}\n`;
    const s1 = splitUserSection(doc);
    const emitted = emitUserSection(s1.managed, s1.userBody);
    const s2 = splitUserSection(emitted);
    expect(s2.userBody).toBe(s1.userBody);
    expect(emitUserSection(s2.managed, s2.userBody)).toBe(emitted);
  });
});

// #452 — the WRITE path (findMarker + stripOrphanMarkers) must ignore markers
// quoted inside a ```fence```, exactly like the read path (#285 locateManagedBlocks,
// #432 listMarkers). A doc that pastes a managed block verbatim as documentation
// used to steer render onto the QUOTED copy: it read the example's body and, when
// the copy's hash matched its own body (the normal case — the block is pasted with
// its `hash=` attribute), it OVERWROTE the documented example and left the real
// block duplicated.
describe("write path is code-fence aware (#452)", () => {
  const FENCE = "```";
  /** A standalone managed block, exactly as navori writes it (hash included). */
  const block = (id: string, body: string): string =>
    injectManagedSection("", id, body).output.trimEnd();
  const openCount = (doc: string, id: string): number =>
    (doc.match(new RegExp(`<!-- navori:managed id="${id}"`, "g")) ?? []).length;

  // Branch 2 of the issue — the copy's hash is CONSISTENT with its own body
  // (a doc pastes the block verbatim, hash and all). This was the corruption
  // case: injectManagedSection returned `updated` having written over the
  // documented example.
  it("reads and writes the real block, not the verbatim copy quoted in a fence", () => {
    const quoted = block("idioma-rol", "EJEMPLO CITADO\n");
    const real = block("idioma-rol", "CONTENIDO REAL\n");
    const doc = `# Doc\n\nAsí se ve un bloque managed:\n\n${FENCE}md\n${quoted}\n${FENCE}\n\n${real}\n`;

    // Read: the quoted copy comes FIRST in the document and used to win.
    expect(extractManagedContent(doc, "idioma-rol")).toBe("CONTENIDO REAL");

    // Write: lands on the real block; the documented example survives verbatim.
    const r = injectManagedSection(doc, "idioma-rol", "CONTENIDO NUEVO\n");
    expect(r.status).toBe("updated");
    expect(r.output).toContain("CONTENIDO NUEVO");
    expect(r.output).not.toContain("CONTENIDO REAL");
    expect(r.output).toContain(`${FENCE}md\n${quoted}\n${FENCE}`);
    // No duplicate: still one quoted open + one real open.
    expect(openCount(r.output, "idioma-rol")).toBe(2);
  });

  // Branch 1 of the issue — the copy's hash does NOT match its own body (an
  // edited example). It used to return `user-modified-skipped`: render wrote
  // nothing at all, because the hash it compared belonged to the quoted copy.
  it("is not blocked by a quoted copy whose hash no longer matches its body", () => {
    const quoted = block("idioma-rol", "EJEMPLO CITADO\n").replace(
      "EJEMPLO CITADO",
      "EJEMPLO EDITADO A MANO",
    );
    const real = block("idioma-rol", "CONTENIDO REAL\n");
    const doc = `# Doc\n\n${FENCE}md\n${quoted}\n${FENCE}\n\n${real}\n`;

    expect(extractManagedContent(doc, "idioma-rol")).toBe("CONTENIDO REAL");
    const r = injectManagedSection(doc, "idioma-rol", "CONTENIDO NUEVO\n");
    expect(r.status).toBe("updated");
    expect(r.output).toContain("EJEMPLO EDITADO A MANO");
    expect(openCount(r.output, "idioma-rol")).toBe(2);
  });

  // Mutation direction 1 — a REAL block outside every fence is still found,
  // written and removed exactly as before. This is the grave failure mode of a
  // fence-aware parser: losing sight of a real block makes render treat it as
  // absent and append a duplicate.
  it("still finds, updates and removes a real block that sits outside fences", () => {
    const doc = `# Doc\n\n${FENCE}sh\nnavori render --apply\n${FENCE}\n\n${block("a", "cuerpo a\n")}\n`;
    expect(extractManagedContent(doc, "a")).toBe("cuerpo a");

    const updated = injectManagedSection(doc, "a", "cuerpo nuevo\n");
    expect(updated.status).toBe("updated");
    expect(openCount(updated.output, "a")).toBe(1);
    expect(injectManagedSection(updated.output, "a", "cuerpo nuevo\n").status).toBe("unchanged");

    const removed = removeManagedSection(doc, "a");
    expect(removed).not.toContain('id="a"');
    expect(removed).toContain("navori render --apply");
  });

  // Mutation direction 2 — a copy that lives ONLY inside a fence is not a block:
  // it is never read, never removed, and injecting creates a real block beside it.
  it("treats a block quoted only inside a fence as documentation, not as a block", () => {
    const quoted = block("a", "cuerpo citado\n");
    const doc = `# Doc\n\n${FENCE}md\n${quoted}\n${FENCE}\n\nProsa final.\n`;

    expect(extractManagedContent(doc, "a")).toBeNull();
    expect(removeManagedSection(doc, "a")).toBe(doc);

    const r = injectManagedSection(doc, "a", "cuerpo real\n");
    expect(r.status).toBe("created");
    expect(r.output).toContain(`${FENCE}md\n${quoted}\n${FENCE}`);
    expect(r.output).toContain("cuerpo real");
    expect(injectManagedSection(r.output, "a", "cuerpo real\n").status).toBe("unchanged");
  });

  // Mutation direction 3 — an UNBALANCED fence inside a managed body must not
  // leave the scanner "inside a fence" and swallow every later block. Managed
  // bodies are opaque in `proseLines`, so the stray delimiter never toggles it.
  it("keeps later blocks visible past an unbalanced fence inside a managed body", () => {
    let doc = injectManagedSection("", "a", `Un fence sin cerrar:\n\n${FENCE}\n`).output;
    doc = injectManagedSection(doc, "b", "cuerpo b\n").output;

    expect(extractManagedContent(doc, "b")).toBe("cuerpo b");
    const r = injectManagedSection(doc, "b", "cuerpo b v2\n");
    expect(r.status).toBe("updated");
    expect(openCount(r.output, "b")).toBe(1);
    expect(r.output).toContain("cuerpo b v2");
    // Block 'a' — the one carrying the stray delimiter — is untouched.
    expect(extractManagedContent(r.output, "a")).toBe(`Un fence sin cerrar:\n\n${FENCE}`);
  });

  // Mutation direction 4 — `stripOrphanMarkers` shares the scan. A HALF block
  // quoted in a fence (an open with no close, natural when a doc shows just the
  // opening line) used to pair with the REAL block's close, marking the real
  // open as an orphan and deleting it — corrupting the block render was about
  // to write.
  it("never strips a real open because a fence quotes a half marker", () => {
    const real = block("a", "cuerpo real\n");
    const doc = `# Doc\n\nLa apertura se ve así:\n\n${FENCE}md\n<!-- navori:managed id="a" hash="deadbeef" -->\n${FENCE}\n\n${real}\n`;

    const r = injectManagedSection(doc, "a", "cuerpo real\n");
    expect(r.status).toBe("unchanged");
    expect(r.output).toBe(doc);
    expect(extractManagedContent(r.output, "a")).toBe("cuerpo real");
    // The quoted half-marker survives in the user's documentation.
    expect(r.output).toContain(
      `${FENCE}md\n<!-- navori:managed id="a" hash="deadbeef" -->\n${FENCE}`,
    );
  });

  it("never strips an orphan close quoted in a fence", () => {
    const doc = `# Doc\n\n${FENCE}md\n<!-- /navori:managed id="a" -->\n${FENCE}\n\nProsa.\n`;
    const r = injectManagedSection(doc, "a", "cuerpo\n");
    expect(r.status).toBe("created");
    expect(r.output).toContain(`${FENCE}md\n<!-- /navori:managed id="a" -->\n${FENCE}`);
    expect(injectManagedSection(r.output, "a", "cuerpo\n").status).toBe("unchanged");
  });

  // Real orphans OUTSIDE fences are still cleaned — the fence-awareness must not
  // turn stripOrphanMarkers into a no-op.
  it("still strips a real orphan open that sits outside a fence", () => {
    const doc = `<!-- navori:managed id="a" hash="deadbeef" -->\n\nprosa suelta\n`;
    const r = injectManagedSection(doc, "a", "cuerpo\n");
    expect(r.status).toBe("created");
    expect(openCount(r.output, "a")).toBe(1);
    expect(r.output).toContain("cuerpo");
  });

  // The collapsed empty-block shape puts open and close on ONE line, so the
  // close IS a prose line: it must still count as paired, never as an orphan.
  it("does not treat the close of a collapsed empty block as an orphan", () => {
    const empty = injectManagedSection("", "a", "").output;
    expect(empty).toContain('<!-- navori:managed id="a"');
    const r = injectManagedSection(empty, "a", "");
    expect(r.status).toBe("unchanged");
    expect(r.output).toBe(empty);
  });

  it("applies the same fence rule to shell markers", () => {
    const quoted = injectManagedSection("", "guard", "echo citado\n", {}, "shell").output.trimEnd();
    const real = injectManagedSection("", "guard", "echo real\n", {}, "shell").output.trimEnd();
    const doc = `#!/usr/bin/env bash\n# Ejemplo:\n${FENCE}sh\n${quoted}\n${FENCE}\n\n${real}\n`;

    expect(extractManagedContent(doc, "guard", "shell")).toBe("echo real");
    const r = injectManagedSection(doc, "guard", "echo nuevo\n", {}, "shell");
    expect(r.status).toBe("updated");
    expect(r.output).toContain("echo citado");
    expect(r.output).toContain("echo nuevo");
    expect(r.output).not.toContain("echo real");
  });
});
