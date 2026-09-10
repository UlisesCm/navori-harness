import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFrontmatterField, splitFrontmatter } from "../frontmatter.ts";
import { tc, type Lang } from "../i18n.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../schema.ts";
import { renderClaudeEngine } from "../../engines/claude/index.ts";
import { isInvokable, listAgentAssets, type AgentAsset } from "./helpers/agent-assets.ts";

/**
 * Every shipped agent declares WHEN to fire it, not only what it is.
 *
 * The defect this exists for (spec 0020, R1): the host picks subagents by
 * their `description` — "Claude uses each subagent's description to decide
 * when to delegate… include phrases like 'use proactively'" — and all 8 of
 * navori's described only what the agent IS. Measured over 48 audited
 * sessions, 12 of the 21 that crossed the R2 threshold (4+ files written by
 * the main thread) delegated nothing at all. The routing ladder shipped as
 * startup context, which the same doc calls "context, not enforced
 * configuration"; the `description` is the lever the host actually evaluates,
 * and navori was leaving it blank on the condition half.
 *
 * Read over the SHIPPED assets (`getCoreRoot()` + `core-assets/agents`) and
 * not a fixture, for the reason `agents-assets.test.ts` gives: a new role has
 * to join the contract by existing. A hand-kept list is how `auditor` shipped
 * outside the shape contract until #417.
 *
 * TWO CHANNELS, one contract. The frontmatter `description` is what the HOST
 * reads to delegate; `blocks.agentsIndex.when` (i18n) is what the ORCHESTRATOR
 * reads, through the `agentes-disponibles` block the SessionStart hook injects.
 * They are separate stores of prose about the same 8 agents, so they drift in
 * silence — and they had: the field is literally named `when` and not one of
 * its entries said when ("Escribe código y tests para UNA tarea bien acotada").
 * Fixing only the frontmatter would have left the host reading "Use proactively
 * when a change touches 4+ files" while the orchestrator read "Escribe código y
 * tests", which is worse than either end being wrong on its own.
 *
 * WHAT THIS DOES NOT DO: it does not pin any description's text, and it does
 * NOT compare the two channels word for word — different languages, different
 * audiences, and a text equality would force a translation nobody wants.
 * Freezing the wording would catch a rewrite and miss the next description that
 * drops the condition, which is the failure being prevented. It checks
 * NECESSARY conditions instead — a trigger clause is present in BOTH channels
 * for the SAME agents, and the frontmatter field stays short enough to be a
 * routing signal.
 */

/** The agents navori ships, `leader` included: its trigger is "never". */
const AGENTS = listAgentAssets();

function description(asset: AgentAsset): string {
  return getFrontmatterField(splitFrontmatter(asset.content).frontmatter, "description") ?? "";
}

interface TriggerForm {
  readonly id: string;
  readonly pattern: RegExp;
}

/**
 * The phrasing families that count as declaring a trigger.
 *
 * Narrow ON PURPOSE, and this is the trade-off worth naming. The wide reading
 * — "any sentence containing `when`" — passes on prose that states no
 * condition at all (`…decide when to delegate`), so it would report coverage
 * it does not have. The host's own documentation names the `use proactively`
 * family as what it evaluates, so pinning that family makes the convention
 * checkable at the cost of rejecting equivalent paraphrases. That cost is
 * real and was paid once already: `auditor` shipped "Trigger it when the user
 * says…", a genuine condition in a phrasing this rejects — and the positive
 * control below keeps that exact string rejected on purpose.
 *
 * THE NARROWNESS IS DELIBERATE, and this is the paragraph that says so, because
 * the next reader's instinct will be to loosen the regex until their phrasing
 * passes. This is a CONVENTION check, not a semantic one. It cannot tell
 * whether a sentence expresses a condition — nothing a regex does can — so it
 * asserts the one thing it can verify: that the description is written in the
 * form the host's own documentation names ("include phrases like 'use
 * proactively'"). Encoding the documented form is the honest proxy; a wide
 * criterion would report coverage over prose a human reads as conditional and
 * the host was never told to treat as a trigger. Rephrase into the family; do
 * not widen the pattern to readmit the paraphrase.
 */
