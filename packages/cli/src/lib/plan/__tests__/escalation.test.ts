import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
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

vi.mock(import("node:fs"), { spy: true });
const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");

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
  // Module-factory spies retain implementations across restoreAllMocks; reset their delegates.
  vi.mocked(fs.fsyncSync).mockImplementation(actualFs.fsyncSync);
  vi.mocked(fs.linkSync).mockImplementation(actualFs.linkSync);
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

/** Uses direct library snapshots consistently; fixture ids never represent real approvals. */
function spent(): escalation.EscalationInspection {
  const current = binding();
  escalation.acknowledgeEscalation(current, "fixture approval");
  escalation.consumeEscalation(current, () => true);
  return escalation.inspectEscalation(current);
}
function request(
  info: escalation.EscalationInspection,
  authorizationId = "fixture-1",
): escalation.ContinuationRequest {
  return {
    continueAfter: info.eligiblePredecessor!,
    authorizationId,
    snapshot: info.currentSnapshot,
  };
}
function retained(): Record<string, string> {
  return Object.fromEntries(
    fs.readdirSync(root).map((name) => [name, readFileSync(join(root, name)).toString("base64")]),
  );
}

describe("explicit immutable continuations", () => {
  it("uses canonical domain-separated snapshots, preserves legacy bytes, and never renews implicitly", () => {
    const info = spent(),
      original = retained(),
      current = binding();
    expect(info.currentSnapshot).toBe(
      createHash("sha256")
        .update(JSON.stringify(["plan-snapshot-v1", current]))
        .digest("hex"),
    );
    const input = request(info);
    const first = escalation.continueEscalation(current, "fixture approval", input);
    const published = retained();
    expect(first.status).toBe("acknowledged");
    const outstanding = escalation.inspectEscalation(current);
    expect(outstanding.terminal).toMatchObject({
      reference: first.reference,
      ordinal: 1,
      status: "unconsumed",
      authorizationId: "fixture-1",
      predecessor: info.terminal.reference,
    });
    expect(outstanding.eligiblePredecessor).toBeUndefined();
    expect(escalation.inspectEscalation(current)).toEqual(outstanding);
    expect(retained()).toEqual(published);
    for (const [path, bytes] of Object.entries(original)) expect(published[path]).toBe(bytes);
    expect(escalation.continueEscalation(current, "fixture approval", input)).toEqual(first);
    expect(() => escalation.continueEscalation(current, "changed", input)).toThrow("conflict");
    escalation.consumeEscalation(current, () => true);
    const secondInfo = escalation.inspectEscalation(current);
    expect(secondInfo.terminal.status).toBe("consumed");
    expect(escalation.continueEscalation(current, "fixture approval", input).status).toBe(
      "consumed",
    );
    expect(() =>
      escalation.continueEscalation(current, "fixture approval", request(secondInfo)),
    ).toThrow("already used");
    escalation.continueEscalation(
      current,
      "fixture next approval",
      request(secondInfo, "fixture-2"),
    );
    expect(escalation.continueEscalation(current, "fixture approval", input).reference).toBe(
      first.reference,
    );
    expect(escalation.acknowledgeEscalation(current, "incidental wording").status).toBe("consumed");
    expect(escalation.inspectEscalation(current).terminal.ordinal).toBe(2);
  });

  it.each(["a", "ab", "", "bc"])(
    "refuses valid historical-set rollback %s before fast paths or producers",
    (letters) => {
      const log = join(root, `workplan_${feature}.gate.jsonl`);
      appendFileSync(
        log,
        JSON.stringify({
          ts: "2026-10-14T00:00:00Z",
          reviewHash: "c".repeat(64),
          verdict: "CHANGES_REQUESTED",
        }) + "\n",
      );
      spent();
      const lines = readFileSync(log, "utf8").trim().split("\n");
      writeFileSync(
        log,
        letters
          .split("")
          .map((letter) => lines[letter === "a" ? 0 : 1])
          .join("\n") + (letters ? "\n" : ""),
      );
      if (letters === "bc")
        writeFileSync(
          log,
          readFileSync(log, "utf8")
            .replaceAll("a".repeat(64), "c".repeat(64))
            .replaceAll("b".repeat(64), "c".repeat(64)),
        );
      const original = retained();
      expect(gate().decision).toBe("deny");
      expect(() => ack()).toThrow("rollback");
      expect(() => acknowledgePlanEscalation(cwd, feature, opening, "", { inspect: true })).toThrow(
        "rollback",
      );
      expect(retained()).toEqual(original);
    },
  );

  it("permits genuine additions without inheritance and ignores valid other-feature history", () => {
    spent();
    const current = binding();
    const other = {
      ...current,
      feature: "other",
      opening: "workplan: other",
      hashes: ["d".repeat(64), "e".repeat(64)],
    };
    escalation.acknowledgeEscalation(other, "fixture other approval");
    appendFileSync(
      join(root, `workplan_${feature}.gate.jsonl`),
      JSON.stringify({
        ts: "2026-10-14T00:00:00Z",
        reviewHash: "c".repeat(64),
        verdict: "CHANGES_REQUESTED",
      }) + "\n",
    );
    expect(gate().decision).toBe("deny");
    expect(ack().status).toBe("acknowledged");
    expect(gate().decision).toBe("allow");
  });

  it("shows current/stored drift and leaves stale outstanding grants unavailable for retirement", () => {
    const info = spent();
    escalation.continueEscalation(binding(), "fixture approval", request(info));
    appendFileSync(join(root, `workplan_${feature}.json`), "\n");
    const drifted = escalation.inspectEscalation(binding());
    expect(drifted.currentSnapshot).not.toBe(drifted.terminal.storedSnapshot);
    expect(drifted.eligiblePredecessor).toBeUndefined();
    expect(() => escalation.consumeEscalation(binding(), () => true)).toThrow("binding changed");
    expect(() =>
      escalation.continueEscalation(binding(), "fixture approval", request(info)),
    ).toThrow("snapshot");
  });

  it.each(["../escape", "", "a".repeat(129), "with space"])(
    "rejects invalid operator id %s",
    (id) => {
      const info = spent(),
        original = retained();
      expect(() =>
        escalation.continueEscalation(binding(), "fixture approval", request(info, id)),
      ).toThrow();
      expect(retained()).toEqual(original);
    },
  );

  it("enforces 32 individually authorized successors without renewing or changing the terminal", () => {
    let info = spent();
    // Grant publication does not change scope files: reuse the same validated snapshot.
    const current = binding();
    for (let index = 1; index <= 32; index++) {
      escalation.continueEscalation(current, "fixture approval", request(info, `fixture-${index}`));
      escalation.consumeEscalation(current, () => true);
      info = escalation.inspectEscalation(current);
      expect(info.terminal.ordinal).toBe(index);
    }
    const original = retained();
    expect(() =>
      escalation.continueEscalation(current, "fixture approval", {
        ...request(info, "fixture-33"),
        continueAfter: info.terminal.reference,
      }),
    ).toThrow();
    expect(retained()).toEqual(original);
  });

  it.each([
    "invalid-utf8",
    "directory",
    "orphan",
    "bad-burn",
    "oversized",
    "wrong-version",
    "wrong-ordinal",
    "wrong-epoch",
    "wrong-kind",
  ])("denies %s state without fallback or repair", (kind) => {
    const info = spent();
    const result = escalation.continueEscalation(binding(), "fixture approval", request(info));
    const child = fs.readdirSync(root).find((name) => name.startsWith("escalation_continuation_"))!;
    const path = join(root, child);
    if (kind === "invalid-utf8") writeFileSync(path, Buffer.from([0xff]));
    else if (kind === "directory") {
      rmSync(path);
      mkdirSync(path);
    } else if (kind === "orphan") {
      fs.renameSync(path, join(root, `escalation_continuation_${"f".repeat(64)}.json`));
    } else if (kind === "bad-burn")
      writeFileSync(join(root, `escalation_burn_${result.reference.split(":")[1]}.json`), "{}");
    else if (kind === "oversized") appendFileSync(path, " ".repeat(65536));
    else {
      const record: Record<string, unknown> = JSON.parse(readFileSync(path, "utf8"));
      record[kind.slice(6)] = kind === "wrong-version" ? 2 : kind === "wrong-ordinal" ? 2 : "wrong";
      writeFileSync(path, JSON.stringify(record));
    }
    expect(() => escalation.inspectEscalation(binding())).toThrow();
    expect(gate().decision).toBe("deny");
  });

  it("rejects unattributable candidates and bounded enumeration overflow before ordinary fast paths", () => {
    const log = join(root, `workplan_${feature}.gate.jsonl`);
    writeFileSync(log, "");
    const path = join(root, `escalation_${"f".repeat(64)}.json`);
    writeFileSync(path, "{}");
    expect(gate().decision).toBe("deny");
    rmSync(path);
    for (let index = 0; index < 513; index++)
      writeFileSync(join(root, `escalation_private_${String(index).padStart(36, "0")}.tmp`), "");
    // Inert private temporaries do not constitute grants, but the overall directory is bounded.
    expect(gate().decision).toBe("allow");
    for (let index = 0; index < 8192; index++) writeFileSync(join(root, `unrelated-${index}`), "");
    expect(gate().decision).toBe("deny");
  });

  it.each([65536, 65537])("enforces the complete record byte boundary at %i bytes", (size) => {
    const info = spent();
    const current = binding();
    const record = {
      version: 1,
      kind: "plan-continuation",
      epoch: createHash("sha256")
        .update(JSON.stringify([current.cwd, current.feature, current.hashes]))
        .digest("hex"),
      ordinal: 1,
      predecessor: info.terminal.reference,
      authorizationId: "fixture-1",
      decision: "fixture approval",
      binding: current,
      snapshot: info.currentSnapshot,
    };
    const padding = size - Buffer.byteLength(`${JSON.stringify(record)}\n`);
    const padded = { ...current, opening: current.opening + " ".repeat(padding) };
    const input = { ...request(info), snapshot: escalation.snapshotDigest(padded) };
    if (size === 65536) {
      expect(escalation.continueEscalation(padded, "fixture approval", input).status).toBe(
        "acknowledged",
      );
      const file = fs
        .readdirSync(root)
        .find((name) => name.startsWith("escalation_continuation_"))!;
      expect(readFileSync(join(root, file)).length).toBe(size);
    } else {
      const original = retained();
      expect(() => escalation.continueEscalation(padded, "fixture approval", input)).toThrow(
        "oversized",
      );
      expect(retained()).toEqual(original);
    }
  });

  it.each([0, 1])(
    "accounts for every legacy, child and burn byte at the cumulative limit +%i",
    (extra) => {
      spent();
      const current = binding();
      const legacy = fs
        .readdirSync(root)
        .find((name) => /^escalation_[a-f0-9]{64}\.json$/.test(name))!;
      const info = escalation.inspectEscalation(current);
      const child = {
        version: 1,
        kind: "plan-continuation",
        epoch: createHash("sha256")
          .update(JSON.stringify([current.cwd, current.feature, current.hashes]))
          .digest("hex"),
        ordinal: 1,
        predecessor: info.terminal.reference,
        authorizationId: "fixture-1",
        decision: "fixture approval",
        binding: current,
        snapshot: info.currentSnapshot,
      };
      const burn = {
        version: 1,
        kind: "plan-continuation-burn",
        reference: `grant:${"0".repeat(64)}`,
        snapshot: info.currentSnapshot,
      };
      const legacyBytes = fs
        .readdirSync(root)
        .filter((name) => /^escalation_[a-f0-9]{64}\.(json|consumed)$/.test(name))
        .reduce((total, name) => total + readFileSync(join(root, name)).length, 0);
      const padding =
        2 * 1024 * 1024 -
        legacyBytes -
        Buffer.byteLength(`${JSON.stringify(child)}\n`) -
        Buffer.byteLength(`${JSON.stringify(burn)}\n`) +
        extra;
      appendFileSync(join(root, legacy), " ".repeat(padding));
      // Legacy padding changes the base reference, but never its fixed-width serialized length.
      const padded = escalation.inspectEscalation(current);
      escalation.continueEscalation(current, "fixture approval", request(padded));
      if (extra) {
        const original = retained();
        expect(() => escalation.consumeEscalation(current, () => true)).toThrow(
          "oversized escalation lineage",
        );
        expect(retained()).toEqual(original);
        expect(escalation.inspectEscalation(current).terminal.status).toBe("unconsumed");
      } else {
        escalation.consumeEscalation(current, () => true);
        const names = fs.readdirSync(root).filter((name) => name.startsWith("escalation_"));
        expect(
          names.reduce((total, name) => total + readFileSync(join(root, name)).length, 0),
        ).toBe(2 * 1024 * 1024);
        expect(escalation.inspectEscalation(current).terminal.status).toBe("consumed");
        const marker = names.find((name) => name.startsWith("escalation_burn_"))!;
        appendFileSync(join(root, marker), " ");
        expect(() => escalation.inspectEscalation(current)).toThrow("oversized escalation lineage");
      }
    },
  );

  it.each([
    "predecessor",
    "snapshot",
    "binding-epoch",
    "noncanonical",
    "unknown-field",
    "legacy-burn",
    "burn-reference",
    "burn-snapshot",
    "reused-id",
    "unspent-parent",
  ])("rejects malformed ancestry %s without rewriting retained state", (kind) => {
    const info = spent(),
      current = binding();
    escalation.continueEscalation(current, "fixture approval", request(info));
    const childPath = join(
      root,
      fs.readdirSync(root).find((name) => name.startsWith("escalation_continuation_"))!,
    );
    if (kind.startsWith("burn-") || kind === "reused-id") {
      escalation.consumeEscalation(current, () => true);
      if (kind === "reused-id") {
        const next = escalation.inspectEscalation(current);
        escalation.continueEscalation(current, "fixture approval", request(next, "fixture-2"));
        const nextPath = join(
          root,
          `escalation_continuation_${next.terminal.reference.split(":")[1]}.json`,
        );
        const record: Record<string, unknown> = JSON.parse(readFileSync(nextPath, "utf8"));
        record.authorizationId = "fixture-1";
        writeFileSync(nextPath, JSON.stringify(record));
      } else {
        const marker = join(
          root,
          fs.readdirSync(root).find((name) => name.startsWith("escalation_burn_"))!,
        );
        const record: Record<string, unknown> = JSON.parse(readFileSync(marker, "utf8"));
        record[kind === "burn-reference" ? "reference" : "snapshot"] =
          kind === "burn-reference" ? `grant:${"f".repeat(64)}` : "f".repeat(64);
        writeFileSync(marker, JSON.stringify(record));
      }
    } else if (kind === "legacy-burn" || kind === "unspent-parent") {
      const marker = join(
        root,
        fs.readdirSync(root).find((name) => name.endsWith(".consumed"))!,
      );
      if (kind === "unspent-parent") rmSync(marker);
      else writeFileSync(marker, JSON.stringify({ ...current, opening: "workplan: wrong" }));
    } else {
      const record: Record<string, unknown> = JSON.parse(readFileSync(childPath, "utf8"));
      if (kind === "predecessor") record.predecessor = `grant:${"f".repeat(64)}`;
      else if (kind === "snapshot") record.snapshot = "f".repeat(64);
      else if (kind === "binding-epoch") record.binding = { ...current, feature: "wrong" };
      else if (kind === "noncanonical")
        record.binding = { ...current, hashes: [...current.hashes].reverse() };
      else record.unknown = true;
      writeFileSync(childPath, JSON.stringify(record));
    }
    const original = retained();
    expect(() => escalation.inspectEscalation(current)).toThrow();
    expect(() =>
      escalation.continueEscalation(current, "fixture approval", request(info)),
    ).toThrow();
    expect(() => escalation.consumeEscalation(current, () => true)).toThrow();
    expect(retained()).toEqual(original);
  });

  it("bounds candidate enumeration and treats malformed burns as spent-state ambiguity", () => {
    const state = resolveStateRoot({ cwd, feature });
    for (let index = 0; index < 512; index++) {
      const hash = index.toString(16).padStart(64, "0");
      writeFileSync(
        join(root, `escalation_burn_${hash}.json`),
        JSON.stringify({
          version: 1,
          kind: "plan-continuation-burn",
          reference: `grant:${hash}`,
          snapshot: "a".repeat(64),
        }),
      );
    }
    expect(() => escalation.readRejectionHistory(state, feature)).toThrow("orphan");
    writeFileSync(
      join(root, `escalation_burn_${"f".repeat(64)}.json`),
      JSON.stringify({
        version: 1,
        kind: "plan-continuation-burn",
        reference: `grant:${"f".repeat(64)}`,
        snapshot: "a".repeat(64),
      }),
    );
    expect(() => escalation.readRejectionHistory(state, feature)).toThrow("enumeration limit");
  });

  it("refuses unsupported no-replace storage without overwrite fallback", () => {
    const info = spent(),
      original = retained();
    vi.mocked(fs.linkSync).mockImplementation(() => {
      throw Object.assign(new Error("fixture unsupported storage"), { code: "ENOTSUP" });
    });
    expect(() =>
      escalation.continueEscalation(binding(), "fixture approval", request(info)),
    ).toThrow("unsupported storage");
    expect(retained()).toEqual(original);
  });

  it.each(["temp-fsync", "link-before", "link-after", "directory-fsync"])(
    "reconciles %s interruption without a partial published child or implicit retry",
    (barrier) => {
      const info = spent(),
        current = binding();
      const sync = actualFs.fsyncSync,
        link = actualFs.linkSync;
      if (barrier.startsWith("link"))
        vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
          if (barrier === "link-before") throw new Error("fixture interruption");
          link(from, to);
          throw new Error("fixture interruption");
        });
      else {
        let calls = 0;
        vi.spyOn(fs, "fsyncSync").mockImplementation((fd: number) => {
          if (++calls === (barrier === "temp-fsync" ? 1 : 2))
            throw new Error("fixture interruption");
          sync(fd);
        });
      }
      expect(() =>
        escalation.continueEscalation(current, "fixture approval", request(info)),
      ).toThrow();
      vi.restoreAllMocks();
      const inspected = escalation.inspectEscalation(current);
      expect(inspected.terminal.ordinal).toBe(
        barrier === "temp-fsync" || barrier === "link-before" ? 0 : 1,
      );
      if (inspected.terminal.ordinal === 1) expect(inspected.terminal.status).toBe("unconsumed");
      const original = retained();
      expect(escalation.inspectEscalation(current)).toEqual(inspected);
      expect(retained()).toEqual(original);
    },
  );

  it.each(["temp-fsync", "link-before", "link-after", "directory-fsync"])(
    "reconciles burn interruption at %s without rearming a published burn",
    (barrier) => {
      const info = spent(),
        current = binding();
      escalation.continueEscalation(current, "fixture approval", request(info));
      if (barrier.startsWith("link"))
        vi.mocked(fs.linkSync).mockImplementation((from, to) => {
          if (barrier === "link-before") throw new Error("fixture interruption");
          actualFs.linkSync(from, to);
          throw new Error("fixture interruption");
        });
      else {
        let calls = 0;
        vi.mocked(fs.fsyncSync).mockImplementation((fd: number) => {
          if (++calls === (barrier === "temp-fsync" ? 1 : 2))
            throw new Error("fixture interruption");
          actualFs.fsyncSync(fd);
        });
      }
      expect(() => escalation.consumeEscalation(current, () => true)).toThrow();
      vi.mocked(fs.linkSync).mockImplementation(actualFs.linkSync);
      vi.mocked(fs.fsyncSync).mockImplementation(actualFs.fsyncSync);
      const inspected = escalation.inspectEscalation(current);
      expect(inspected.terminal.status).toBe(
        barrier === "temp-fsync" || barrier === "link-before" ? "unconsumed" : "consumed",
      );
      const original = retained();
      expect(escalation.inspectEscalation(current)).toEqual(inspected);
      expect(retained()).toEqual(original);
      if (inspected.terminal.status === "consumed")
        expect(() => escalation.consumeEscalation(current, () => true)).toThrow("consumed");
    },
  );

  it.each(["config", "workplan", "tasks", "review", "log"])(
    "denies %s drift before publication, before burn and after burn at deterministic barriers",
    (file) => {
      fixture(true);
      const info = spent(),
        current = binding();
      const path =
        file === "config"
          ? join(cwd, "navori.config.json")
          : file === "tasks"
            ? join(cwd, "specs/demo/tasks.md")
            : join(
                root,
                file === "workplan"
                  ? `workplan_${feature}.json`
                  : file === "review"
                    ? `review_${feature}.md`
                    : `workplan_${feature}.gate.jsonl`,
              );
      const original = readFileSync(path);
      vi.mocked(fs.fsyncSync).mockImplementation((fd: number) => {
        actualFs.fsyncSync(fd);
        appendFileSync(path, "\n");
      });
      expect(() =>
        escalation.continueEscalation(current, "fixture approval", request(info)),
      ).toThrow("changed before publication");
      vi.mocked(fs.fsyncSync).mockImplementation(actualFs.fsyncSync);
      expect(fs.readdirSync(root).some((name) => name.startsWith("escalation_continuation_"))).toBe(
        false,
      );
      writeFileSync(path, original);
      vi.mocked(fs.linkSync).mockImplementation((from, to) => {
        actualFs.linkSync(from, to);
        appendFileSync(path, "\n");
      });
      expect(() =>
        escalation.continueEscalation(current, "fixture approval", request(info)),
      ).toThrow("changed after publication");
      vi.mocked(fs.linkSync).mockImplementation(actualFs.linkSync);
      expect(escalation.inspectEscalation(binding()).terminal.status).toBe("unconsumed");
      writeFileSync(path, original);
      // Exact replay reconciles the retained publication, never issues a second grant.
      escalation.continueEscalation(current, "fixture approval", request(info));
      expect(() =>
        escalation.consumeEscalation(current, () => {
          appendFileSync(path, "\n");
          return true;
        }),
      ).toThrow("changed before consumption");
      writeFileSync(path, original);
      expect(escalation.inspectEscalation(current).terminal.status).toBe("unconsumed");
      let publicationChecks = 0;
      expect(() =>
        escalation.consumeEscalation(current, () => {
          if (++publicationChecks === 2) appendFileSync(path, "\n");
          return true;
        }),
      ).toThrow("changed before publication");
      writeFileSync(path, original);
      expect(escalation.inspectEscalation(current).terminal.status).toBe("unconsumed");
      let calls = 0;
      expect(() =>
        escalation.consumeEscalation(current, () => {
          if (++calls === 3) appendFileSync(path, "\n");
          return true;
        }),
      ).toThrow("changed after consumption");
      const drifted = escalation.inspectEscalation(binding());
      expect(drifted.terminal.status).toBe("consumed");
      expect(drifted.currentSnapshot).not.toBe(drifted.terminal.storedSnapshot);
    },
  );

  it("never re-arms a child after a burn publication loses its response", () => {
    const info = spent(),
      current = binding();
    escalation.continueEscalation(current, "fixture approval", request(info));
    const link = actualFs.linkSync;
    vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
      link(from, to);
      throw new Error("fixture lost response");
    });
    expect(() => escalation.consumeEscalation(current, () => true)).toThrow();
    vi.restoreAllMocks();
    expect(escalation.inspectEscalation(current).terminal.status).toBe("consumed");
    expect(() => escalation.consumeEscalation(current, () => true)).toThrow("consumed");
  });

  it.each([1, 2])(
    "pins the validated M1 grant when an independent process authorizes M2 at comparison %i",
    (barrier) => {
      fixture(true);
      const info = spent(),
        current = binding(),
        next = { ...current, opening: "spec: demo E1 M2" };
      const first = escalation.continueEscalation(current, "fixture approval", request(info));
      const module = resolve(import.meta.dirname, "../escalation.ts");
      const script = `import * as e from ${JSON.stringify(module)};
        const [current,next]=JSON.parse(process.argv[1]);
        e.consumeEscalation(current,()=>true);
        const info=e.inspectEscalation(next);
        const child=e.continueEscalation(next,'fixture M2 approval',{
          continueAfter:info.eligiblePredecessor,authorizationId:'fixture-2',snapshot:info.currentSnapshot
        });
        process.stdout.write(JSON.stringify(child));`;
      let calls = 0,
        successor = "";
      let afterWinner: Record<string, string> = {};
      expect(() =>
        escalation.consumeEscalation(current, () => {
          if (++calls === barrier) {
            const result: { reference: string } = JSON.parse(
              execFileSync("bun", ["-e", script, JSON.stringify([current, next])], {
                encoding: "utf8",
              }),
            );
            successor = result.reference;
            // The caller may already own a private burn temporary at comparison 2.
            afterWinner = Object.fromEntries(
              Object.entries(retained()).filter(
                ([name]) => !name.startsWith("escalation_private_"),
              ),
            );
          }
          return true;
        }),
      ).toThrow("already consumed");
      expect(successor).not.toBe(first.reference);
      expect(retained()).toEqual(afterWinner);
      const inspected = escalation.inspectEscalation(next);
      expect(inspected.terminal).toMatchObject({
        reference: successor,
        ordinal: 2,
        predecessor: first.reference,
        status: "unconsumed",
        storedSnapshot: escalation.snapshotDigest(next),
      });
      expect(inspected.currentSnapshot).toBe(inspected.terminal.storedSnapshot);
      expect(() => escalation.requireAcknowledgement(next)).not.toThrow();
      expect(() => escalation.requireAcknowledgement(current)).toThrow("binding changed");
      expect(retained()).toEqual(afterWinner);
    },
  );

  it.each([false, true])(
    "has one successor and one consumer winner across independent ready-barrier processes (identical=%s)",
    async (identical) => {
      const info = spent(),
        current = binding();
      const module = resolve(import.meta.dirname, "../escalation.ts");
      const dispatchModule = resolve(import.meta.dirname, "../gate.ts");
      const marker = join(root, "dispatch-fixture");
      const script = `import * as e from ${JSON.stringify(module)}; import {claimDispatch} from ${JSON.stringify(dispatchModule)}; import {appendFileSync} from "node:fs"; const [binding,request,mode]=JSON.parse(process.argv[1]); process.stdout.write('READY\\n'); for await (const chunk of process.stdin) { try { if(mode==='produce') { const r=e.continueEscalation(binding,'fixture approval',request); process.stdout.write(r.status); } else if(mode==='dispatch') { const denied=claimDispatch(${JSON.stringify(marker)},'fixture',0,(unchanged)=>{appendFileSync(${JSON.stringify(marker + ".burns")},'1');e.consumeEscalation(binding,unchanged);});process.stdout.write(denied?'deny':'allow'); } else { e.consumeEscalation(binding,()=>true); process.stdout.write('allow'); } } catch { process.stdout.write('deny'); } break; }`;
      const start = (
        input: escalation.ContinuationRequest,
        mode: string,
      ): { ready: Promise<void>; result: Promise<string>; release: () => void } => {
        const child = spawn("bun", ["-e", script, JSON.stringify([current, input, mode])], {
          stdio: ["pipe", "pipe", "pipe"],
        });
        let output = "",
          errors = "";
        let ready: () => void = () => {};
        const readiness = new Promise<void>((accept) => {
          ready = accept;
        });
        const result = new Promise<string>((accept, reject) => {
          child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes("READY\n")) ready();
          });
          child.stderr.on("data", (chunk: Buffer) => {
            errors += chunk.toString();
          });
          child.on("error", reject);
          child.on("close", (code: number | null) =>
            code === 0 ? accept(output.replace("READY\n", "")) : reject(new Error(errors)),
          );
        });
        return { ready: readiness, result, release: () => child.stdin.end("go") };
      };
      const first = start(request(info), "produce"),
        second = start(request(info, identical ? "fixture-1" : "fixture-competitor"), "produce");
      await Promise.all([first.ready, second.ready]);
      first.release();
      second.release();
      expect((await Promise.all([first.result, second.result])).sort()).toEqual([
        "acknowledged",
        identical ? "acknowledged" : "deny",
      ]);
      expect(escalation.inspectEscalation(current).terminal.ordinal).toBe(1);
      const a = start(request(info), "consume"),
        b = start(request(info), "consume");
      await Promise.all([a.ready, b.ready]);
      a.release();
      b.release();
      expect((await Promise.all([a.result, b.result])).sort()).toEqual(["allow", "deny"]);
      const next = escalation.inspectEscalation(current);
      escalation.continueEscalation(
        current,
        "fixture dispatch approval",
        request(next, "fixture-dispatch"),
      );
      writeFileSync(marker, "fixture");
      const x = start(request(next), "dispatch"),
        y = start(request(next), "dispatch");
      await Promise.all([x.ready, y.ready]);
      x.release();
      y.release();
      expect((await Promise.all([x.result, y.result])).sort()).toEqual(["allow", "deny"]);
      expect(readFileSync(marker + ".burns", "utf8")).toBe("1");
      expect(escalation.inspectEscalation(current).terminal.status).toBe("consumed");
    },
  );
});

