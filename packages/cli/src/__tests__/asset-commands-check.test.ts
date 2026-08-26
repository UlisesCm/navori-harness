import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #490 — the unreleased-subcommand guard (`scripts/check-asset-commands.mjs`).
 *
 * An asset that orders `navori <cmd>` resolves the PUBLISHED binary, so a PR
 * landing a subcommand and an asset calling it together ships an asset that is
 * broken until the next release. That is how `audit` shipped in #485, and it
 * failed silently: citty prints help and exits 0 for an unknown subcommand.
 *
 * #504 — the first version of this spec asserted only that the check "ran"
 * (`stdout` matched `[✓⚠]`), and the SKIP path printed a ⚠ too: the check
 * passed its own anti-false-green test while skipping itself. The three
 * outcomes are covered below over FIXTURE repos — a throwaway repo with its own
 * git history, its own tag and a copy of the real script — because the real
 * repo's verdict changes with every release and cannot exercise the skip.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const SCRIPT = resolve(REPO_ROOT, "scripts", "check-asset-commands.mjs");

function run(cwd: string = REPO_ROOT, script: string = SCRIPT, ...args: string[]) {
  return spawnSync("node", [script, ...args], {
    encoding: "utf-8",
    cwd,
    env: { ...process.env, FORCE_COLOR: "0" },
  });
}

/** `git` inside the fixture, with signing/identity pinned so a developer's global config can't break it. */
function git(repo: string, ...args: string[]): void {
  const r = spawnSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=navori-test",
      "-c",
      "user.email=test@navori.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      ...args,
    ],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/** A `packages/cli/src/index.ts` whose `subCommands` block registers `names`. */
function indexTs(names: string[]): string {
  const entries = names.map((n) => `    ${n}: () => import("./commands/${n}.ts"),`).join("\n");
  return `export const main = defineCommand({\n  meta: { name: "navori" },\n  subCommands: {\n${entries}\n  },\n});\n`;
}

function write(repo: string, rel: string, content: string): void {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf-8");
}

interface FixtureSpec {
  /** subCommands the tagged (published) CLI had. `null` → the tag predates index.ts. */
  published: string[] | null;
  /** subCommands the working tree registers. */
  registered: string[];
  /** `navori <cmd>` invocations the fixture asset carries. */
  cites: string[];
  /** Create the release tag at all (false → a shallow clone with no tags). */
  tag?: boolean;
  /** Write the asset tree at all (false → a renamed/absent asset layout). */
  assets?: boolean;
}

const fixtures: string[] = [];

