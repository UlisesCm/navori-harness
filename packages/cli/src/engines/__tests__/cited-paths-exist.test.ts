import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/schema.ts";
import { renderAgentsMdEngine } from "../agents-md/index.ts";
import { renderClaudeEngine } from "../claude/index.ts";
import { renderCodexEngine } from "../codex/index.ts";
import { renderCopilotEngine } from "../copilot/index.ts";
import { renderCursorEngine } from "../cursor/index.ts";

/**
 * Cross-engine anti-drift gate (#392), generalizing the Codex-only sweep that
 * entered with #364. Harness assets cite each other (an agent sends the model to
 * `.claude/skills/review-diff/SKILL.md`, a skill writes `.claude/progress/…`,
 * a settings fragment points at a hook script) and four findings in a row —
 * #352, #364 A/B, #389 — were the same failure: an emitted artifact cited a
 * path its engine never generates. This suite renders EVERY engine and asserts
 * each harness path cited in each emitted artifact resolves inside that render,
 * or sits on an explicit, justified exception list. A new asset that cites
 * another engine's route — or a path nobody generates — fails here, not in an
 * onboarded repo.
 *
 * Hooks are the deliberate exception (#389): `placeHook` copies the body
 * verbatim for every engine, so a hook cannot know at render time which engine
 * dir exists — the decision was that hooks probe at RUNTIME. For them the
 * assertion is not "the path exists" but "the probe list covers every engine's
 * dir" (see the dedicated test below).
 */

/** A tolerated citation that does not resolve in the rendered tree. */
interface PathException {
  /** Citation prefix this exception covers (repo-relative). */
  readonly prefix: string;
  /** Why the missing path is fine — every entry must justify itself. */
  readonly reason: string;
  /** Match the citation verbatim instead of by prefix (default: prefix). */
  readonly exact?: boolean;
}

/**
 * Runtime/on-demand paths every engine's prose may cite: they are created by
 * the user or the agents after onboarding, never by render.
 */
const SHARED_RUNTIME_EXCEPTIONS: readonly PathException[] = [
  {
    prefix: "progress/",
    reason:
      "git-persisted session state (current.md/history.md) is seeded by init/first session close, not by every engine's render",
  },
  {
    prefix: "specs/",
    reason: "SDD artifacts are created on demand by the spec-bootstrap flow",
  },
  {
    prefix: ".github/pull_request_template.md",
    reason: "optional user-repo file; the commit-pr-pilot checks for it at runtime",
  },
];

/**
 * Paths only reachable in a repo that renders the CLAUDE engine. Scoped per
 * engine on purpose: `.claude/progress` cited from a Codex-only surface is a
 * real #364-class bug and must NOT be excused by this list.
 */
const CLAUDE_RUNTIME_EXCEPTIONS: readonly PathException[] = [
  {
    prefix: ".claude/progress",
    reason:
      "ephemeral subagent-handoff dir, created by the first agent at runtime; render never emits it and #348 gitignores it",
  },
  {
    prefix: ".claude/worktrees",
    reason: "parallel-agent worktrees exist only at runtime (#348 ephemeral set)",
  },
  {
    prefix: ".claude/settings.local.json",
    reason: "per-user local settings, never rendered nor versioned (#348 ephemeral set)",
  },
  {
    prefix: ".claude/scripts/",
    reason:
      "plugin-owned check scripts (jscpd/semgrep); they exist only with that plugin enabled, and their callers skip silently when absent",
  },
];

/**
 * TODO(#392follow): real finding surfaced by this suite. The arranque-sesion
 * managed block ships "run `navori doctor` if `navori.config.json` / `.claude/`
 * look inconsistent" into the prose engines (AGENTS.md / Cursor / Copilot),
 * which never generate a `.claude/` dir — the prose pipeline has no path
 * adapter (Codex's `compat.ts` rewrite does not run there). Tolerated (exact
 * match only, so any OTHER `.claude/...` citation still fails) until the asset
 * or a prose adapter is fixed in its own unit.
 */
const PROSE_KNOWN_BROKEN: readonly PathException[] = [
  {
    prefix: ".claude/",
    exact: true,
    reason: "arranque-sesion's doctor hint names the Claude harness dir; see TODO(#392follow)",
  },
];

