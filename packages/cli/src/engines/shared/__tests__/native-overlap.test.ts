import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { NavoriConfig } from "../../../lib/config/config.ts";
import { getCoreRoot, listBundledPluginIds } from "../../../lib/render/bundled-assets.ts";
import { buildCodexRules } from "../../codex/build-rules.ts";
import { CODEX_HOOK_REGISTRATIONS } from "../../codex/hook-registrations.ts";
import { loadPlugin } from "../../../lib/config/plugins.ts";
import {
  CODEX_PARITY,
  NARROWED_PATTERN_FAMILIES,
  codexParityIssues,
  missingParityUnits,
  type CodexParity,
} from "../codex-parity.ts";
import { CONTROL_DEFINITIONS, ENGINE_CAPABILITIES } from "../engine-capabilities.ts";
import { collectShellPermissionRules } from "../permission-rules.ts";
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

const CONTROL_HOOKS = Object.fromEntries(
  Object.entries(CONTROL_DEFINITIONS).map(([id, definition]) => [id, definition.hookScripts]),
);

const keyOf = (kind: string, id: string): string => `${kind}:${id}`;

const IGUAL: CodexParity = { state: "igual", enforcing: false };

/** A `limite-codex` parity with a valid source, to mutate in negative cases. */
function limiteParity(
  source: { url: string; codexVersion: string; verifiedAt: string } = {
    url: "https://learn.chatgpt.com/docs/hooks",
    codexVersion: "0.160.0",
    verifiedAt: "2026-10-02",
  },
): CodexParity {
  return { state: "limite-codex", source };
}

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
    codexParity: IGUAL,
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
  } as OverlapRow;
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

  // Covers: R51
  it("has a single engram row: recortar evaluation, existing evidence, allowlisted native URL", () => {
    const rows = OVERLAP_ROWS.filter((r) => r.unit.kind === "plugin" && r.unit.id === "engram");
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(OverlapRowSchema.safeParse(row).success).toBe(true);
    expect(row?.verdict).toBe("complementa");
    expect(row?.evaluation?.kind).toBe("engram");
    expect(row?.evaluation?.verdict).toBe("recortar");
    const evidence = row?.evaluation?.evidence ?? "";
    expect(() => readFileSync(resolve(coreAssets, "../../../", evidence), "utf-8")).not.toThrow();
    const url = new URL(row?.native?.url ?? "");
    expect(url.protocol).toBe("https:");
    expect(NATIVE_URL_ALLOWLIST.has(url.hostname)).toBe(true);
  });

  // Covers: R34, R35
  it("has one informational codegraph row backed by T31 evidence", () => {
    const rows = OVERLAP_ROWS.filter(
      (row) => row.unit.kind === "plugin" && row.unit.id === "codegraph",
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row?.native).toBeNull();
    expect(row?.verdict).toBe("complementa");
    expect(row?.evaluation).toEqual({
      kind: "codegraph",
      verdict: "quitar-del-default",
      evidence: "docs/research/codegraph-costo-neto.md",
    });
    expect(() =>
      readFileSync(resolve(coreAssets, "../../../", row?.evaluation?.evidence ?? ""), "utf-8"),
    ).not.toThrow();
    expect(row?.engines).toEqual({
      claude: "emit",
      codex: "emit",
      pi: "unsupported",
      "agents-md": "emit",
      cursor: "emit",
      copilot: "emit",
    });
  });

  // Covers: R35
  it("validates codegraph evaluations even when the overlap verdict complements", () => {
    const row = OVERLAP_ROWS.find(
      (candidate) => candidate.unit.kind === "plugin" && candidate.unit.id === "codegraph",
    );
    expect(row).toBeDefined();
    for (const verdict of ["conservar", "conservar-con-maxFiles", "quitar-del-default"]) {
      expect(
        OverlapRowSchema.safeParse({
          ...row,
          evaluation: {
            kind: "codegraph",
            verdict,
            evidence: "docs/research/codegraph-costo-neto.md",
          },
        }).success,
      ).toBe(true);
    }
    expect(
      OverlapRowSchema.safeParse({
        ...row,
        evaluation: {
          kind: "codegraph",
          verdict: "typo",
          evidence: "docs/research/codegraph-costo-neto.md",
        },
      }).success,
    ).toBe(false);
    expect(
      OverlapRowSchema.safeParse(
        OVERLAP_ROWS.find(
          (candidate) => candidate.unit.kind === "plugin" && candidate.unit.id === "engram",
        ),
      ).success,
    ).toBe(true);
  });

  // Covers: R1
  it("requires a codexParity on every row", () => {
    const { codexParity: _omitted, ...withoutParity } = nativeRow();
    expect(OverlapRowSchema.safeParse(withoutParity).success).toBe(false);
  });

  // Covers: R2
  it("accepts a limite-codex row with an official URL, version and date", () => {
    expect(OverlapRowSchema.safeParse(nativeRow({ codexParity: limiteParity() })).success).toBe(
      true,
    );
    const github = limiteParity({
      url: "https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/core/src/exec_policy.rs",
      codexVersion: "0.160.0",
      verifiedAt: "2026-10-02",
    });
    expect(OverlapRowSchema.safeParse(nativeRow({ codexParity: github })).success).toBe(true);
  });

  // Covers: R2
  it.each([
    ["no url", { url: "", codexVersion: "0.160.0", verifiedAt: "2026-10-02" }],
    [
      "a host outside the allowlist",
      { url: "https://example.com/x", codexVersion: "0.160.0", verifiedAt: "2026-10-02" },
    ],
    [
      "a non-https url",
      {
        url: "http://learn.chatgpt.com/docs/hooks",
        codexVersion: "0.160.0",
        verifiedAt: "2026-10-02",
      },
    ],
    [
      "another GitHub repository",
      {
        url: "https://github.com/someone/else/blob/rust-v0.160.0/x.rs",
        codexVersion: "0.160.0",
        verifiedAt: "2026-10-02",
      },
    ],
    [
      "a GitHub tag that differs from codexVersion",
      {
        url: "https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/x.rs",
        codexVersion: "0.160.0",
        verifiedAt: "2026-10-02",
      },
    ],
    [
      "a GitHub URL with no release tag",
      {
        url: "https://github.com/openai/codex/blob/main/codex-rs/x.rs",
        codexVersion: "0.160.0",
        verifiedAt: "2026-10-02",
      },
    ],
    [
      "no Codex version",
      { url: "https://learn.chatgpt.com/docs/hooks", codexVersion: "", verifiedAt: "2026-10-02" },
    ],
    [
      "a future date",
      {
        url: "https://learn.chatgpt.com/docs/hooks",
        codexVersion: "0.160.0",
        verifiedAt: "2999-01-01",
      },
    ],
    [
      "a malformed date",
      {
        url: "https://learn.chatgpt.com/docs/hooks",
        codexVersion: "0.160.0",
        verifiedAt: "02/10/2026",
      },
    ],
  ])("limite-codex requires official URL, version and date: rejects %s", (_name, source) => {
    const result = OverlapRowSchema.safeParse(nativeRow({ codexParity: limiteParity(source) }));
    expect(result.success).toBe(false);
    // R2: the failure names the row.
    expect(JSON.stringify(result.error?.issues)).toContain("hook:routing-watch");
  });

  // Covers: R2
  it("flags an enforcing row without a passing smoke, naming the missing verification", () => {
    expect(codexParityIssues({ state: "igual", enforcing: true })).toEqual([
      "an enforcing row needs a verification with smoke 'pass'",
    ]);
    expect(codexParityIssues({ state: "igual", enforcing: true, verification: "V9" })).toContain(
      "references unknown verification V9",
    );
    expect(
      codexParityIssues(
        { state: "igual", enforcing: true, verification: "V1" },
        {
          V1: {
            capability: "x",
            url: "https://learn.chatgpt.com/docs/hooks",
            codexVersion: "0.160.0",
            verifiedAt: "2026-10-02",
            probe: "pass",
            smoke: "pass",
          },
        },
      ),
    ).toEqual([]);
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
      engine: "claude",
    }).hooks.map((h) => h.id),
  );
  add(
    "managed-block",
    readdirSync(join(coreAssets, "managed"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3)),
  );
  add("plugin", listBundledPluginIds());
  const allPlugins = listBundledPluginIds().map((id) => loadPlugin(id));
  add(
    "plugin-script",
    allPlugins.flatMap((plugin) =>
      plugin.scriptAssets.map((script) => `${plugin.manifest.id}/${script.dest}`),
    ),
  );
  const shellRules = collectShellPermissionRules(FULL_CONFIG, allPlugins);
  const codexRules = buildCodexRules(shellRules);
  add("permission-rule", [
    "class:bash-ask",
    "class:bash-deny",
    "class:allow-not-translated",
    "class:prompt-amendment",
    ...codexRules.dropped.map((rule) => `dropped:${rule.pattern}`),
    ...codexRules.narrowed.map((rule) => `narrowed:${rule.pattern}`),
  ]);
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

  // Covers: R1, R3
  it("has a CODEX_PARITY row for every unit and none left over", () => {
    const parityKeys = Object.keys(CODEX_PARITY);
    const unitKeys = [...expected.keys()];
    expect({
      missing: missingParityUnits(unitKeys),
      extra: parityKeys.filter((key) => !expected.has(key)),
    }).toEqual({ missing: [], extra: [] });
    // Every OVERLAP_ROWS row carries the parity of its own key.
    for (const row of OVERLAP_ROWS) {
      expect(row.codexParity, keyOf(row.unit.kind, row.unit.id)).toBe(
        CODEX_PARITY[keyOf(row.unit.kind, row.unit.id)],
      );
    }
  });

  // Covers: R3
  it("names the unit that has no parity row", () => {
    expect(missingParityUnits(["hook:invented", "hook:guard-destructive"])).toEqual([
      "hook:invented",
    ]);
  });

  // Covers: R14, R26
  it("every narrowed pattern belongs to a family, and no family keeps a stale pattern", () => {
    const familyPatterns = new Set(NARROWED_PATTERN_FAMILIES.flatMap((f) => f.patterns));
    const narrowed = codexRules.narrowed.map((rule) => rule.pattern);
    expect(narrowed.filter((pattern) => !familyPatterns.has(pattern))).toEqual([]);
    expect([...familyPatterns].filter((pattern) => !narrowed.includes(pattern))).toEqual([]);
    expect(narrowed.length).toBe(85);
    for (const family of NARROWED_PATTERN_FAMILIES) {
      const decisions = new Set(
        codexRules.narrowed
          .filter((r) => family.patterns.includes(r.pattern))
          .map((r) => r.decision),
      );
      expect([...decisions], family.id).toEqual([family.decision]);
    }
  });

  // Covers: R14
  it("never drops a non-Bash rule silently: each dropped pattern has its own row", () => {
    expect(codexRules.dropped.map((rule) => rule.pattern)).toContain("Agent(orchestrator)");
    for (const rule of codexRules.dropped) {
      expect(CODEX_PARITY[`permission-rule:dropped:${rule.pattern}`], rule.pattern).toBeDefined();
    }
  });

  // Covers: R15
  it("records that Claude allow is not translated as a limite-codex row citing F8", () => {
    const row = CODEX_PARITY["permission-rule:class:allow-not-translated"];
    expect(row?.state).toBe("limite-codex");
    expect(row?.state === "limite-codex" ? row.source.url : "").toContain("exec_policy.rs");
    expect(buildCodexRules({ allow: ["Bash(git status*)"], ask: [], deny: [] }).body).not.toContain(
      '"allow"',
    );
  });

  // Covers: R26
  it("an equivalente family points at a registered hook; a limite-codex family at its source", () => {
    const registered = new Set(
      CODEX_HOOK_REGISTRATIONS.filter((row) => row.registration).map((row) => row.script),
    );
    for (const family of NARROWED_PATTERN_FAMILIES) {
      if (family.parity.state === "equivalente") {
        expect(family.parity.mechanism, family.id).toContain("guard-destructive");
        expect(registered.has("guard-destructive")).toBe(true);
      } else {
        expect(family.parity.state, family.id).toBe("limite-codex");
      }
    }
  });

  // Covers: R3
  it("keeps CODEX_HOOK_REGISTRATIONS and the hook parity rows consistent", () => {
    for (const row of CODEX_HOOK_REGISTRATIONS) {
      const parity = CODEX_PARITY[`hook:${row.script}`];
      expect(parity, `hook:${row.script} has no parity row`).toBeDefined();
      // A registered hook is igual/equivalente; an unregistered one is a limit.
      expect(parity?.state === "limite-codex", `hook:${row.script}`).toBe(!row.registration);
    }
  });

  // Covers: R1, R3
  it("lists as Codex-unsupported surfaces exactly the limite-codex hooks, with the row's reason", () => {
    const surfaces = ENGINE_CAPABILITIES.codex.unsupportedSurfaces.filter((s) =>
      s.renderedPaths?.some((path) => path.startsWith(".codex/hooks/")),
    );
    const unregistered = CODEX_HOOK_REGISTRATIONS.filter((row) => !row.registration).map(
      (row) => row.script,
    );
    expect(surfaces.map((s) => s.surface)).toEqual(unregistered);
    for (const surface of surfaces) {
      const parity = CODEX_PARITY[`hook:${surface.surface}`];
      expect(parity?.state === "limite-codex" ? parity.containment : undefined).toBe(
        surface.reason,
      );
    }
  });

  // Covers: R3
  it("declares no Codex control unsupported while one of its hooks is igual/equivalente", () => {
    for (const [control, declaration] of Object.entries(ENGINE_CAPABILITIES.codex.controls)) {
      if (declaration.state !== "unsupported") continue;
      const scripts = CONTROL_HOOKS[control as keyof typeof CONTROL_HOOKS] ?? [];
      for (const script of scripts) {
        const state = CODEX_PARITY[`hook:${script.replace(/\.sh$/, "")}`]?.state;
        expect(state, `${control} is unsupported but ${script} is ${state}`).toBe("limite-codex");
      }
    }
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
  // Covers: R5
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

  // Covers: R5
  it("prints the Codex parity state, mechanism, source, version and date per row", () => {
    const doc = renderOverlapDoc([
      nativeRow({
        codexParity: {
          state: "limite-codex",
          source: {
            url: "https://learn.chatgpt.com/docs/hooks",
            codexVersion: "0.160.0",
            verifiedAt: "2026-10-02",
          },
          containment: "advisory only",
        },
      }),
      nativeRow({
        unit: { kind: "hook", id: "other" },
        codexParity: { state: "equivalente", mechanism: "SubagentStop", enforcing: false },
      }),
    ]);
    expect(doc).toContain(
      "| Paridad Codex | Mecanismo | Fuente | Versión Codex | Verificada Codex |",
    );
    expect(doc).toContain(
      "| limite-codex | advisory only | https://learn.chatgpt.com/docs/hooks | 0.160.0 | 2026-10-02 |",
    );
    expect(doc).toContain("| equivalente | SubagentStop | — | — | — |");
  });
});
