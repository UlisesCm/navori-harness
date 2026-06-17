import { describe, it, expect } from "vitest";
import { formatLineDiff } from "../diff.ts";

// Strip ANSI so assertions don't depend on whether colors are emitted.
const plain = (s: string): string => s.replace(/\[[0-9;]*m/g, "");

describe("formatLineDiff", () => {
  it("shows no +/- markers for identical content", () => {
    const out = plain(formatLineDiff("a\nb", "a\nb"));
    expect(out).not.toMatch(/^[-+] /m);
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  it("marks removed and added lines", () => {
    const out = plain(formatLineDiff("old", "new"));
    expect(out).toContain("- old");
    expect(out).toContain("+ new");
  });

  it("handles null inputs", () => {
    expect(typeof formatLineDiff(null, null)).toBe("string");
    expect(plain(formatLineDiff(null, "x"))).toContain("+ x");
    expect(plain(formatLineDiff("y", null))).toContain("- y");
  });
});