const TRIGGER_FORMS: readonly TriggerForm[] = [
  {
    // "Use proactively when …", "Use when …", "Use after …", "Use before …".
    id: "affirmative (use proactively / use when / use after / use before)",
    pattern: /\buse\s+(?:it\s+)?(?:proactively|when|after|before)\b/i,
  },
  {
    // The other half of R1: an agent whose condition is that there is none.
    // `leader` is a playbook the main agent embodies, so the honest trigger is
    // an explicit prohibition — and the marker is `helpers/agent-assets.ts`'s
    // `NOT_INVOKABLE`, which `handoff-contract` and `mcp-capability-wiring`
    // already read to decide what is launchable. One source, three readers.
    id: "negative (do NOT invoke / never)",
    pattern: /\bdo not invoke\b[\s\S]*\bnever\b|\bnever\b[\s\S]*\bdo not invoke\b/i,
  },
] as const;

function triggerForm(text: string): TriggerForm | undefined {
  return TRIGGER_FORMS.find((form) => form.pattern.test(text));
}

/** Every language navori renders the orchestrator catalog in. */
const CATALOG_LANGS: readonly Lang[] = ["es", "en"];

/**
 * The trigger phrasing per language for the ORCHESTRATOR catalog
 * (`blocks.agentsIndex.when`), which is a different channel from the
 * frontmatter and therefore gets its own reader.
 *
 * Two families and not one because this channel is LOCALIZED: the catalog is
 * copy the orchestrator reads in the project's language, while the frontmatter
 * is an artifact the host reads and ships in English. Running the English
 * pattern over the Spanish table would demand English copy in a Spanish block;
 * running one merged pattern over both would let an English phrasing pass the
 * Spanish audit, which is the same "reports coverage it doesn't have" defect
 * the narrow criterion exists to avoid.
 */
const CATALOG_TRIGGER: Record<Lang, RegExp> = {
  en: /\buse\s+(?:it\s+)?(?:proactively|when|after|before)\b/i,
  // "Úsalo proactivamente cuando…", "Úsalo tras…", "Úsalo cuando…". The
  // character class covers the capitalized Ú without relying on case folding
  // outside ASCII.
  es: /[úÚ]sal[ao]\s+(?:proactivamente\s+)?(?:cuando|tras|antes|despu[eé]s)\b/,
};

/** The catalog entries for a language, as the engine reads them. */
function catalogWhen(lang: Lang): Record<string, string> {
  return tc(lang).blocks.agentsIndex.when;
}

/**
 * The agents the catalog must list: the shipped roster minus whatever declares
 * itself un-launchable. Today that is exactly `leader`, which
 * `buildAgentsIndexBody` skips by id — deriving it from `isInvokable` instead
 * of hardcoding the name is the point: if a SECOND agent ever declares the
 * prohibition, this test goes red and says the engine's literal `leader` check
 * has to become the marker check too.
 */
const CATALOGUED = AGENTS.filter(isInvokable)
  .map((asset) => asset.id)
  .sort();

/**
 * Ceiling per description, in characters.
 *
 * The reason is residency, not any single delivery channel: the host loads
 * EVERY agent's `description` to decide delegation, so all 8 are in context in
 * every session whether or not anything is delegated — and the Codex engine
 * renders the same field verbatim into `.codex/agents/*.toml` and its agent
 * catalog. The longest shipped today is 294 characters and the 8 total 1,874,
 * so 340 is headroom for a rewrite and a wall against a second one: past a
 * paragraph the field stops being a routing signal and becomes a copy of the
 * agent's body, which is the duplication that desyncs. If a description needs
 * more room, the surplus belongs in the body, which loads only when the agent
 * runs.
 */
const MAX_DESCRIPTION = 340;