/** A throwaway repo shaped like navori's, carrying a copy of the real script. */
function makeFixture(spec: FixtureSpec): string {
  const repo = mkdtempSync(join(tmpdir(), "navori-assetcheck-"));
  fixtures.push(repo);

  git(repo, "init", "-q", "-b", "main");
  if (spec.published) write(repo, "packages/cli/src/index.ts", indexTs(spec.published));
  else write(repo, "README.md", "# fixture\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "published state");
  if (spec.tag !== false) git(repo, "tag", "v0.0.1");

  // The working tree moves on past the tag — that gap is what the check reads.
  write(repo, "packages/cli/src/index.ts", indexTs(spec.registered));
  if (spec.assets !== false) {
    const lines = ["#!/usr/bin/env bash", ...spec.cites.map((c) => `navori ${c} --apply`)];
    write(repo, "packages/core/core-assets/hooks/demo.sh", `${lines.join("\n")}\n`);
  }

  mkdirSync(join(repo, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, join(repo, "scripts", "check-asset-commands.mjs"));
  return repo;
}

function runFixture(repo: string, ...args: string[]) {
  return run(repo, join(repo, "scripts", "check-asset-commands.mjs"), ...args);
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("asset subcommand check — the three outcomes (#490, #504)", () => {
  it("FOUND: flags a cited subcommand absent from the tag, with its file:line", () => {
    const repo = makeFixture({
      published: ["render"],
      registered: ["render", "audit"],
      cites: ["render", "audit"],
    });

    const { status, stdout } = runFixture(repo);

    expect(stdout).toContain("⚠ assets cite 1 subcommand(s)");
    expect(stdout).toContain("navori audit");
    expect(stdout).not.toContain("navori render —"); // released: not flagged
    expect(stdout).toMatch(/\s{4}packages\/core\/core-assets\/hooks\/demo\.sh:\d+/);
    // Reporting, not blocking: publishing must not become a merge prerequisite.
    expect(status).toBe(0);
  });

  it("CLEAN: says how much it scanned, so a ✓ can't come from an empty run", () => {
    const repo = makeFixture({
      published: ["render", "audit"],
      registered: ["render", "audit"],
      cites: ["render", "audit"],
    });

    const { status, stdout } = runFixture(repo);

    expect(stdout).toContain("✓ every subcommand cited by an asset exists in v0.0.1");
    expect(stdout).toContain("2 cited across 1 asset files");
    expect(stdout).not.toContain("⊘");
    expect(status).toBe(0);
  });

  it("CANNOT RUN: no tag → its own marker, never a ✓ and never a ⚠", () => {
    const repo = makeFixture({
      published: ["render"],
      registered: ["render", "audit"],
      cites: ["audit"], // would be flagged, IF the check could compare
      tag: false,
    });

    const { status, stdout } = runFixture(repo);

    // The distinction #504 is about: "I could not compare" reads differently
    // from "I compared and found nothing".
    expect(stdout).toContain("⊘ could not run");
    expect(stdout).toContain("NO asset was compared");
    expect(stdout).not.toMatch(/[✓⚠]/);
    expect(status).toBe(0);
  });

  it("CANNOT RUN: a tag that predates index.ts is a skip, not a clean run", () => {
    const repo = makeFixture({
      published: null, // the tagged commit has no packages/cli/src/index.ts
      registered: ["render", "audit"],
      cites: ["audit"],
    });

    const { status, stdout } = runFixture(repo);

    expect(stdout).toContain("⊘ could not run");
    expect(stdout).toContain("unreadable at v0.0.1");
    expect(status).toBe(0);
  });

  it("CANNOT RUN: zero assets walked is a skip, not a clean run", () => {
    const repo = makeFixture({
      published: ["render"],
      registered: ["render", "audit"],
      cites: [],
      assets: false,
    });

    const { status, stdout } = runFixture(repo);

    // Without this the renamed asset layout printed "✓ ... (0 cited)".
    expect(stdout).toContain("⊘ could not run");
    expect(stdout).toContain("no .md/.sh asset found");
    expect(status).toBe(0);
  });

  it("--strict turns 'could not run' into a failure, and leaves real verdicts alone", () => {
    const skipped = makeFixture({
      published: ["render"],
      registered: ["render", "audit"],
      cites: ["audit"],
      tag: false,
    });
    const flagged = makeFixture({
      published: ["render"],
      registered: ["render", "audit"],
      cites: ["audit"],
    });

    // CI configures the environment so the check CAN run (fetch-depth: 0), so
    // there a skip means that configuration regressed — and must be red.
    expect(runFixture(skipped, "--strict").status).toBe(1);
    expect(runFixture(skipped).status).toBe(0);
    // A verdict the check could actually reach is untouched by --strict: the
    // flag changes what a skip costs, never what the check concludes.
    const plain = runFixture(flagged);
    const strict = runFixture(flagged, "--strict");
    expect(strict.stdout).toBe(plain.stdout);
    expect(strict.status).toBe(0);
  });

  it("ERROR: an unparseable subCommands block fails loudly (exit 1)", () => {
    const repo = makeFixture({
      published: ["render"],
      registered: ["render"],
      cites: ["render"],
    });
    // The parser is the load-bearing half: if it silently yielded nothing, every
    // citation would read as prose and the check would flag nothing, forever.
    write(repo, "packages/cli/src/index.ts", "export const main = defineCommand({});\n");

    const { status, stderr } = runFixture(repo);

    expect(status).toBe(1);
    expect(stderr).toContain("could not parse subCommands");
  });
});

describe("asset subcommand check — against this repo", () => {
  it("never blocks the build — a pending release is not a failure", () => {
    // Blocking would invert the order: you'd have to publish before merging.
    expect(run().status).toBe(0);
  });

  it("reaches one of the three outcomes and says which (anti-false-green)", () => {
    const { stdout } = run();
    // Environment-tolerant on purpose: which outcome the real repo reaches
    // depends on the release state and on whether the clone has tags. What is
    // NOT tolerated is a silent run. Each marker is asserted for real in the
    // fixture specs above.
    expect(stdout.trim()).not.toBe("");
    expect(stdout).toMatch(/^[✓⚠⊘]/);
  });

  it("reports a file:line for anything it flags", () => {
    const { stdout } = run();
    if (!stdout.includes("⚠ assets cite")) return; // nothing pending: vacuously fine
    // A warning without a location is not actionable.
    expect(stdout).toMatch(/\s{4}\S+\.(md|sh):\d+/);
  });

  it("knows every subcommand the CLI registers", () => {
    // The parser is the load-bearing half: if `subCommands` stops matching, the
    // check silently considers every citation prose and flags nothing.
    const source = readFileSync(resolve(REPO_ROOT, "packages/cli/src/index.ts"), "utf-8");
    const block = source.match(/subCommands:\s*\{([\s\S]*?)\n\s*\},/)?.[1];
    expect(block, "the check's own regex must still match index.ts").toBeTypeOf("string");
    const names = [...(block ?? "").matchAll(/^\s*([a-z][\w-]*)\s*:/gm)].map((m) => m[1]);
    expect(names).toContain("render");
    expect(names).toContain("audit");
    expect(names.length).toBeGreaterThanOrEqual(20);
  });
});
