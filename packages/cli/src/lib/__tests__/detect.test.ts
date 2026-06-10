import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectProject } from "../detect.ts";

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), "navori-detect-"));
}

describe("detectProject — name detection", () => {
  it("detects name from package.json", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-cool-app" }));
      const d = detectProject(dir);
      expect(d.name).toBe("my-cool-app");
      expect(d.sources.name).toBe("package.json");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does not crash when package.json name is not a string", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: { value: "object-name" } }),
      );
      // Must not throw; should fall back to directory name.
      const d = detectProject(dir);
      expect(d.name).not.toBeNull();
      expect(d.name).not.toContain("object");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("reads package.json with UTF-8 BOM at the start", () => {
    const dir = makeTmp();
    try {
      const content = "﻿" + JSON.stringify({ name: "bom-app" });
      writeFileSync(join(dir, "package.json"), content);
      const d = detectProject(dir);
      expect(d.name).toBe("bom-app");
      expect(d.sources.name).toBe("package.json");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("strips npm scope from package name", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@bonum/dashboard" }));
      const d = detectProject(dir);
      expect(d.name).toBe("dashboard");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("falls back to pyproject.toml when no package.json", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "pyproject.toml"),
        '[project]\nname = "my-python-app"\nversion = "0.1.0"\n',
      );
      const d = detectProject(dir);
      expect(d.name).toBe("my-python-app");
      expect(d.sources.name).toBe("pyproject.toml");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("falls back to Cargo.toml when no package.json or pyproject", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "Cargo.toml"),
        '[package]\nname = "my-rust-app"\nversion = "0.1.0"\n',
      );
      const d = detectProject(dir);
      expect(d.name).toBe("my-rust-app");
      expect(d.sources.name).toBe("Cargo.toml");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("falls back to directory name when no manifest exists", () => {
    const parent = makeTmp();
    const target = join(parent, "my-Repo-Name");
    mkdirSync(target);
    try {
      const d = detectProject(target);
      expect(d.name).toBe("my-repo-name");
      expect(d.sources.name).toBe("directory name");
    } finally {
      rmSync(parent, { recursive: true });
    }
  });

  it("normalizes uppercase / spaces / special chars to kebab-case", () => {
    const parent = makeTmp();
    const target = join(parent, "My Cool App!!!");
    mkdirSync(target);
    try {
      const d = detectProject(target);
      expect(d.name).toBe("my-cool-app");
    } finally {
      rmSync(parent, { recursive: true });
    }
  });
});

describe("detectProject — engines detection", () => {
  it("returns empty when no engine artifacts exist", () => {
    const dir = makeTmp();
    try {
      const d = detectProject(dir);
      expect(d.existingEngines).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects .claude/ directory", () => {
    const dir = makeTmp();
    try {
      mkdirSync(join(dir, ".claude"));
      const d = detectProject(dir);
      expect(d.existingEngines).toContain("claude");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects AGENTS.md", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n");
      const d = detectProject(dir);
      expect(d.existingEngines).toContain("agents-md");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects .cursor/ directory", () => {
    const dir = makeTmp();
    try {
      mkdirSync(join(dir, ".cursor"));
      const d = detectProject(dir);
      expect(d.existingEngines).toContain("cursor");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects copilot instructions", () => {
    const dir = makeTmp();
    try {
      mkdirSync(join(dir, ".github"));
      writeFileSync(join(dir, ".github", "copilot-instructions.md"), "# instr\n");
      const d = detectProject(dir);
      expect(d.existingEngines).toContain("copilot");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects multiple engines at once", () => {
    const dir = makeTmp();
    try {
      mkdirSync(join(dir, ".claude"));
      writeFileSync(join(dir, "AGENTS.md"), "# AGENTS\n");
      const d = detectProject(dir);
      expect(d.existingEngines).toContain("claude");
      expect(d.existingEngines).toContain("agents-md");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("detectProject — branchBase detection", () => {
  it("returns null when not a git repo", () => {
    const dir = makeTmp();
    try {
      const d = detectProject(dir);
      expect(d.branchBase).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
