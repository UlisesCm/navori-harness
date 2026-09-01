import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getCoreRoot, readCliVersion } from "../../../lib/bundled-assets.ts";
import { defaultGlobalConfig } from "../../../lib/global-config.ts";
import { composeBaseline } from "../global-render.ts";
import {
  applyGlobalPlugin,
  globalPluginDir,
  planGlobalPlugin,
  pluginDrift,
  pluginInstalled,
  removeGlobalPlugin,
  PLUGIN_HOOKS_REL,
  PLUGIN_HOOK_SCRIPT_REL,
  PLUGIN_MANIFEST_REL,
} from "../global-plugin.ts";
import { interpolate } from "../../../lib/interpolate.ts";
import { placeholderFallback } from "../../../lib/placeholders.ts";
import { CORE_AGENTS, CORE_SKILLS, WORKFLOW_SKILLS } from "../../shared/harness-assets.ts";

/**
 * Spec 0010 FB (#546) — the operational half of the machine-wide harness: the
 * agents and skills a project with no navori config inherits, shipped as the
 * `navori@skills-dir` plugin.
 *
 * The render targets Claude Code's config dir, pinned here to a throwaway temp
 * dir via CLAUDE_CONFIG_DIR so nothing touches the developer's real ~/.claude.
 * The assets are the REAL shipped ones (`getCoreRoot`), which is the point: the
 * inventory spec below is what stops a placeholder from shipping globally with
 * no answer, and a stub would prove nothing about that.
 */
let claudeDir: string;
const savedEnv = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  claudeDir = mkdtempSync(join(tmpdir(), "navori-plugin-"));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = savedEnv;
  rmSync(claudeDir, { recursive: true, force: true });
});

function plan(lang: "es" | "en" = "es") {
  const cfg = defaultGlobalConfig(readCliVersion(), lang);
  return planGlobalPlugin(cfg, composeBaseline(cfg), claudeDir);
}

function install(lang: "es" | "en" = "es") {
  const p = plan(lang);
  applyGlobalPlugin(p);
  return p;
}

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full, root));
    else out.push(relative(root, full));
  }
  return out;
}

