import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig } from "../../lib/schema.ts";
import { renderAgentsMdEngine } from "../agents-md/index.ts";
import { renderClaudeEngine } from "../claude/index.ts";
import { renderCodexEngine } from "../codex/index.ts";
import { renderCopilotEngine } from "../copilot/index.ts";
import { renderCursorEngine } from "../cursor/index.ts";

/**
 * Golden snapshot of the rendered tree, one file per engine (#394).
 *
 * The ~11 wiring/invariant suites around this one assert TOKENS: that a phrase
 * is present, that a retired wording is gone. That is deliberate — rewording
 * stays free, re-duplicating does not — but it leaves a hole: nobody sees the
 * whole output. A change only shows up if somebody thought to write the assert
 * for that line. Two real misses that this suite would have surfaced without
 * anyone looking for them: the `0.5.1 → 0.6.0` stamp drift across 43 managed
 * blocks (#388) and the `.claude/` citations that survived the Codex path
 * adapter (#364).
 *
 * The issue that asked for this attached three conditions, because a big
 * snapshot that churns is worse than no snapshot (people run `-u` without
 * reading). All three are met here:
 *
 *  1. ONE snapshot PER ENGINE (`__golden__/<engine>.snap`), never a global one,
 *     so a Codex-only regression produces a Codex-only diff.
 *  2. NORMALIZATION of everything that moves for reasons unrelated to content:
 *     the marker's `version=` and `hash=` attributes (see `NORMALIZERS`). Both
 *     change on every release and in every block; unnormalized, the snapshot
 *     would be invalidated by each version bump and lose all signal. This is
 *     the load-bearing mitigation.
 *  3. ONE representative config (`goldenConfig`), not the 12 preset
 *     combinations — preset extras have their own suite
 *     (`engines/claude/__tests__/preset-extras.test.ts`).
 *
 * Regenerating is meant to be trivial (it happens on every legitimate asset
 * change): `cd packages/cli && pnpm test:golden`. Then READ the diff — that is
 * the entire point of the tool.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = join(__dirname, "__golden__");

/** The one command that rewrites every golden file. Quoted in the failure. */
const REGEN_COMMAND = "cd packages/cli && pnpm test:golden";

/** Opens a file's section in the snapshot. Guarded: no content may contain it. */
const FILE_MARKER = "===== FILE: ";

/**
 * A substitution applied to every rendered byte before comparison. Only for
 * values that move WITHOUT the output's meaning moving — anything content-
 * bearing must reach the snapshot verbatim or the guard is theatre.
 */
interface Normalizer {
  /** Why this value is noise rather than signal. */
  readonly reason: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

const NORMALIZERS: readonly Normalizer[] = [
  {
    reason:
      "the marker's version stamp is the CLI version: it moves in EVERY managed block on every release (#388) while the prose stays identical",
    // Lazy up to the first `version="…"` on the same marker line, so only the
    // attribute is touched and never a version quoted in the prose itself.
    pattern: /(navori:managed[^\n]*?)version="[^"]*"/g,
    replacement: '$1version="<VERSION>"',
  },
  {
    reason:
      "the marker's content hash is derived from the body: it adds a second changed line per block and no information the body diff does not already carry",
    pattern: /(navori:managed[^\n]*?)hash="[^"]*"/g,
    replacement: '$1hash="<HASH>"',
  },
  {
    reason:
      "the `$navori.version` stamp is the same CLI version in JSON notation (#538): it moves on every release with nothing behind it",
    // Scoped to the `$navori` object — whose value has no nested braces — so a
    // `"version"` belonging to any other JSON navori renders is left verbatim.
    pattern: /("\$navori":\s*\{[^}]*?"version":\s*")[^"]*"/g,
    replacement: '$1<VERSION>"',
  },
];

function normalize(content: string): string {
  let out = content;
  for (const n of NORMALIZERS) out = out.replace(n.pattern, n.replacement);
  return out;
}

/**
 * The representative config (mitigation 3). Deliberate choices:
 *  - `preset: "custom"` — pins the CORE surface every preset shares, which is
 *    where cross-cutting drift lands. Preset extras have their own suite.
 *  - EVERY plugin enabled — a plugin's managed block is prose written from the
 *    PLUGIN author's frame and rendered into a repo with a different layout,
 *    exactly the drift class of #407; with only one plugin on, it is invisible.
 *  - two library skills — enough to pin the library layer and its index rows
 *    without pulling all 28 into the fixture.
 *  - literal `qualityGate` / `branchBase` values, because `{{qualityGate.*}}`
 *    and `{{prTarget}}` are interpolated at render time and reach the snapshot
 *    already resolved; stable inputs keep them stable.
 */
function goldenConfig(engines: NavoriConfig["engines"]): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "golden-demo",
    engines,
    preset: "custom",
    branchBase: "main",
    commits: "conventional-es",
    qualityGate: { fast: "pnpm lint", full: "pnpm test && pnpm lint" },
    plugins: {
      acli: { enabled: true },
      codegraph: { enabled: true },
      engram: { enabled: true },
      gh: { enabled: true },
      jscpd: { enabled: true },
      semgrep: { enabled: true },
    },
    project: { libraries: ["zod-validation", "vitest"] },
  });
}

