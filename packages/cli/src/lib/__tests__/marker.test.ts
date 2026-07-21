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

  // #77 — a brand-new block must land after the LAST managed block, not at the
  // end of the file, so user prose below the managed region never ends up
  // interleaved between blocks (which would block reorderManagedBlocks forever).
  describe("new block insertion with trailing user prose (#77)", () => {
    it("inserts the new block after the last managed block, before user prose", () => {
      const base = injectManagedSection("", "a", "Block A\n").output + "\n## Mis notas\n\n- nota propia\n";
      const result = injectManagedSection(base, "b", "Block B\n");
      expect(result.status).toBe("created");
      // Block B sits between block A and the prose.
      expect(result.output).toMatch(
        /id="a".*Block B.*## Mis notas/s,
      );
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
      expect(result.output.indexOf('end id="b"')).toBeLessThan(result.output.indexOf("# user: custom tail"));
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

describe("splitUserSection / emitUserSection", () => {
  const managedDoc = (ids: string[]) =>
    ids.map((id) => `<!-- navori:managed id="${id}" hash="h" -->\nbody ${id}\n<!-- /navori:managed id="${id}" -->`).join("\n\n");

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