describe("global-plugin — the @skills-dir layout Claude Code loads", () => {
  it("lands at ~/.claude/skills/navori with a manifest, so it loads with no install step", () => {
    const p = install();
    expect(p.dir).toBe(join(claudeDir, "skills", "navori"));
    expect(pluginInstalled(claudeDir)).toBe(true);

    const manifest = JSON.parse(readFileSync(join(p.dir, PLUGIN_MANIFEST_REL), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(manifest.name).toBe("navori");
    expect(manifest.version).toBe(readCliVersion());
    // ONLY documented fields: `claude plugin validate --strict` reports
    // unrecognized keys, so navori's usual marker has no place in here.
    expect(Object.keys(manifest).sort()).toEqual(["author", "description", "name", "version"]);
  });

  it("ships every core agent and every base skill, in the directory shape each needs", () => {
    const p = install();
    for (const agent of CORE_AGENTS) {
      expect(existsSync(join(p.dir, `agents/${agent.id}.md`))).toBe(true);
    }
    for (const id of [...CORE_SKILLS, ...WORKFLOW_SKILLS]) {
      // Directory form — the only shape Claude Code auto-discovers.
      expect(existsSync(join(p.dir, `skills/${id}/SKILL.md`))).toBe(true);
    }
    expect(p.files.length).toBe(
      CORE_AGENTS.length + CORE_SKILLS.length + WORKFLOW_SKILLS.length + 3,
    );
  });

  it("registers the gate through ${CLAUDE_PLUGIN_ROOT}, not an absolute path", () => {
    const p = install();
    const hooks = JSON.parse(readFileSync(join(p.dir, PLUGIN_HOOKS_REL), "utf-8")) as {
      hooks: { SessionStart: Array<{ matcher: string; hooks: Array<{ command: string }> }> };
    };
    const entry = hooks.hooks.SessionStart[0];
    expect(entry?.matcher).toBe("startup|resume|compact");
    // Quoted: the plugin root sits under $HOME, which routinely has spaces.
    expect(entry?.hooks[0]?.command).toBe(`"\${CLAUDE_PLUGIN_ROOT}"/${PLUGIN_HOOK_SCRIPT_REL}`);
    expect(entry?.hooks[0]?.command).not.toContain(claudeDir);
    expect(statSync(join(p.dir, PLUGIN_HOOK_SCRIPT_REL)).mode & 0o111).toBeGreaterThan(0);
  });

  it("reports drift per file, and none right after an apply", () => {
    const p = install();
    expect(pluginDrift(p)).toEqual([]);

    rmSync(join(p.dir, "agents/reviewer.md"));
    writeFileSync(join(p.dir, PLUGIN_MANIFEST_REL), "{}\n");
    expect(pluginDrift(p).sort()).toEqual([PLUGIN_MANIFEST_REL, "agents/reviewer.md"]);
  });

  it("preserves a user's edits below the managed marker across a re-render", () => {
    const p = install();
    const skill = join(p.dir, "skills/review-diff/SKILL.md");
    writeFileSync(skill, `${readFileSync(skill, "utf-8")}\n## Mine\nkeep this line\n`);

    applyGlobalPlugin(plan());
    expect(readFileSync(skill, "utf-8")).toContain("keep this line");
  });
});

/**
 * Test 1 of the spec's FB list, and the load-bearing one: the net that stops a
 * new placeholder from shipping globally with no answer. #375 and #445 were
 * this same bug on the repo path, twice.
 */
describe("global-plugin — every shipped asset resolves in the global scope", () => {
  const coreRoot = getCoreRoot();

  /**
   * The RENDERED artifacts, not a raw interpolation of the sources: the
   * frontmatter goes through `omitUnresolvedKeyLines`, so an absent
   * `{{models.reviewer}}` drops its line rather than leaving a hint in the YAML.
   * Asserting on the source would fail on exactly the case the pipeline handles.
   */
  const rendered = (() => {
    const cfg = defaultGlobalConfig(readCliVersion());
    const dir = mkdtempSync(join(tmpdir(), "navori-plugin-inv-"));
    try {
      return planGlobalPlugin(cfg, composeBaseline(cfg), dir).files.map(
        (f) => [f.relPath, f.content] as [string, string],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();

  it.each(rendered)("'%s' ships with no <not configured: …>", (_label, content) => {
    expect(content.match(/<not configured: [^>]+>/g) ?? []).toEqual([]);
  });

  /**
   * The assets wrap these placeholders in code spans — ``not on `{{branchBase}}` ``
   * — so a backtick inside a fallback closes the span early and the rest of the
   * sentence renders as prose with a stray backtick. Caught in review of the
   * first FB draft, where the `branchBase` text carried a git command in ticks.
   */
  it("no global fallback carries a backtick, which would break its code span", () => {
    for (const path of ["branchBase", "prTarget", "qualityGate.fast", "qualityGate.full"]) {
      for (const lang of ["es", "en"] as const) {
        expect(placeholderFallback(path, lang, "global")).not.toContain("`");
      }
    }
  });

  it("covers every agent and skill on disk — the inventory cannot silently shrink", () => {
    const onDisk = ["agents", "skills"].flatMap((kind) =>
      readdirSync(join(coreRoot, "core-assets", kind)).map((e) => e.replace(/\.md$/, "")),
    );
    const shipped = rendered.map(([rel]) => rel);
    for (const id of onDisk) {
      expect(shipped.some((rel) => rel.includes(`/${id}.md`) || rel.includes(`/${id}/`))).toBe(
        true,
      );
    }
  });

  /**
   * Test 2: the derived quality gate, asserted on the agent that gates the PR
   * on it. A baked command would be some OTHER repo's gate — the file is static
   * and the project is whatever cwd the session opened.
   */
  it("the pilot derives the quality gate instead of carrying one baked in", () => {
    const p = install("en");
    const pilot = readFileSync(join(p.dir, "agents/commit-pr-pilot.md"), "utf-8");
    expect(pilot).not.toContain("{{qualityGate");
    expect(pilot).not.toContain("pnpm test:coverage"); // this repo's own gate
    expect(pilot).toContain("whichever quality gate the project declares");
    expect(pilot).toContain("and name");
  });

  it("the same agent in a repo render still carries the repo's literal gate", () => {
    // The counterpart: `global` is an override, not a rewrite of the default.
    const repoCfg = { name: "x", language: "en", qualityGate: { full: "make check" } };
    const asset = join(coreRoot, "core-assets/agents/commit-pr-pilot.md");
    const rendered = interpolate(
      readFileSync(asset, "utf-8"),
      repoCfg as unknown as Parameters<typeof interpolate>[1],
    );
    expect(rendered).toContain("make check");
    expect(rendered).not.toContain("whichever quality gate the project declares");
  });
});

/** Test 4: uninstall gives the user's ~/.claude/skills back exactly as it was. */
describe("global-plugin — uninstall round-trip", () => {
  it("removes only navori's directory, leaving the user's own skills untouched", () => {
    const mine = join(claudeDir, "skills", "my-skill");
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "SKILL.md"), "---\nname: my-skill\n---\nmine\n");
    const before = filesUnder(join(claudeDir, "skills")).sort();

    install();
    expect(removeGlobalPlugin(claudeDir)).toBe(true);

    expect(existsSync(globalPluginDir(claudeDir))).toBe(false);
    expect(filesUnder(join(claudeDir, "skills")).sort()).toEqual(before);
    expect(readFileSync(join(mine, "SKILL.md"), "utf-8")).toContain("mine");
  });

  it("takes the skills/ dir with it when navori's departure leaves it empty", () => {
    install();
    expect(removeGlobalPlugin(claudeDir)).toBe(true);
    expect(existsSync(join(claudeDir, "skills"))).toBe(false);
    expect(removeGlobalPlugin(claudeDir)).toBe(false); // idempotent
  });
});

/**
 * Test 5: the manifest and the components hold up against Claude Code's own
 * validator. Skipped when the `claude` CLI is not installed — the same silent
 * skip the jscpd/semgrep gates use, so a contributor without it is not blocked.
 */
describe("global-plugin — validated by Claude Code itself", () => {
  const hasClaude =
    spawnSync("bash", ["-c", "command -v claude"], { stdio: "ignore" }).status === 0;

  it.runIf(hasClaude)("passes `claude plugin validate --strict`", () => {
    const p = install();
    const r = spawnSync("claude", ["plugin", "validate", p.dir, "--strict"], {
      encoding: "utf-8",
      timeout: 60_000,
    });
    expect(`${r.stdout ?? ""}${r.stderr ?? ""}`).not.toMatch(/warning|✘/);
    expect(r.status).toBe(0);
  });
});

/**
 * Test 3: the zero-footprint invariant (§2.4) extended to FB. Its structural
 * half lives in `global-zero-footprint.test.ts` (the repo render never imports
 * these modules); this is the behavioural half, run against the real binary.
 */
describe("global-plugin — a repo render is byte-identical with the plugin installed", () => {
  const CLI = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../dist/index.js");

  it("renders the same .claude/agents with and without a global harness", () => {
    const home = mkdtempSync(join(tmpdir(), "navori-fb-home-"));
    const emptyClaude = mkdtempSync(join(tmpdir(), "navori-fb-empty-"));
    const repoA = mkdtempSync(join(tmpdir(), "navori-fb-a-"));
    const repoB = mkdtempSync(join(tmpdir(), "navori-fb-b-"));
    try {
      install(); // claudeDir now carries the plugin

      const render = (repo: string, configDir: string) =>
        spawnSync("node", [CLI, "init", "--recommended", "--cwd", repo], {
          encoding: "utf-8",
          env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: configDir, FORCE_COLOR: "0" },
        });

      expect(render(repoA, emptyClaude).status).toBe(0);
      expect(render(repoB, claudeDir).status).toBe(0);

      const agentsA = join(repoA, ".claude", "agents");
      const agentsB = join(repoB, ".claude", "agents");
      const names = filesUnder(agentsA).sort();
      expect(names.length).toBeGreaterThan(0);
      expect(filesUnder(agentsB).sort()).toEqual(names);
      for (const name of names) {
        expect(readFileSync(join(agentsB, name), "utf-8")).toBe(
          readFileSync(join(agentsA, name), "utf-8"),
        );
      }
      // …and the repo render wrote nothing into the global scope.
      expect(filesUnder(globalPluginDir(claudeDir)).sort()).toEqual(
        plan()
          .files.map((f) => f.relPath)
          .sort(),
      );
    } finally {
      for (const d of [home, emptyClaude, repoA, repoB]) {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});