describe("strict reset history compatibility", () => {
  const reset = {
    ts: "2026-10-14T01:00:00Z",
    kind: "reset",
    approvedBy: "user",
    reason: "fixture new review round",
    rejectionsBefore: 2,
  };
  const logPath = (): string => join(root, `workplan_${feature}.gate.jsonl`);
  const appendReset = (): void => appendFileSync(logPath(), JSON.stringify(reset) + "\n");

  // Covers: R9, R19
  it("keeps complete legacy identity, deduplicates old reviews and projects only new active rejections", () => {
    const state = resolveStateRoot({ cwd, feature });
    const original = escalation.readRejectionHistory(state, feature);
    const old = binding();
    escalation.acknowledgeEscalation(old, "fixture approval");
    const acknowledgement = retained();
    appendReset();
    appendFileSync(logPath(), (original.files[0]!.content ?? "").split("\n")[0] + "\n");
    const history = escalation.readRejectionHistory(state, feature);
    expect(history.hashes).toEqual(original.hashes);
    expect(history.activeTimestamps).toEqual([]);
    expect(gate().decision).toBe("allow");
    expect(gate().decision).toBe("allow");
    expect(() => escalation.consumeEscalation(old, () => true)).toThrow("changed");
    for (const [name, bytes] of Object.entries(acknowledgement))
      if (name.startsWith("escalation_")) expect(retained()[name]).toBe(bytes);
    expect(() => escalation.requireAcknowledgement(binding())).toThrow("binding changed");
    writeFileSync(join(root, `review_${feature}.md`), "**Final verdict:** CHANGES_REQUESTED\nnew1");
    expect(gate().decision).toBe("allow");
    expect(gate().decision).toBe("allow");
    writeFileSync(join(root, `review_${feature}.md`), "**Final verdict:** CHANGES_REQUESTED\nnew2");
    expect(gate().decision).toBe("deny");
    ack();
    expect(gate().decision).toBe("allow");
    expect(gate().decision).toBe("deny");
  });

  // Covers: R9, R19
  it("preserves consumed legacy references across reset and supports explicit reset-bearing continuations", () => {
    const before = spent(),
      bytes = retained();
    appendReset();
    const current = binding(),
      after = escalation.inspectEscalation(current);
    expect(after.terminal.reference).toBe(before.terminal.reference);
    expect(after.terminal.status).toBe("consumed");
    expect(after.currentSnapshot).not.toBe(before.currentSnapshot);
    const continued = escalation.continueEscalation(current, "fixture approval", request(after));
    expect(escalation.continueEscalation(current, "fixture approval", request(after))).toEqual(
      continued,
    );
    escalation.consumeEscalation(current, () => true);
    expect(escalation.inspectEscalation(current).terminal.status).toBe("consumed");
    expect(() => escalation.consumeEscalation(current, () => true)).toThrow("consumed");
    for (const [name, value] of Object.entries(bytes))
      if (name.startsWith("escalation_")) expect(retained()[name]).toBe(value);
  });

  // Covers: R9, R19
  it("reconciles missing historical evidence after reset even with zero active rejections", () => {
    spent();
    const lines = readFileSync(logPath(), "utf8").trim().split("\n");
    writeFileSync(logPath(), lines[0] + "\n" + JSON.stringify(reset) + "\n");
    const before = retained();
    expect(gate().decision).toBe("deny");
    expect(gate().reason).toContain("rollback");
    expect(retained()).toEqual(before);
  });

  // Covers: R9, R19
  it.each([
    { ...reset, kind: "unknown" },
    { ...reset, approvedBy: "agent" },
    { ...reset, reason: " " },
    { ...reset, rejectionsBefore: 1 },
    { ...reset, rejectionsBefore: 2.5 },
    { ...reset, reason: "x".repeat(4097) },
    { ...reset, ts: "yesterday" },
    { ...reset, approvedBy: undefined },
    { ...reset, reason: undefined },
    { ...reset, rejectionsBefore: undefined },
    { ...reset, reviewHash: "a".repeat(64), verdict: "CHANGES_REQUESTED" },
    { ts: reset.ts, reviewHash: "h1", verdict: "CHANGES_REQUESTED" },
  ])("rejects invalid or hybrid history %j without writes", (invalid) => {
    appendFileSync(logPath(), JSON.stringify(reset) + "\n" + JSON.stringify(invalid) + "\n");
    const before = retained();
    expect(gate().decision).toBe("deny");
    expect(() => ack()).toThrow();
    expect(retained()).toEqual(before);
  });

  // Covers: R9, R19
  it.each(["{\n", "{", JSON.stringify(reset)])(
    "rejects corruption before/after reset %j",
    (bad) => {
      for (const text of [bad + JSON.stringify(reset) + "\n", JSON.stringify(reset) + "\n" + bad]) {
        writeFileSync(logPath(), text);
        const before = retained();
        expect(gate().decision).toBe("deny");
        expect(retained()).toEqual(before);
      }
    },
  );
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
