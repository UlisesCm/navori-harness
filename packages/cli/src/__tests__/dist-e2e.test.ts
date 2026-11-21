import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/** Release blocker (decision of 20 Nov): what `scripts/js/dist-e2e.mjs` installs and demands. */

interface E2e {
  SCENARIOS: string[];
  EXPECTED_DOCTOR_WARNINGS: string[];
  installPlan: (
    scenario: string,
    tarballs: string[],
  ) => { argv: string[]; env: Record<string, string> };
  unexpectedWarnings: (output: string, expected?: string[]) => string[];
  median: (values: number[]) => number;
  dockerfile: (node: string) => string;
  imageTag: (node: string, text: string) => string;
  parseArgs: (argv: string[]) => { managers: string[]; alias: boolean; binary: string };
  allowed: (r: { status: number | null; stdout: string }) => boolean;
  verifyRowDetail: (r: {
    engine: string;
    ok: boolean;
    p50Ms?: number;
    problems: string[];
    notes?: string[];
  }) => string;
  throwIfInterrupted: (signal: string | null, trappedStatus?: number | null) => void;
  verifyGates: (mode: string) => boolean;
}

interface Registration {
  engine: string;
  event: string;
  matcher: string | null;
  command: string;
}
interface Verify {
  hookOf: (command: string) => string | null;
  wrapperProblems: (text: string, label: string) => string[];
  decisionOf: (stdout: string, code: number | null) => string;
  piRuntimeRegistrations: (runtime: unknown) => Registration[];
  parseArgs: (argv: string[]) => { root: string; manifest?: string; hooks: string[]; runs: number };
}

const repo = resolve(import.meta.dirname, "..", "..", "..", "..");
const load = async <T>(file: string): Promise<T> =>
  (await import(pathToFileURL(join(repo, "scripts", "js", file)).href)) as T;
const e2e = await load<E2e>("dist-e2e.mjs");
const verify = await load<Verify>("activation-verify.mjs");

describe("dist-e2e", () => {
  it("instala con npm, pnpm y npm sin scripts", () => {
    const tgz = ["/e2e/pkg/main.tgz", "/e2e/pkg/platform.tgz"];
    expect(e2e.SCENARIOS).toEqual(["npm", "pnpm", "npm-ignore-scripts"]);
    expect(e2e.installPlan("npm", tgz).argv).not.toContain("--ignore-scripts");
    expect(e2e.installPlan("npm-ignore-scripts", tgz).argv).toContain("--ignore-scripts");
    const pnpm = e2e.installPlan("pnpm", tgz);
    expect(pnpm.argv.slice(0, 2)).toEqual(["pnpm", "add"]);
    expect(pnpm.env.PNPM_CONFIG_DANGEROUSLY_ALLOW_ALL_BUILDS).toBe("true");
    expect(() => e2e.installPlan("bun", tgz)).toThrow(/unknown scenario/);
  });

  it("solo los avisos de doctor fuera de la lista son inesperados", () => {
    const output = [
      "▲  Herramientas opcionales no instaladas (1) — el harness funciona con fallback",
      "│    ⇡ locate-code",
      "▲  Restos de interpolación en el árbol renderizado (22)",
      "●  Proveedores externos disponibles",
    ].join("\n");
    expect(e2e.unexpectedWarnings(output)).toEqual([
      "Restos de interpolación en el árbol renderizado (22)",
    ]);
    expect(e2e.unexpectedWarnings("▲  algo nuevo", [])).toEqual(["algo nuevo"]);
  });

  it("la imagen trae jq acreditado (Debian 13) y no trae Rust", () => {
    const text = e2e.dockerfile("26.13.0");
    expect(text).toContain("FROM node:26.13.0-trixie-slim");
    expect(text).toMatch(/apt-get install .*\bjq\b/);
    expect(text).not.toMatch(/rustup|cargo/);
    expect(e2e.imageTag("26.13.0", text)).toMatch(/^navori-e2e:node26\.13\.0-[0-9a-f]{12}$/);
    expect(e2e.imageTag("26.13.0", `${text}#`)).not.toBe(e2e.imageTag("26.13.0", text));
  });

  it("exige binario, legacy y pin en el modo host", () => {
    expect(() => e2e.parseArgs([])).toThrow(/required/);
    const options = e2e.parseArgs([
      "--binary",
      "b",
      "--legacy-tarball",
      "l",
      "--legacy-pin",
      "p",
      "--managers",
      "npm",
      "--alias",
    ]);
    expect(options.managers).toEqual(["npm"]);
    expect(options.alias).toBe(true);
    expect(() =>
      e2e.parseArgs([
        "--binary",
        "b",
        "--legacy-tarball",
        "l",
        "--legacy-pin",
        "p",
        "--managers",
        "yarn",
      ]),
    ).toThrow(/unknown scenario/);
    expect(e2e.median([3, 1, 2])).toBe(2);
    expect(e2e.median([4, 1, 2, 3])).toBe(2.5);
  });
});

