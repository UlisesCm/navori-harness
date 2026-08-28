import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readConfig } from "../lib/config.ts";
import { DEFAULT_LANG } from "../lib/i18n.ts";
import { placeholderFallback } from "../lib/placeholders.ts";

/**
 * This repo dogfoods navori: its own `navori.config.json` is what renders the
 * harness the agents working on it obey. Two fields of it were quietly wrong
 * and nothing noticed, because a config is data — no compiler reads it (#508).
 *
 *  1. `qualityGate.full` is the command the prose orders an agent to run before
 *     a PR. It listed fewer checks than CI gates on, so a green local gate
 *     could still land a red CI (it did: `check:render` red, `full` green).
 *  2. `project.criticalAreas` was undeclared, so every asset rendered the
 *     generic placeholder `auth, permissions, payments, data integrity`. A CLI
 *     scaffolder has none of the first three, so the harness escalated on
 *     signals that can never fire and stayed quiet on the ones that can — a
 *     change deleting files in the user's repo did not count as critical.
 *
 * The CI half DERIVES its expectations from `.github/workflows/ci.yml` instead
 * of restating them: a hand-written gate checked against a hand-written list is
 * exactly the pair that already drifted. Add a step to CI and this suite fails
 * until the gate covers it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const CI_WORKFLOW = resolve(REPO_ROOT, ".github", "workflows", "ci.yml");
const CONFIG_PATH = resolve(REPO_ROOT, "navori.config.json");

interface RootPackageJson {
  scripts?: Record<string, string>;
}

/**
 * CI checks the local gate is NOT expected to repeat. Every entry needs a
 * reason; an unexplained one is how a check quietly leaves the gate. Anything
 * CI adds that is NOT listed here must show up in the gate.
 */
const EXEMPT_FROM_LOCAL_GATE = new Map<string, string>([
  ["install", "dependency install, not a check"],
  ["build", "`check:render` rebuilds before rendering, so the gate builds anyway"],
  [
    "check:assets:ci",
    // The gate runs `check:assets`, the SAME check: `:ci` only adds `--strict`,
    // which turns its "could not run" outcome red. That outcome depends on tags
    // being present, and CI fetches them on purpose (`fetch-depth`/tags in the
    // checkout) precisely so the strict form can compare against one. A fresh
    // local clone usually has none, so demanding `:ci` here would fail the gate
    // for an environmental reason while the substance — do the assets cite a
    // released subcommand — is already covered locally. What the strict form
    // adds is detection of a CI-SETUP regression, which a local run cannot
    // observe by construction.
    "same check as `check:assets`; `--strict` only guards CI's own tag setup, which a local clone cannot observe",
  ],
]);

/**
 * Identify a check independently of WHICH package script carries it: the gate
 * reaches the CLI's scripts as `cd packages/cli && pnpm <s>` and CI as
 * `pnpm --filter navori <s>`, so both must reduce to `<s>`. A script in any
 * OTHER workspace package keeps its filter, because running it is a genuinely
 * distinct command — collapsing it would let `--filter @navori/website build`
 * hide behind the CLI's own `build` and stay out of the gate unnoticed.
 */
function checkKey(match: RegExpMatchArray): string {
  const filter = match[1];
  const script = match[2] ?? "";
  return !filter || filter === "navori" ? script : `${filter} ${script}`;
}

const PNPM_INVOCATION = /\bpnpm\s+(?:--filter\s+(\S+)\s+)?(?:run\s+)?([a-z][\w:.-]*)/g;

