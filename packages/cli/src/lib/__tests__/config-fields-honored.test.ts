import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../../engines/claude/index.ts";
import { readRenderedVersion } from "../../commands/status.ts";
import { NavoriConfigSchema } from "../schema.ts";
import type { NavoriConfig } from "../config.ts";

/**
 * #604 — three fields `navori.config.json` declared and the render didn't honour.
 *
 * The repo's stated invariant is that the config is the source of truth and
 * `render` rebuilds everything from it. Each case below pins one field that
 * used to break it: a value the doctrine cited but never received, a name that
 * meant two different things, and a question the wizard asked and threw away.
 */

const BASE = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
} as const;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-604-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("#604 — `commits` reaches the doctrine that cites it", () => {
  /** Every asset that used to send the agent to read the config itself. */
  const SURFACES = [
    ".claude/agents/commit-pr-pilot.md",
    ".claude/agents/implementer.md",
    "CLAUDE.md",
  ];

  it("renders the configured value, not a pointer to the config", () => {
    renderClaudeEngine(cwd, { ...BASE, commits: "conventional" } as unknown as NavoriConfig);
    for (const rel of SURFACES) {
      const body = readFileSync(join(cwd, rel), "utf-8");
      // The dangling citation is gone…
      expect(body, `${rel} still points at the config`).not.toContain("config's `commits`");
      // …and an unresolved placeholder never ships either.
      expect(body, `${rel} shipped an unresolved placeholder`).not.toContain("{{commits}}");
    }
  });

  it("distinguishes two repos that declare different commit styles", () => {
    renderClaudeEngine(cwd, { ...BASE, commits: "conventional" } as unknown as NavoriConfig);
    const english = readFileSync(join(cwd, ".claude/agents/commit-pr-pilot.md"), "utf-8");

    const other = mkdtempSync(join(tmpdir(), "navori-604-b-"));
    try {
      renderClaudeEngine(other, { ...BASE, commits: "conventional-es" } as unknown as NavoriConfig);
      const spanish = readFileSync(join(other, ".claude/agents/commit-pr-pilot.md"), "utf-8");
      // Before #604 these two files were byte-identical: the field was declared
      // and never delivered, so both repos got the same instruction.
      expect(spanish).not.toEqual(english);
      expect(english).toContain("conventional");
      expect(spanish).toContain("conventional-es");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("#604 — `version` no longer answers two questions with one name", () => {
  it("reads the navori release that rendered the harness", () => {
    renderClaudeEngine(cwd, { ...BASE, commits: "conventional-es" } as unknown as NavoriConfig);
    const rendered = readRenderedVersion(cwd);
    // Whatever the CLI's version is, it is NOT the project's default "1.0.0" —
    // which is exactly what `status` used to print as if it were the harness's.
    expect(rendered).toBeTruthy();
    expect(rendered).not.toBe(BASE.version);
    const settings = JSON.parse(readFileSync(join(cwd, ".claude/settings.json"), "utf-8")) as {
      $navori: { version: string };
    };
    expect(rendered).toBe(settings.$navori.version);
  });

  it("answers null instead of guessing when nothing was rendered", () => {
    expect(readRenderedVersion(cwd)).toBeNull();
  });

  it("answers null on a settings.json that is not navori's", () => {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude/settings.json"), JSON.stringify({ permissions: {} }));
    expect(readRenderedVersion(cwd)).toBeNull();
  });
});

describe("#604 — `agentAssignments` is gone without breaking existing configs", () => {
  it("no longer belongs to the schema", () => {
    const shape = NavoriConfigSchema.parse({ ...BASE, commits: "conventional-es" });
    expect(Object.keys(shape)).not.toContain("agentAssignments");
  });

  // The whole reason removal is safe: the top-level passthrough keeps an
  // unknown key harmlessly, so a config written by an older navori still
  // parses — the same exit `skills` took in #236.
  it("still parses a config that carries the retired field", () => {
    const legacy = {
      ...BASE,
      commits: "conventional-es",
      agentAssignments: { "jscpd-protocol": "reviewer" },
    };
    const parsed = NavoriConfigSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
  });

  it("renders identically with and without it", () => {
    const withField = {
      ...BASE,
      commits: "conventional-es",
      agentAssignments: { "jscpd-protocol": "reviewer" },
    } as unknown as NavoriConfig;
    renderClaudeEngine(cwd, withField);
    const a = readFileSync(join(cwd, "CLAUDE.md"), "utf-8");

    const other = mkdtempSync(join(tmpdir(), "navori-604-c-"));
    try {
      renderClaudeEngine(other, { ...BASE, commits: "conventional-es" } as unknown as NavoriConfig);
      expect(readFileSync(join(other, "CLAUDE.md"), "utf-8")).toEqual(a);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
