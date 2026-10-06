import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStateRoot } from "../../primitives/state-root.ts";
import {
  computeWorktreeTree,
  fingerprintTree,
  readEvidenceLog,
  readHead,
  validateEvidence,
  type EvidenceLine,
  type DeliveryEvidenceBinding,
} from "../evidence.ts";

let cwd: string;
const COMMAND = "bun test x";

function git(...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), "navori-evidence-")));
  git("init", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(cwd, "a.txt"), "a\n");
  git("add", "-A");
  git("commit", "-m", "init");
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function logLine(overrides: Partial<EvidenceLine> = {}): EvidenceLine {
  return {
    ts: "2026-09-30T10:00:00Z",
    feature: "demo",
    id: "A1",
    command: COMMAND,
    tree: cwd,
    cwd,
    head: readHead(cwd),
    worktreeTree: computeWorktreeTree(cwd) ?? "",
    dirty: false,
    ...overrides,
  };
}

function writeLog(lines: EvidenceLine[]): void {
  const dir = join(cwd, ".navori/state/handoffs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "workplan_demo.evidence.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

function validate(command = COMMAND) {
  return validateEvidence({
    root: resolveStateRoot({ cwd, feature: "demo" }),
    feature: "demo",
    id: "A1",
    command,
  });
}

/** A physical fixture stage, never a generic state/STATUS exclusion. */
function deliveryBinding(): DeliveryEvidenceBinding {
  const stagePath = "specs/_master/01-evidence";
  mkdirSync(join(cwd, stagePath), { recursive: true });
  writeFileSync(
    join(cwd, stagePath, "state.json"),
    JSON.stringify({ version: 2, workflow: "deliveries" }),
  );
  writeFileSync(join(cwd, stagePath, "STATUS.md"), "Derived lifecycle\n");
  return {
    policy: "deliveries-content-v1",
    authorityGeneration: 1,
    stagePath,
    sourceIdentity: "a".repeat(64),
    baselineIdentity: "b".repeat(64),
    queueIdentity: "c".repeat(64),
    qualifiedId: "P1.A1",
    criterionIdentity: "d".repeat(64),
  };
}

describe("delivery producer-bound fingerprint policy", () => {
  // Covers: R7, R8, R9
  it("preserves original delivery HEAD as provenance while leaving legacy validation HEAD-strict", () => {
    const binding = deliveryBinding();
    const fp = fingerprintTree(cwd, binding);
    if (!fp.ok) throw new Error(fp.reason);
    const original = readHead(cwd);
    writeLog([logLine({ deliveryBinding: binding, worktreeTree: fp.tree })]);
    git("commit", "--allow-empty", "-m", "identical code snapshot");
    const input = {
      root: resolveStateRoot({ cwd, feature: "demo" }),
      feature: "demo",
      id: "A1",
      command: COMMAND,
      deliveryBinding: binding,
    };
    const result = validateEvidence(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.evidence.head).toBe(original);
    writeLog([logLine({ head: original })]);
    expect(validate().ok).toBe(false);
    const { policy: _policy, ...partial } = binding;
    writeFileSync(
      join(cwd, ".navori/state/handoffs/workplan_demo.evidence.jsonl"),
      JSON.stringify({ ...logLine(), deliveryBinding: partial }) + "\n",
    );
    expect(validateEvidence(input).ok).toBe(false);
  });
  // Covers: R7, R8, R9
  it("keeps only this stage's lifecycle writes stable and leaves legacy fingerprints unchanged", () => {
    const binding = deliveryBinding();
    const before = fingerprintTree(cwd, binding);
    const legacy = fingerprintTree(cwd);
    writeFileSync(join(cwd, binding.stagePath, "state.json"), "updated lifecycle");
    writeFileSync(join(cwd, binding.stagePath, "STATUS.md"), "regenerated view");
    expect(fingerprintTree(cwd, binding)).toEqual(before);
    expect(fingerprintTree(cwd)).not.toEqual(legacy);
  });

  // Covers: R7, R8, R9
  it.each(["parts.json", "MASTER.md", "UX.md", "source.txt"])(
    "does not exclude %s from technical proof",
    (name: string) => {
      const binding = deliveryBinding();
      const path = join(cwd, binding.stagePath, name);
      writeFileSync(path, "reviewed definition");
      const before = fingerprintTree(cwd, binding);
      writeFileSync(path, "changed definition");
      expect(fingerprintTree(cwd, binding)).not.toEqual(before);
    },
  );

  // Covers: R7, R8, R9
  it.each(["state.json", "STATUS.md"])(
    "keeps neighboring stage %s and executable code in the fingerprint",
    (name: string) => {
      const binding = deliveryBinding();
      const neighbor = join(cwd, "specs/_master/02-neighbor");
      mkdirSync(neighbor, { recursive: true });
      writeFileSync(join(neighbor, name), "old");
      const before = fingerprintTree(cwd, binding);
      writeFileSync(join(neighbor, name), "new");
      const afterNeighbor = fingerprintTree(cwd, binding);
      expect(afterNeighbor).not.toEqual(before);
      writeFileSync(join(cwd, "a.txt"), "code changed");
      expect(fingerprintTree(cwd, binding)).not.toEqual(afterNeighbor);
    },
  );

  // Covers: R7, R8, R9
  it("rejects lexical traversal, physically aliased stages and redirected lifecycle files", () => {
    const binding = deliveryBinding();
    expect(fingerprintTree(cwd, { stagePath: "../outside" }).ok).toBe(false);
    symlinkSync(join(cwd, binding.stagePath), join(cwd, "alias"));
    expect(fingerprintTree(cwd, { stagePath: "alias" }).ok).toBe(false);
    rmSync(join(cwd, binding.stagePath, "state.json"));
    symlinkSync(join(cwd, "a.txt"), join(cwd, binding.stagePath, "state.json"));
    expect(fingerprintTree(cwd, binding).ok).toBe(false);
  });

  // Covers: R7, R8, R9
  it("requires the producer binding and rejects queue/criterion replacement despite stable lifecycle bytes", () => {
    const binding = deliveryBinding();
    const fingerprint = fingerprintTree(cwd, binding);
    expect(fingerprint.ok).toBe(true);
    if (!fingerprint.ok) throw new Error(fingerprint.reason);
    writeLog([logLine({ worktreeTree: fingerprint.tree, deliveryBinding: binding })]);
    const input = {
      root: resolveStateRoot({ cwd, feature: "demo" }),
      feature: "demo",
      id: "A1",
      command: COMMAND,
      deliveryBinding: binding,
    };
    expect(validateEvidence(input).ok).toBe(true);
    writeFileSync(join(cwd, binding.stagePath, "state.json"), "accepted metadata");
    expect(validateEvidence(input).ok).toBe(true);
    expect(
      validateEvidence({ ...input, deliveryBinding: { ...binding, queueIdentity: "e".repeat(64) } })
        .ok,
    ).toBe(false);
    expect(
      validateEvidence({
        ...input,
        deliveryBinding: { ...binding, criterionIdentity: "e".repeat(64) },
      }).ok,
    ).toBe(false);
    writeLog([logLine({ worktreeTree: fingerprint.tree })]);
    expect(validateEvidence(input).ok).toBe(false);
  });

  // Covers: R7, R8, R9
  it("compares the producer binding independently of key order", () => {
    const binding = deliveryBinding();
    const fingerprint = fingerprintTree(cwd, binding);
    if (!fingerprint.ok) throw new Error(fingerprint.reason);
    const reversed = Object.fromEntries(
      Object.entries(binding).reverse(),
    ) as DeliveryEvidenceBinding;
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(binding));
    writeLog([logLine({ worktreeTree: fingerprint.tree, deliveryBinding: binding })]);
    const input = {
      root: resolveStateRoot({ cwd, feature: "demo" }),
      feature: "demo",
      id: "A1",
      command: COMMAND,
    };
    expect(validateEvidence({ ...input, deliveryBinding: reversed }).ok).toBe(true);
    // The log line itself carries the binding in another key order.
    writeFileSync(
      join(cwd, ".navori/state/handoffs/workplan_demo.evidence.jsonl"),
      JSON.stringify({
        ...logLine({ worktreeTree: fingerprint.tree }),
        deliveryBinding: reversed,
      }) + "\n",
    );
    expect(validateEvidence({ ...input, deliveryBinding: binding }).ok).toBe(true);
    expect(
      validateEvidence({
        ...input,
        deliveryBinding: { ...reversed, queueIdentity: "e".repeat(64) },
      }).ok,
    ).toBe(false);
  });
});

// Covers: R7, R8, R9
describe("computeWorktreeTree", () => {
  it("is stable against the evidence log itself", () => {
    const before = computeWorktreeTree(cwd);
    writeLog([logLine()]);
    expect(computeWorktreeTree(cwd)).toBe(before);
  });

  it("changes on an edit and on a new file", () => {
    const base = computeWorktreeTree(cwd);
    writeFileSync(join(cwd, "a.txt"), "edited\n");
    const edited = computeWorktreeTree(cwd);
    expect(edited).not.toBe(base);
    writeFileSync(join(cwd, "new.txt"), "n\n");
    expect(computeWorktreeTree(cwd)).not.toBe(edited);
  });

  it("does not touch the real index or HEAD", () => {
    writeFileSync(join(cwd, "new.txt"), "n\n");
    const head = readHead(cwd);
    computeWorktreeTree(cwd);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" })).toContain(
      "?? new.txt",
    );
    expect(readHead(cwd)).toBe(head);
  });
});