/** The `quality:` job's body, sliced out of the workflow by indentation. */
function qualityJobBody(): string {
  const yaml = readFileSync(CI_WORKFLOW, "utf-8");
  const start = yaml.indexOf("\n  quality:\n");
  expect(start, "ci.yml no longer declares a `quality:` job").toBeGreaterThan(-1);
  const rest = yaml.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Every check the quality job invokes, as `checkKey` identities. */
function ciChecks(): Set<string> {
  const runs = [...qualityJobBody().matchAll(/^\s*run: (.+)$/gm)].flatMap((m) => m[1] ?? []);
  const checks = new Set<string>();
  for (const run of runs) {
    for (const m of run.matchAll(PNPM_INVOCATION)) checks.add(checkKey(m));
  }
  return checks;
}

/** The checks an `&&`-chained gate command actually invokes. */
function gateChecks(command: string): Set<string> {
  const checks = new Set<string>();
  for (const segment of command.split("&&")) {
    for (const m of segment.trim().matchAll(PNPM_INVOCATION)) checks.add(checkKey(m));
  }
  return checks;
}

describe("qualityGate.full covers what CI gates on (#508.1)", () => {
  const ci = ciChecks();
  const config = readConfig(CONFIG_PATH);
  const declaredGate = config.qualityGate?.full ?? "";
  const gate = gateChecks(declaredGate);

  it("the ci.yml parser finds the steps it is meant to police (anti-false-green)", () => {
    // A parser that silently matched nothing would report "the gate covers
    // everything" — the exact false green this suite exists to prevent.
    expect([...ci]).toEqual(
      expect.arrayContaining(["check:render", "check:assets:ci", "format:check", "lint"]),
    );
    expect(ci.size).toBeGreaterThanOrEqual(7);
  });

  it("the gate parser reads the declared command (anti-false-green)", () => {
    expect(declaredGate).not.toBe("");
    expect([...gate]).toContain("lint");
    expect(gate.size).toBeGreaterThanOrEqual(5);
  });

  it("every non-exempt CI check appears in qualityGate.full", () => {
    const missing = [...ci].filter((c) => !EXEMPT_FROM_LOCAL_GATE.has(c) && !gate.has(c)).sort();
    expect(
      missing,
      "add these to navori.config.json qualityGate.full, or exempt them here with a reason",
    ).toEqual([]);
  });

  it("no exemption is stale (each still names a check CI runs)", () => {
    const unused = [...EXEMPT_FROM_LOCAL_GATE.keys()].filter((c) => !ci.has(c)).sort();
    expect(unused, "CI stopped running these — drop the exemption").toEqual([]);
  });

  it("CI builds the website, so a broken site fails the PR and not the deploy (#508.4)", () => {
    // `apps/website` used to be built only by deploy-website.yml, which runs
    // after the merge. This is the one CI step nothing else would notice
    // leaving, because the gate being a superset of CI is otherwise fine.
    expect([...ci]).toContain("@navori/website build");
  });

  it("the root `check` script runs the same thing the gate declares", () => {
    // Before #508 this was a THIRD hand-written list, shorter than both the
    // gate and CI. One string, two consumers (humans type `pnpm check`, agents
    // read the gate) — so they must be the same string.
    const rootPkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"),
    ) as RootPackageJson;
    expect(rootPkg.scripts?.check).toBe(declaredGate);
  });
});

describe("project.criticalAreas describes THIS product (#508.2)", () => {
  const config = readConfig(CONFIG_PATH);
  const declared = config.project?.criticalAreas ?? [];

  it("the generic placeholder is still what an undeclared config renders (anti-false-green)", () => {
    // The comparison below is only meaningful while this is the fallback. If
    // the fallback text changes, this fails first and says so, instead of
    // letting the real assertion pass against a value nothing produces.
    expect(placeholderFallback("project.criticalAreas", DEFAULT_LANG)).toBe(
      "auth, permissions, payments, data integrity",
    );
  });

  it("is declared, so no asset renders the placeholder", () => {
    expect(declared.length).toBeGreaterThan(0);
  });

  it("is not the placeholder list restated", () => {
    const placeholder = placeholderFallback("project.criticalAreas", DEFAULT_LANG);
    expect(declared.join(", ")).not.toBe(placeholder);
    const generic = new Set(placeholder.split(", "));
    const restated = declared.filter((area) => generic.has(area.trim().toLowerCase()));
    expect(
      restated,
      "these are the generic placeholder's areas, not this repo's — a CLI scaffolder has no auth or payments",
    ).toEqual([]);
  });
});
