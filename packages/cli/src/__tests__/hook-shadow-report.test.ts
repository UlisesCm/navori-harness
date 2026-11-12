import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { expect, it } from "vitest";

interface Row {
  hook: string;
  engine: string;
  ok: boolean;
  invocations: number;
  legacyPayloadRows: number;
  problems: string[];
}
interface Report {
  ok: boolean;
  rows: Row[];
}
interface ReportInput {
  hooks: Record<string, { gating: boolean; impl: string }>;
  journals: Record<string, Uint8Array | Uint8Array[] | undefined>;
  engines: Record<string, string[]>;
  approved: Record<string, string[]>;
  now: number;
  windowDays: number;
}
interface Module {
  buildReport: (input: ReportInput) => Report;
  approvedWithoutTraffic: (history: string, hook: string) => string[];
  collect: (root: string, windowDays: number, now: number, journalRoots?: string[]) => Report;
}
const shadow = (await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/js/hook-shadow-report.mjs")).href
)) as Module;

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-10T12:00:00Z");
const IMPL = `sha256:${"a".repeat(64)}`;
const comparison = (differs: boolean): Record<string, boolean> => ({
  nativeFailed: false,
  shellFailed: false,
  codeDiffers: differs,
  stdoutDiffers: false,
  stderrDiffers: false,
});

/** One completed observation, `ageDays` before NOW; `legacy` adds the payload old binaries wrote. */
function journal(
  hook: string,
  engine: string,
  calls: { ageDays: number; differs?: boolean; complete?: boolean; legacy?: boolean }[],
): Uint8Array {
  const lines: string[] = [];
  for (const call of calls) {
    const id = randomUUID();
    const common = { schema: 1, id, hook, engine, implementation: IMPL };
    lines.push(JSON.stringify({ ...common, timeMs: NOW - call.ageDays * DAY, kind: "begin" }));
    if (call.complete === false) continue;
    lines.push(
      JSON.stringify({
        ...common,
        timeMs: NOW - call.ageDays * DAY + 5,
        kind: "complete",
        comparison: comparison(call.differs === true),
        ...(call.legacy ? { payloadBase64: "e30=" } : {}),
      }),
    );
  }
  return Buffer.from(`${lines.join("\n")}\n`);
}

const run = (
  gating: boolean,
  calls: { ageDays: number; differs?: boolean; complete?: boolean; legacy?: boolean }[] | undefined,
  approved: string[] = [],
): Report =>
  shadow.buildReport({
    hooks: { example: { gating, impl: IMPL } },
    journals: { example: calls === undefined ? undefined : journal("example", "claude", calls) },
    engines: { example: ["claude"] },
    approved: { example: approved },
    now: NOW,
    windowDays: 7,
  });

// Covers: R81, R82
it("una divergencia o un hook con compuerta sin tráfico deja el reporte en rojo", (): void => {
  const clean = [{ ageDays: 8 }, { ageDays: 1 }];
  expect(run(true, clean).ok).toBe(true);
  const diverged = run(true, [...clean, { ageDays: 2, differs: true }]);
  expect(diverged.ok).toBe(false);
  expect(diverged.rows[0]?.problems.join()).toContain("divergence");
  expect(run(false, [...clean, { ageDays: 2, differs: true }]).ok).toBe(false);

  const silent = run(true, undefined);
  expect(silent.ok).toBe(false);
  expect(silent.rows[0]?.problems.join()).toContain("R82");
  expect(run(true, undefined, ["claude"]).ok).toBe(true);
  expect(run(false, undefined).ok).toBe(true);
});

// Covers: R81
it("una ventana corta o una observación sin completar rompe un hook con compuerta", (): void => {
  expect(run(true, [{ ageDays: 3 }, { ageDays: 1 }]).ok).toBe(false);
  expect(run(false, [{ ageDays: 3 }]).ok).toBe(true);
  expect(run(true, [{ ageDays: 8 }, { ageDays: 1, complete: false }]).ok).toBe(false);
  const garbage = shadow.buildReport({
    hooks: { example: { gating: false, impl: IMPL } },
    journals: { example: Buffer.from("not json\n") },
    engines: { example: ["claude"] },
    approved: {},
    now: NOW,
    windowDays: 7,
  });
  expect(garbage.ok).toBe(false);
});

// Covers: R81
it("suma los journals de varios checkouts y uno inválido deja el reporte en rojo", (): void => {
  const scratch = mkdtempSync(join(tmpdir(), "shadow-report-"));
  try {
    const root = join(scratch, "root");
    const other = join(scratch, "other");
    mkdirSync(join(root, "crates"), { recursive: true });
    writeFileSync(
      join(root, "crates/ported.json"),
      JSON.stringify({ hooks: { example: { gating: true, impl: IMPL } } }),
    );
    mkdirSync(join(root, ".claude/hooks"), { recursive: true });
    writeFileSync(join(root, ".claude/hooks/example.sh"), "# navori:native-runtime start\n");
    for (const [dir, ageDays] of [
      [root, 1],
      [other, 8],
    ] as const) {
      mkdirSync(join(dir, ".navori/state/rust-shadow"), { recursive: true });
      writeFileSync(
        join(dir, ".navori/state/rust-shadow/example.jsonl"),
        journal("example", "claude", [{ ageDays }]),
      );
    }
    const alone = shadow.collect(root, 7, NOW);
    expect(alone.ok).toBe(false);
    expect(alone.rows[0]?.invocations).toBe(1);
    const merged = shadow.collect(root, 7, NOW, [root, other]);
    expect(merged.ok).toBe(true);
    expect(merged.rows[0]?.invocations).toBe(1);

    const invalid = shadow.buildReport({
      hooks: { example: { gating: false, impl: IMPL } },
      journals: {
        example: [journal("example", "claude", [{ ageDays: 1 }]), Buffer.from("not json\n")],
      },
      engines: { example: ["claude"] },
      approved: {},
      now: NOW,
      windowDays: 7,
    });
    expect(invalid.ok).toBe(false);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

// Covers: R82
it("solo una línea activate con no-shadow-traffic aprueba la falta de tráfico", (): void => {
  const line = (reason: string, op = "activate", id = "example"): string =>
    JSON.stringify({ date: "2026-11-01", op, id, reason, pr: 1 });
  expect(shadow.approvedWithoutTraffic(line("no-shadow-traffic"), "example")).toContain("pi");
  expect(shadow.approvedWithoutTraffic(line("replay ok"), "example")).toEqual([]);
  expect(shadow.approvedWithoutTraffic(line("no-shadow-traffic", "port"), "example")).toEqual([]);
  expect(
    shadow.approvedWithoutTraffic(line("no-shadow-traffic", "activate", "other"), "example"),
  ).toEqual([]);
});

// Covers: R81
it("las filas legacy con payloadBase64 se leen, se cuentan y nunca se devuelven", (): void => {
  const clean = [{ ageDays: 8 }, { ageDays: 1 }];
  expect(run(true, clean).rows[0]?.legacyPayloadRows).toBe(0);
  const mixed = run(true, [
    ...clean,
    { ageDays: 2, differs: true, legacy: true },
    { ageDays: 3, legacy: true },
  ]);
  expect(mixed.rows[0]?.legacyPayloadRows).toBe(2);
  expect(mixed.rows[0]?.invocations).toBe(3);
  expect(JSON.stringify(mixed)).not.toContain("e30=");
  // A legacy divergence still turns the report red; the count is informational.
  expect(mixed.ok).toBe(false);
  expect(run(true, [...clean, { ageDays: 3, legacy: true }]).ok).toBe(true);
});