/** Codex mirror of the runtime handoff dir (#354). */
const CODEX_RUNTIME_EXCEPTIONS: readonly PathException[] = [
  {
    prefix: ".codex/progress",
    reason: "ephemeral subagent-handoff dir under Codex, created at runtime (#354 gitignores it)",
  },
];

/**
 * Harness-path citations inside a text artifact. Rooted at the directories the
 * engines own (or the harness contract names); bare-word roots (`progress`,
 * `specs`, `scripts`) additionally require a path-like shape — a trailing slash
 * or a `.md`/`.txt`/`.sh` leaf — so English prose such as "progress/success
 * lines" (debug-error skill) is not mistaken for a citation.
 *
 * `scripts` is a root because a plugin author writes prose from the PLUGIN's
 * frame, where the check script lives at `scripts/check-*.sh`, while the repo
 * that reads it only ever has `.claude/scripts/check-*.sh` (#407). Without this
 * root the sweep could not see that class at all: every other citation it knows
 * starts with a dot. The dot-rooted alternatives still win when both apply,
 * and the lookbehind keeps `.claude/scripts/…` from matching as a bare root.
 */
function extractCitations(content: string): string[] {
  const re =
    /(?:\.claude|\.codex|\.agents|\.cursor|\.github|(?<![\w./-])progress|(?<![\w./-])specs|(?<![\w./-])scripts)\/[\w<>*./-]*/g;
  const citations: string[] = [];
  for (const raw of content.match(re) ?? []) {
    // Trailing sentence punctuation is not part of the path.
    const cite = raw.replace(/\.+$/, "");
    if (
      (cite.startsWith("progress/") || cite.startsWith("specs/") || cite.startsWith("scripts/")) &&
      !(cite.endsWith("/") || cite.endsWith(".md") || cite.endsWith(".txt") || cite.endsWith(".sh"))
    ) {
      continue;
    }
    citations.push(cite);
  }
  return citations;
}

/**
 * Resolve one citation against the rendered tree. A citation with a
 * placeholder (`<feature>`, `*`) is checked at its deepest static directory —
 * `.claude/skills/<id>/SKILL.md` resolves if `.claude/skills/` exists.
 */
function citationResolves(
  cwd: string,
  citation: string,
  exceptions: readonly PathException[],
): boolean {
  if (
    exceptions.some((e) =>
      e.exact === true ? citation === e.prefix : citation.startsWith(e.prefix),
    )
  ) {
    return true;
  }
  const placeholderAt = citation.search(/[<*]/);
  const target =
    placeholderAt >= 0 ? citation.slice(0, citation.lastIndexOf("/", placeholderAt) + 1) : citation;
  return target === "" || existsSync(join(cwd, target));
}

/** Recursively list every file render emitted (repo-relative). */
function listFiles(cwd: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(cwd, rel))) {
    const relPath = rel === "" ? name : `${rel}/${name}`;
    if (statSync(join(cwd, relPath)).isDirectory()) out.push(...listFiles(cwd, relPath));
    else out.push(relPath);
  }
  return out;
}

/** Prose/config surfaces swept for citations. Shell scripts are the hook case. */
const SWEPT_EXTENSIONS = /\.(md|mdc|toml|json)$/;

interface EngineCase {
  readonly id: string;
  readonly engines: NavoriConfig["engines"];
  readonly render: (cwd: string, config: NavoriConfig) => void;
  readonly exceptions: readonly PathException[];
}

/**
 * Both engines in ONE repo: the cross-model-review sub-block only renders with
 * `engines: ["claude", "codex"]`, and its `.codex/agents/*.toml` citation must
 * resolve against the sibling engine's tree. Also the repo whose hooks trees
 * feed the #389 probe-parity test below.
 */
const DUAL_ENGINE_CASE: EngineCase = {
  id: "claude+codex",
  engines: ["claude", "codex"],
  render: (cwd, config) => {
    renderClaudeEngine(cwd, config);
    renderCodexEngine(cwd, config);
  },
  exceptions: [
    ...SHARED_RUNTIME_EXCEPTIONS,
    ...CLAUDE_RUNTIME_EXCEPTIONS,
    ...CODEX_RUNTIME_EXCEPTIONS,
  ],
};

/**
 * One rendered repo per engine (plus the dual claude+codex repo: the
 * cross-model-review block only exists there).
 */