interface EngineCase {
  /** Snapshot basename, and the per-engine scope of the diff (mitigation 1). */
  readonly id: string;
  /** `engines` declared in the config for this case. */
  readonly engines: NavoriConfig["engines"];
  readonly render: (cwd: string, config: NavoriConfig) => void;
}

/**
 * `claude` and `codex` declare BOTH engines: that is the dogfood shape (this
 * repo included) and the only one where the cross-model-review sub-block of
 * `leader.md` renders at all — with a single engine the snapshot would silently
 * stop covering it. The prose engines declare only themselves; nobody runs
 * AGENTS.md alongside Cursor alongside Copilot.
 */
const ENGINE_CASES: readonly EngineCase[] = [
  {
    id: "claude",
    engines: ["claude", "codex"],
    render: (cwd, config) => void renderClaudeEngine(cwd, config),
  },
  {
    id: "codex",
    engines: ["claude", "codex"],
    render: (cwd, config) => void renderCodexEngine(cwd, config),
  },
  {
    id: "agents-md",
    engines: ["agents-md"],
    render: (cwd, config) => void renderAgentsMdEngine(cwd, config),
  },
  {
    id: "cursor",
    engines: ["cursor"],
    render: (cwd, config) => void renderCursorEngine(cwd, config),
  },
  {
    id: "copilot",
    engines: ["copilot"],
    render: (cwd, config) => void renderCopilotEngine(cwd, config),
  },
];

/** Recursively list every emitted file (repo-relative), sorted for stability. */
function listFiles(cwd: string, rel = ""): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(cwd, rel)).sort()) {
    const relPath = rel === "" ? name : `${rel}/${name}`;
    if (statSync(join(cwd, relPath)).isDirectory()) out.push(...listFiles(cwd, relPath));
    else out.push(relPath);
  }
  return out.sort();
}

/**
 * Serialize a rendered tree into the golden text format: a header explaining
 * how to regenerate it, then every file as `===== FILE: <path> =====` followed
 * by its normalized bytes, then a terminator carrying the file count (so an
 * added or removed file always shows up as a diff line, even if its section
 * scrolls past).
 *
 * The executable bit is part of the contract, not decoration: hooks that stop
 * being executable are a silent harness failure, and `[exec]` in the header is
 * the cheapest place to pin it.
 *
 * Every section body is emitted followed by a newline, which makes a missing
 * trailing newline visible (`x` and `x\n` serialize differently) instead of
 * being swallowed by the delimiter.
 */
function serializeTree(cwd: string, engineId: string): string {
  const files = listFiles(cwd);
  const parts = [
    `# navori golden render — engine: ${engineId}`,
    "#",
    `# Regenerate: ${REGEN_COMMAND}`,
    "# Then READ the diff: an unexplained change here is the finding.",
    "#",
    "# Normalized (see golden-render-tree.test.ts → NORMALIZERS):",
    ...NORMALIZERS.map((n) => `#   ${n.pattern.source} → ${n.replacement}`),
    "",
  ];
  for (const file of files) {
    const abs = join(cwd, file);
    const exec = (statSync(abs).mode & 0o111) !== 0 ? " [exec]" : "";
    const body = normalize(readFileSync(abs, "utf-8"));
    if (body.includes(FILE_MARKER)) {
      throw new Error(
        `${file} contains the golden delimiter "${FILE_MARKER}" — it would corrupt the snapshot. ` +
          "Change the asset, or change FILE_MARKER in golden-render-tree.test.ts.",
      );
    }
    parts.push(`${FILE_MARKER}${file}${exec} =====`, body, "");
  }
  parts.push(`===== END: ${files.length} files =====`, "");
  return parts.join("\n");
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("golden render tree, per engine (#394)", () => {
  for (const engineCase of ENGINE_CASES) {
    it(`${engineCase.id}: rendered tree matches its golden snapshot`, async () => {
      // A fresh dir per case: `render --apply` treats an already-modified mirror
      // as a user edit and skips it, so rendering twice into one directory would
      // snapshot the FIRST render's bytes and hide the second's.
      const cwd = mkdtempSync(join(tmpdir(), `navori-golden-${engineCase.id}-`));
      tempDirs.push(cwd);
      engineCase.render(cwd, goldenConfig(engineCase.engines));

      const serialized = serializeTree(cwd, engineCase.id);
      const goldenPath = join(GOLDEN_DIR, `${engineCase.id}.snap`);
      try {
        await expect(serialized).toMatchFileSnapshot(goldenPath);
      } catch (error) {
        // The diff alone does not say what to do with it. Re-throw with the
        // regeneration command attached: this message is the most-read place
        // in the whole feature, so it is where the instruction belongs.
        const cause = error instanceof Error ? error.message : String(error);
        throw new Error(
          `The rendered ${engineCase.id} tree no longer matches its golden snapshot.\n` +
            "  → If the change is INTENDED, regenerate and review the diff in the PR:\n" +
            `        ${REGEN_COMMAND}\n` +
            "  → If it is NOT, you just caught unreviewed render drift (#394).\n" +
            `  Snapshot: ${goldenPath}\n\n${cause}`,
          { cause: error },
        );
      }
    });
  }
});