describe("dist-e2e: gates", () => {
  it("el guard solo permite con exit 0, sin el ask de falla y con pass o allow", () => {
    const ask = '{"hookSpecificOutput":{"permissionDecision":"ask"}}';
    const failed =
      '{"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"navori: guard-destructive could not evaluate this call (native runtime failed); confirm it manually"}}';
    expect(e2e.allowed({ status: 0, stdout: "" })).toBe(true);
    expect(
      e2e.allowed({ status: 0, stdout: '{"hookSpecificOutput":{"permissionDecision":"allow"}}' }),
    ).toBe(true);
    expect(e2e.allowed({ status: null, stdout: "" })).toBe(false);
    expect(e2e.allowed({ status: 0, stdout: failed })).toBe(false);
    expect(e2e.allowed({ status: 0, stdout: ask })).toBe(false);
    expect(e2e.allowed({ status: 2, stdout: "" })).toBe(false);
  });

  it("el detalle de activation-verify muestra notas y omite la mediana sin tiempos", () => {
    expect(e2e.verifyRowDetail({ engine: "claude", ok: true, p50Ms: 4.2, problems: [] })).toBe(
      "claude: OK p50=4.2 ms",
    );
    expect(
      e2e.verifyRowDetail({ engine: "pi", ok: true, problems: [], notes: ["not registered"] }),
    ).toBe("pi: OK note: not registered");
    expect(
      e2e.verifyRowDetail({ engine: "pi", ok: false, problems: ["did not finish within 1000 ms"] }),
    ).toBe("pi: did not finish within 1000 ms");
  });

  it("una señal de interrupción corta la corrida", () => {
    expect(() => e2e.throwIfInterrupted("SIGINT")).toThrow(/interrupted by SIGINT/);
    expect(() => e2e.throwIfInterrupted("SIGTERM")).toThrow(/interrupted by SIGTERM/);
    expect(() => e2e.throwIfInterrupted(null)).not.toThrow();
    expect(() => e2e.throwIfInterrupted("SIGKILL")).not.toThrow();
    expect(() => e2e.throwIfInterrupted(null, 130)).toThrow(/SIGINT \(exit 130\)/);
    expect(() => e2e.throwIfInterrupted(null, 143)).toThrow(/SIGTERM \(exit 143\)/);
    expect(() => e2e.throwIfInterrupted(null, 1)).not.toThrow();
  });

  it("activation-verify bloquea salvo con el guard en sombra", () => {
    expect(e2e.verifyGates("shadow")).toBe(false);
    expect(e2e.verifyGates("active")).toBe(true);
    expect(e2e.verifyGates("missing")).toBe(true);
  });
});

describe("activation-verify", () => {
  it("reconoce el hook de un comando de Claude o de Pi", () => {
    expect(
      verify.hookOf('f="$CLAUDE_PROJECT_DIR/.claude/hooks/guard-destructive.sh"; bash "$f"'),
    ).toBe("guard-destructive");
    expect(verify.hookOf('bash ".pi/navori/hooks/pr-publisher-confirm.sh"')).toBe(
      "pr-publisher-confirm",
    );
    expect(verify.hookOf("echo hi")).toBeNull();
  });

  it("un wrapper activo no pasa --shadow", () => {
    const block = (args: string) =>
      `# navori:native-runtime start\nnv_out=$("$nv_native" hook --via-script "$0"${args} "$@")\n# navori:native-runtime end\n`;
    expect(verify.wrapperProblems(block(""), "x.sh")).toEqual([]);
    expect(verify.wrapperProblems(block(" --shadow"), "x.sh")).toEqual([
      expect.stringMatching(/--shadow/),
    ]);
    expect(verify.wrapperProblems("#!/bin/bash\n", "x.sh")).toEqual([
      expect.stringMatching(/no native-runtime block/),
    ]);
  });

  it("resume la decisión y lee los hooks de Pi renderizados", () => {
    expect(verify.decisionOf('{"hookSpecificOutput":{"permissionDecision":"deny"}}', 0)).toBe(
      "deny",
    );
    expect(verify.decisionOf("", 2)).toBe("block (exit 2)");
    expect(verify.decisionOf("", 0)).toBe("pass (exit 0)");
    expect(
      verify.piRuntimeRegistrations({
        hooks: [
          {
            script: "guard-destructive",
            path: ".pi/navori/hooks/guard-destructive.sh",
            on: "tool_call",
            tools: ["bash"],
          },
          {
            script: "worktree-reclaim",
            path: ".pi/navori/hooks/worktree-reclaim.sh",
            on: "session_shutdown",
          },
          { script: "x", path: "x.sh", on: "agent_before_settle" },
        ],
      }),
    ).toEqual([
      {
        engine: "pi",
        event: "PreToolUse",
        matcher: "Bash",
        command: 'bash ".pi/navori/hooks/guard-destructive.sh"',
      },
      {
        engine: "pi",
        event: "SessionEnd",
        matcher: null,
        command: 'bash ".pi/navori/hooks/worktree-reclaim.sh"',
      },
    ]);
    expect(
      verify.parseArgs(["--manifest", "/m.json", "--hook", "guard-destructive.sh", "--runs", "3"]),
    ).toMatchObject({
      manifest: "/m.json",
      hooks: ["guard-destructive"],
      runs: 3,
    });
  });
});
