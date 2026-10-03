import { z } from "zod";
import { ENGINES } from "../../lib/config/schema.ts";
import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import type { EngineId } from "./engine-capabilities.ts";
import {
  CODEX_PARITY,
  CODEX_VERIFICATIONS,
  CodexParitySchema,
  DROPPED_PERMISSION_PATTERNS,
  NARROWED_PATTERN_FAMILIES,
  PERMISSION_RULE_CLASS_IDS,
  codexParityIssues,
  codexParityKey,
  type CodexParity,
} from "./codex-parity.ts";
import type { HarnessPlan } from "./harness-plan.ts";
import {
  HOOK_ENGINES,
  WORKFLOW_SKILL_ENGINES,
  inEngineScope,
  RETIRED_AGENTS,
  RETIRED_HOOKS,
  RETIRED_SKILLS,
  ROSTER_AGENTS,
  ROSTER_CORE_SKILLS,
  ROSTER_WORKFLOW_SKILLS,
} from "./roster.ts";

/**
 * Native-overlap matrix (spec 0039, D1/D2): one typed row per distributed unit
 * saying whether the host already ships the capability. It is the SINGLE source
 * of what an engine writes and registers: `filterInventory` drops the units a
 * row marks `native` for that engine, and the Claude adapter feeds the filtered
 * result to both the file writer and `buildClaudeSettings`, so a file and its
 * registration disappear together (B1).
 *
 * Every real row is `complementa` today: no capability is verified to replace a
 * unit yet (`docs/research/claude-first-verificacion.md`). A verdict change is a
 * deliberate edit to a row, gated by `OverlapRowSchema`'s refine below.
 *
 * Imported by `codex/hook-registrations.ts`, so this module must not import it
 * (or `engine-capabilities.ts`) as a value: that would be an ESM cycle.
 */

export type Verdict = "complementa" | "reemplazar-por-nativo" | "retirar";
export type EngineSupport = "emit" | "native" | "unsupported" | "n/a";
export type UnitKind =
  | "hook"
  | "skill"
  | "agent"
  | "managed-block"
  | "plugin"
  | "flow"
  | "permission-rule"
  | "plugin-script";

/**
 * What is emitted in place of a unit on an engine where it is native. Closed on
 * purpose: a variant is added only when a real verdict needs it (D1).
 */
export type NativeEmissionKind = "settings-patch" | "agent-frontmatter" | "none";

