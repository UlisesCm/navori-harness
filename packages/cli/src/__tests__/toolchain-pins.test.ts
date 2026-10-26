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

  // Covers: R1
  it("states the pinned Bun version in every README that names one", () => {
    const bun = /^bun@(.+)$/.exec(readJson("package.json").packageManager ?? "")?.[1] as string;
    for (const rel of READMES) {
      const mentions = [...read(rel).matchAll(/\bbun\s+`?(\d+\.\d+\.\d+)`?/gi)].map((m) => m[1]);
      expect(mentions.length, `${rel} names a Bun version`).toBeGreaterThan(0);
      for (const v of mentions) expect(v, rel).toBe(bun);
    }
  });
});
