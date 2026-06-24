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

describe("detectProject — suggested preset never points to a phantom (F1)", () => {
  it("falls back to 'custom' for a turbo monorepo instead of the unshipped 'monorepo-turbopnpm'", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mono" }));
      writeFileSync(join(dir, "turbo.json"), "{}");
      writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
      const d = detectProject(dir);
      // The candidate "monorepo-turbopnpm" has no preset JSON; suggesting it
      // would render the baseline AND emit a "not found" warning.
      expect(d.suggestedPreset).toBe("custom");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("still suggests a real preset when one ships (nextjs)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "web", dependencies: { next: "^15" } }),
      );
      const d = detectProject(dir);
      expect(d.suggestedPreset).toBe("nextjs");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does not treat a pnpm-workspace.yaml with no packages as a monorepo", () => {
    const dir = makeTmp();
    try {
      // Single-package repo that ships pnpm-workspace.yaml only for build
      // config (no `packages:`). Must fall through to the framework preset.
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "api", dependencies: { express: "^4" } }),
      );
      writeFileSync(
        join(dir, "pnpm-workspace.yaml"),
        "onlyBuiltDependencies:\n  - esbuild\n",
      );
      const d = detectProject(dir);
      expect(d.monorepo).toBeNull();
      expect(d.suggestedPreset).toBe("express-mongoose");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does not treat an empty packages list as a monorepo", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "svc", dependencies: { "@nestjs/core": "^10" } }),
      );
      writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
      const d = detectProject(dir);
      expect(d.monorepo).toBeNull();
      expect(d.suggestedPreset).toBe("nestjs");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("still detects a real pnpm monorepo when packages are declared", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mono" }));
      writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n');
      const d = detectProject(dir);
      expect(d.monorepo).not.toBeNull();
      expect(d.monorepo?.tool).toBe("pnpm");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("detectProject — qualityGate only references scripts that exist (F-gate)", () => {
  it("returns null when there is no usable script", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { start: "node ." } }),
      );
      expect(detectProject(dir).qualityGate).toBeNull();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("pairs umbrella 'validate' (full) with a real typecheck (fast)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { validate: "tsc && eslint .", typecheck: "tsc --noEmit" } }),
      );
      expect(detectProject(dir).qualityGate).toEqual({
        fast: "npm run typecheck",
        full: "npm run validate",
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does NOT invent a typecheck script when only 'validate' exists", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { validate: "tsc && eslint ." } }),
      );
      const gate = detectProject(dir).qualityGate;
      expect(gate?.fast).toBe("npm run validate");
      expect(gate?.fast).not.toContain("typecheck");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("uses 'check:all' (full) with an existing 'type-check' (fast)", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { "check:all": "tsc && lint", "type-check": "tsc --noEmit" } }),
      );
      expect(detectProject(dir).qualityGate).toEqual({
        fast: "npm run type-check",
        full: "npm run check:all",
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("composes fast+full from the individual scripts that exist", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { typecheck: "tsc --noEmit", lint: "eslint .", test: "vitest run" } }),
      );
      expect(detectProject(dir).qualityGate).toEqual({
        fast: "npm run typecheck",
        full: "npm run typecheck && npm run lint && npm run test",
      });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("falls fast back to an existing step when no typecheck script exists", () => {
    const dir = makeTmp();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "x", scripts: { test: "vitest run" } }),
      );
      // no typecheck/lint — fast must be a real script (test), never "npm run lint"
      expect(detectProject(dir).qualityGate).toEqual({ fast: "npm run test", full: "npm run test" });
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
