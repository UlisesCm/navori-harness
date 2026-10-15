import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { acknowledgePlanEscalation, evaluatePlanGate } from "../gate.ts";
import * as escalation from "../escalation.ts";
import { resolveStateRoot } from "../../primitives/state-root.ts";

let cwd: string;
let root: string;
let feature: string;
let opening: string;

/** Seeds a valid bounded recovery with legacy rejection history and optional delivery tasks. */
function fixture(spec = false): void {
  feature = spec ? "demo-e1" : "demo";
  opening = spec ? "spec: demo E1 M1" : "workplan: demo";
  writeFileSync(
    join(cwd, "navori.config.json"),
    JSON.stringify({
      name: "demo",
      preset: "custom",
      engines: ["codex"],
      harness: { planTiers: true },
    }),
  );
  writeFileSync(
    join(root, `workplan_${feature}.json`),
    JSON.stringify({
      feature,
      level: spec ? 3 : 2,
      classification: { score: 8, level: 2, signals: [] },
      objective: "Recover workflow",
      files: [],
      acceptance: [
        {
          id: "A1",
          description: "check",
          command: "bun test",
          expected: "exit0",
        },
      ],
      progress: { A1: "pendiente" },
      decisions: [],
      outOfScope: [],
      solution: { path: "solution_demo.md", verdict: "CONCERNS" },
      phases: [{ name: "one", acceptance: ["A1"] }],
      risks: [{ risk: "replay", rollback: "deny" }],
    }),
  );
  writeFileSync(
    join(root, `workplan_${feature}.gate.jsonl`),
    ["a", "b"]
      .map((letter) =>
        JSON.stringify({
          ts: "2026-10-14T00:00:00Z",
          reviewHash: letter.repeat(64),
          verdict: "CHANGES_REQUESTED",
        }),
      )
      .join("\n") + "\n",
  );
  writeFileSync(join(root, `review_${feature}.md`), "**Final verdict:** APPROVED\n");
  if (spec) {
    mkdirSync(join(cwd, "specs/demo"), { recursive: true });
    writeFileSync(
      join(cwd, "specs/demo/tasks.md"),
      "## E1 — Delivery\n### M1 — Milestone\n### M2 — Another\n",
    );
  }
}

function gate(line = opening): ReturnType<typeof evaluatePlanGate> {
  return evaluatePlanGate({
    cwd,
    tool_input: { subagent_type: "implementer", prompt: line },
  });
}
function ack(
  decision = "User explicitly authorizes continuation",
): ReturnType<typeof acknowledgePlanEscalation> {
  return acknowledgePlanEscalation(cwd, feature, opening, decision);
}
/** Captures the same scope files for deterministic pre/post-claim drift barriers. */
function binding(): escalation.EscalationBinding {
  const state = resolveStateRoot({ cwd, feature });
  return escalation.escalationBinding(
    state,
    feature,
    feature.endsWith("-e1") ? 3 : 2,
    opening,
    escalation.readRejectionHistory(state, feature),
    [
      escalation.readPlanSnapshot(join(root, `workplan_${feature}.json`)),
      escalation.readPlanSnapshot(join(cwd, "navori.config.json")),
      ...(feature.endsWith("-e1")
        ? [escalation.readPlanSnapshot(join(cwd, "specs/demo/tasks.md"))]
        : []),
    ],
  );
}

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-escalation-")));
  execFileSync("git", ["init", "-b", "main"], { cwd });
  root = join(cwd, ".navori/state/handoffs");
  mkdirSync(root, { recursive: true });
  fixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