describe("readEvidenceLog", () => {
  it("skips malformed lines", () => {
    writeLog([logLine()]);
    const dir = join(cwd, ".navori/state/handoffs");
    writeFileSync(
      join(dir, "workplan_demo.evidence.jsonl"),
      `not json\n${JSON.stringify(logLine())}\n{"partial":`,
    );
    expect(readEvidenceLog(join(dir, "workplan_demo.evidence.jsonl"))).toHaveLength(1);
  });
});

describe("validateEvidence", () => {
  it("accepts a fresh run recorded at the tree root", () => {
    writeLog([logLine()]);
    const verdict = validate();
    expect(verdict.ok).toBe(true);
  });

  it("reports no run recorded, with a FIX that mentions large repos", () => {
    const verdict = validate();
    expect(verdict).toMatchObject({ ok: false, why: "no run recorded" });
    if (!verdict.ok) expect(verdict.fix).toContain("large repos");
  });

  it("rejects an edited command", () => {
    writeLog([logLine()]);
    const verdict = validate("bun test y");
    expect(verdict).toMatchObject({ ok: false, why: "recorded for a different command" });
  });

  it("rejects a moved HEAD", () => {
    writeLog([logLine()]);
    git("commit", "--allow-empty", "-m", "moved");
    const verdict = validate();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain("HEAD");
  });

  it("rejects uncommitted changes after the run", () => {
    writeLog([logLine()]);
    writeFileSync(join(cwd, "a.txt"), "later\n");
    const verdict = validate();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain("uncommitted");
  });

  it("rejects a run from a subdirectory", () => {
    mkdirSync(join(cwd, "sub"));
    writeLog([logLine({ cwd: join(cwd, "sub") })]);
    const verdict = validate();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain("not the tree root");
  });

  it("rejects a run in a foreign worktree", () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "navori-evidence-other-")));
    try {
      execFileSync("git", ["init", "-b", "main"], { cwd: other, stdio: "ignore" });
      writeLog([logLine({ tree: other, cwd: other })]);
      const verdict = validate();
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.why).toContain("not this feature's checkout/worktree");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

