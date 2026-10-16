import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getCoreRoot } from "../lib/render/bundled-assets.ts";
import { conditionOrchestration } from "../lib/render/render-plan.ts";
import { NavoriConfigSchema } from "../lib/config/schema.ts";
import type { NavoriConfig } from "../lib/config/config.ts";
import { renderClaudeEngine } from "../engines/claude/index.ts";
import { renderAgentsMdEngine } from "../engines/agents-md/index.ts";
import { renderCursorEngine } from "../engines/cursor/index.ts";
import { renderCopilotEngine } from "../engines/copilot/index.ts";
import {
  simulateContextDelivery,
  SESSION_CONTEXT_DELIVERY_BUDGET_CHARS,
  type ContextDeliveryFile,
} from "../lib/assets/doc-budgets.ts";

/**
 * Doctrine contracts over prose assets (spec 0054 R8, T14). Merges what used to
 * be four files — `orquestacion-doctrina`, `scribe-owns-markdown-contracts`,
 * `plan-tiers-contracts` and `claude-md-diet` — so the suite pays the render
 * and import cost once instead of four times.
 *
 * Each contract is a row `{ file, tokens[], absent[] }` (plus `match` /
 * `absentMatch` for the regex assertions): `file` says which rendered or raw
 * asset to read, `tokens` must all be present, `absent` must all be missing.
 * Assertions that are not text-in-text (disk layout, delivery simulation,
 * config checks) stay as bespoke cases below the table.
 *
 * Equivalence: every assertion goes through `has` / `lacks` / `matches` /
 * `lacksMatch`, which record the literal and its polarity. The last case
 * compares them with `fixtures/doctrine-literals.baseline.json`, the literal
 * set the four old files asserted (captured from their execution), so a
 * dropped literal, or one that moved from "present" to "absent", fails here.
 *
 * Original specs, preserved: spec 0019 (R4, R7, R9, R11), spec 0030 lote 2
 * (R1, R2, R5-R9, R13, R49), spec 0032 (R6-R8, R10, R18, R20-R33, R36, R37,
 * R40), spec 0052 (R38, R42, R45, R47), #1273.
 */

/* ---------------------------------------------------------------- recording */

/** Literals the four old files asserted, by polarity (see the header). */
const baseline = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "doctrine-literals.baseline.json"), "utf-8"),
) as { positive: string[]; negative: string[] };

const seen = { positive: new Set<string>(), negative: new Set<string>() };
const key = (lit: string | RegExp): string =>
  lit instanceof RegExp ? `re:${lit.toString()}` : lit;

function has(text: string | readonly string[], literal: string, message?: string): void {
  seen.positive.add(key(literal));
  expect(text, message).toContain(literal);
}
function lacks(text: string | readonly string[], literal: string, message?: string): void {
  seen.negative.add(key(literal));
  expect(text, message).not.toContain(literal);
}
function matches(text: string, pattern: RegExp, message?: string): void {
  seen.positive.add(key(pattern));
  expect(text, message).toMatch(pattern);
}
function lacksMatch(text: string, pattern: RegExp, message?: string): void {
  seen.negative.add(key(pattern));
  expect(text, message).not.toMatch(pattern);
}

/* ------------------------------------------------------------------ sources */

const CORE_ASSETS = resolve(getCoreRoot(), "core-assets");
const readAsset = (rel: string): string => readFileSync(resolve(CORE_ASSETS, rel), "utf-8");

const BLOCK = "managed/orquestacion.md";
const ORCHESTRATOR = "agents/orchestrator.md";
const CONTEXT_DIR = ".claude/context";

const PLAN_BASE = {
  name: "plan-tiers-demo",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
} as unknown as NavoriConfig;

const DIET = {
  name: "diet",
  engines: ["claude", "agents-md", "cursor", "copilot"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "pnpm test", full: "pnpm test" },
} as unknown as NavoriConfig;

/** Named configs the full-engine renders use. */
const RENDER_CONFIGS = {
  base: PLAN_BASE,
  tiers: { ...PLAN_BASE, harness: { planTiers: true } } as unknown as NavoriConfig,
  diet: DIET,
  dietGh: { ...DIET, plugins: { gh: { enabled: true } } } as NavoriConfig,
} as const;
type RenderConfig = keyof typeof RENDER_CONFIGS;
type Engine = "claude" | "agents-md" | "cursor" | "copilot";

