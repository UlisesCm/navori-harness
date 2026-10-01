import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { NavoriConfig } from "../../../lib/config/config.ts";
import { getCoreRoot, listBundledPluginIds } from "../../../lib/render/bundled-assets.ts";
import { CODEX_HOOK_REGISTRATIONS } from "../../codex/hook-registrations.ts";
import { resolveHarnessPlan } from "../harness-plan.ts";
import {
  NATIVE_URL_ALLOWLIST,
  OVERLAP_ROWS,
  OverlapRowSchema,
  renderOverlapDoc,
  type OverlapRow,
} from "../native-overlap.ts";
import {
  RETIRED_AGENTS,
  ROSTER_AGENTS,
  ROSTER_CORE_SKILLS,
  ROSTER_WORKFLOW_SKILLS,
} from "../roster.ts";

const coreAssets = resolve(getCoreRoot(), "core-assets");

/** Every optional hook of the plan switched on. */
const FULL_CONFIG = {
  name: "t",
  engines: ["claude"],
  preset: "custom",
  version: "1.0.0",
  language: "es",
  branchBase: "main",
  commits: "conventional-es",
  qualityGate: { fast: "x", full: "y" },
  hooks: { verifyOnStop: true },
  harness: { planTiers: true, masterPlan: true },
} as unknown as NavoriConfig;

const keyOf = (kind: string, id: string): string => `${kind}:${id}`;

/** A well-formed non-complementa row to mutate in negative cases. */
function nativeRow(overrides: Partial<OverlapRow> = {}): OverlapRow {
  return {
    unit: { kind: "hook", id: "routing-watch" },
    native: {
      capability: "fixture",
      url: "https://code.claude.com/docs/en/hooks",
      verifiedAt: "2026-09-30",
    },
    verdict: "reemplazar-por-nativo",
    engines: {
      claude: "native",
      codex: "emit",
      pi: "unsupported",
      "agents-md": "n/a",
      cursor: "n/a",
      copilot: "n/a",
    },
    nativeEmission: { kind: "none", detail: "fixture" },
    note: "fixture",
    ...overrides,
  };
}

describe("OverlapRowSchema (D2)", () => {
  // Covers: R2, R3
  it("accepts every real row", () => {
    for (const row of OVERLAP_ROWS) {
      const parsed = OverlapRowSchema.safeParse(row);
      expect(parsed.success, `${row.unit.kind}:${row.unit.id}`).toBe(true);
    }
  });

  // Covers: R3
  it("keeps every real row complementa until a capability is verified", () => {
    expect(OVERLAP_ROWS.filter((row) => row.verdict !== "complementa")).toEqual([]);
  });

  // Covers: R3
  it("accepts a well-formed reemplazar-por-nativo row", () => {
    expect(OverlapRowSchema.safeParse(nativeRow()).success).toBe(true);
  });

  // Covers: R3
  it.each([
    ["no url", { native: { capability: "c", verifiedAt: "2026-09-30" } }],
    [
      "host outside the allowlist",
      { native: { capability: "c", url: "https://example.com/x", verifiedAt: "2026-09-30" } },
    ],
    [
      "non-https url",
      { native: { capability: "c", url: "http://code.claude.com/x", verifiedAt: "2026-09-30" } },
    ],
    ["missing date", { native: { capability: "c", url: "https://code.claude.com/docs/en/hooks" } }],
    [
      "malformed date",
      {
        native: {
          capability: "c",
          url: "https://code.claude.com/docs/en/hooks",
          verifiedAt: "30/09/2026",
        },
      },
    ],
    [
      "future date",
      {
        native: {
          capability: "c",
          url: "https://code.claude.com/docs/en/hooks",
          verifiedAt: "2999-01-01",
        },
      },
    ],
    ["null native", { native: null }],
    [
      "claude not native",
      {
        engines: {
          claude: "emit",
          codex: "emit",
          pi: "unsupported",
          "agents-md": "n/a",
          cursor: "n/a",
          copilot: "n/a",
        },
      },
    ],
    ["no nativeEmission", { nativeEmission: undefined }],
  ] as const)("rejects reemplazar-por-nativo with %s", (_name, override) => {
    expect(OverlapRowSchema.safeParse(nativeRow(override as Partial<OverlapRow>)).success).toBe(
      false,
    );
  });

  // Covers: R3
  it("lets every allowlisted host through", () => {
    for (const host of NATIVE_URL_ALLOWLIST) {
      const row = nativeRow({
        native: { capability: "c", url: `https://${host}/x`, verifiedAt: "2026-09-30" },
      });
      expect(OverlapRowSchema.safeParse(row).success, host).toBe(true);
    }
  });

  // Covers: R3
  it("requires a retirar row's id to be in the matching RETIRED_* registry", () => {
    const retired = RETIRED_AGENTS[0]!.id;
    const ok = nativeRow({ verdict: "retirar", unit: { kind: "agent", id: retired } });
    const bad = nativeRow({ verdict: "retirar", unit: { kind: "agent", id: "implementer" } });
    expect(OverlapRowSchema.safeParse(ok).success).toBe(true);
    expect(OverlapRowSchema.safeParse(bad).success).toBe(false);
  });
});

