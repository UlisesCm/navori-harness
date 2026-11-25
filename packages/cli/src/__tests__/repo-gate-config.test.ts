import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readConfig } from "../lib/config/config.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const gate = readConfig(resolve(REPO_ROOT, "navori.config.json")).qualityGate;

/** Ordered `bun run <script>` / `bun <script>` names of an `&&` chain. */
function steps(command: string | undefined): string[] {
  return (command ?? "")
    .split("&&")
    .map((s) => s.trim())
    .filter((s) => !s.startsWith("cd "))
    .map((s) => /^bun (?:run )?(\S+)/.exec(s)?.[1] ?? s);
}

// After the cutover (spec 0062 T10) the frozen TS has no lint, typecheck or bundle-size step.
const CHEAP = [
  "check:deps",
  "format:check",
  "check:dup",
  "check:ast",
  "check:links",
  "check:render",
  "check:assets",
  "check:doc-budgets",
  "check:blame-ignore",
];

describe("this repo's quality gate (R23, R25)", () => {
  // Covers: R23
  it("orden y conjunto", () => {
    // The Rust gate first (`check:post-cutover`, R18), then the cheap checks, the test-preservation
    // check and the asset and docs suites last (spec 0062 T10, option C: no TS suite).
    expect(steps(gate?.full)).toEqual([
      "check:post-cutover",
      ...CHEAP,
      "check:tests-preserved",
      "test:assets",
    ]);
    // The package.json `check` script mirrors `full`.
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(steps(pkg.scripts.check)).toEqual(steps(gate?.full));
    expect(steps(gate?.fast)).toEqual(["check:fast"]);
    expect(pkg.scripts.typecheck).toBeTruthy();
    // Covers: R25
    // `scoped` is the static checks of `full` in order: no test step of any kind.
    expect(steps(gate?.scoped)).toEqual(["check:scoped"]);
    expect(steps(pkg.scripts["check:scoped"])).toEqual(CHEAP);
    expect(
      steps(gate?.full)
        .filter((step) => step !== "check:tests-preserved" && step !== "check:post-cutover")
        .slice(0, CHEAP.length),
    ).toEqual(steps(pkg.scripts["check:scoped"]));
    expect(pkg.scripts["check:scoped"]).not.toMatch(/test|vitest/);
  });

  // Covers: R1
  it("declaraciones nativas", () => {
    // Only the gate declares native hooks; no plugin does (amendment after #1282).
    expect(gate?.nativeHooks).toBe(true);
    const config = JSON.parse(readFileSync(resolve(REPO_ROOT, "navori.config.json"), "utf8")) as {
      plugins?: Record<string, { nativeHook?: unknown }>;
    };
    for (const plugin of Object.values(config.plugins ?? {})) {
      expect(plugin.nativeHook).toBeUndefined();
    }
    // `prepare` installs the hook; the installer must warn instead of throwing on a foreign one.
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.prepare).toContain("hooks:install");
    const installer = readFileSync(resolve(REPO_ROOT, "scripts/js/install-git-hooks.mjs"), "utf8");
    expect(installer).not.toMatch(/throw new Error/);
    expect(installer).toContain("console.warn");
    // The versioned hook runs the fast gate.
    expect(readFileSync(resolve(REPO_ROOT, "scripts/git-hooks/pre-commit"), "utf8")).toContain(
      "check:fast",
    );
  });
});