// Covers: R7
describe("repo-controlled code is never executed", () => {
  it("runs neither core.fsmonitor nor a clean filter while fingerprinting or validating", () => {
    writeFileSync(join(cwd, ".gitattributes"), "f.txt filter=x\n");
    writeFileSync(join(cwd, "f.txt"), "content\n");
    git("config", "core.fsmonitor", `touch ${join(cwd, "FSM_RAN")}; echo`);
    git("config", "filter.x.clean", `touch ${join(cwd, "FILTER_RAN")}; cat`);
    git("config", "filter.x.required", "true");
    const first = computeWorktreeTree(cwd);
    expect(first).toBeDefined();
    writeLog([logLine({ worktreeTree: first ?? "" })]);
    expect(validate().ok).toBe(true);
    writeFileSync(join(cwd, "f.txt"), "edited\n");
    expect(validate().ok).toBe(false);
    expect(existsSync(join(cwd, "FSM_RAN"))).toBe(false);
    expect(existsSync(join(cwd, "FILTER_RAN"))).toBe(false);
  });

  it("hashes symlinks and respects .gitignore", () => {
    writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
    const base = computeWorktreeTree(cwd);
    writeFileSync(join(cwd, "ignored.txt"), "x\n");
    expect(computeWorktreeTree(cwd)).toBe(base);
    symlinkSync("a.txt", join(cwd, "link"));
    expect(computeWorktreeTree(cwd)).not.toBe(base);
  });
});

describe("fingerprint failures are controlled rejections", () => {
  it("names an orphan navori-fp-index.lock in WHY and FIX", () => {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(gitDir, "navori-fp-index.lock"), "");
    writeLog([logLine()]);
    const verdict = validate();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.why).toContain("navori-fp-index.lock");
      expect(verdict.fix).toContain("navori-fp-index.lock");
    }
  });

  it("returns a reason instead of throwing when the git dir is read-only", () => {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd,
      encoding: "utf8",
    }).trim();
    computeWorktreeTree(cwd); // creates the scratch index
    chmodSync(join(gitDir, "navori-fp-index"), 0o444);
    try {
      const result = fingerprintTree(cwd);
      // root can still write; otherwise the failure must be reported, not thrown
      if (!result.ok) expect(result.reason).toContain("navori-fp-index");
    } finally {
      chmodSync(join(gitDir, "navori-fp-index"), 0o644);
    }
  });
});
