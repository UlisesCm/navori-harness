import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readConfig } from "../lib/config/config.ts";
import { fastCoveredByFull } from "../lib/gate/cache.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

describe("this repo's gate chains (spec 0054 T19)", () => {
  const gate = readConfig(resolve(REPO_ROOT, "navori.config.json")).qualityGate;
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  // Covers: R13
  it("cada paso de fast aparece literal en full", () => {
    expect(gate?.fast).toBeTruthy();
    // `fast` is `bun run check:fast`; its root-script steps are the literal steps of `full`.
    expect(fastCoveredByFull(gate?.fast ?? "", gate?.full ?? "", pkg.scripts)).toBe(true);
    expect(fastCoveredByFull(pkg.scripts["check:fast"] ?? "", gate?.full ?? "")).toBe(true);
  });
});

describe("this repo's .gitignore (#1496)", () => {
  it("does not ignore the versioned progress/ files", () => {
    // `--no-index` applies the ignore rules even to tracked files: a rule that
    // matched them made the publisher's `git add progress/...` fail.
    for (const path of ["progress/current.md", "progress/history.md"]) {
      const result = spawnSync("git", ["check-ignore", "-q", "--no-index", path], {
        cwd: REPO_ROOT,
      });
      expect(result.status, path).toBe(1);
    }
  });
});
