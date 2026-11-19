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
  firstMs: number | null;
  lastMs: number | null;
  closesMs: number | null;
  status: "green" | "amber" | "red";
  warnings: string[];
  nativeFailed: number;
  shellFailed: number;
  divergences: number;
  legacyPayloadRows: number;
  problems: string[];
}
interface Report {
  ok: boolean;
  status: "green" | "amber" | "red";
  rows: Row[];
}
interface ReportInput {
  hooks: Record<string, { gating: boolean; impl: string }>;
  journals: Record<string, Uint8Array | Uint8Array[] | undefined>;
  engines: Record<string, string[]>;
  approved: Record<string, string[]>;
  now: number;
  windowDays: number;
  perRowClose?: boolean;
  causes?: Record<string, string>;
}
interface Module {
  buildReport: (input: ReportInput) => Report;
  approvedWithoutTraffic: (history: string, hook: string) => string[];
  collect: (root: string, windowDays: number, now: number, journalRoots?: string[]) => Report;
  formatMarkdown: (report: Report, batches?: Record<string, string[]>) => string;
}
const shadow = (await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/js/hook-shadow-report.mjs")).href
)) as Module;

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-10T12:00:00Z");
const IMPL = `sha256:${"a".repeat(64)}`;
const comparison = (differs: boolean, failed?: "native" | "shell"): Record<string, boolean> => ({
  nativeFailed: failed === "native",
  shellFailed: failed === "shell",
  codeDiffers: differs,
  stdoutDiffers: false,
  stderrDiffers: false,
});

/** One completed observation, `ageDays` before NOW; `legacy` adds the payload old binaries wrote. */
function journal(
  hook: string,
  engine: string,
  calls: {
    ageDays: number;
    differs?: boolean;
    complete?: boolean;
    legacy?: boolean;
    failed?: "native" | "shell";
  }[],
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
        comparison: comparison(call.differs === true, call.failed),
        ...(call.legacy ? { payloadBase64: "e30=" } : {}),
      }),
    );
  }
  return Buffer.from(`${lines.join("\n")}\n`);
}