describe("spec 0020 R1 — the shipped agents declare when to fire them", () => {
  it("todo agente declara cuándo dispararlo", () => {
    // Covers: R1
    const missing = AGENTS.filter((asset) => !triggerForm(description(asset))).map(
      (asset) => `${asset.id}: "${description(asset)}"`,
    );
    expect(
      missing.join("\n"),
      "Each description must state WHAT the agent does AND the observable condition that fires it.\n" +
        `Accepted forms: ${TRIGGER_FORMS.map((f) => f.id).join(" | ")}.`,
    ).toBe("");
  });

  it("la convención no se revierte en silencio", () => {
    // Covers: R1
    const over = AGENTS.map((asset) => ({ id: asset.id, length: description(asset).length }))
      .filter(({ length }) => length > MAX_DESCRIPTION)
      .map(({ id, length }) => `${id}: ${length} chars`);
    expect(
      over.join("\n"),
      `A description over ${MAX_DESCRIPTION} characters is a copy of the agent's body in a field ` +
        "that ships resident in every session. Move the surplus to the body.",
    ).toBe("");
  });

  it("los dos canales declaran condición para los mismos agentes", () => {
    // Covers: R1
    // Per agent AND per channel, so the failure says which store to fix. The
    // host channel and the orchestrator channel are checked against the same
    // roster: an agent that declares its trigger to the host and not to the
    // orchestrator is the divergence this case exists for.
    const missing: string[] = [];
    for (const asset of AGENTS) {
      if (!triggerForm(description(asset))) missing.push(`frontmatter/${asset.id}`);
      if (!isInvokable(asset)) continue;
      for (const lang of CATALOG_LANGS) {
        const text = catalogWhen(lang)[asset.id];
        if (text === undefined) continue; // absence is the next case's failure
        if (!CATALOG_TRIGGER[lang].test(text))
          missing.push(`agentsIndex.when.${lang}/${asset.id}: "${text}"`);
      }
    }
    expect(
      missing.join("\n"),
      "Both channels describe the SAME agents and both must state the condition " +
        "that fires them — the frontmatter for the host, `blocks.agentsIndex.when` " +
        "for the orchestrator. Not the same words: the same contract.",
    ).toBe("");
  });

  it("el catálogo del orquestador cubre el roster enviado", () => {
    // Covers: R1
    // `buildAgentsIndexBody` does `if (!description) continue`, so a missing
    // entry drops the agent from the catalog with no error anywhere: the
    // orchestrator simply never learns it exists. Equality (not `toContain`)
    // catches the other direction too — an entry left behind for an agent that
    // no longer ships.
    for (const lang of CATALOG_LANGS) {
      expect(
        Object.keys(catalogWhen(lang)).sort(),
        `blocks.agentsIndex.when.${lang} must list every launchable shipped agent, and only those`,
      ).toEqual(CATALOGUED);
    }
  });

  // Anti-vacuity: an empty roster, or a `description` the reader returns blank
  // for, would make both cases above pass on nothing — the shape of green this
  // repo keeps finding. Both trigger forms must also be live on disk: a form
  // no asset exercises is a rule nobody would notice going blind.
  it("reads the real roster and exercises both trigger forms", () => {
    expect(AGENTS.length).toBeGreaterThanOrEqual(8);
    expect(AGENTS.map((a) => a.id)).toContain("leader");
    for (const asset of AGENTS)
      expect(description(asset), `${asset.id} has no description`).not.toBe("");

    const exercised = new Set(AGENTS.map((a) => triggerForm(description(a))?.id));
    for (const form of TRIGGER_FORMS) {
      expect([...exercised], `no shipped agent uses the "${form.id}" form`).toContain(form.id);
    }

    // Same guard on the second channel: a language whose table came back empty
    // would make the two cases above pass over nothing.
    expect(CATALOGUED.length).toBeGreaterThanOrEqual(7);
    for (const lang of CATALOG_LANGS)
      expect(Object.keys(catalogWhen(lang)).length, `empty catalog for ${lang}`).toBeGreaterThan(0);
  });
});

