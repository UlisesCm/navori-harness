import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeConfig, readConfig, ConfigError } from "../config.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "navori-test-"));
}

describe("writeConfig", () => {
  it("writes a valid config with defaults applied", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, {
        name: "test-project",
        engines: ["claude"],
        preset: "custom",
      });
      const parsed = JSON.parse(readFileSync(path, "utf-8"));
      expect(parsed.name).toBe("test-project");
      expect(parsed.engines).toEqual(["claude"]);
      expect(parsed.version).toBe("1.0.0");
      expect(parsed.commits).toBe("conventional-es");
      expect(parsed.branchBase).toBe("main");
      expect(parsed.$schema).toContain("navori.config.v1.json");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects invalid name (must be kebab-case)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      expect(() =>
        writeConfig(path, {
          name: "Invalid Name With Spaces",
          engines: ["claude"],
          preset: "custom",
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("writes atomically: no .tmp file remains in the directory", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, {
        name: "atomic-test",
        engines: ["claude"],
        preset: "custom",
      });
      const remaining = readdirSync(dir);
      const tmps = remaining.filter((e) => e.includes(".navori.tmp."));
      expect(tmps).toHaveLength(0);
      expect(remaining).toContain("navori.config.json");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects unknown engine", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      expect(() =>
        writeConfig(path, {
          name: "test",
          // @ts-expect-error: testing runtime validation
          engines: ["unknown-engine"],
          preset: "custom",
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects unknown model in models override", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      expect(() =>
        writeConfig(path, {
          name: "test",
          engines: ["claude"],
          preset: "custom",
          // @ts-expect-error: testing runtime validation
          models: { reviewer: "gpt4" },
        }),
      ).toThrow();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("readConfig", () => {
  it("reads and validates a written config", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, {
        name: "valid",
        engines: ["claude", "agents-md"],
        preset: "custom",
      });
      const config = readConfig(path);
      expect(config.name).toBe("valid");
      expect(config.engines).toContain("agents-md");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws ConfigError on missing file", () => {
    const dir = makeTmpDir();
    const path = join(dir, "missing.json");
    try {
      expect(() => readConfig(path)).toThrow(ConfigError);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws ConfigError on invalid JSON", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeFileSync(path, "not valid json{", "utf-8");
      expect(() => readConfig(path)).toThrow(ConfigError);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("throws ConfigError on schema mismatch with issues list", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeFileSync(path, JSON.stringify({ name: 42, engines: ["claude"] }), "utf-8");
      try {
        readConfig(path);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigError);
        expect((err as ConfigError).issues).toBeDefined();
        expect((err as ConfigError).issues!.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