const RENDERERS: Record<Engine, (cwd: string, config: NavoriConfig) => unknown> = {
  claude: renderClaudeEngine,
  "agents-md": renderAgentsMdEngine,
  cursor: renderCursorEngine,
  copilot: renderCopilotEngine,
};

/** Where a row reads its text from. */
type Source =
  /** A raw core asset. */
  | { kind: "asset"; rel: string }
  /** A core asset after `conditionOrchestration` under the given harness flags. */
  | { kind: "conditioned"; rel: string; harness: Record<string, boolean> }
  /** A file of a full engine render (each engine+config renders once). */
  | { kind: "render"; engine: Engine; config: RenderConfig; file: string };

const asset = (rel: string): Source => ({ kind: "asset", rel });
const conditioned = (rel: string, harness: Record<string, boolean>): Source => ({
  kind: "conditioned",
  rel,
  harness,
});
const rendered = (engine: Engine, config: RenderConfig, file: string): Source => ({
  kind: "render",
  engine,
  config,
  file,
});
const claude = (config: RenderConfig, file: string): Source => rendered("claude", config, file);

const renderDirs = new Map<string, string>();
function renderDir(engine: Engine, config: RenderConfig): string {
  const id = `${engine}|${config}`;
  let cwd = renderDirs.get(id);
  if (cwd === undefined) {
    cwd = mkdtempSync(join(tmpdir(), "navori-doctrine-"));
    RENDERERS[engine](cwd, RENDER_CONFIGS[config]);
    renderDirs.set(id, cwd);
  }
  return cwd;
}
afterAll(() => {
  for (const d of renderDirs.values()) rmSync(d, { recursive: true, force: true });
});

function read(src: Source): string {
  switch (src.kind) {
    case "asset":
      return readAsset(src.rel);
    case "conditioned":
      return conditionOrchestration(
        readAsset(src.rel),
        NavoriConfigSchema.parse({
          name: "doctrine-contracts-demo",
          engines: ["claude"],
          preset: "custom",
          harness: src.harness,
        }),
      );
    case "render":
      return readFileSync(join(renderDir(src.engine, src.config), src.file), "utf-8");
  }
}

/* -------------------------------------------------------------------- table */

interface ContractRow {
  /** Case id, unique within the table. */
  id: string;
  /** Asset or rendered file the row reads. */
  file: Source;
  /** Collapse whitespace runs before asserting (rendered prose wraps). */
  squash?: boolean;
  /** Lowercase before asserting. */
  lower?: boolean;
  /** Literals that must be present. */
  tokens?: readonly string[];
  /** Literals that must be absent. */
  absent?: readonly string[];
  /** Patterns that must match. */
  match?: readonly RegExp[];
  /** Patterns that must not match. */
  absentMatch?: readonly RegExp[];
}

const INTAKE_BULLETS = [
  "**The problem is the contract.**",
  "**The proposed solution is a suggestion, never the spec.**",
  "**Not every ticket proceeds.**",
  "**Size is measured, not assumed.**",
] as const;
const SKILL_POINTER = ".claude/skills/resolve-ticket/SKILL.md";

const RULE_R38 =
  "Two `CHANGES_REQUESTED`: at level 0/1, a fresh `solution_<f>.md` and its challenge before the " +
  "next dispatch (each pair of rejections needs its own); at level ≥2, escalate to the user, " +
  "who alone authorizes another round with `navori plan escalation-reset`.";

const ARCHITECT_R18 =
  "Verify every 'already exists' claim against `origin/main` after `git fetch origin main`; " +
  "if the fetch fails or the ref doesn't exist, name the ref you actually used — or mark " +
  "the claim *unverified* with the cause.";

const ARCHITECT_TOKENS = [
  "Derive the decision drivers from the project's own rules (DIRECTION, CLAUDE.md, EXTENDING, `quality-attributes`) before you list any option.",
  "Explore at least three rungs — the existing pattern, an extension, a new abstraction. A discarded rung gets one line with its evidence; a surviving one is developed in full.",
  "Recommend the option that best fits the drivers, not the cheapest by default.",
  // Covers: R18
  ARCHITECT_R18,
  "Decision drivers",
  "Options",
  "Recommendation",
  "Durable knowledge",
  "You propose the destination; you never write it.",
  "specs/<feature>/design.md",
  "spec-bootstrap",
] as const;