/** Hosts whose pages may back a non-`complementa` verdict (R3). */
export const NATIVE_URL_ALLOWLIST: ReadonlySet<string> = new Set([
  "code.claude.com",
  "learn.chatgpt.com",
  "developers.openai.com",
]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const EngineSupportSchema = z.enum(["emit", "native", "unsupported", "n/a"]);

const RETIRED_IDS: Readonly<Partial<Record<UnitKind, ReadonlySet<string>>>> = {
  agent: new Set(RETIRED_AGENTS.map((r) => r.id)),
  skill: new Set(RETIRED_SKILLS.map((r) => r.id)),
  hook: new Set(RETIRED_HOOKS.map((r) => r.id)),
};

export const OverlapRowSchema = z
  .object({
    unit: z.object({
      kind: z.enum([
        "hook",
        "skill",
        "agent",
        "managed-block",
        "plugin",
        "flow",
        "permission-rule",
        "plugin-script",
      ]),
      id: z.string().min(1),
    }),
    native: z
      .object({
        capability: z.string().min(1),
        url: z.string().optional(),
        verifiedAt: z.string().optional(),
        ccVersion: z.string().optional(),
      })
      .nullable(),
    verdict: z.enum(["complementa", "reemplazar-por-nativo", "retirar"]),
    /** What Codex gives for this unit (spec 0041 R1); required on every row. */
    codexParity: CodexParitySchema,
    engines: z.record(z.enum(ENGINES), EngineSupportSchema),
    nativeEmission: z
      .object({
        kind: z.enum(["settings-patch", "agent-frontmatter", "none"]),
        detail: z.string(),
      })
      .optional(),
    evaluation: z
      .object({
        kind: z.enum(["codegraph", "engram"]),
        verdict: z.string(),
        evidence: z.string(),
      })
      .optional(),
    note: z.string(),
  })
  .superRefine((row, ctx) => {
    const fail = (message: string, path: (string | number)[]): void => {
      ctx.addIssue({ code: "custom", message, path });
    };
    if (
      row.evaluation?.kind === "codegraph" &&
      !["conservar", "conservar-con-maxFiles", "quitar-del-default"].includes(
        row.evaluation.verdict,
      )
    ) {
      fail("invalid codegraph evaluation verdict", ["evaluation", "verdict"]);
    }
    // R2: the issue names the unit, so a bad row is findable in a 150-row table.
    for (const issue of codexParityIssues(row.codexParity)) {
      fail(`${row.unit.kind}:${row.unit.id} ${issue}`, ["codexParity"]);
    }
    if (row.verdict === "complementa") return;

    // Syntactic check only (m11): that the page backs the capability is the
    // human reviewer's call, which is why the generated doc prints URL + date.
    const url = row.native?.url;
    let host: string | null = null;
    if (url !== undefined) {
      try {
        const parsed = new URL(url);
        host = parsed.protocol === "https:" ? parsed.hostname : null;
      } catch {
        host = null;
      }
    }
    if (host === null || !NATIVE_URL_ALLOWLIST.has(host)) {
      fail(`a '${row.verdict}' verdict needs native.url on an allowlisted https host`, [
        "native",
        "url",
      ]);
    }
    const verifiedAt = row.native?.verifiedAt;
    const today = new Date().toISOString().slice(0, 10);
    if (
      verifiedAt === undefined ||
      !ISO_DATE.test(verifiedAt) ||
      Number.isNaN(Date.parse(verifiedAt)) ||
      verifiedAt > today
    ) {
      fail("native.verifiedAt must be a YYYY-MM-DD date that is not in the future", [
        "native",
        "verifiedAt",
      ]);
    }

    if (row.verdict === "reemplazar-por-nativo") {
      if (row.engines.claude !== "native") {
        fail("'reemplazar-por-nativo' needs engines.claude === 'native'", ["engines", "claude"]);
      }
      if (row.nativeEmission === undefined) {
        fail("'reemplazar-por-nativo' needs a nativeEmission", ["nativeEmission"]);
      }
      // `emit` where the unit exists: an engine that is not native and is not
      // marked n/a/unsupported keeps getting the unit, and says so explicitly.
      // The enum already forbids any other value, so nothing more to check here.
    }
    if (row.verdict === "retirar" && RETIRED_IDS[row.unit.kind]?.has(row.unit.id) !== true) {
      fail("'retirar' needs the unit id in the matching RETIRED_* registry", ["unit", "id"]);
    }
  });

export type OverlapRow = z.infer<typeof OverlapRowSchema>;
export type OverlapUnit = OverlapRow["unit"];

/** What `filterInventory` filters: the same two inputs that decide what is written. */
export interface FilteredInventory {
  plan: HarnessPlan;
  plugins: LoadedPlugin[];
}

type Support = Record<EngineId, EngineSupport>;

/** Every hook `resolveHarnessPlan` can emit, with every optional input switched on. */
const HOOK_IDS: readonly string[] = [
  "guard-destructive",
  "implementer-no-markdown",
  "subagent-no-background",
  "session-start-context",
  "model-advisor",
  "subagent-stop-handoff",
  "managed-drift-watch",
  "routing-watch",
  "bash-outcome-watch",
  "worktree-reclaim",
  "audit-mode-trigger",
  "audit-mode-close",
  "master-plan-context",
  "master-accept-confirm",
  "role-guard",
  "comment-draft-confirm",
  "pr-publisher-confirm",
  "general-purpose-confirm",
  "quality-gate-pre-commit",
  "plan-gate",
  "stop-verify-reminder",
];

/** Blocks under `core-assets/managed/`, by file basename. */
const MANAGED_BLOCK_IDS: readonly string[] = [
  "arranque-sesion",
  "cierre-sesion",
  "code-discovery-routing",
  "codex-cross-review",
  "formato-respuesta",
  "idioma-rol",
  "intake-tickets",
  "operaciones-seguras",
  "orquestacion",
  "plan-maestro",
  "planificacion",
  "sdd",
  "tipado-fuerte",
];

/** Bundled plugins under `packages/plugins/`. */
const PLUGIN_IDS: readonly string[] = [
  "acli",
  "codegraph",
  "engram",
  "gh",
  "jscpd",
  "semgrep",
  "tgrep",
];

/** Scripts bundled plugins copy into `.claude/scripts` (and `.codex/scripts` when registered). */
const PLUGIN_SCRIPT_IDS: readonly string[] = [
  "jscpd/check-jscpd.sh",
  "semgrep/check-semgrep.sh",
  "tgrep/guard-search-routing.sh",
];

/**
 * `permission-rule` unit ids (spec 0041 R14/R15/R26): the generic classes, every
 * pattern `buildCodexRules` drops, and every pattern it narrows (one row each,
 * from `NARROWED_PATTERN_FAMILIES`).
 */
const PERMISSION_RULE_IDS: readonly string[] = [
  ...PERMISSION_RULE_CLASS_IDS.map((id) => `class:${id}`),
  ...DROPPED_PERMISSION_PATTERNS.map((pattern) => `dropped:${pattern}`),
  ...NARROWED_PATTERN_FAMILIES.flatMap(({ patterns }) =>
    patterns.map((pattern) => `narrowed:${pattern}`),
  ),
];

/**
 * What Codex writes for a permission rule: a narrowed or ordinary rule still
 * becomes a (narrower) prefix_rule, so it is `emit`; only what is never
 * translated (allow, dropped patterns) is `unsupported`, and the amendment is a
 * Codex-side behavior with nothing to write (`n/a`).
 */
function permissionRuleCodexSupport(id: string): EngineSupport {
  if (id === "class:prompt-amendment") return "n/a";
  return id === "class:allow-not-translated" || id.startsWith("dropped:") ? "unsupported" : "emit";
}

/** R57 flows: where the harness duplicates a native Claude Code workflow. */
const FLOWS: ReadonlyArray<{ id: string; note: string; codex: EngineSupport }> = [
  {
    id: "master-plan-vs-plan-mode",
    note: "master-plan (multi-session plan with acceptance) versus native plan mode; unverified, kept.",
    codex: "unsupported",
  },
  {
    id: "native-task-list",
    note: "Spec task boards versus the native task list; unverified, kept.",
    codex: "n/a",
  },
  {
    id: "native-workflows",
    note: "Orchestrated agent flows versus native workflows; unverified, kept.",
    codex: "n/a",
  },
  {
    id: "nested-agent-dispatch",
    note: "An agent dispatching subagents (`Agent(scout, scribe)` in `architect`); Claude Code allows it, Codex and CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=1 do not, so orquestacion.md falls back to the orchestrator running scout before and scribe after.",
    codex: "unsupported",
  },
];

function support(claude: EngineSupport, codex: EngineSupport, prose: EngineSupport): Support {
  return { claude, codex, pi: "unsupported", "agents-md": prose, cursor: prose, copilot: prose };
}

/** The Codex parity row for `unit`; throws naming the unit when none exists (R3). */
function parityOf(unit: OverlapUnit): CodexParity {
  const parity = CODEX_PARITY[codexParityKey(unit.kind, unit.id)];
  if (parity === undefined) {
    throw new Error(`no CODEX_PARITY row for unit ${unit.kind}:${unit.id}`);
  }
  return parity;
}

function complementa(unit: OverlapUnit, engines: Support, note: string): OverlapRow {
  return { unit, native: null, verdict: "complementa", codexParity: parityOf(unit), engines, note };
}

/**
 * Engram's dedicated row (spec 0039 T40, R51), instead of the generic plugin
 * row. Overlap verdict stays `complementa`: `recortar` (the evaluation verdict,
 * a user decision backed by `docs/research/engram-vs-memoria-nativa.md`) is not
 * `reemplazar-por-nativo`, so nothing is dropped from the inventory; it only
 * records which engram parts are to be trimmed because Claude Code's `/memory`
 * covers them. Native URL and date come from that doc (Claude Code 2.1.286).
 */
const ENGRAM_ROW: OverlapRow = {
  unit: { kind: "plugin", id: "engram" },
  native: {
    capability: "Claude Code auto memory and /memory",
    url: "https://code.claude.com/docs/en/memory",
    verifiedAt: "2026-09-30",
    ccVersion: "2.1.286",
  },
  verdict: "complementa",
  codexParity: parityOf({ kind: "plugin", id: "engram" }),
  engines: support("emit", "emit", "emit"),
  evaluation: {
    kind: "engram",
    verdict: "recortar",
    evidence: "docs/research/engram-vs-memoria-nativa.md",
  },
  note: "Bundled plugin; native memory covers part of it, so the evaluation is recortar while the overlap verdict stays complementa.",
};

const CODEGRAPH_ROW: OverlapRow = {
  unit: { kind: "plugin", id: "codegraph" },
  native: null,
  verdict: "complementa",
  codexParity: parityOf({ kind: "plugin", id: "codegraph" }),
  engines: support("emit", "emit", "emit"),
  evaluation: {
    kind: "codegraph",
    verdict: "quitar-del-default",
    evidence: "docs/research/codegraph-costo-neto.md",
  },
  note: "Bundled opt-in plugin; T31 found no net context saving on the measured Claude discovery workload.",
};

/**
 * One row per distributed unit: roster agents and skills, plan hooks, managed
 * blocks, bundled plugins and the R57 flows. `native-overlap.test.ts` fails when
 * a unit has no row or two rows. Library skills and preset extras are NOT units
 * here: they are config-driven catalogs, not harness surfaces a host replaces.
 */
export const OVERLAP_ROWS: readonly OverlapRow[] = [
  ...ROSTER_AGENTS.map(({ id }) =>
    complementa(
      { kind: "agent", id },
      support("emit", "emit", "n/a"),
      "No verified native equivalent; emitted everywhere the engine has agents.",
    ),
  ),
  ...[...ROSTER_CORE_SKILLS, ...ROSTER_WORKFLOW_SKILLS].map((id) =>
    complementa(
      { kind: "skill", id },
      support(
        "emit",
        inEngineScope(WORKFLOW_SKILL_ENGINES[id], "codex") ? "emit" : "unsupported",
        "n/a",
      ),
      "No verified native equivalent; emitted everywhere the engine has skills.",
    ),
  ),
  ...HOOK_IDS.map((id) =>
    complementa(
      { kind: "hook", id },
      support(
        // Spec 0041 D5: `role-guard` is scoped to Codex, so Claude never gets it.
        inEngineScope(HOOK_ENGINES[id], "claude") ? "emit" : "unsupported",
        parityOf({ kind: "hook", id }).state === "limite-codex" ? "unsupported" : "emit",
        "n/a",
      ),
      "No verified native equivalent; registered where the engine can.",
    ),
  ),
  ...MANAGED_BLOCK_IDS.map((id) =>
    complementa(
      { kind: "managed-block", id },
      support("emit", "emit", "emit"),
      "Prose contract; no verified native equivalent.",
    ),
  ),
  ...PLUGIN_IDS.filter((id) => id !== "engram" && id !== "codegraph").map((id) =>
    complementa(
      { kind: "plugin", id },
      support("emit", "emit", "emit"),
      "Bundled plugin; no verified native equivalent.",
    ),
  ),
  ENGRAM_ROW,
  CODEGRAPH_ROW,
  ...FLOWS.map(({ id, note, codex }) =>
    complementa({ kind: "flow", id }, support("emit", codex, "n/a"), note),
  ),
  ...PLUGIN_SCRIPT_IDS.map((id) =>
    complementa(
      { kind: "plugin-script", id },
      support(
        "emit",
        parityOf({ kind: "plugin-script", id }).state === "limite-codex" ? "unsupported" : "emit",
        "n/a",
      ),
      "Bundled plugin script; no verified native equivalent.",
    ),
  ),
  ...PERMISSION_RULE_IDS.map((id) =>
    complementa(
      { kind: "permission-rule", id },
      support("emit", permissionRuleCodexSupport(id), "n/a"),
      "Claude ask/deny/allow rule; Codex translates it to a prefix_rule where it can.",
    ),
  ),
];

/** Rows that mark `kind:id` native on `engine`, as `kind:id` keys. */
function nativeKeys(engine: EngineId, rows: readonly OverlapRow[]): Set<string> {
  return new Set(
    rows
      .filter((row) => row.engines[engine] === "native")
      .map((row) => `${row.unit.kind}:${row.unit.id}`),
  );
}

/**
 * Whether `kind:id` is native on `engine` — the one predicate behind
 * `filterInventory` and the Codex hook resolution, so both agree.
 */
export function isNativeOn(
  engine: EngineId,
  kind: UnitKind,
  id: string,
  rows: readonly OverlapRow[] = OVERLAP_ROWS,
): boolean {
  return rows.some(
    (row) => row.unit.kind === kind && row.unit.id === id && row.engines[engine] === "native",
  );
}

/**
 * The inventory `engine` writes and registers: `inventory` minus every agent,
 * skill, hook and plugin a row marks `native` for that engine. Managed blocks
 * and flows are not in the inventory; their pruning belongs to the engine.
 */
export function filterInventory(
  inventory: FilteredInventory,
  engine: EngineId,
  rows: readonly OverlapRow[] = OVERLAP_ROWS,
): FilteredInventory {
  const native = nativeKeys(engine, rows);
  if (native.size === 0) return inventory;
  const keep = (kind: UnitKind) => (unit: { id: string }) => !native.has(`${kind}:${unit.id}`);
  return {
    plan: {
      agents: inventory.plan.agents.filter(keep("agent")),
      skills: inventory.plan.skills.filter(keep("skill")),
      hooks: inventory.plan.hooks.filter(keep("hook")),
    },
    plugins: inventory.plugins.filter((plugin) => !native.has(`plugin:${plugin.manifest.id}`)),
  };
}

/** What `engine` emits instead of each unit that is native there. */
export function nativeEmissionsFor(
  engine: EngineId,
  rows: readonly OverlapRow[] = OVERLAP_ROWS,
): ReadonlyArray<{
  unit: OverlapUnit;
  emission: NonNullable<OverlapRow["nativeEmission"]>;
}> {
  return rows.flatMap((row) =>
    row.engines[engine] === "native" && row.nativeEmission !== undefined
      ? [{ unit: row.unit, emission: row.nativeEmission }]
      : [],
  );
}

/**
 * `docs/native-overlap.md`, generated from the matrix (spec 0039 T13): one table
 * row per unit with the verdict, per-engine support, and the URL and date that
 * back it ("—" when the row has none). The syntactic refine cannot tell whether
 * a page supports a capability (m11), so this printout is what a reviewer reads.
 * `native-overlap.test.ts` fails when the committed file differs from this output.
 */
export function renderOverlapDoc(rows: readonly OverlapRow[] = OVERLAP_ROWS): string {
  const cell = (text: string): string => text.replace(/\|/g, "\\|");
  const lines = [
    "# Solapamiento con capacidades nativas",
    "",
    "<!-- Generado desde `OVERLAP_ROWS` (`packages/cli/src/engines/shared/native-overlap.ts`). No editar a mano: lo fija `native-overlap.test.ts`. -->",
    "",
    "Una fila por unidad que navori distribuye. `complementa` significa que ninguna capacidad nativa verificada la reemplaza; solo una fila con URL y fecha puede salir de ahí (`OverlapRowSchema`).",
    "",
    "Las columnas de paridad Codex salen de `CODEX_PARITY` (`packages/cli/src/engines/shared/codex-parity.ts`): `igual` (misma garantía y mecanismo), `equivalente` (misma garantía, mecanismo distinto) o `limite-codex` (Codex no la ofrece, con su fuente oficial, versión y fecha).",
    "",
    "| Tipo | Unidad | Veredicto | Claude | Codex | URL | Verificada | Paridad Codex | Mecanismo | Fuente | Versión Codex | Verificada Codex |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) =>
      [
        row.unit.kind,
        `\`${row.unit.id}\``,
        row.verdict,
        row.engines.claude,
        row.engines.codex,
        row.native?.url ?? "—",
        row.native?.verifiedAt ?? "—",
        row.codexParity.state,
        parityMechanism(row.codexParity),
        parityEvidence(row.codexParity)?.url ?? "—",
        parityEvidence(row.codexParity)?.codexVersion ?? "—",
        parityEvidence(row.codexParity)?.verifiedAt ?? "—",
      ]
        .map(cell)
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |"),
    ),
    "",
  ];
  return lines.join("\n");
}

/** The mechanism column: what Codex does instead, or what still holds around a limit. */
function parityMechanism(parity: CodexParity): string {
  if (parity.state === "igual") return "—";
  if (parity.state === "limite-codex") return parity.containment ?? "—";
  return parity.difference === undefined
    ? parity.mechanism
    : `${parity.mechanism}; ${parity.difference}`;
}

/**
 * Source, Codex version and date of a parity row: the `limite-codex` source, or
 * the verification an `igual`/`equivalente` row cites. Rows pending their probe
 * have none and print a dash.
 */
function parityEvidence(
  parity: CodexParity,
): { url: string; codexVersion: string; verifiedAt: string } | undefined {
  if (parity.state === "limite-codex") return parity.source;
  return parity.verification === undefined ? undefined : CODEX_VERIFICATIONS[parity.verification];
}