describe("the criterion fires on the descriptions that shipped before spec 0020", () => {
  /**
   * Positive control on the real regression, not on a synthetic string: these
   * are the exact `description` values the assets carried. A rewrite of the
   * criterion loose enough to accept them again has to fail here.
   */
  it.each([
    ["reviewer", "Strict reviewer. Approves or rejects the implementer's work against CLAUDE.md."],
    [
      "researcher",
      "Read-only investigation of a scoped question. Reads the repo, writes findings to a file.",
    ],
    [
      "explorer",
      "Broad map of an area or module of the repo. Returns structure, dependencies, and entry points.",
    ],
    [
      "implementer",
      "Worker. Implements ONE scoped task, respects CLAUDE.md conventions, and leaves the quality gate green before returning.",
    ],
    [
      "commit-pr-pilot",
      "Drafts commit messages and opens PRs with a title + body following the repo's format.",
    ],
    [
      "auditor",
      'Deep read-only audit of existing code. Trigger it when the user says "audit X", "deep audit".',
    ],
    [
      "leader (prohibition without the never half)",
      "Do NOT invoke as a subagent. Orchestration playbook that the main agent EMBODIES.",
    ],
  ])("flags the old %s description", (_id, text) => {
    expect(triggerForm(text), `accepted a description with no trigger clause: ${text}`).toBe(
      undefined,
    );
  });

  it.each([
    ["es", "Escribe código y tests para UNA tarea bien acotada."],
    ["es", "Valida un diff contra la spec y la calidad (APPROVED / CHANGES_REQUESTED)."],
    ["en", "Writes code and tests for ONE well-scoped task."],
    ["en", "Maps a broad area or module: structure, entry points, dependencies."],
  ] as ReadonlyArray<readonly [Lang, string]>)("flags the old %s catalog entry", (lang, text) => {
    expect(
      CATALOG_TRIGGER[lang].test(text),
      `accepted a catalog entry with no trigger clause: ${text}`,
    ).toBe(false);
  });

  it.each([
    [
      "es",
      "Escribe código y tests para UNA tarea acotada. Úsalo proactivamente cuando toque 4+ archivos.",
    ],
    ["es", "Abre el PR. Úsalo tras la aprobación del reviewer."],
    ["en", "Maps a broad area. Use when you don't know where something lives."],
  ] as ReadonlyArray<readonly [Lang, string]>)(
    "accepts a %s catalog entry that states its trigger",
    (lang, text) => {
      expect(
        CATALOG_TRIGGER[lang].test(text),
        `rejected a catalog entry that does state its trigger: ${text}`,
      ).toBe(true);
    },
  );

  it.each([
    [
      "use proactively",
      "Implements ONE scoped task. Use proactively when a change touches 4+ files.",
    ],
    ["use when", "Maps a broad area. Use when you don't know where something lives."],
    ["use after", "Opens the PR. Use after the reviewer approves."],
    ["use before", "Analyzes a ticket. Use before decomposing it."],
    ["the prohibition", "Do NOT invoke as a subagent, never and under no condition."],
  ])("accepts %s", (_id, text) => {
    expect(
      triggerForm(text),
      `rejected a description that does state its trigger: ${text}`,
    ).toBeDefined();
  });
});

describe("the rendered tree carries the triggers (what the host actually reads)", () => {
  /**
   * Cold-review finding on PR #660: the sweep above is over the SOURCE assets,
   * and a status-collapse bug in `rerender` kept every already-onboarded
   * repo's `.claude/agents/*.md` on the OLD descriptions while this suite was
   * green. The host reads the rendered file, so the convention has to hold
   * there — this renders a real tree and sweeps that.
   */
  it("every rendered agent description declares its trigger", () => {
    // Covers: R1
    const cwd = mkdtempSync(join(tmpdir(), "navori-desc-render-"));
    const config: NavoriConfig = NavoriConfigSchema.parse({
      name: "desc-render",
      engines: ["claude"],
      preset: "custom",
      branchBase: "main",
      qualityGate: { fast: "pnpm test", full: "pnpm test" },
    });
    renderClaudeEngine(cwd, config);
    const agentsDir = join(cwd, ".claude", "agents");
    const rendered = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
    expect(rendered.length).toBeGreaterThanOrEqual(7);
    for (const file of rendered) {
      const raw = readFileSync(join(agentsDir, file), "utf-8");
      const description = /^description:\s*(.+)$/m.exec(raw)?.[1] ?? "";
      expect(triggerForm(description), `${file}: "${description}"`).toBeDefined();
    }
  });
});
