import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditReadBudget, retainAuditFact } from "../model.ts";
import {
  mineActivation,
  mineClaudeMetrics,
  mineCodegraphProjectPaths,
  mineSearchRouting,
  flattenMinedMetrics,
  minerMetricKey,
  type MinedSession,
} from "../signals.ts";
import * as paths from "../paths.ts";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const user = (text = "work"): object => ({ type: "user", message: { content: text } });
const assistant = (...content: object[]): object => ({ type: "assistant", message: { content } });
const tool = (id: string, name: string, input: object = {}): object => ({
  type: "tool_use",
  id,
  name,
  input,
});
const result = (id: string, is_error: boolean, content: unknown): object => ({
  type: "tool_result",
  tool_use_id: id,
  is_error,
  content,
});
const text = (value: string): object => ({ type: "text", text: value });

/** Materialize synthetic Claude sources only, with complete newline-terminated rows. */
function fixture(rows: readonly object[]): MinedSession & { transcript: string } {
  const directory = mkdtempSync(join(tmpdir(), "audit-miners-"));
  directories.push(directory);
  const transcript = join(directory, "s.jsonl");
  writeFileSync(transcript, rows.map((row) => JSON.stringify(row) + "\n").join(""));
  return { sessionId: "s", host: "claude", transcript, cwd: "/synthetic" };
}

