import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../../..");
const read = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");
const readJson = (rel: string): { packageManager?: string; engines?: { node?: string } } =>
  JSON.parse(read(rel)) as { packageManager?: string; engines?: { node?: string } };

const workflowsDir = join(repoRoot, ".github/workflows");
const workflows = readdirSync(workflowsDir)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => ({ name: f, text: readFileSync(join(workflowsDir, f), "utf8") }));

/** Every value of a `<key>: <value>` workflow line, across all workflows. */
const workflowValues = (key: string): string[] =>
  workflows.flatMap(({ text }) =>
    [...text.matchAll(new RegExp(`^\\s*${key}: (.+)$`, "gm"))].map((m) =>
      (m[1] as string).trim().replace(/^["']|["']$/g, ""),
    ),
  );

const READMES = [
  "README.md",
  "README.es.md",
  "README.zh-CN.md",
  "apps/website/README.md",
  "apps/website/README.es.md",
  "apps/website/README.zh-CN.md",
];

describe("toolchain pins", () => {
  // Covers: R1
  it("pins Node 26.12.1 locally and Bun 1.4.4 with Node 24 in every CI job", () => {
    expect(read(".nvmrc").trim()).toBe("26.12.1");
    const bun = /^bun@(.+)$/.exec(readJson("package.json").packageManager ?? "")?.[1];
    expect(bun).toBe("1.4.4");
    const bunVersions = workflowValues("bun-version");
    expect(bunVersions.length).toBeGreaterThan(0);
    for (const v of bunVersions) expect(v).toBe(bun);
    const nodeVersions = workflowValues("node-version");
    expect(nodeVersions.length).toBeGreaterThan(0);
    for (const v of nodeVersions) expect(v).toBe("24");
  });

  // Covers: R2
  it("keeps root engines at >=24 and the published CLI at >=22.12", () => {
    expect(readJson("package.json").engines?.node).toBe(">=24");
    expect(readJson("packages/cli/package.json").engines?.node).toBe(">=22.12");
  });

  // Covers: R5
  it("pins every workflow action to a full commit SHA with a release comment", () => {
    const uses = workflows.flatMap(({ text }) =>
      [...text.matchAll(/^\s*(?:- )?uses: (.+)$/gm)].map((m) => (m[1] as string).trim()),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    for (const { text } of workflows)
      expect(text).not.toContain("FORCE_JAVASCRIPT_ACTIONS_TO_NODE24");
  });

  // Covers: R1
  it("states the pinned Bun version in every README that names one", () => {
    const bun = /^bun@(.+)$/.exec(readJson("package.json").packageManager ?? "")?.[1] as string;
    for (const rel of READMES) {
      const mentions = [...read(rel).matchAll(/\bbun\s+`?(\d+\.\d+\.\d+)`?/gi)].map((m) => m[1]);
      expect(mentions.length, `${rel} names a Bun version`).toBeGreaterThan(0);
      for (const v of mentions) expect(v, rel).toBe(bun);
    }
  });

  // Covers: R3
  it("pins the static analysis tools at their latest versions", () => {
    const dev = (JSON.parse(read("package.json")) as { devDependencies: Record<string, string> })
      .devDependencies;
    expect(dev["@ast-grep/cli"]).toBe("0.51.0");
    expect(dev["oxlint"]).toBe("1.89.0");
    expect(dev["oxfmt"]).toBe("^0.74.0");
    expect(dev["jscpd"]).toBe("5.4.2");
  });

  // Covers: R6
  it("disables no oxlint rule", () => {
    const config = JSON.parse(read(".oxlintrc.json")) as {
      rules?: Record<string, unknown>;
      overrides?: unknown[];
    };
    const off = (v: unknown): boolean => v === "off" || v === 0 || (Array.isArray(v) && off(v[0]));
    for (const [rule, setting] of Object.entries(config.rules ?? {}))
      expect(off(setting), `${rule} is disabled`).toBe(false);
    expect(config.overrides ?? []).toEqual([]);
    expect(read(".oxlintrc.json")).not.toMatch(/"off"/);
  });

  // Covers: R3
  it("tracks @types/node on major 24", () => {
    const dev = (
      JSON.parse(read("packages/cli/package.json")) as { devDependencies: Record<string, string> }
    ).devDependencies;
    expect(dev["@types/node"]).toMatch(/^\^24\.\d+\.\d+$/);
  });
});
