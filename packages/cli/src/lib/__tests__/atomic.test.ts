import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileAtomic } from "../atomic.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "navori-atomic-"));
}

describe("writeFileAtomic", () => {
  it("writes content to the destination path", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.txt");
    try {
      writeFileAtomic(path, "hello atomic");
      expect(readFileSync(path, "utf-8")).toBe("hello atomic");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("overwrites existing file atomically", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.txt");
    try {
      writeFileSync(path, "old content", "utf-8");
      writeFileAtomic(path, "new content");
      expect(readFileSync(path, "utf-8")).toBe("new content");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("leaves no temp file behind on success", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.txt");
    try {
      writeFileAtomic(path, "content");
      const entries = readdirSync(dir);
      const tmps = entries.filter((e) => e.includes(".navori.tmp."));
      expect(tmps).toHaveLength(0);
      expect(entries).toContain("out.txt");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("preserves unicode and multi-line content", () => {
    const dir = makeTmpDir();
    const path = join(dir, "out.md");
    const content = "# Título\n\n- Código en inglés\n- Chat es-MX ✓\n";
    try {
      writeFileAtomic(path, content);
      expect(readFileSync(path, "utf-8")).toBe(content);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
