import { z } from "zod";
import { ENGINES } from "../../lib/config/schema.ts";
import type { LoadedPlugin } from "../../lib/config/plugins.ts";
import type { EngineId } from "./engine-capabilities.ts";
import type { HarnessPlan } from "./harness-plan.ts";
import {
  CLAUDE_ONLY_WORKFLOW_SKILLS,
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
export type UnitKind = "hook" | "skill" | "agent" | "managed-block" | "plugin" | "flow";

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
      kind: z.enum(["hook", "skill", "agent", "managed-block", "plugin", "flow"]),
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

/** Hooks that Codex does not register (see `CODEX_HOOK_REGISTRATIONS`); kept in step by a test. */
const CODEX_UNREGISTERED_HOOKS: ReadonlySet<string> = new Set([
  "plan-gate",
  "pr-publisher-confirm",
  "subagent-no-background",
  "master-accept-confirm",
  "master-plan-context",
]);

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
  "worktree-reclaim",
  "audit-mode-trigger",
  "audit-mode-close",
  "master-plan-context",
  "master-accept-confirm",
  "comment-draft-confirm",
  "pr-publisher-confirm",
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

function complementa(unit: OverlapUnit, engines: Support, note: string): OverlapRow {
  return { unit, native: null, verdict: "complementa", engines, note };
}

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
      support("emit", CLAUDE_ONLY_WORKFLOW_SKILLS.has(id) ? "unsupported" : "emit", "n/a"),
      "No verified native equivalent; emitted everywhere the engine has skills.",
    ),
  ),
  ...HOOK_IDS.map((id) =>
    complementa(
      { kind: "hook", id },
      support("emit", CODEX_UNREGISTERED_HOOKS.has(id) ? "unsupported" : "emit", "n/a"),
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
  ...PLUGIN_IDS.map((id) =>
    complementa(
      { kind: "plugin", id },
      support("emit", "emit", "emit"),
      "Bundled plugin; no verified native equivalent.",
    ),
  ),
  ...FLOWS.map(({ id, note, codex }) =>
    complementa({ kind: "flow", id }, support("emit", codex, "n/a"), note),
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
    "| Tipo | Unidad | Veredicto | Claude | Codex | URL | Verificada |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((row) =>
      [
        row.unit.kind,
        `\`${row.unit.id}\``,
        row.verdict,
        row.engines.claude,
        row.engines.codex,
        row.native?.url ?? "—",
        row.native?.verifiedAt ?? "—",
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
