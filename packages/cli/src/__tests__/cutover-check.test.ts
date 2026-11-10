import { describe, expect, it } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Spec 0062 T8 (R20, R17, R18): `scripts/js/cutover-check.mjs` and `post-cutover-check.mjs`. */

interface Finding {
  check: string;
  detail: string;
}
interface Delegation {
  path: string[];
  flags?: string[];
  reason: string;
}
interface ShellHook {
  hook: string;
  reason: string;
}
interface Input {
  manifest: {
    commands: Array<{ path: string[]; flags?: string[] }>;
    hooks: Record<string, { mode?: string }>;
  };
  commands: Array<{ path: string[]; flags: string[] }>;
  hooks: string[];
  history: Array<{ date: string; op: string; id: string }>;
  delegation?: Delegation[];
  shellHooks?: ShellHook[];
  bench: {
    comparable?: boolean;
    measurements?: Array<{ engine?: string; hook?: string; wallMsP95: number }>;
  } | null;
  versionMs: number | null;
  postCutover: { ok: boolean; seconds: number; host?: string } | null;
}
interface Cutover {
  cutoverFindings: (input: Input) => Finding[];
  VERSION_BUDGET_MS: number;
  HOOK_P95_BUDGET_MS: number;
  POST_CUTOVER_BUDGET_S: number;
  POST_CUTOVER_CI_BUDGET_S: number;
  postCutoverBudget: (host: string | undefined) => number;
}
interface PostCutover {
  STEPS: Array<{ name: string; cmd: string; args: string[]; sharded?: boolean }>;
  ARTIFACT_SUITES: string[];
  postCutoverHost: (env: Record<string, string | undefined>) => "ci" | "reference";
  stepInvocations: (step: { args: string[]; sharded?: boolean }, shards: number) => string[][];
  TS_ORACLE_CRATE: string;
  postCutoverOk: (steps: Array<{ status: number }>, seconds: number) => boolean;
}
interface Areas {
  PERMANENT_DELEGATION: Delegation[];
  permanentlyDelegated: (path: string[], flag?: string, list?: Delegation[]) => boolean;
  PERMANENT_SHELL_HOOKS: ShellHook[];
  permanentShellHook: (id: string, list?: ShellHook[]) => boolean;
  hookInventory: () => string[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const load = async <T>(name: string): Promise<T> =>
  (await import(pathToFileURL(join(root, "scripts", "js", name)).href)) as T;
const cutover = await load<Cutover>("cutover-check.mjs");
const post = await load<PostCutover>("post-cutover-check.mjs");
const areas = await load<Areas>("rust-areas.mjs");

/** A cutover-ready input: everything declared, active, measured and within budget. */
const ready = (): Input => ({
  manifest: {
    commands: [
      { path: ["render"], flags: ["apply", "json"] },
      { path: ["spec", "check"], flags: ["json"] },
    ],
    hooks: { "guard-destructive": { mode: "active" }, "plan-gate": { mode: "active" } },
  },
  commands: [
    { path: ["render"], flags: ["apply", "json"] },
    { path: ["spec", "check"], flags: ["json"] },
  ],
  hooks: ["guard-destructive", "plan-gate"],
  history: [{ date: "2026-10-29", op: "port", id: "render" }],
  delegation: [],
  shellHooks: [],
  bench: {
    comparable: true,
    measurements: [{ engine: "claude", hook: "plan-gate", wallMsP95: 2 }],
  },
  versionMs: 3,
  postCutover: { ok: true, seconds: 200 },
});

describe("cutover-check (spec 0062 T8)", () => {
  // Covers: R20
  it("falla con un hook en shadow o un subcomando fuera del manifiesto y de la lista de delegación", () => {
    expect(cutover.cutoverFindings(ready())).toEqual([]);

    const shadow = ready();
    shadow.manifest.hooks["plan-gate"] = { mode: "shadow" };
    expect(cutover.cutoverFindings(shadow)).toEqual([{ check: "shadow", detail: "plan-gate" }]);

    const missing = ready();
    missing.commands.push({ path: ["doctor"], flags: [] });
    missing.commands[0]?.flags.push("prune");
    missing.hooks.push("role-guard");
    expect(cutover.cutoverFindings(missing)).toEqual([
      { check: "flag", detail: "render --prune" },
      { check: "command", detail: "doctor" },
      { check: "hook", detail: "role-guard" },
    ]);

    // The permanent delegation list answers for a whole subcommand, or for one flag.
    missing.delegation = [
      { path: ["doctor"], reason: "r" },
      { path: ["render"], flags: ["prune"], reason: "r" },
    ];
    expect(cutover.cutoverFindings(missing)).toEqual([{ check: "hook", detail: "role-guard" }]);

    // An open unport blocks; a later port closes it.
    const unport = ready();
    unport.history.push({ date: "2026-11-01", op: "unport", id: "render" });
    expect(cutover.cutoverFindings(unport)).toEqual([
      { check: "unport", detail: "render (since 2026-11-01)" },
    ]);
    unport.history.push({ date: "2026-11-02", op: "port", id: "render" });
    expect(cutover.cutoverFindings(unport)).toEqual([]);

    // A subcommand or hook with no area fails loudly instead of slipping past the inventory.
    const stray = ready();
    stray.commands.push({ path: ["nuevo"], flags: [] });
    expect(() => cutover.cutoverFindings(stray)).toThrow(/no area/);
  });

  // Covers: R20 (enmienda: hooks shell permanentes)
  it("un hook shell permanente no falta ni deja un unport abierto; cualquier otro sí", () => {
    const input = ready();
    input.hooks.push("role-guard", "model-advisor");
    input.history.push(
      { date: "2026-11-10", op: "unport", id: "role-guard" },
      { date: "2026-11-10", op: "unport", id: "model-advisor" },
    );
    input.shellHooks = [{ hook: "role-guard", reason: "r" }];
    expect(cutover.cutoverFindings(input)).toEqual([
      { check: "hook", detail: "model-advisor" },
      { check: "unport", detail: "model-advisor (since 2026-11-10)" },
    ]);

    // The list is explicit: the five hooks frozen by #1503 plus the two Codex-only guards,
    // every one a real core hook with a reason.
    expect(areas.PERMANENT_SHELL_HOOKS.map((e) => e.hook).sort()).toEqual([
      "audit-mode-close",
      "audit-mode-trigger",
      "engram-write-guard",
      "master-accept-confirm",
      "master-plan-context",
      "role-guard",
      "stop-verify-reminder",
    ]);
    const inventory = areas.hookInventory();
    for (const entry of areas.PERMANENT_SHELL_HOOKS) {
      expect(inventory).toContain(entry.hook);
      expect(entry.reason).toContain("#1503");
    }
    expect(areas.permanentShellHook("guard-destructive")).toBe(false);
  });

  // Covers: R17, R18
  it("exige la evidencia de R17 y R18 dentro de su presupuesto", () => {
    const input = ready();
    input.bench = null;
    input.versionMs = null;
    input.postCutover = null;
    expect(cutover.cutoverFindings(input).map((f) => f.check)).toEqual(["R17", "R17", "R18"]);

    const over = ready();
    over.bench = {
      comparable: false,
      measurements: [
        { engine: "pi", hook: "role-guard", wallMsP95: cutover.HOOK_P95_BUDGET_MS + 1 },
      ],
    };
    over.versionMs = cutover.VERSION_BUDGET_MS + 1;
    over.postCutover = { ok: true, seconds: cutover.POST_CUTOVER_BUDGET_S + 1 };
    expect(cutover.cutoverFindings(over).map((f) => f.detail)).toEqual([
      "the last bench:hooks --impl rust is not comparable",
      "pi/role-guard p95 6.000 ms > 5 ms",
      "navori-rust --version 11.0 ms > 10 ms",
      "check:post-cutover took 301 s > 300 s",
    ]);
    const red = ready();
    red.postCutover = { ok: false, seconds: 10 };
    expect(cutover.cutoverFindings(red)).toEqual([
      { check: "R18", detail: "the last check:post-cutover failed" },
    ]);
  });

  // Covers: R18
  it("R18 vale 300 s en la máquina de referencia y 600 s en CI, según el host del registro", () => {
    expect(cutover.POST_CUTOVER_BUDGET_S).toBe(300);
    expect(cutover.POST_CUTOVER_CI_BUDGET_S).toBe(600);
    expect(cutover.postCutoverBudget("ci")).toBe(600);
    expect(cutover.postCutoverBudget("reference")).toBe(300);
    // a record without a host predates the field: the stricter budget applies
    expect(cutover.postCutoverBudget(undefined)).toBe(300);
    const ci = ready();
    ci.postCutover = { ok: true, seconds: 599, host: "ci" };
    expect(cutover.cutoverFindings(ci)).toEqual([]);
    ci.postCutover = { ok: true, seconds: 601, host: "ci" };
    expect(cutover.cutoverFindings(ci).map((f) => f.detail)).toEqual([
      "check:post-cutover took 601 s > 600 s",
    ]);
    const local = ready();
    local.postCutover = { ok: true, seconds: 301, host: "reference" };
    expect(cutover.cutoverFindings(local).map((f) => f.check)).toEqual(["R18"]);
    expect(post.postCutoverHost({ GITHUB_ACTIONS: "true" })).toBe("ci");
    expect(post.postCutoverHost({})).toBe("reference");
    expect(post.postCutoverHost({ GITHUB_ACTIONS: "false" })).toBe("reference");
  });

  // Covers: R18
  it("el oráculo de hooks corre en rebanadas --shard i/n paralelas; los demás pasos, una vez", () => {
    const oracle = post.STEPS.find((s) => s.name === "hook oracle");
    expect(oracle?.sharded).toBe(true);
    expect(post.STEPS.filter((s) => s.sharded)).toHaveLength(1);
    expect(oracle && post.stepInvocations(oracle, 3).map((args) => args.slice(-2))).toEqual([
      ["--shard", "1/3"],
      ["--shard", "2/3"],
      ["--shard", "3/3"],
    ]);
    const fmt = post.STEPS[0];
    expect(fmt && post.stepInvocations(fmt, 3)).toEqual([fmt?.args]);
  });

  // Covers: R18
  it("check:post-cutover corre cargo, el oráculo de hooks, las suites de artefacto y los checks, sin la suite TS", () => {
    expect(post.STEPS.map((s) => s.name)).toEqual([
      "cargo fmt",
      "cargo clippy",
      "cargo test",
      "cargo build",
      "hook oracle",
      "artifact suites",
      "check:links",
      "check:render",
      "check:assets",
      "check:doc-budgets",
    ]);
    // the TS oracle crate leaves with the cutover (R24): neither clippy nor the tests build it
    for (const name of ["cargo clippy", "cargo test"]) {
      const args = post.STEPS.find((s) => s.name === name)?.args ?? [];
      expect(args.slice(args.indexOf("--exclude"), args.indexOf("--exclude") + 2)).toEqual([
        "--exclude",
        post.TS_ORACLE_CRATE,
      ]);
    }
    expect(post.TS_ORACLE_CRATE).toBe("navori-oracle-tests");
    const suites = post.STEPS.find((s) => s.name === "artifact suites");
    expect(suites?.args.slice(0, 3)).toEqual(["run", "vitest", "run"]);
    expect(suites?.args.slice(3)).toEqual(post.ARTIFACT_SUITES);
    // never the whole TS suite: every run names its files
    expect(post.ARTIFACT_SUITES.length).toBeGreaterThan(0);
    const tsSuite = (s: { cmd: string; args: string[] }): boolean =>
      s.cmd === "bun" && (s.args.includes("test") || s.args.includes("test:coverage"));
    expect(post.STEPS.some(tsSuite)).toBe(false);
    expect(post.postCutoverOk([{ status: 0 }], 300)).toBe(true);
    expect(post.postCutoverOk([{ status: 0 }], 300.5)).toBe(false);
    expect(post.postCutoverOk([{ status: 0 }, { status: 1 }], 10)).toBe(false);
  });

  // Covers: R20
  it("la lista de delegación permanente arranca vacía y cada entrada lleva motivo", () => {
    for (const entry of areas.PERMANENT_DELEGATION) expect(entry.reason.trim()).not.toBe("");
    const list = [{ path: ["codex", "trust"], flags: ["yes"], reason: "r" }];
    expect(areas.permanentlyDelegated(["codex", "trust"], "yes", list)).toBe(true);
    expect(areas.permanentlyDelegated(["codex", "trust"], undefined, list)).toBe(false);
    expect(areas.permanentlyDelegated(["codex"], undefined, list)).toBe(false);
  });
});