describe("OVERLAP_ROWS coverage (one row per distributed unit)", () => {
  const expected = new Map<string, string>();
  const add = (kind: string, ids: readonly string[]): void => {
    for (const id of ids) expected.set(keyOf(kind, id), kind);
  };
  add(
    "agent",
    ROSTER_AGENTS.map((a) => a.id),
  );
  add("skill", [...ROSTER_CORE_SKILLS, ...ROSTER_WORKFLOW_SKILLS]);
  add(
    "hook",
    resolveHarnessPlan(FULL_CONFIG, coreAssets, null, {
      includeOrchestrator: true,
      includeClaudeOnlySkills: true,
      includeClaudeOnlyHooks: true,
    }).hooks.map((h) => h.id),
  );
  add(
    "managed-block",
    readdirSync(join(coreAssets, "managed"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3)),
  );
  add("plugin", listBundledPluginIds());
  add("flow", [
    "master-plan-vs-plan-mode",
    "native-task-list",
    "native-workflows",
    "nested-agent-dispatch",
  ]);

  // Covers: R2, R3, R57
  it("has exactly one row for every unit and no extras", () => {
    const counts = new Map<string, number>();
    for (const row of OVERLAP_ROWS) {
      const key = keyOf(row.unit.kind, row.unit.id);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const duplicated = [...counts].filter(([, n]) => n > 1).map(([key]) => key);
    const missing = [...expected.keys()].filter((key) => !counts.has(key));
    const extra = [...counts.keys()].filter((key) => !expected.has(key));
    expect({ duplicated, missing, extra }).toEqual({ duplicated: [], missing: [], extra: [] });
  });

  // Covers: R57, R36, R37
  it("carries the R57 flow rows plus the nested-dispatch row", () => {
    const flows = OVERLAP_ROWS.filter((row) => row.unit.kind === "flow").map((r) => r.unit.id);
    expect(flows.sort()).toEqual(
      [
        "master-plan-vs-plan-mode",
        "native-task-list",
        "native-workflows",
        "nested-agent-dispatch",
      ].sort(),
    );
    const nested = OVERLAP_ROWS.find((r) => r.unit.id === "nested-agent-dispatch");
    expect(nested?.engines.claude).toBe("emit");
    expect(nested?.engines.codex).toBe("unsupported");
  });

  // Covers: R2
  it("marks as unsupported on Codex exactly the hooks CODEX_HOOK_REGISTRATIONS leaves unregistered", () => {
    const unregistered = CODEX_HOOK_REGISTRATIONS.filter((row) => !row.registration)
      .map((row) => row.script)
      .sort();
    const marked = OVERLAP_ROWS.filter(
      (row) => row.unit.kind === "hook" && row.engines.codex === "unsupported",
    )
      .map((row) => row.unit.id)
      .sort();
    expect(marked).toEqual(unregistered);
  });
});

describe("docs/native-overlap.md (generated)", () => {
  // Covers: R2
  it("matches the output of renderOverlapDoc(OVERLAP_ROWS) byte for byte", () => {
    const committed = readFileSync(resolve(coreAssets, "../../../docs/native-overlap.md"), "utf-8");
    expect(committed).toBe(renderOverlapDoc(OVERLAP_ROWS));
  });

  // Covers: R2
  it("prints URL and date per row, with a dash where the row has none", () => {
    const doc = renderOverlapDoc([
      nativeRow(),
      { ...nativeRow(), verdict: "complementa", native: null, unit: { kind: "hook", id: "other" } },
    ]);
    expect(doc).toContain("https://code.claude.com/docs/en/hooks | 2026-09-30");
    expect(doc).toContain("| — | — |");
  });
});