describe("bound workflow escalation", () => {
  // Covers: R19
  it("does not turn a snapshot size violation into a configuration fail-open", () => {
    ack();
    appendFileSync(join(cwd, "navori.config.json"), " ".repeat(4 * 1024 * 1024));
    expect(gate().decision).toBe("deny");
    expect(() => ack()).toThrow();
  });
  // Covers: R19
  it.each([false, true])(
    "keeps level2/spec-level3 denied without ack, allows once, preserves history and review (spec=%s)",
    (spec) => {
      fixture(spec);
      const log = join(root, `workplan_${feature}.gate.jsonl`),
        review = join(root, `review_${feature}.md`);
      const original = readFileSync(log, "utf8"),
        originalReview = readFileSync(review, "utf8");
      expect(gate().decision).toBe("deny");
      expect(ack().status).toBe("acknowledged");
      expect(ack("Changed user wording").status).toBe("acknowledged");
      expect(gate().decision).toBe("allow");
      expect(gate().decision).toBe("deny");
      expect(ack().status).toBe("consumed");
      expect(readFileSync(log, "utf8")).toBe(original);
      expect(readFileSync(review, "utf8")).toBe(originalReview);
    },
  );

  // Covers: R19
  it.each(["plan", "review", "log", "tasks", "opening", "checkout"])(
    "denies %s drift after acknowledgement",
    (kind) => {
      fixture(true);
      ack();
      if (kind === "opening") {
        expect(gate("spec: demo E1 M2").decision).toBe("deny");
        return;
      }
      if (kind === "checkout") {
        const other = realpathSync(mkdtempSync(join(tmpdir(), "navori-escalation-other-")));
        execFileSync("git", ["init", "-b", "main"], { cwd: other });
        expect(
          evaluatePlanGate({
            cwd: other,
            tool_input: { subagent_type: "implementer", prompt: opening },
          }).dispatch,
        ).toBeUndefined();
        const changed = { ...binding(), cwd: other };
        expect(() => escalation.requireAcknowledgement(changed)).toThrow();
        rmSync(other, { recursive: true, force: true });
        return;
      }
      const file =
        kind === "tasks"
          ? join(cwd, "specs/demo/tasks.md")
          : kind === "plan"
            ? join(root, `workplan_${feature}.json`)
            : kind === "review"
              ? join(root, `review_${feature}.md`)
              : join(root, `workplan_${feature}.gate.jsonl`);
      appendFileSync(
        file,
        kind === "log"
          ? JSON.stringify({
              ts: "2026-10-14T00:00:00Z",
              reviewHash: "c".repeat(64),
              verdict: "CHANGES_REQUESTED",
            }) + "\n"
          : "\n",
      );
      expect(gate().decision).toBe("deny");
    },
  );

  // Covers: R19
  it("cannot regenerate a consumed epoch through changed plan/opening/decision", () => {
    ack();
    expect(gate().decision).toBe("allow");
    appendFileSync(join(root, `workplan_${feature}.json`), "\n");
    expect(ack("another decision").status).toBe("consumed");
    expect(gate().decision).toBe("deny");
  });

  // Covers: R19
  it("requires another explicit acknowledgement for a genuinely new rejection", () => {
    ack();
    expect(gate().decision).toBe("allow");
    writeFileSync(
      join(root, `review_${feature}.md`),
      "**Final verdict:** CHANGES_REQUESTED\nnew rejection\n",
    );
    expect(gate().decision).toBe("deny");
    expect(ack("User escalated the new rejection").status).toBe("acknowledged");
    expect(gate().decision).toBe("allow");
    expect(readFileSync(join(root, `review_${feature}.md`), "utf8")).toContain("CHANGES_REQUESTED");
  });

  // Covers: R19
  it.each([
    "{bad}\n",
    '{"reviewHash":"one"}\n',
    '{"ts":"2026-10-14T00:00:00Z","reviewHash":"' + "a".repeat(64) + '","verdict":"APPROVED"}\n',
    '{"truncated":',
    "x".repeat(1024 * 1024 + 1),
  ])("denies malformed/incomplete/oversized history without rewriting it", (bad) => {
    const file = join(root, `workplan_${feature}.gate.jsonl`);
    appendFileSync(file, bad);
    const original = readFileSync(file, "utf8");
    expect(gate().decision).toBe("deny");
    expect(() => ack()).toThrow();
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  // Covers: R19
  it("denies unreadable/non-file history rather than lowering the count", () => {
    const file = join(root, `workplan_${feature}.gate.jsonl`);
    rmSync(file);
    mkdirSync(file);
    expect(gate().decision).toBe("deny");
    expect(() => ack()).toThrow();
  });

  // Covers: R19
  it.each(
    ["before", "after"].flatMap((moment) =>
      ["plan", "review", "log", "tasks", "config"].map((input) => [moment, input]),
    ),
  )("denies %s-claim %s drift and burns only an already claimed attempt", (moment, input) => {
    fixture(true);
    const captured = binding();
    escalation.acknowledgeEscalation(captured, "User continuation");
    let checks = 0;
    const drift = (): boolean => {
      checks++;
      if (checks === (moment === "before" ? 1 : 2)) {
        const file =
          input === "tasks"
            ? join(cwd, "specs/demo/tasks.md")
            : input === "config"
              ? join(cwd, "navori.config.json")
              : join(
                  root,
                  input === "plan"
                    ? `workplan_${feature}.json`
                    : input === "log"
                      ? `workplan_${feature}.gate.jsonl`
                      : `review_${feature}.md`,
                );
        appendFileSync(file, "\n");
      }
      return true;
    };
    expect(() => escalation.consumeEscalation(captured, drift)).toThrow();
    if (moment === "after")
      expect(() => escalation.requireAcknowledgement(captured)).toThrow("consumed");
    else expect(() => escalation.requireAcknowledgement(captured)).not.toThrow();
  });

  // Covers: R19
  it("preserves a replaced dispatch marker and denies after claim", () => {
    const captured = binding();
    escalation.acknowledgeEscalation(captured, "User continuation");
    const marker = join(root, "dispatch_demo.json");
    writeFileSync(marker, "original");
    let reads = 0;
    expect(() =>
      escalation.consumeEscalation(captured, () => {
        if (++reads === 2) writeFileSync(marker, "replacement");
        return readFileSync(marker, "utf8") === "original";
      }),
    ).toThrow();
    expect(readFileSync(marker, "utf8")).toBe("replacement");
    expect(() => escalation.requireAcknowledgement(captured)).toThrow("consumed");
  });

  // Covers: R19
  it.each(["missing", "stale", "malformed", "foreign", "multiple"])(
    "does not consume acknowledgement on normal %s Codex dispatch denial",
    (kind) => {
      ack();
      const file = join(root, "dispatch_demo.json");
      const marker = {
        feature,
        opening,
        createdAt: new Date(kind === "stale" ? Date.now() - 660000 : Date.now()).toISOString(),
      };
      if (kind !== "missing")
        writeFileSync(
          file,
          kind === "malformed"
            ? "{"
            : JSON.stringify({
                ...marker,
                ...(kind === "foreign" ? { feature: "other" } : {}),
              }),
        );
      if (kind === "multiple")
        writeFileSync(
          join(root, "dispatch_other.json"),
          JSON.stringify({ ...marker, feature: "other" }),
        );
      expect(
        evaluatePlanGate({
          cwd,
          tool_input: {
            agent_type: "implementer",
            message: "gAAAAABencryption",
          },
        }).decision,
      ).toBe("deny");
      expect(ack().status).toBe("acknowledged");
      if (kind !== "missing") expect(existsSync(file)).toBe(true);
    },
  );

  // Covers: R19
  it("allows at most one of two competing OS processes", async () => {
    ack();
    const module = resolve(import.meta.dirname, "../gate.ts");
    const script = `import {evaluatePlanGate} from ${JSON.stringify(module)}; process.stdout.write(evaluatePlanGate({cwd:process.argv[1],tool_input:{subagent_type:'implementer',prompt:'workplan: demo'}}).decision);`;
    const run = (): Promise<string> =>
      new Promise((accept, reject) => {
        const child = spawn("bun", ["-e", script, cwd], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        let output = "",
          errors = "";
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          errors += chunk.toString();
        });
        child.on("error", reject);
        child.on("close", (code: number | null) => {
          if (code !== 0) reject(new Error(errors));
          else accept(output);
        });
      });
    expect((await Promise.all([run(), run()])).sort()).toEqual(["allow", "deny"]);
  });
});
