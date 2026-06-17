import { describe, it, expect, afterEach } from "vitest";
import { hasBinary } from "../which.ts";

describe("hasBinary", () => {
  const savedPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = savedPath;
  });

  it("finds a binary that exists in PATH", () => {
    // node is running this test, so it must be resolvable on PATH.
    expect(hasBinary("node")).toBe(true);
  });

  it("returns false for a binary that does not exist", () => {
    expect(hasBinary("definitely-not-a-real-binary-xyz123")).toBe(false);
  });

  it("returns false when PATH is empty", () => {
    process.env.PATH = "";
    expect(hasBinary("node")).toBe(false);
  });
});