const ENGINE_CASES: readonly EngineCase[] = [
  {
    id: "claude",
    engines: ["claude"],
    render: (cwd, config) => void renderClaudeEngine(cwd, config),
    exceptions: [...SHARED_RUNTIME_EXCEPTIONS, ...CLAUDE_RUNTIME_EXCEPTIONS],
  },
  {
    id: "codex",
    engines: ["codex"],
    render: (cwd, config) => void renderCodexEngine(cwd, config),
    exceptions: [...SHARED_RUNTIME_EXCEPTIONS, ...CODEX_RUNTIME_EXCEPTIONS],
  },
  DUAL_ENGINE_CASE,
  {
    id: "agents-md",
    engines: ["agents-md"],
    render: (cwd, config) => void renderAgentsMdEngine(cwd, config),
    exceptions: [...SHARED_RUNTIME_EXCEPTIONS, ...PROSE_KNOWN_BROKEN],
  },
  {
    id: "cursor",
    engines: ["cursor"],
    render: (cwd, config) => void renderCursorEngine(cwd, config),
    exceptions: [...SHARED_RUNTIME_EXCEPTIONS, ...PROSE_KNOWN_BROKEN],
  },
  {
    id: "copilot",
    engines: ["copilot"],
    render: (cwd, config) => void renderCopilotEngine(cwd, config),
    exceptions: [...SHARED_RUNTIME_EXCEPTIONS, ...PROSE_KNOWN_BROKEN],
  },
];

function makeConfig(engines: NavoriConfig["engines"]): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "cited-paths-demo",
    engines,
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    // EVERY plugin on: a plugin's managed block is prose written from the
    // PLUGIN author's frame and rendered into a repo that has a different
    // layout, which is precisely the drift this sweep exists to catch (#407
    // was a semgrep-block citation, invisible here while only engram shipped).
    plugins: {
      acli: { enabled: true },
      codegraph: { enabled: true },
      engram: { enabled: true },
      gh: { enabled: true },
      jscpd: { enabled: true },
      semgrep: { enabled: true },
    },
    project: { libraries: ["zod-validation"] },
  });
}

const tempDirs: string[] = [];

function renderCase(engineCase: EngineCase): string {
  const cwd = mkdtempSync(join(tmpdir(), `navori-cited-${engineCase.id}-`));
  tempDirs.push(cwd);
  engineCase.render(cwd, makeConfig(engineCase.engines));
  return cwd;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("every path cited by a rendered artifact exists in its render (#392)", () => {
  for (const engineCase of ENGINE_CASES) {
    it(`${engineCase.id}: emitted artifacts cite no unreachable path`, () => {
      const cwd = renderCase(engineCase);
      const surfaces = listFiles(cwd).filter((f) => SWEPT_EXTENSIONS.test(f));
      expect(surfaces.length).toBeGreaterThan(0);

      const misses: Array<{ file: string; citation: string }> = [];
      for (const file of surfaces) {
        const body = readFileSync(join(cwd, file), "utf-8");
        for (const citation of extractCitations(body)) {
          if (!citationResolves(cwd, citation, engineCase.exceptions)) {
            misses.push({ file, citation });
          }
        }
      }
      expect(misses).toEqual([]);
    });
  }
});

describe("hooks probe every engine's handoff dir, not one engine's (#389)", () => {
  /**
   * The runtime handoff dir per engine. A hook body that names one of them must
   * name ALL of them — `placeHook` ships the same bytes to every engine, so a
   * single-engine probe is exactly the #389 bug (and #352 before it).
   */
  const HANDOFF_DIRS = [".claude/progress", ".codex/progress"] as const;

  it("every emitted hook that probes a handoff dir probes all of them", () => {
    const cwd = renderCase(DUAL_ENGINE_CASE); // claude+codex: both hook trees
    const hooks = listFiles(cwd).filter((f) => f.endsWith(".sh"));
    expect(hooks.length).toBeGreaterThan(0);

    const misses: Array<{ file: string; probes: string[] }> = [];
    for (const file of hooks) {
      const body = readFileSync(join(cwd, file), "utf-8");
      const probes = HANDOFF_DIRS.filter((dir) => body.includes(dir));
      if (probes.length > 0 && probes.length < HANDOFF_DIRS.length) {
        misses.push({ file, probes });
      }
    }
    expect(misses).toEqual([]);
  });
});
