import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderClaudeEngine } from "../index.ts";
import type { NavoriConfig } from "../../../lib/config.ts";
import { loadPlugin } from "../../../lib/plugins.ts";

/**
 * Covers: R11 — the tgrep plugin's doctrine, as it lands in a rendered repo
 * (spec 0017).
 *
 * The wrapper is only the default if the four places that decide HOW to search
 * say so: the CLAUDE.md protocol, the executor rung of `structural-search`, and
 * the two agent pairs (search: researcher/explorer, code: implementer/reviewer).
 * Mechanism without doctrine is the failure this spec was written against — a
 * perfectly wired tool nobody calls — so the wiring is pinned here per surface.
 */

const CONFIG = {
  name: "demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  plugins: { tgrep: { enabled: true } },
} as unknown as NavoriConfig;

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-tgrep-render-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function read(rel: string): string {
  return readFileSync(join(cwd, rel), "utf-8");
}

describe("render — tgrep plugin doctrine (spec 0017)", () => {
  it("writes both scripts into .claude/scripts/", () => {
    renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(join(cwd, ".claude/scripts/tgrep-search.sh"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/scripts/tgrep-session.sh"))).toBe(true);
  });

  it("adds the protocol block to CLAUDE.md, with the canonical invocation", () => {
    renderClaudeEngine(cwd, CONFIG);
    const claudeMd = read("CLAUDE.md");
    expect(claudeMd).toContain("tgrep-protocol");
    expect(claudeMd).toContain(".claude/scripts/tgrep-search.sh");
  });

  // The routing table is the point of the codegraph↔tgrep synergy: two layers
  // that answer different questions, not two tools competing for the same call.
  it("routes between the graph and the wrapper instead of letting them compete", () => {
    renderClaudeEngine(cwd, CONFIG);
    const claudeMd = read("CLAUDE.md");
    expect(claudeMd).toContain("codegraph_explore");
  });

  it("injects the executor rung into the structural-search skill", () => {
    renderClaudeEngine(cwd, CONFIG);
    const skill = read(".claude/skills/structural-search/SKILL.md");
    expect(skill).toContain("tgrep-search.sh");
  });

  // The wrapper inherits ripgrep's default: dot-directories sit outside every
  // search. A lookup for a string that lives only in `.claude/` comes back
  // empty with no warning — the same silent false negative R2 was written
  // against, arriving through a different door — so the doctrine has to name it.
  it("warns that dot-directories are outside a default search", () => {
    renderClaudeEngine(cwd, CONFIG);
    const claudeMd = read("CLAUDE.md");
    expect(claudeMd).toContain("--hidden");
    expect(claudeMd).toMatch(/dot-director/i);
    expect(read(".claude/skills/structural-search/SKILL.md")).toMatch(/dot-director/i);
  });

  it("injects into all four agents that search or edit code", () => {
    renderClaudeEngine(cwd, CONFIG);
    for (const agent of ["researcher", "explorer", "implementer", "reviewer"]) {
      expect(read(`.claude/agents/${agent}.md`), `${agent} lost its injection`).toContain(
        "tgrep-search.sh",
      );
    }
  });
});

/**
 * Covers: R9, R12, R14, R15 — the permissions, the core-doctrine clause, the
 * invariants and reversibility (spec 0017).
 *
 * R9 is the "default in every mode" half of the design: doctrine names the
 * wrapper, but only an `allow` rule makes it promptless — and only for the
 * wrapper. `rg` stays out on purpose (`rg --pre` runs an arbitrary command per
 * file), and it can afford to: the fallback runs inside the wrapper's already
 * authorized process.
 */
describe("render — tgrep permissions, core clause and reversibility (spec 0017)", () => {
  const DISABLED = {
    ...CONFIG,
    plugins: { tgrep: { enabled: false } },
  } as unknown as NavoriConfig;

  function allowOf(rel = ".claude/settings.json"): string[] {
    const settings = JSON.parse(read(rel)) as { permissions: { allow: string[] } };
    return settings.permissions.allow;
  }

  it("adds exactly the two wrapper rules — and nothing for rg or grep (R9)", () => {
    renderClaudeEngine(cwd, DISABLED);
    const without = allowOf();
    rmSync(cwd, { recursive: true, force: true });
    cwd = mkdtempSync(join(tmpdir(), "navori-tgrep-render-"));
    renderClaudeEngine(cwd, CONFIG);
    const withPlugin = allowOf();

    // The DELTA is what the plugin is responsible for; the base set already
    // ships read-only rules of its own and is not this plugin's business.
    const added = withPlugin.filter((rule) => !without.includes(rule));
    expect(added).toEqual(["Bash(bash .claude/scripts/tgrep-search.sh *)", "Bash(tgrep *)"]);
  });

  it("makes the core search doctrine cede to the wrapper without dropping the rg exclusion (R12)", () => {
    renderClaudeEngine(cwd, CONFIG);
    const claudeMd = read("CLAUDE.md");
    // The clause is conditional on purpose: the same core asset renders in
    // repos that don't have the plugin, and two managed blocks contradicting
    // each other in one file is the failure this requirement exists against.
    expect(claudeMd).toContain("When the tgrep plugin is enabled");
    expect(claudeMd).toContain("`rg` itself is deliberately NOT pre-approved");
  });

  it("renders every invariant the manifest declares (R14)", () => {
    renderClaudeEngine(cwd, CONFIG);
    const rendered = collectText(cwd);
    for (const invariant of loadPlugin("tgrep").manifest.invariants) {
      expect(rendered, `invariant '${invariant}' vanished from the render`).toContain(invariant);
    }
  });

  it("leaves no trace when the plugin is disabled and the repo re-renders (R15)", () => {
    renderClaudeEngine(cwd, CONFIG);
    expect(existsSync(join(cwd, ".claude/scripts/tgrep-search.sh"))).toBe(true);

    renderClaudeEngine(cwd, DISABLED);
    expect(existsSync(join(cwd, ".claude/scripts/tgrep-search.sh"))).toBe(false);
    expect(existsSync(join(cwd, ".claude/scripts/tgrep-session.sh"))).toBe(false);
    expect(read("CLAUDE.md")).not.toContain("tgrep-protocol");
    expect(read(".claude/skills/structural-search/SKILL.md")).not.toContain("tgrep-search.sh");
    for (const agent of ["researcher", "explorer", "implementer", "reviewer"]) {
      expect(read(`.claude/agents/${agent}.md`), `${agent} kept an orphan sub-block`).not.toContain(
        "tgrep-search.sh",
      );
    }
    expect(allowOf()).not.toContain("Bash(tgrep *)");
  });
});

/** Every rendered text file, concatenated — what `doctor` scans for invariants. */
function collectText(dir: string): string {
  let out = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out += collectText(path);
    } else if (/\.(md|json|sh)$/.test(entry.name)) {
      out += readFileSync(path, "utf-8");
    }
  }
  return out;
}
