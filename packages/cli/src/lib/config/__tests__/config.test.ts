import { describe, it, expect, vi } from "vitest";
import { writeFileSync, readFileSync, rmSync, mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeConfig,
  readConfig,
  effectiveConfig,
  ConfigError,
  findUnknownConfigKeys,
  checkRetiredConfigKeys,
  migrateRetiredConfigKeys,
  RETIRED_CONFIG_KEYS,
  type RetiredConfigKey,
} from "../config.ts";
import { NavoriConfigSchema } from "../schema.ts";
import { schemaUrl } from "../schema-url.ts";

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
      writeConfig(path, {
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        branchBase: "develop",
      });
      const onDisk = JSON.parse(readFileSync(path, "utf-8"));
      expect("prTarget" in onDisk).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("effectiveConfig — sdd derivation", () => {
  const base = NavoriConfigSchema.parse({
    name: "demo",
    engines: ["claude"],
    preset: "custom",
  });

  it("defaults sdd.enabled to true when the sdd section is absent", () => {
    expect(effectiveConfig(base).sdd?.enabled).toBe(true);
    expect(effectiveConfig(base).sdd?.specsDir).toBe("specs");
  });

  it("respects an explicit sdd.enabled=false (opt out)", () => {
    const c = NavoriConfigSchema.parse({ ...base, sdd: { enabled: false } });
    expect(effectiveConfig(c).sdd?.enabled).toBe(false);
  });

  it("keeps a custom specsDir", () => {
    const c = NavoriConfigSchema.parse({ ...base, sdd: { specsDir: "docs/specs" } });
    expect(effectiveConfig(c).sdd?.specsDir).toBe("docs/specs");
  });

  it("does not persist derived sdd defaults (config on disk stays clean)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeConfig(path, { name: "demo", engines: ["claude"], preset: "custom" });
      const onDisk = JSON.parse(readFileSync(path, "utf-8"));
      expect("sdd" in onDisk).toBe(false);
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
          $schema: schemaUrl("navori.config.v1.json"),
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

describe("config key diagnostics (#779)", () => {
  it("finds typos at each declared level but leaves extension points open", () => {
    expect(
      findUnknownConfigKeys({
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        harnes: {},
        "gitignore-harness": "off",
        project: {
          pluginDefinedPrompt: "allowed",
          foreignHarness: { acknowleged: ["agent:global:other"] },
        },
        plugins: { customPlugin: { enabeld: true } },
      }),
    ).toEqual([
      { path: "harnes", suggestion: "harness" },
      { path: "gitignore-harness", suggestion: "gitignoreHarness" },
      { path: "plugins.customPlugin.enabeld", suggestion: "enabled" },
      { path: "project.foreignHarness.acknowleged", suggestion: "acknowledged" },
    ]);
  });

  it("warns about unknown keys without rejecting a future config", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    const warnings: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      warnings.push(chunk);
      return true;
    }) as never);
    try {
      writeFileSync(
        path,
        JSON.stringify({
          name: "demo",
          engines: ["claude"],
          preset: "custom",
          futureFeature: { enabled: true },
          "gitignore-harness": "off",
        }),
      );

      expect(readConfig(path).gitignoreHarness).toBe("off");
      expect(warnings.join("")).toContain("futureFeature");
      expect(warnings.join("")).toContain("gitignore-harness");
      expect(warnings.join("")).toContain("gitignoreHarness");
    } finally {
      stderr.mockRestore();
      rmSync(dir, { recursive: true });
    }
  });

  it("is silent for a clean config", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    const warnings: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      warnings.push(chunk);
      return true;
    }) as never);
    try {
      writeConfig(path, { name: "demo", engines: ["claude"], preset: "custom" });
      readConfig(path);
      expect(warnings).toEqual([]);
    } finally {
      stderr.mockRestore();
      rmSync(dir, { recursive: true });
    }
  });

  it("warns when a deprecated partial runtime knob is configured", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    const warnings: string[] = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
      warnings.push(chunk);
      return true;
    }) as never);
    try {
      writeConfig(path, {
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        project: { testRunner: "vitest" },
        progress: { dir: "docs/state", currentFile: "now.md", historyFile: "then.md" },
      });
      readConfig(path);
      expect(warnings.join("")).toContain("project.testRunner");
      expect(warnings.join("")).toContain("progress.dir");
      expect(warnings.join("")).toContain("progress.currentFile");
      expect(warnings.join("")).toContain("progress.historyFile");
    } finally {
      stderr.mockRestore();
      rmSync(dir, { recursive: true });
    }
  });
});