const R2_KEYS = [
  '"feature"',
  '"status"',
  '"worktree"',
  '"branch"',
  '"commits"',
  '"filesTouched"',
  '"verification"',
  '"markdownRequests"',
] as const;

const OFF = { scribeOwnsMarkdown: false };
const ON = { scribeOwnsMarkdown: true };

const ROWS: readonly ContractRow[] = [
  /* ---- orquestacion-doctrina (spec 0019) ---------------------------------- */
  // Covers: R4
  {
    id: "el bloque conserva la regla operativa (R4)",
    file: asset(BLOCK),
    tokens: [
      "NEVER delegate that role",
      "Every change to source goes through",
      "Delegation is about WRITING, not about answering",
      "### How much analysis does this task deserve",
      "**The architectural pass — design before you decompose.**",
      "ALL `Agent` calls in a SINGLE turn",
      "### When delegation is genuinely impossible",
    ],
  },
  {
    id: "la escalera retirada no vuelve al bloque",
    file: asset(BLOCK),
    absent: ["R1 · Inline", "R2 · Delegate", "4-file rule", "2+ non-trivial files"],
  },
  {
    id: "orchestrator.md explica por qué se retiró la escalera y qué hace falta para reponerla",
    file: asset(ORCHESTRATOR),
    tokens: ["seven places that did not agree", "shared classifier"],
  },
  // Covers: R7
  {
    id: "cada sección retirada vive en orchestrator.md (R7)",
    file: asset(ORCHESTRATOR),
    tokens: [
      "git worktree remove",
      "squash merge leaves no ancestry",
      "load-bearing claims",
      "2 `CHANGES_REQUESTED` cycles",
      "## Frugal delegation",
      "a review from a **different provider**",
    ],
  },
  // Covers: R9
  {
    id: "el bloque nombra con ruta literal dónde vive la profundidad (R9)",
    file: asset(BLOCK),
    tokens: [
      ".claude/agents/orchestrator.md",
      ".claude/skills/resolve-ticket/SKILL.md",
      ".claude/skills/solution-design/SKILL.md",
    ],
  },
  // Covers: R11
  {
    id: "la escalera no se repite en orchestrator.md (R11)",
    file: asset(ORCHESTRATOR),
    absent: [
      "Delegation is about WRITING, not about answering",
      "### How much analysis does this task deserve",
      "### When delegation is genuinely impossible",
    ],
  },
  // Covers: R11
  {
    id: "la profundidad no se repite en el bloque (R11)",
    file: asset(BLOCK),
    absent: [
      "## Frugal delegation",
      "git worktree remove",
      "squash merge leaves no ancestry",
      "a review from a **different provider**",
    ],
  },
  // Covers: R33
  {
    id: "architectural pass: proposes via `architect` while planTiers is off (default)",
    file: conditioned(BLOCK, { auditor: true }),
    tokens: [
      "`architect` applies `solution-design` and writes",
      "READY / CONCERNS / BLOCKED — always yours",
    ],
    match: [/an `auditor`, not a new agent/],
  },
  // Covers: R30
  {
    id: "architectural pass: the paragraph drops once planTiers is on",
    file: conditioned(BLOCK, { planTiers: true, auditor: true }),
    absent: ["`architect` applies `solution-design`"],
  },
  {
    id: "architectural pass: the verdict is the orchestrator's without an auditor",
    file: conditioned(BLOCK, { auditor: false }),
    tokens: ["READY / CONCERNS / BLOCKED — always yours"],
  },
  // Covers: R7
  {
    // `render-engine.test.ts` uses the same token as proof the sub-block is absent,
    // so the prose can never contain it (the detection would self-satisfy).
    id: "orchestrator.md no nombra el id del sub-bloque que navori le inyecta",
    file: asset(ORCHESTRATOR),
    absent: ["codex-cross-review"],
  },
  // Covers: R38
  ...[ORCHESTRATOR, "managed/planificacion.md", "skills/plan-advanced.md"].map(
    (rel): ContractRow => ({
      id: `${rel} lleva la regla de dos rechazos (R38)`,
      file: asset(rel),
      squash: true,
      tokens: [RULE_R38],
    }),
  ),

  /* ---- scribe-owns-markdown (spec 0030 lote 2) ---------------------------- */
  // Covers: R1, R2
  {
    id: "implementer OFF: keeps the current contract (R13)",
    file: conditioned("agents/implementer.md", OFF),
    tokens: [
      "Write `.navori/state/handoffs/impl_<feature>.md`",
      "done -> .navori/state/handoffs/impl_<feature>.md",
    ],
    absent: ["impl_<feature>.json", "markdownRequests"],
  },
  // Covers: R1
  {
    id: "implementer ON: states the .md/.mdx prohibition and gives no instruction to write one",
    file: conditioned("agents/implementer.md", ON),
    match: [/SHALL NOT create or edit any file whose name ends in `\.md` or `\.mdx`/],
    absent: ["Write `.navori/state/handoffs/impl_<feature>.md`"],
    absentMatch: [/Write.*impl_<feature>\.md/],
  },
  // Covers: R2
  {
    id: "implementer ON: writes impl_<feature>.json with every required key",
    file: conditioned("agents/implementer.md", ON),
    tokens: [
      "impl_<feature>.json",
      "done -> .navori/state/handoffs/impl_<feature>.json",
      ...R2_KEYS,
    ],
  },
  // Covers: R5, R6, R7
  {
    id: "scribe OFF: keeps the serializer-only contract (R13)",
    file: conditioned("agents/scribe.md", OFF),
    tokens: ["ahead of the typed-handoff migration", "user-authored documentation"],
    absent: ["markdownRequests"],
  },
  {
    id: "scribe ON: has no 'not yet wired' disclaimer and no 'you do not investigate' rule",
    file: conditioned("agents/scribe.md", ON),
    absent: [
      "ahead of the typed-handoff migration",
      "not yet wired",
      "user-authored documentation",
    ],
    absentMatch: [/you do not investigate/i],
  },
  // Covers: R5
  {
    id: "scribe ON: renders impl_<feature>.md from impl_<feature>.json",
    file: conditioned("agents/scribe.md", ON),
    tokens: ["impl_<feature>.json"],
    match: [/render.*impl_<feature>\.md/i],
  },
  // Covers: R6
  {
    id: "scribe ON: reports BLOCKED and fabricates no artifact on invalid or mismatched payload",
    file: conditioned("agents/scribe.md", ON),
    match: [
      /BLOCKED/,
      /create NO `\.md` artifact|create no `?\.md`? artifact/i,
      /feature.*doesn't match|doesn't match.*feature/i,
    ],
  },
  // Covers: R7
  {
    id: "scribe ON: applies markdownRequests in the producer's worktree/branch with its own commit",
    file: conditioned("agents/scribe.md", ON),
    tokens: ["markdownRequests"],
    match: [/intent/, /evidence/, /commit it yourself|separate from the producer's/],
  },
  // Covers: R49
  {
    id: "implementer declara la división del Markdown por doctrina y estado (R49)",
    file: conditioned("agents/implementer.md", ON),
    tokens: [
      "AI doctrine",
      "packages/core/core-assets/{agents,skills,managed,hooks}/",
      "navori render --apply",
    ],
    match: [/never with Bash/],
  },
  // Covers: R49
  {
    id: "scribe declara la división del Markdown por doctrina y estado (R49)",
    file: conditioned("agents/scribe.md", ON),
    tokens: ["`progress/`"],
    match: [/implementer.*writes AI doctrine itself/],
  },
  // Covers: R49
  {
    // Flag OFF keeps the pre-spec text: no doctrine split.
    id: "implementer OFF no declara la división del Markdown (R49)",
    file: conditioned("agents/implementer.md", OFF),
    absent: ["AI doctrine"],
  },
  // Covers: R8, R9
  {
    id: "orchestrator OFF: no scribe leg, no per-dispatch model rule",
    file: conditioned("agents/orchestrator.md", OFF),
    tokens: ["impl_<feature>.md"],
    absent: ["The `scribe` leg", "model: sonnet", "impl_<feature>.json"],
  },
  // Covers: R8, R9
  {
    id: "orquestacion OFF: implementer then reviewer only",
    file: conditioned("managed/orquestacion.md", OFF),
    tokens: ["then **1 fresh `reviewer`**"],
    absent: ["`scribe`"],
  },
  // Covers: R9
  {
    id: "orchestrator ON: chains implementer -> scribe -> reviewer for markdownRequests",
    file: conditioned("agents/orchestrator.md", ON),
    tokens: ["prose-only change (no code) skips the `implementer`"],
    match: [/implementer.*scribe.*reviewer/s],
  },
  // Covers: R9
  {
    id: "orquestacion ON: scribe appears with markdownRequests",
    file: conditioned("managed/orquestacion.md", ON),
    match: [/`scribe`.*markdownRequests/s],
  },
  // Covers: R9
  {
    id: "orchestrator ON: the reviewer judges the complete diff including the scribe's commit",
    file: conditioned("agents/orchestrator.md", ON),
    lower: true,
    match: [/scribe.*commit|reviewer.*scribe/s],
  },
  // Covers: R8
  {
    id: "orchestrator ON: model is chosen per dispatch",
    file: conditioned("agents/orchestrator.md", ON),
    tokens: ["model: sonnet"],
    match: [/\{\{models\.scribe\}\}/],
  },
  // Covers: R9
  {
    id: "resolve-ticket OFF: implementer alone produces impl_<feature>.md",
    file: conditioned("skills/resolve-ticket.md", OFF),
    tokens: ["Produces `impl_<feature>.md`"],
    absent: ["impl_<feature>.json"],
  },
  // Covers: R9
  {
    id: "resolve-ticket ON: implementer produces JSON, scribe renders the .md and applies requests",
    file: conditioned("skills/resolve-ticket.md", ON),
    tokens: ["impl_<feature>.json"],
    match: [/scribe.*renders.*impl_<feature>\.md/i],
  },
  {
    id: "verify-before-done OFF: done -> impl_<feature>.md",
    file: conditioned("skills/verify-before-done.md", OFF),
    tokens: ["done -> impl_<feature>.md"],
  },
  {
    id: "verify-before-done ON: done -> impl_<feature>.json",
    file: conditioned("skills/verify-before-done.md", ON),
    tokens: ["done -> impl_<feature>.json"],
  },

  /* ---- plan-tiers-contracts (spec 0032, spec 0052) ------------------------ */
  // Covers: R6, R7, R8, R22
  {
    id: "planTiers on: 05-planificacion.md carries the level table",
    file: claude("tiers", `${CONTEXT_DIR}/05-planificacion.md`),
    tokens: ["Planning tiers"],
    match: [/\| 0 \|.*\| 1 \|.*\| 2 \|.*\| 3 \|/s],
  },
  // Covers: R30
  {
    id: "planTiers off: orquestacion keeps the architect paragraph",
    file: claude("base", `${CONTEXT_DIR}/10-orquestacion.md`),
    tokens: ["`architect` applies `solution-design` and writes"],
  },
  {
    id: "planTiers on: orquestacion drops the architectural paragraph",
    file: claude("tiers", `${CONTEXT_DIR}/10-orquestacion.md`),
    absent: ["`architect` applies `solution-design`"],
  },
  // Covers: R40
  {
    id: "planTiers on: el contexto inline trae precondición, regla sin ruta inline y spec",
    file: claude("tiers", `${CONTEXT_DIR}/05-planificacion.md`),
    squash: true,
    tokens: [
      "Plan precondition:",
      "every code write goes through `implementer` → `reviewer`, with no inline route",
      "spec: <spec> E<n> M<n>",
    ],
    absent: ["see `orquestacion`"],
  },
  // Covers: R6
  {
    id: "planificacion declara nivel-0 con feature y que el gate no ve el diff real",
    file: claude("tiers", `${CONTEXT_DIR}/05-planificacion.md`),
    squash: true,
    tokens: [
      "nivel-0: <path>[,<path>] <feature>",
      "the gate checks only the declared path, never the real diff",
      "a feature with a workplan opens with `workplan: <feature>`",
    ],
    // The old one-token grammar must not survive anywhere in the block.
    absentMatch: [/nivel-0: <path>(?![[ ])/],
  },
  // Covers: R42
  {
    id: "reviewer rechaza progress-unevidenced y stale pero no unevidenced-accepted",
    file: claude("tiers", ".claude/agents/reviewer.md"),
    squash: true,
    tokens: [
      "`progress-unevidenced` or `progress-evidence-stale` → `CHANGES_REQUESTED`",
      "`progress-unevidenced-accepted` is not a rejection",
    ],
  },
  // Covers: R45
  {
    id: "reviewer documenta receipt gate --phase para workplans con fases",
    file: claude("tiers", ".claude/agents/reviewer.md"),
    squash: true,
    tokens: ["`navori receipt gate --feature <feature> --phase <phase>`"],
  },
  // Covers: R47
  ...[".claude/agents/reviewer.md", ".claude/skills/plan-advanced/SKILL.md"].map(
    (file): ContractRow => ({
      id: `${file} declara el recibo y el reset como atestación local y CODEX_THREAD_ID`,
      file: claude("tiers", file),
      squash: true,
      tokens: ["local attestations without authentication", "`CODEX_THREAD_ID`"],
    }),
  ),
  // Covers: R10, R18, R23, R24, R25, R26, R27, R28, R36, R37
  ...([false, true] as const).map((planTiers): ContractRow => ({
    id: `R26/R28: architect's rendered body carries the method and the artifact (planTiers ${planTiers ? "on" : "off"}, architect always renders — R33)`,
    file: claude(planTiers ? "tiers" : "base", ".claude/agents/architect.md"),
    tokens: ARCHITECT_TOKENS,
  })),
  {
    id: "R25: the rendered architect never claims to write the workplan or decompose into tasks",
    file: claude("tiers", ".claude/agents/architect.md"),
    match: [/never decompose into (implementer )?tasks/i],
    absentMatch: [/writes? the workplan/i],
  },
  {
    id: "R27: solution-design derives decision drivers before the ladder and verifies existing claims",
    file: claude("tiers", ".claude/skills/solution-design/SKILL.md"),
    squash: true,
    tokens: [
      "Before any option, derive the decision drivers from the project's own rules; the ladder " +
        "`existing pattern > small extension > new abstraction > new subsystem` is one driver, not the default winner.",
      // Covers: R18
      ARCHITECT_R18,
    ],
  },
  {
    id: "R28: spec-bootstrap's rendered Order has the architect apply solution-design for design.md",
    file: claude("tiers", ".claude/skills/spec-bootstrap/SKILL.md"),
    tokens: ["The `architect` writes `design.md`, applying `solution-design`."],
  },
  {
    id: "R23/R24: planTiers on routes level 2 through architect/auditor/user/verdict",
    file: claude("tiers", `${CONTEXT_DIR}/05-planificacion.md`),
    tokens: [
      "`architect` → `auditor` challenge → user picks → your verdict → level-2 workplan. Skill `plan-advanced`",
    ],
  },
  {
    id: "R10/R36/R37: the orchestrator omits the workplan handoff files without planTiers",
    file: claude("base", ".claude/agents/orchestrator.md"),
    absent: ["workplan_<feature>.gate.jsonl"],
  },
  {
    id: "R10/R36/R37: the orchestrator names the workplan handoff files and the plan-tiers doctrine under planTiers",
    file: claude("tiers", ".claude/agents/orchestrator.md"),
    tokens: [
      "`.navori/state/handoffs/workplan_<feature>.json` — the workplan source, written by you; " +
        "`workplan_<feature>.md` is `navori plan render`'s output, and `workplan_<feature>.gate.jsonl` the gate's log",
      "Planning tiers: the `planificacion` block decides the level; the `plan-simple` / `plan-advanced` skills carry the procedure.",
    ],
  },
  // Covers: R20, R21
  {
    id: "R20: the implementer omits the workplan/acceptance protocol without planTiers",
    file: claude("base", ".claude/agents/implementer.md"),
    absent: ["under `acceptance` (`id`, `command`, `exitCode`, `excerpt`)"],
  },
  {
    id: "R20: the implementer carries the workplan/acceptance protocol under planTiers",
    file: claude("tiers", ".claude/agents/implementer.md"),
    tokens: [
      "When the encargo opens with `workplan: <feature>`, read " +
        "`.navori/state/handoffs/workplan_<feature>.json`, run each assigned `A<n>` `command` exactly as " +
        "written (same string, foreground, no rewrites), then mark progress and report it in " +
        "`impl_<feature>.json` under `acceptance` (`id`, `command`, `exitCode`, `excerpt`). " +
        "The routing-watch hook records acceptance evidence only when the host itself ran that exact " +
        "command; `navori plan update <feature> --progress A<n>=cumplido` is rejected without it and " +
        "never runs the command for you. A file outside the workplan's files is a blocker to report, not a change to make.",
    ],
  },
  {
    id: "R21: the reviewer omits classify --diff evidence without planTiers",
    file: claude("base", ".claude/agents/reviewer.md"),
    absent: ["navori plan classify <feature> --diff"],
  },
  {
    id: "R21: the reviewer requires classify --diff evidence under planTiers",
    file: claude("tiers", ".claude/agents/reviewer.md"),
    tokens: [
      "With a workplan: an assigned `A<n>` without evidence in `acceptance`, a file outside the " +
        "workplan's files without a covering decision, or `navori plan classify <feature> --diff` " +
        "returning a higher level than declared → `CHANGES_REQUESTED`.",
    ],
  },
  {
    id: "R22: resolve-ticket omits plan-advanced without planTiers",
    file: claude("base", ".claude/skills/resolve-ticket/SKILL.md"),
    absent: ["plan-advanced"],
  },
  {
    id: "R22: resolve-ticket points level 2 at plan-advanced and opens the encargo with workplan: <feature> under planTiers",
    file: claude("tiers", ".claude/skills/resolve-ticket/SKILL.md"),
    tokens: ["plan-advanced", "the encargo opens with `workplan: <feature>`"],
  },

  /* ---- claude-md-diet (#1273) --------------------------------------------- */
  {
    id: "Claude CLAUDE.md: intake keeps the ticket contract and the pointer, drops the bullets",
    file: rendered("claude", "diet", "CLAUDE.md"),
    tokens: ["problem is the contract", SKILL_POINTER],
    absent: [...INTAKE_BULLETS, "navori:if"],
  },
  {
    id: "Claude CLAUDE.md: sdd keeps the trigger and the no-TaskCreate rule, drops Structure/Tracking",
    file: rendered("claude", "diet", "CLAUDE.md"),
    tokens: ["When to PROPOSE a spec", "do NOT use `TaskCreate`"],
    absent: ["**Structure:**", "Covers: R"],
  },
  {
    id: "Claude CLAUDE.md: ships neither the skills index nor gh-protocol",
    file: rendered("claude", "dietGh", "CLAUDE.md"),
    absent: ['id="skills-index"', 'id="gh-protocol"'],
  },
  ...(
    [
      ["agents-md", "AGENTS.md"],
      ["cursor", ".cursor/rules/navori.mdc"],
      ["copilot", ".github/copilot-instructions.md"],
    ] as const
  ).map(([engine, file]): ContractRow => ({
    id: `${engine}: full intake bullets and SDD Structure/Tracking, no pointer, no markers`,
    file: rendered(engine, "diet", file),
    tokens: [...INTAKE_BULLETS, "**Structure:**", "Covers: R"],
    absent: [SKILL_POINTER, "navori:if"],
  })),
];

describe("doctrine contracts — text tables", () => {
  it("every row id is unique", () => {
    expect(new Set(ROWS.map((r) => r.id)).size).toBe(ROWS.length);
  });

  it.each(ROWS)("$id", (row) => {
    let text = read(row.file);
    if (row.squash) text = text.replace(/\s+/g, " ");
    if (row.lower) text = text.toLowerCase();
    for (const token of row.tokens ?? []) has(text, token, `falta "${token.slice(0, 80)}"`);
    for (const token of row.absent ?? []) lacks(text, token, `sobra "${token.slice(0, 80)}"`);
    for (const pattern of row.match ?? []) matches(text, pattern);
    for (const pattern of row.absentMatch ?? []) lacksMatch(text, pattern);
  });
});

/* ------------------------------------------------------------ bespoke cases */

/** Every `.claude/context/*.md` file, sorted the way the SessionStart hook globs them. */
function contextFiles(cwd: string): ContextDeliveryFile[] {
  const dir = join(cwd, CONTEXT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({
      path: `${CONTEXT_DIR}/${f}`,
      chars: readFileSync(join(dir, f), "utf-8").length,
    }));
}

describe("doctrine contracts — render layout and delivery (spec 0032)", () => {
  // Covers: R30
  it("planTiers off (default) renders no planificacion context file", () => {
    expect(existsSync(join(renderDir("claude", "base"), CONTEXT_DIR, "05-planificacion.md"))).toBe(
      false,
    );
  });

  it("planTiers on writes 05-planificacion.md ahead of 10-orquestacion.md", () => {
    const files = readdirSync(join(renderDir("claude", "tiers"), CONTEXT_DIR)).sort();
    has(files, "05-planificacion.md");
    expect(files.indexOf("05-planificacion.md")).toBeLessThan(files.indexOf("10-orquestacion.md"));
  });

  it("R6/R8/R22: the planificacion body is DELIVERED INLINE to the SessionStart context, not just written to disk", () => {
    const files = contextFiles(renderDir("claude", "tiers"));
    expect(files.length).toBeGreaterThan(0);

    const delivered = simulateContextDelivery(files);
    const planificacion = delivered.find((f) => f.path.endsWith("05-planificacion.md"));
    expect(
      planificacion,
      "05-planificacion.md must be part of the delivered context set",
    ).toBeDefined();
    expect(
      planificacion!.delivered,
      "the block degraded to a pointer — it never reaches `hook_additional_context` whole",
    ).toBe("inline");
    // Sanity: the block is nowhere near the delivery budget on its own (T6's
    // 250-word ceiling is a small fraction of the 8000-char session budget).
    expect(planificacion!.chars).toBeLessThan(SESSION_CONTEXT_DELIVERY_BUDGET_CHARS);
  });

  // Covers: R40
  it("con planTiers 05- queda inline aunque orquestacion degrade a puntero", () => {
    // A field-sized `progress/current.md` pushes `10-orquestacion.md` past the
    // budget: it degrades to a pointer, while `05-` (first in order) stays inline.
    const files = contextFiles(renderDir("claude", "tiers")).map((f) =>
      f.path.endsWith("10-orquestacion.md") ? { ...f, chars: 9000 } : f,
    );
    const delivered = simulateContextDelivery(files);
    expect(delivered.find((f) => f.path.endsWith("10-orquestacion.md"))?.delivered).toBe("pointer");
    expect(delivered.find((f) => f.path.endsWith("05-planificacion.md"))?.delivered).toBe("inline");
  });
});

describe("doctrine contracts — intake doctrine has two owners by engine, one wording (#1273)", () => {
  // Covers: #1273
  it("every intake bullet in the block (prose engines) is verbatim in resolve-ticket (Claude)", () => {
    const block = readAsset("managed/intake-tickets.md");
    const skill = readAsset("skills/resolve-ticket.md");
    const bullets = block.split("\n").filter((l) => l.startsWith("- **"));
    expect(bullets).toHaveLength(INTAKE_BULLETS.length);
    for (const bullet of bullets) {
      has(skill, bullet, `resolve-ticket lost the intake bullet "${bullet.slice(0, 40)}…"`);
    }
  });

  // Covers: #1273
  it("the SDD threshold stays single-owner and spec-bootstrap owns the Covers convention", () => {
    has(readAsset("managed/sdd.md"), "~2 days");
    lacks(readAsset("skills/spec-bootstrap.md"), "~2 days");
    has(readAsset("skills/spec-bootstrap.md"), "// Covers: R<n>");
  });
});

describe("doctrine contracts — this repo's navori.config.json (spec 0032 R29, R31)", () => {
  const REPO_CONFIG_PATH = join(import.meta.dirname, "..", "..", "..", "..", "navori.config.json");

  // Covers: R31
  it("R31: harness.planTiers is on", () => {
    const config = JSON.parse(readFileSync(REPO_CONFIG_PATH, "utf-8")) as NavoriConfig;
    expect(config.harness?.planTiers).toBe(true);
  });

  // Covers: R29
  it("R29: no harness.architect, models.architect or effort.architect override — core's always-on default applies", () => {
    const config = JSON.parse(readFileSync(REPO_CONFIG_PATH, "utf-8")) as NavoriConfig & {
      harness?: { architect?: unknown };
    };
    expect(config.harness?.architect).toBeUndefined();
    expect(config.models?.architect).toBeUndefined();
    expect(config.effort?.architect).toBeUndefined();
  });

  // Covers: R29
  it("R29: design.md registers the architect's admission per spec 0031 R3", () => {
    const designPath = join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "..",
      "specs",
      "0032-planificacion-por-niveles",
      "design.md",
    );
    has(readFileSync(designPath, "utf-8"), "Admisión del architect (spec 0031 R3)");
  });
});

/* ------------------------------------------------------------- equivalence */

// Must stay the LAST case: it reads what every case above asserted.
describe("doctrine contracts — equivalence with the four merged files (R8)", () => {
  // Covers: R8
  it("cada token afirmado antes de la fusión sigue afirmado", () => {
    const missingPositive = baseline.positive.filter((l) => !seen.positive.has(l));
    const missingNegative = baseline.negative.filter((l) => !seen.negative.has(l));
    expect({ missingPositive, missingNegative }).toEqual({
      missingPositive: [],
      missingNegative: [],
    });
  });
});
