import { describe, it, expect } from "vitest";
import { detectEol, normalizeEol } from "../eol.ts";

describe("normalizeEol", () => {
  // Covers: R1
  it("converts CRLF and lone CR to LF and leaves LF untouched", () => {
    expect(normalizeEol("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(normalizeEol("a\n\nb")).toBe("a\n\nb");
  });
});

describe("detectEol", () => {
  // Covers: R1
  it("reports CRLF only when the first line break is CRLF", () => {
    expect(detectEol("a\r\nb\r\n")).toBe("\r\n");
    expect(detectEol("a\nb\r\n")).toBe("\n");
    expect(detectEol("a\nb\n")).toBe("\n");
    expect(detectEol("no break")).toBe("\n");
    expect(detectEol("a\rb")).toBe("\n");
  });
});
