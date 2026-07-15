import { describe, it, expect } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeConfig, readConfig, effectiveConfig, ConfigError } from "../config.ts";
import { NavoriConfigSchema } from "../schema.ts";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "navori-test-"));
}

describe("effectiveConfig — prTarget fallback", () => {
  const base = NavoriConfigSchema.parse({
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
  });

  it("fills prTarget from branchBase when omitted", () => {
    expect(effectiveConfig(base).prTarget).toBe("main");
  });

  it("keeps an explicit prTarget untouched", () => {
    const c = { ...base, prTarget: "develop" };
    expect(effectiveConfig(c).prTarget).toBe("develop");
  });

  it("does not persist the derived prTarget (config on disk stays clean)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, { name: "demo", engines: ["claude"], preset: "custom", branchBase: "develop" });
      const onDisk = JSON.parse(readFileSync(path, "utf-8"));
      expect("prTarget" in onDisk).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("effectiveConfig — typedLanguage derivation", () => {
  const withLang = (codeLanguage?: string) =>
    NavoriConfigSchema.parse({
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      ...(codeLanguage ? { project: { codeLanguage } } : {}),
    });

  it("is true for ts/js/unknown (JS-ecosystem baseline applies)", () => {
    for (const lang of ["ts", "js", "unknown"]) {
      expect(effectiveConfig(withLang(lang)).project?.typedLanguage, lang).toBe(true);
    }
  });

  it("is true when codeLanguage is absent (back-compat with old configs)", () => {
    expect(effectiveConfig(withLang()).project?.typedLanguage).toBe(true);
  });

  it("is false for python/rust/go (TS-only baseline suppressed)", () => {
    for (const lang of ["python", "rust", "go"]) {
      expect(effectiveConfig(withLang(lang)).project?.typedLanguage, lang).toBe(false);
    }
  });

  it("does not persist typedLanguage (config on disk stays clean)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, {
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        project: { codeLanguage: "python" } as never,
      });
      const onDisk = JSON.parse(readFileSync(path, "utf-8"));
      expect("typedLanguage" in (onDisk.project ?? {})).toBe(false);
      expect(onDisk.project.codeLanguage).toBe("python");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

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

  it("preserves unknown fields through a read/write roundtrip (forward compat)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      // Simulate a config written by a future version of navori
      writeFileSync(
        path,
        JSON.stringify({
          $schema: "https://navori.dev/schema/navori.config.v1.json",
          name: "future-app",
          engines: ["claude"],
          preset: "custom",
          // Fields unknown to v0.1
          futureFeature: { enabled: true, settings: { x: 1 } },
          customTeamField: "internal",
        }),
        "utf-8",
      );
      const config = readConfig(path);
      // The known fields validate
      expect(config.name).toBe("future-app");
      // Unknown fields survive in the parsed object
      expect((config as unknown as { futureFeature: unknown }).futureFeature).toEqual({
        enabled: true,
        settings: { x: 1 },
      });
      // Round-trip: writing preserves them
      writeConfig(path, config);
      const reread = JSON.parse(readFileSync(path, "utf-8"));
      expect(reread.futureFeature).toEqual({ enabled: true, settings: { x: 1 } });
      expect(reread.customTeamField).toBe("internal");
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("PRESERVES an unknown engine on write (forward-compat, #79)", () => {
    // #70: reading a config a newer navori wrote must not throw — the tolerant
    // schema drops the unknown engine IN MEMORY so an old CLI keeps working.
    // #79: but WRITING must NOT make that drop permanent, or a stale CLI running
    // `update` would strip a future engine out of a checked-in config.
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, {
        name: "test",
        engines: ["unknown-engine", "claude"],
        preset: "custom",
      });
      const written = JSON.parse(readFileSync(path, "utf-8")) as { engines: string[] };
      // On disk both survive — a newer navori will re-recognize "unknown-engine".
      expect(written.engines).toEqual(["unknown-engine", "claude"]);
      // In memory the old CLI still drops the unknown one so its logic is safe.
      const inMemory = readConfig(path);
      expect(inMemory.engines).toEqual(["claude"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("accepts every MonorepoTool that detect.ts can return", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      for (const tool of ["pnpm", "turbo", "nx", "rush", "lerna", "npm"] as const) {
        writeConfig(path, {
          name: `mono-${tool}`,
          engines: ["claude"],
          preset: "custom",
          monorepo: { enabled: true, tool, workspaces: [] },
        });
        const cfg = readConfig(path);
        expect(cfg.monorepo?.tool).toBe(tool);
        rmSync(path);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a `project` block with defaults and preserves custom keys (passthrough)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, {
        name: "test",
        engines: ["claude"],
        preset: "custom",
        project: {
          legacyPaths: ["src/legacy"],
          criticalAreas: ["src/auth"],
          testRunner: "vitest",
          // Custom key contributed by a plugin prompt — must survive
          customRule: "no-default-export",
        } as never,
      });
      const cfg = readConfig(path);
      expect(cfg.project?.legacyPaths).toEqual(["src/legacy"]);
      expect(cfg.project?.testRunner).toBe("vitest");
      expect((cfg.project as unknown as { customRule: string }).customRule).toBe(
        "no-default-export",
      );
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("project field is optional", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, {
        name: "no-project",
        engines: ["claude"],
        preset: "custom",
      });
      const cfg = readConfig(path);
      expect(cfg.project).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects progress.dir that escapes the cwd (absolute path)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      expect(() =>
        writeConfig(path, {
          name: "test",
          engines: ["claude"],
          preset: "custom",
          progress: { dir: "/etc/escape" } as never,
        }),
      ).toThrow(/relative|must not contain/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects progress.dir containing `..` (traversal)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      expect(() =>
        writeConfig(path, {
          name: "test",
          engines: ["claude"],
          preset: "custom",
          progress: { dir: "progress/../../escape" } as never,
        }),
      ).toThrow(/relative|must not contain/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects progress.currentFile that escapes via traversal", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      expect(() =>
        writeConfig(path, {
          name: "test",
          engines: ["claude"],
          preset: "custom",
          progress: { currentFile: "../escape.md" } as never,
        }),
      ).toThrow(/relative|must not contain/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects monorepo.workspaces[].path that is absolute", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      expect(() =>
        writeConfig(path, {
          name: "test",
          engines: ["claude"],
          preset: "custom",
          monorepo: {
            enabled: true,
            tool: "pnpm",
            workspaces: [{ name: "backend", path: "/etc/backend" }],
          } as never,
        }),
      ).toThrow(/relative|must not contain/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("rejects monorepo.workspaces[].path containing `..`", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      expect(() =>
        writeConfig(path, {
          name: "test",
          engines: ["claude"],
          preset: "custom",
          monorepo: {
            enabled: true,
            tool: "pnpm",
            workspaces: [{ name: "backend", path: "apps/../../escape" }],
          } as never,
        }),
      ).toThrow(/relative|must not contain/);
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
        const issues = (err as ConfigError).issues ?? [];
        // The only invalid field is `name: 42` (expected string in kebab format)
        // and `preset` is missing, so we expect at least the name issue.
        const nameIssue = issues.find((i) => i.path.join(".") === "name");
        expect(nameIssue?.code).toBe("invalid_type");
      }
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