describe("bounded Claude miners", () => {
  // Covers: R11, R21
  it("keeps search blocks persistent but activation results asymmetric and last-result-wins", () => {
    const session = fixture([
      user(),
      assistant(result("a", true, "BLOCKED by guard-x")),
      assistant(tool("a", "Bash", { command: "rg needle src" })),
      { type: "user", message: { content: [result("a", false, "success")] } },
      user(),
      assistant(tool("b", "Bash", { command: "bun test" })),
      { type: "user", message: { content: [result("b", true, "FAIL"), result("b", false, "ok")] } },
    ]);
    const mined = mineClaudeMetrics([session]);
    expect(mined.search).toEqual({ bloqueado: 1 });
    expect(mined.activation.opp["debug-error"]).toBeUndefined();
    expect(mined.evidence.search.state).toBe("observed");
    expect(mined.diagnostics.passes).toBe(2);
    expect(mined.diagnostics.bytesRead).toBe(2 * statSync(session.transcript).size);
  });
  // Covers: R21
  it("preserves duplicate calls and late errors in original activation turn order", () => {
    const session = fixture([
      user(),
      assistant(tool("first", "Bash", { command: "bun test same" })),
      user(),
      assistant(tool("duplicate", "Bash", { command: "bun test same" })),
      { type: "user", message: { content: [result("first", true, "FAIL")] } },
      { type: "user", message: { content: [result("duplicate", true, "FAIL")] } },
      user(),
      assistant(tool("duplicate", "Bash", { command: "bun test later" })),
      { type: "user", message: { content: [result("duplicate", false, "ok")] } },
    ]);
    const mined = mineActivation([session]);
    expect(mined.value.opp["debug-error"]).toBe(2);
    expect(mined.value.opp["loop-back-debug"]).toBe(1);
    expect(mined.evidence.state).toBe("observed");
  });
  // Covers: R21
  it("keeps search last-use and file-local IDs, sorting admitted subagent files", () => {
    const session = fixture([
      assistant(
        tool("same", "Bash", { command: "rg first src" }),
        tool("same", "Bash", { command: "tgrep search second" }),
      ),
    ]);
    const subagents = join(session.transcript, "..", "s", "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(
      join(subagents, "agent-a.jsonl"),
      JSON.stringify(assistant(tool("same", "Bash", { command: "rg third src" }))) + "\n",
    );
    const mined = mineSearchRouting([session]);
    expect(mined.value).toEqual({ "tgrep-v2": 1, shell: 1 });
    expect(mined.diagnostics.passes).toBe(2);
  });
  // Covers: R21
  it("does not run or reserve activation state for search and CodeGraph wrappers", () => {
    const session = fixture([
      user(),
      ...Array.from({ length: 80 }, (_, index) =>
        assistant(tool(String(index), "Skill", { skill: `unrelated-${index}` })),
      ),
      assistant(tool("search", "Grep")),
    ]);
    const search = mineSearchRouting([session], createAuditReadBudget({ factsPerReport: 24 }));
    expect(search.value.nativo).toBe(1);
    expect(search.evidence.state).toBe("observed");
    expect(search.diagnostics.passes).toBe(1);
    const codegraph = mineCodegraphProjectPaths(
      [session],
      createAuditReadBudget({ factsPerReport: 24 }),
    );
    expect(codegraph.evidence.state).toBe("observed");
    expect(codegraph.diagnostics.passes).toBe(1);
  });
  // Covers: R21
  it("accounts replacements and releases transient state while retaining returned entries", () => {
    const empty = fixture([]);
    const baselineBudget = createAuditReadBudget();
    mineSearchRouting([empty], baselineBudget);
    const session = fixture(
      Array.from({ length: 200 }, () =>
        assistant(tool("same", "Bash", { command: "rg needle src" })),
      ),
    );
    const budget = createAuditReadBudget({ factsPerReport: 24 });
    const mined = mineSearchRouting([session], budget);
    expect(mined.value).toEqual({ shell: 1 });
    expect(mined.evidence.state).toBe("observed");
    expect(budget.diagnostics.retainedFacts).toBe(baselineBudget.diagnostics.retainedFacts + 1);
    expect(budget.diagnostics.truncated).toBe(false);
  });
  // Covers: R21
  it("stops after exhausted inventory without a useless second pass", () => {
    const session = fixture([
      user(),
      ...Array.from({ length: 200 }, (_, index) =>
        assistant(tool(String(index), "Skill", { skill: `custom-${index}` })),
      ),
    ]);
    const budget = createAuditReadBudget({ factsPerReport: 24 });
    const mined = mineClaudeMetrics([session], budget);
    expect(mined.diagnostics.passes).toBe(1);
    expect(mined.diagnostics.unknownRemainder).toBe(true);
    expect(budget.diagnostics.retainedFacts).toBeLessThanOrEqual(24);
    expect(mined.evidence.activation.state).toBe("unavailable");
    const flat = flattenMinedMetrics(mined);
    expect(flat.metrics["activation.total.opportunities"]).toBeNull();
    expect(flat.metrics["activation.total.pct"]).toBeNull();
  });
  // Covers: R21
  it("bounds subagent enumeration before building the sorted file list", () => {
    const session = fixture([]);
    const directory = join(session.transcript, "..", "s", "subagents");
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 12; index++)
      writeFileSync(join(directory, `agent-${index}.jsonl`), "\n");
    const budget = createAuditReadBudget({ pathsPerReport: 2 });
    const mined = mineSearchRouting([session], budget);
    expect(budget.diagnostics.retainedPaths).toBe(2);
    expect(mined.evidence.state).toBe("partial");
    expect(mined.diagnostics.passes).toBe(1);
  });
  // Covers: R21
  it("charges flattened output entries and nulls ratios when the shared output cap is exhausted", () => {
    const session = fixture([assistant(tool("a", "Grep"))]);
    const budget = createAuditReadBudget({ factsPerReport: 30 });
    const mined = mineClaudeMetrics([session], budget);
    const flat = flattenMinedMetrics(mined, budget);
    expect(budget.diagnostics.retainedFacts).toBeLessThanOrEqual(30);
    expect(budget.diagnostics.truncated).toBe(true);
    expect(mined.evidence.search.state).toBe("partial");
    expect(flat.metrics["search.good.pct"] ?? null).toBeNull();
    expect(Object.keys(flat.metrics).length).toBeLessThan(50);
  });
  // Covers: R4, R21
  it("excludes unknown/Codex sources, including transcript-shaped paths and missing rollouts", () => {
    const claude = fixture([]);
    const mined = mineClaudeMetrics([
      claude,
      { ...claude, sessionId: "codex", host: "codex" },
      { sessionId: "codex-missing", host: "codex", transcript: null },
      { ...claude, host: "unknown" },
    ]);
    expect(mined.evidence.activation).toMatchObject({
      state: "observed",
      eligible: 1,
      observed: 1,
      unavailable: 0,
    });
    expect(mined.activation.sessions).toBe(1);
    const codexOnly = mineClaudeMetrics([{ sessionId: "codex", host: "codex", transcript: null }]);
    expect(codexOnly.evidence.activation).toMatchObject({ state: "unavailable", eligible: 0 });
    expect(flattenMinedMetrics(codexOnly).metrics["activation.total.opportunities"]).toBeNull();
  });
  // Covers: R21
  it("distinguishes complete empty zero, missing Claude, and damaged source partial counts", () => {
    const session = fixture([]);
    expect(flattenMinedMetrics(mineClaudeMetrics([session])).metrics["search.shell"]).toBe(0);
    const missing = mineClaudeMetrics([{ ...session, transcript: null }]);
    expect(missing.evidence.search.state).toBe("unavailable");
    expect(missing.search.no_disponible).toBe(1);
    writeFileSync(session.transcript, JSON.stringify(assistant(tool("a", "Grep"))) + "\n{bad\n");
    const damaged = mineClaudeMetrics([session]);
    expect(damaged.evidence.search.state).toBe("partial");
    const flat = flattenMinedMetrics(damaged);
    expect(flat.metrics["search.nativo"]).toBe(1);
    expect(flat.metrics["search.good.pct"]).toBeNull();
    expect(flat.metrics["activation.sessions.graded"]).toBeNull();
    expect(damaged.diagnostics.malformedJson).toBe(2);
  });
  // Covers: R21
  it("preserves admitted-row EOF counts with malformed JSON but suppresses valid omitted late results", () => {
    const session = fixture([assistant(tool("a", "Bash", { command: "rg needle src" }))]);
    appendFileSync(session.transcript, "not JSON\n");
    const malformed = mineSearchRouting([session]);
    expect(malformed.value).toEqual({ shell: 1, malformado: 1 });
    expect(malformed.evidence).toMatchObject({ state: "partial", reason: "malformed" });
    writeFileSync(
      session.transcript,
      [
        assistant(tool("a", "Bash", { command: "rg needle src" })),
        {
          type: "user",
          message: { content: [result("a", true, "BLOCKED by guard-x" + "x".repeat(500))] },
        },
      ]
        .map((row) => JSON.stringify(row) + "\n")
        .join(""),
    );
    const omitted = mineSearchRouting([session], createAuditReadBudget({ maxLineBytes: 256 }));
    expect(omitted.value.shell).toBeUndefined();
    expect(omitted.value.bloqueado).toBeUndefined();
    expect(omitted.evidence.state).toBe("partial");
    expect(omitted.diagnostics.oversizedLines).toBe(1);
  });
  // Covers: R21
  it.each(["tail", "oversized", "utf8"])("exposes %s loss without raw source text", (kind) => {
    const session = fixture([assistant(tool("a", "Grep"))]);
    if (kind === "tail") appendFileSync(session.transcript, "PRIVATE_RAW_TAIL");
    else if (kind === "utf8") appendFileSync(session.transcript, Buffer.from([255, 10]));
    else appendFileSync(session.transcript, "PRIVATE_RAW_OVERSIZED".repeat(50) + "\n");
    const mined = mineSearchRouting([session], createAuditReadBudget({ maxLineBytes: 256 }));
    expect(mined.evidence.state).toBe("partial");
    expect(JSON.stringify(mined)).not.toContain("PRIVATE_RAW");
    expect(mined.diagnostics.omittedLowerBound).toBeGreaterThan(0);
  });
  // Covers: R11, R21
  it("preserves arbitrary-name asked, alias and Python name coercion/case semantics", () => {
    const session = fixture([
      user("custom-name publisher none ? mixedcase"),
      assistant(
        tool("a", "Skill", { skill: "custom-name" }),
        tool("b", "Agent", { subagent_type: "commit-pr-pilot" }),
        tool("c", "Skill", { skill: null }),
        tool("d", "Skill"),
        tool("e", "Skill", { skill: "MixedCase" }),
        tool("f", "Skill", { skill: "" }),
      ),
    ]);
    const mined = mineActivation([session]);
    expect(mined.value.asked).toEqual({ "custom-name": 1, publisher: 1, "?": 1, "": 1 });
    expect(mined.value.auto).toEqual({ None: 1, MixedCase: 1 });
  });
  // Covers: R21
  it("does not treat a retired alias spelling as a request for its canonical name", () => {
    const mined = mineActivation([
      fixture([
        user("commit-pr-pilot"),
        assistant(tool("a", "Agent", { subagent_type: "commit-pr-pilot" })),
      ]),
    ]);
    expect(mined.value.auto.publisher).toBe(1);
    expect(mined.value.asked.publisher).toBeUndefined();
  });
  // Covers: R11, R21
  it("counts prototype-shaped technical names without inheriting alias objects or mutating dictionaries", () => {
    const mined = mineActivation([
      fixture([
        user("__proto__ constructor tostring"),
        assistant(
          tool("a", "Skill", { skill: "__proto__" }),
          tool("b", "Skill", { skill: "constructor" }),
          tool("c", "Skill", { skill: "toString" }),
        ),
      ]),
    ]);
    expect(mined.value.asked["__proto__"]).toBe(1);
    expect(mined.value.asked.constructor).toBe(1);
    expect(mined.value.auto.toString).toBe(1);
    expect(mined.evidence.state).toBe("observed");
    expect(minerMetricKey("activation.invoked.auto.")).toBe(true);
  });
  // Covers: R21
  it("rejects oversized names and ambiguous IDs as loss instead of fallback identity", () => {
    const session = fixture([
      user(),
      assistant(tool("a", "Skill", { skill: "x".repeat(257) }), {
        type: "tool_use",
        id: {},
        name: "Bash",
        input: { command: "rg needle src" },
      }),
    ]);
    const mined = mineClaudeMetrics([session]);
    expect(mined.evidence.activation.state).toBe("partial");
    expect(mined.evidence.search.state).toBe("partial");
    expect(mined.activation.auto).toEqual({});
  });
  // Covers: R21
  it("preserves source-first/test-fallback, command join and 1500-character assistant suffix", () => {
    const session = fixture([
      user(),
      assistant(
        tool("a", "Edit", { file_path: "/synthetic/a.ts" }),
        tool("b", "Write", { file_path: "/synthetic/a.test.ts" }),
        tool("c", "Bash", { command: " gh pr create" }),
        text("listo"),
        text("x".repeat(1500)),
      ),
      user(),
      assistant(
        tool("d", "Edit", { file_path: "/synthetic/b.test.ts" }),
        tool("e", "Write", { file_path: "/synthetic/c.test.ts" }),
        tool("f", "Bash", { command: "echo x" }),
        tool("g", "Bash", { command: " gh pr create" }),
        text("listo"),
        text(""),
      ),
    ]);
    const mined = mineActivation([session]);
    expect(mined.value.opp).toEqual({ implementer: 1, "verify-before-done": 1, "pr-review": 1 });
  });
  // Covers: R21
  it("marks second-pass names absent from inventory partial without claiming snapshot integrity", () => {
    const session = fixture([
      user("custom-b"),
      assistant(tool("a", "Skill", { skill: "custom-a" })),
    ]);
    let passes = 0;
    const actual = paths.readAuditJsonl;
    vi.spyOn(paths, "readAuditJsonl").mockImplementation((path, visit, options) => {
      if (++passes === 2)
        writeFileSync(
          session.transcript,
          [user("custom-b"), assistant(tool("a", "Skill", { skill: "custom-b" }))]
            .map((row) => JSON.stringify(row) + "\n")
            .join(""),
        );
      return actual(path, visit, options);
    });
    const mined = mineActivation([session]);
    expect(mined.evidence.state).toBe("partial");
    expect(mined.value.asked).toEqual({});
  });
  // Covers: R11, R21
  it("never returns private prompt, command, tool-output, path or forged derived facts", () => {
    const sentinel = "PRIVATE_MINER_SENTINEL";
    const session = fixture([
      { ...user(sentinel), _auditClaude: { toolResultBytes: 9999, isError: true } },
      assistant(
        tool("a", "Bash", { command: `rg ${sentinel} src` }),
        tool("b", "mcp__codegraph__codegraph_explore", { projectPath: `/other/${sentinel}` }),
        text(`${sentinel} listo`),
      ),
      { type: "user", message: { content: [result("a", true, sentinel)] } },
    ]);
    const mined = mineClaudeMetrics([session]);
    expect(JSON.stringify(mined)).not.toContain(sentinel);
    expect(JSON.stringify(mined)).not.toContain("_auditClaude");
    expect(mined.codegraph).toMatchObject({ calls: 1, mismatched: 1 });
  });
  // Covers: R21
  it("uses a closed metric grammar rather than arbitrary family prefixes", () => {
    for (const key of [
      "search.shell",
      "codegraph.calls",
      "activation.total.pct",
      "activation.invoked.auto.custom",
      "mining.bytesRead",
    ])
      expect(minerMetricKey(key)).toBe(true);
    for (const key of [
      "search.extra",
      "codegraph.extra",
      "activation.extra",
      "activation.total.extra",
      "mining.extra",
      "tokens.input",
      "coverage.pct",
      "sessions.total",
    ])
      expect(minerMetricKey(key)).toBe(false);
  });
  // Covers: R21
  it("measures generated large-source early stopping with actual bytes and shared reservations", () => {
    const session = fixture([]);
    const line = JSON.stringify(assistant(tool("same", "Grep"))) + "\n";
    const chunk = line.repeat(1000);
    for (let index = 0; index < 120; index++) appendFileSync(session.transcript, chunk);
    const budget = createAuditReadBudget({ eventsPerSession: 20, factsPerReport: 30 });
    expect(retainAuditFact(budget, null, Object.freeze({ parserReservation: true }))).toBe(true);
    const rssBefore = process.memoryUsage().rss;
    const started = performance.now();
    const mined = mineClaudeMetrics([session], budget);
    const sampleRss = process.memoryUsage().rss;
    expect(mined.diagnostics.bytesRead).toBeLessThan(statSync(session.transcript).size);
    expect(mined.diagnostics.passes).toBe(2);
    expect(mined.diagnostics.unknownRemainder).toBe(true);
    expect(budget.diagnostics.retainedFacts).toBeLessThanOrEqual(30);
    expect(mined.evidence.search.state).toBe("partial");
    process.stdout.write(
      JSON.stringify({
        benchmark: "synthetic-miner-early-stop",
        runtime: process.version,
        platform: process.platform,
        arch: process.arch,
        inputBytes: statSync(session.transcript).size,
        elapsedMs: performance.now() - started,
        rssBefore,
        sampledPeakRss: Math.max(rssBefore, sampleRss),
        sampledRssDelta: Math.max(0, sampleRss - rssBefore),
        diagnostics: mined.diagnostics,
        budget: budget.diagnostics,
      }) + "\n",
    );
  });
  // Covers: R21
  it("measures complete shared main/subagent passes independently from the ordinary parser", () => {
    const session = fixture([]);
    const row =
      JSON.stringify({ ...assistant(tool("same", "Grep")), syntheticPadding: "x".repeat(1024) }) +
      "\n";
    const chunk = row.repeat(1000);
    for (let index = 0; index < 16; index++) appendFileSync(session.transcript, chunk);
    const directory = join(session.transcript, "..", "s", "subagents");
    mkdirSync(directory, { recursive: true });
    const subagent = join(directory, "agent-a.jsonl");
    writeFileSync(subagent, chunk);
    const mainBytes = statSync(session.transcript).size;
    const subagentBytes = statSync(subagent).size;
    const budget = createAuditReadBudget();
    const started = performance.now();
    const rssBefore = process.memoryUsage().rss;
    const mined = mineClaudeMetrics([session], budget);
    const sampleRss = process.memoryUsage().rss;
    expect(mined.evidence.search.state).toBe("observed");
    expect(mined.search.nativo).toBe(17_000);
    expect(mined.diagnostics).toMatchObject({
      bytesRead: 2 * mainBytes + subagentBytes,
      passes: 3,
      completePasses: 3,
      omittedLowerBound: 0,
    });
    process.stdout.write(
      JSON.stringify({
        benchmark: "synthetic-miner-complete",
        runtime: process.version,
        execPath: process.execPath,
        pid: process.pid,
        platform: process.platform,
        arch: process.arch,
        inputBytes: mainBytes + subagentBytes,
        elapsedMs: performance.now() - started,
        sampledRssDelta: Math.max(0, sampleRss - rssBefore),
        rssSampling: "before/after the synchronous miner; not continuous peak RSS",
        diagnostics: mined.diagnostics,
        budget: budget.diagnostics,
      }) + "\n",
    );
  });
});