const run = (
  gating: boolean,
  calls: Parameters<typeof journal>[2] | undefined,
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

// Covers: R81
it("un now fijo cierra la ventana y la tabla da fallas, primera y última fila y veredicto por lote", (): void => {
  const report = run(true, [{ ageDays: 7 }, { ageDays: 1 }, { ageDays: -1 }]);
  expect(report.rows[0]?.invocations).toBe(2);
  expect(report.rows[0]?.firstMs).toBe(NOW - 7 * DAY);
  expect(report.rows[0]?.lastMs).toBe(NOW - DAY);
  expect(report.ok).toBe(true);

  const table = shadow.formatMarkdown(report, { B: ["example"], X: ["missing"] });
  expect(table).toContain(
    `| ${new Date(NOW - 7 * DAY).toISOString()} | ${new Date(NOW - DAY).toISOString()} | - | green |`,
  );
  expect(table).toContain("| B | example | green |");
  expect(table).toContain("| X | missing | red: no rows for missing");

  const failed = run(true, [
    { ageDays: 8 },
    { ageDays: 2, failed: "native" },
    { ageDays: 1, failed: "shell" },
  ]);
  expect(failed.rows[0]).toMatchObject({ nativeFailed: 1, shellFailed: 1, divergences: 2 });

  // One red engine turns the whole batch red, even when the other engine is green.
  const twoEngines = shadow.buildReport({
    hooks: { example: { gating: true, impl: IMPL } },
    journals: {
      example: [
        journal("example", "claude", [{ ageDays: 8 }, { ageDays: 1 }]),
        journal("example", "pi", [{ ageDays: 8 }, { ageDays: 1, differs: true }]),
      ],
    },
    engines: { example: ["claude", "pi"] },
    approved: {},
    now: NOW,
    windowDays: 7,
  });
  expect(shadow.formatMarkdown(twoEngines, { B: ["example"] })).toContain(
    "| B | example | red: example [pi] |",
  );
});

// Covers: R81
it("con cierre por fila cada hook y engine se juzga a los 7 días de su primera fila", (): void => {
  const perRow = (calls: Parameters<typeof journal>[2], gating = true): Report =>
    shadow.buildReport({
      hooks: { example: { gating, impl: IMPL } },
      journals: { example: journal("example", "claude", calls) },
      engines: { example: ["claude"] },
      approved: {},
      now: NOW,
      windowDays: 7,
      perRowClose: true,
    });
  // First row 9 d ago: the window closed 2 d ago, so the divergence 1 d ago does not count.
  const closed = perRow([{ ageDays: 9 }, { ageDays: 5 }, { ageDays: 1, differs: true }]);
  expect(closed.rows[0]).toMatchObject({ invocations: 2, divergences: 0, closesMs: NOW - 2 * DAY });
  expect(closed.ok).toBe(true);
  // First row 3 d ago: the window is still open, amber (not red) for a gating hook only.
  const open = perRow([{ ageDays: 3 }, { ageDays: 1 }]);
  expect(open.rows[0]?.status).toBe("amber");
  expect(open.rows[0]?.problems).toEqual([]);
  expect(open.rows[0]?.warnings).toEqual([
    `window open until ${new Date(NOW + 4 * DAY).toISOString()}`,
  ]);
  expect(perRow([{ ageDays: 3 }], false).ok).toBe(true);
});

// Covers: R81
it("una observación sin completar queda en ámbar y al cierre pasa a verde solo con causa, < 0,5 % y aislada", (): void => {
  const LOST = 8.5;
  const lostAt = (ageDays: number): string => new Date(NOW - ageDays * DAY).toISOString();
  // 200 completed calls inside the row's window (9 to 3 days ago; it closes 2 days ago), so one
  // lost observation is 1/201 < 0.5 %.
  const traffic = Array.from({ length: 200 }, (_, at) => ({ ageDays: 9 - at * 0.03 }));
  const report = (
    lost: number[],
    causes: Record<string, string>,
    perRowClose = true,
    calls = traffic,
  ): Report =>
    shadow.buildReport({
      hooks: { example: { gating: true, impl: IMPL } },
      journals: {
        example: journal("example", "claude", [
          ...calls,
          ...lost.map((ageDays) => ({ ageDays, complete: false })),
        ]),
      },
      engines: { example: ["claude"] },
      approved: {},
      now: NOW,
      windowDays: 7,
      perRowClose,
      causes,
    });
  const cause = { [`example|claude|${lostAt(LOST)}`]: "interrupción probable" };

  // Open window (clock mode): amber with its time, never red, never green.
  const open = report([1], {}, false);
  expect(open.rows[0]?.status).toBe("amber");
  expect(open.status).toBe("amber");
  expect(open.rows[0]?.warnings.join()).toContain(lostAt(1));
  expect(shadow.formatMarkdown(open, { B: ["example"] })).toContain(
    "| B | example | amber: example [claude] |",
  );

  // At the close: green with a recorded cause, red without one.
  expect(report([LOST], cause).rows[0]?.status).toBe("green");
  const unexplained = report([LOST], {});
  expect(unexplained.rows[0]?.status).toBe("red");
  expect(unexplained.rows[0]?.problems.join()).toContain("without a recorded cause");

  // At the close: red when they reach 0.5 % of the calls, or when two fall within 10 minutes.
  const few = report([LOST], cause, true, traffic.slice(0, 100));
  expect(few.rows[0]?.problems.join()).toContain("% of calls");
  const twin = LOST - 5 / 1440;
  // 400 calls keep two lost observations under 0.5 %, so only the grouping turns the row red.
  const grouped = report(
    [LOST, twin],
    { ...cause, [`example|claude|${lostAt(twin)}`]: "interrupción probable" },
    true,
    [...traffic, ...traffic],
  );
  expect(grouped.rows[0]?.status).toBe("red");
  expect(grouped.rows[0]?.problems.join()).toContain("grouped");
  expect(grouped.rows[0]?.problems.join()).not.toContain("% of calls");
});