describe("retired agent keys fail with replacement and conflicting values", () => {
  // Covers: R40, R42
  const SEED: RetiredConfigKey[] = [
    { key: "leader", replacement: "orchestrator" },
    { key: "researcher", replacement: "scout" },
    { key: "explorer", replacement: "scout" },
  ];

  it("production registry names all five retired agent keys (spec 0026 T11)", () => {
    // The roster rename landed in the SAME commit that removed the old keys
    // from the schema — `RETIRED_CONFIG_KEYS` is populated from here on, not
    // empty like it shipped in T9 (before the schema accepted the replacements).
    expect([...RETIRED_CONFIG_KEYS].sort((a, b) => a.key.localeCompare(b.key))).toEqual([
      { key: "commitPrPilot", replacement: "publisher" },
      { key: "explorer", replacement: "scout" },
      { key: "leader", replacement: "orchestrator" },
      { key: "researcher", replacement: "scout" },
      { key: "ticketAudit", replacement: "auditor" },
    ]);
  });

  it("names the single retired key and its replacement", () => {
    expect(() => checkRetiredConfigKeys({ harness: { leader: false } }, SEED)).toThrowError(
      /harness\.leader está retirada — reemplázala por harness\.orchestrator/,
    );
  });

  it("checks harness, models and effort independently", () => {
    expect(() => checkRetiredConfigKeys({ models: { leader: "opus" } }, SEED)).toThrowError(
      /models\.leader está retirada — reemplázala por models\.orchestrator/,
    );
    expect(() => checkRetiredConfigKeys({ effort: { leader: "high" } }, SEED)).toThrowError(
      /effort\.leader está retirada — reemplázala por effort\.orchestrator/,
    );
  });

  it("speaks the repo's language and names the repair command (#920)", () => {
    // The message is built before the schema parses, so the locale comes off
    // the RAW `language` key. Default (no key) is DEFAULT_LANG = es.
    expect(() =>
      checkRetiredConfigKeys({ language: "en", models: { leader: "opus" } }, SEED),
    ).toThrowError(/models\.leader is retired — replace it with models\.orchestrator/);
    expect(() =>
      checkRetiredConfigKeys({ language: "en", models: { leader: "opus" } }, SEED),
    ).toThrowError(/Run 'navori configure migrate'/);
    expect(() => checkRetiredConfigKeys({ models: { leader: "opus" } }, SEED)).toThrowError(
      /Corre 'navori configure migrate'/,
    );
  });

  it("reports BOTH conflicting values when two retired keys share a replacement", () => {
    try {
      checkRetiredConfigKeys({ harness: { researcher: true, explorer: false } }, SEED);
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const message = (err as ConfigError).message;
      expect(message).toContain("harness.researcher");
      expect(message).toContain("harness.explorer");
      expect(message).toContain("harness.scout");
      expect(message).toContain("harness.researcher=true");
      expect(message).toContain("harness.explorer=false");
    }
  });

  it("does nothing when no retired key is present", () => {
    expect(() => checkRetiredConfigKeys({ harness: { implementer: true } }, SEED)).not.toThrow();
  });

  it("readConfig rejects a config carrying a real retired key (spec 0026 T11)", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      writeFileSync(
        path,
        JSON.stringify({
          name: "demo",
          engines: ["claude"],
          preset: "custom",
          harness: { leader: false },
        }),
        "utf-8",
      );
      // readConfig always calls the exported default (production) registry —
      // this proves the wiring rejects the pre-rename `harness.leader` shape
      // every one of the 28 existing repos carried before spec 0026 T11.
      expect(() => readConfig(path)).toThrowError(ConfigError);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe("migrateRetiredConfigKeys — the repair path R40 lacked (#920)", () => {
  // Covers: R40
  const SEED: RetiredConfigKey[] = [
    { key: "leader", replacement: "orchestrator" },
    { key: "researcher", replacement: "scout" },
    { key: "explorer", replacement: "scout" },
    { key: "ticketAudit", replacement: "auditor" },
  ];

  it("renames a 1:1 retired key and drops the old one", () => {
    const result = migrateRetiredConfigKeys({ models: { leader: "opus" } }, {}, SEED);
    expect(result.config.models).toEqual({ orchestrator: "opus" });
    expect(result.renamed).toEqual([{ from: "models.leader", to: "models.orchestrator" }]);
    expect(result.decisions).toEqual([]);
  });

  it("migrates harness, models and effort independently in one pass", () => {
    const result = migrateRetiredConfigKeys(
      {
        name: "demo",
        harness: { leader: false, implementer: true },
        models: { leader: "opus" },
        effort: { leader: "high" },
      },
      {},
      SEED,
    );
    expect(result.config).toEqual({
      name: "demo",
      harness: { orchestrator: false, implementer: true },
      models: { orchestrator: "opus" },
      effort: { orchestrator: "high" },
    });
    expect(result.renamed).toHaveLength(3);
  });

  it("NEVER infers the N:1 case with different values — it asks", () => {
    const result = migrateRetiredConfigKeys(
      { models: { researcher: "sonnet", explorer: "haiku" } },
      {},
      SEED,
    );
    expect(result.renamed).toEqual([]);
    expect(result.decisions).toEqual([
      {
        target: "models.scout",
        candidates: [
          { path: "models.researcher", value: "sonnet" },
          { path: "models.explorer", value: "haiku" },
        ],
      },
    ]);
    // The retired keys stay put: an unresolved section is left untouched, not
    // half-repaired into something that reads as valid.
    expect(result.config.models).toEqual({ researcher: "sonnet", explorer: "haiku" });
  });

  it("resolves the N:1 case from an explicit choice keyed by target path", () => {
    const result = migrateRetiredConfigKeys(
      { models: { researcher: "sonnet", explorer: "haiku" } },
      { "models.scout": "sonnet" },
      SEED,
    );
    expect(result.config.models).toEqual({ scout: "sonnet" });
    expect(result.decisions).toEqual([]);
    expect(result.renamed).toEqual([
      { from: "models.researcher", to: "models.scout" },
      { from: "models.explorer", to: "models.scout" },
    ]);
  });

  it("does not ask when both retired keys carry the SAME value", () => {
    const result = migrateRetiredConfigKeys(
      { effort: { researcher: "medium", explorer: "medium" } },
      {},
      SEED,
    );
    expect(result.config.effort).toEqual({ scout: "medium" });
    expect(result.decisions).toEqual([]);
  });

  it("a choice never overrides an unambiguous rename", () => {
    const result = migrateRetiredConfigKeys(
      { models: { researcher: "opus" } },
      { "models.scout": "haiku" },
      SEED,
    );
    expect(result.config.models).toEqual({ scout: "opus" });
  });

  it("drops the retired key when its replacement is already set", () => {
    const result = migrateRetiredConfigKeys(
      { models: { ticketAudit: "sonnet", auditor: "sonnet" } },
      {},
      SEED,
    );
    expect(result.config.models).toEqual({ auditor: "sonnet" });
    expect(result.dropped).toEqual([{ from: "models.ticketAudit", to: "models.auditor" }]);
    expect(result.renamed).toEqual([]);
  });

  it("leaves a clean config alone and never mutates its input", () => {
    const input = { models: { orchestrator: "opus" }, plugins: { engram: { enabled: true } } };
    const result = migrateRetiredConfigKeys(input, {}, SEED);
    expect(result.config).toEqual(input);
    expect(result.renamed).toEqual([]);
    expect(result.dropped).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(input.models).toEqual({ orchestrator: "opus" });
  });

  it("mutating the result does not reach back into the input", () => {
    const input = { models: { leader: "opus" } };
    const result = migrateRetiredConfigKeys(input, {}, SEED);
    (result.config.models as Record<string, unknown>).orchestrator = "haiku";
    expect(input.models).toEqual({ leader: "opus" });
  });

  it("the migrated shape of the real blocked configs round-trips through readConfig", () => {
    const dir = makeTmpDir();
    const path = join(dir, "navori.config.json");
    try {
      // The exact shape the 17 blocked repos carry (issue #920): 10 retired
      // keys, `researcher`/`explorer` disagreeing in BOTH sections.
      const broken = {
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        models: {
          leader: "opus",
          researcher: "sonnet",
          explorer: "haiku",
          ticketAudit: "sonnet",
          commitPrPilot: "haiku",
        },
        effort: {
          leader: "high",
          researcher: "medium",
          explorer: "low",
          ticketAudit: "medium",
          commitPrPilot: "low",
        },
      };
      writeFileSync(path, JSON.stringify(broken), "utf-8");
      expect(() => readConfig(path)).toThrowError(ConfigError);

      // Production registry (no SEED) + the global resolution the user picked.
      const result = migrateRetiredConfigKeys(broken, {
        "models.scout": "sonnet",
        "effort.scout": "medium",
      });
      expect(result.decisions).toEqual([]);
      const { $schema: _schema, ...rest } = result.config;
      writeConfig(path, rest as Parameters<typeof writeConfig>[1]);

      const reread = readConfig(path);
      expect(reread.models).toEqual({
        orchestrator: "opus",
        scout: "sonnet",
        auditor: "sonnet",
        publisher: "haiku",
      });
      expect(reread.effort).toEqual({
        orchestrator: "high",
        scout: "medium",
        auditor: "medium",
        publisher: "low",
      });
      // And nothing retired survives on disk.
      expect(readFileSync(path, "utf-8")).not.toMatch(/leader|researcher|explorer|ticketAudit/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
