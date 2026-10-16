import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
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
  isPureEvidenceRunner,
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
    fp: 2,
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
  it("names the HEAD change when a committed content change stales bound evidence", () => {
    const binding = deliveryBinding();
    const fp = fingerprintTree(cwd, binding);
    if (!fp.ok) throw new Error(fp.reason);
    const old = readHead(cwd);
    writeLog([logLine({ deliveryBinding: binding, worktreeTree: fp.tree })]);
    const input = {
      root: resolveStateRoot({ cwd, feature: "demo" }),
      feature: "demo",
      id: "A1",
      command: COMMAND,
      deliveryBinding: binding,
    };
    writeFileSync(join(cwd, "a.txt"), "committed change\n");
    git("commit", "-am", "content change");
    const verdict = validateEvidence(input);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.why).toContain(`HEAD ${old.slice(0, 7)} → ${readHead(cwd).slice(0, 7)}`);
      expect(verdict.why).not.toContain("uncommitted");
    }
  });

  // Covers: R7, R8, R9
  it("keeps 'uncommitted changes' for bound evidence when HEAD is unchanged", () => {
    const binding = deliveryBinding();
    const fp = fingerprintTree(cwd, binding);
    if (!fp.ok) throw new Error(fp.reason);
    writeLog([logLine({ deliveryBinding: binding, worktreeTree: fp.tree })]);
    writeFileSync(join(cwd, "a.txt"), "uncommitted change\n");
    const verdict = validateEvidence({
      root: resolveStateRoot({ cwd, feature: "demo" }),
      feature: "demo",
      id: "A1",
      command: COMMAND,
      deliveryBinding: binding,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.why).toContain("uncommitted changes");
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

  // Covers: R7
  it("names `navori plan render` when the acceptance index has no line for the feature", () => {
    const verdict = validate();
    expect(verdict).toMatchObject({ ok: false, why: "no run recorded" });
    if (!verdict.ok) expect(verdict.fix).toContain("navori plan render demo");
  });

  it("reports no run recorded, with a FIX that mentions large repos", () => {
    const dir = join(cwd, ".navori/state/handoffs");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "acceptance-index"), `${COMMAND}\tdemo\tA1\t${dir}\n`);
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
  // Covers: R35
  it("does not depend on the git dir: an orphan scratch lock or read-only index cannot block it", () => {
    const gitDir = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
      cwd,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(gitDir, "navori-fp-index.lock"), "");
    writeLog([logLine()]);
    expect(validate().ok).toBe(true);
    chmodSync(gitDir, 0o555);
    try {
      expect(fingerprintTree(cwd).ok).toBe(true);
    } finally {
      chmodSync(gitDir, 0o755);
    }
  });

  // Covers: R35
  it("returns a reason instead of throwing outside a git checkout", () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "navori-evidence-plain-")));
    try {
      const result = fingerprintTree(plain);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("criteria shaped `cd <dir> && ...` (host persists cd)", () => {
  const CD_COMMAND = "cd packages/cli && bun run test x";

  function recordFrom(command: string, lineCwd: string): void {
    mkdirSync(join(cwd, "packages/cli"), { recursive: true });
    writeLog([logLine({ command, cwd: lineCwd })]);
  }

  it("accepts the post-cd cwd <tree>/<dir>", () => {
    mkdirSync(join(cwd, "packages/cli"), { recursive: true });
    recordFrom(CD_COMMAND, join(cwd, "packages/cli"));
    expect(validate(CD_COMMAND).ok).toBe(true);
  });

  it("still accepts the tree root cwd for the same command", () => {
    recordFrom(CD_COMMAND, cwd);
    expect(validate(CD_COMMAND).ok).toBe(true);
  });

  it("rejects another subdirectory than the cd target", () => {
    mkdirSync(join(cwd, "other"), { recursive: true });
    recordFrom(CD_COMMAND, join(cwd, "other"));
    expect(validate(CD_COMMAND).ok).toBe(false);
  });

  it("rejects <tree>/<dir> for a command without the cd prefix", () => {
    recordFrom(COMMAND, join(cwd, "packages/cli"));
    expect(validate(COMMAND).ok).toBe(false);
  });

  it.each(["cd ../x && bun test x", "cd /abs && bun test x", "cd ~/x && bun test x"])(
    "rejects an unsafe cd target: %s",
    (command: string) => {
      mkdirSync(join(cwd, "x"), { recursive: true });
      recordFrom(command, join(cwd, "x"));
      expect(validate(command).ok).toBe(false);
    },
  );

  it("rejects a cd target that is a symlink leaving the tree", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "navori-evidence-out-")));
    try {
      symlinkSync(outside, join(cwd, "link"));
      const command = "cd link && bun test x";
      writeLog([logLine({ command, cwd: outside })]);
      expect(validate(command).ok).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // Covers: R14
  it("cd dentro de una cadena && vale como cwd y el rechazo por cwd no repite el comando", () => {
    mkdirSync(join(cwd, "a/b"), { recursive: true });
    const chain = "cd a && echo x && cd b && bun test x";
    writeLog([logLine({ command: chain, cwd: join(cwd, "a/b") })]);
    expect(validate(chain).ok).toBe(true);

    for (const command of [
      "cd a; cd b && x",
      "cd a || cd b && x",
      "(cd a) && cd b && x",
      "cd a && cd `echo b` && x",
      "cd a && cd $(echo b) && x",
      "cd a && cd .. && cd a/b && x",
      "pushd a && cd b && x",
    ]) {
      writeLog([logLine({ command, cwd: join(cwd, "a/b") })]);
      expect(validate(command).ok, command).toBe(false);
    }

    const bad = "cd a && bun test x";
    writeLog([logLine({ command: bad, cwd: join(cwd, "a/b") })]);
    const verdict = validate(bad);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.fix).toContain(`cd ${cwd}`);
      expect(verdict.fix).toContain("change the criterion's `command`");
      expect(verdict.fix).not.toContain(`run exactly:\n         ${bad}`);
    }
  });
});

/** The pre-0054 `fingerprintTree` (hash-object + scratch index + write-tree), kept as the equivalence reference. */
function referenceFingerprint(tree: string): string {
  const excludes = [".navori/state", ".claude/progress", ".codex/progress", ".claude/worktrees"];
  const run = (args: string[], options: { input?: string; env?: NodeJS.ProcessEnv } = {}): string =>
    execFileSync("git", args, {
      cwd: tree,
      encoding: "utf8",
      input: options.input,
      env: options.env ?? process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
  const scratch = run([
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "navori-fp-reference-index",
  ]).trim();
  const listed = run([
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
    "--deduplicate",
    "--",
    ".",
    ...excludes.map((path) => `:(exclude,literal)${path}`),
  ]);
  const files: Array<{ path: string; mode: string }> = [];
  const links: Array<{ path: string; target: string }> = [];
  for (const path of listed.split("\0").filter(Boolean)) {
    let stat;
    try {
      stat = lstatSync(join(tree, path));
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) links.push({ path, target: readlinkSync(join(tree, path)) });
    else if (stat.isFile()) files.push({ path, mode: stat.mode & 0o111 ? "100755" : "100644" });
  }
  const entries: string[] = [];
  const shas = run(["hash-object", "-w", "--no-filters", "--stdin-paths"], {
    input: `${files.map((f) => f.path).join("\n")}\n`,
  })
    .split("\n")
    .filter(Boolean);
  files.forEach((f, i) => entries.push(`${f.mode} ${shas[i]}\t${f.path}\0`));
  for (const link of links) {
    const sha = run(["hash-object", "-w", "--no-filters", "--stdin"], {
      input: link.target,
    }).trim();
    entries.push(`120000 ${sha}\t${link.path}\0`);
  }
  const env = { ...process.env, GIT_INDEX_FILE: scratch };
  run(["read-tree", "--empty"], { env });
  if (entries.length > 0)
    run(["update-index", "--add", "-z", "--index-info"], { input: entries.join(""), env });
  return run(["write-tree"], { env }).trim();
}

describe("pure runners and fingerprint versions (spec 0054 R19, R20)", () => {
  const PURE = "bun run test src/lib/plan/__tests__/evidence.test.ts";

  // Covers: R19
  it("HEAD movido con la misma huella vale para un runner puro y no para otro comando; línea legacy valida con la huella vieja", () => {
    const pure = [
      "bun run test",
      PURE,
      "bun run test:golden",
      "bun x vitest run src/a.test.ts",
      "cd packages/cli && bun run test src/a.test.ts",
      "cd a && cd b && bun x vitest run",
    ];
    const bound = [
      "bun test x",
      "navori plan classify --diff",
      "bun run check:blame-ignore",
      "navori receipt check",
      "bun run test && git log",
      "bun run test | tee out",
      "bun run test; echo x",
      "bun run test $(git rev-parse HEAD)",
      "bun run test > out",
      "bun run test src/a.test.ts &",
      "bun run test:coverage",
      "bun run testing",
      "cd ../x && bun run test",
      "cd /abs && bun run test",
      "echo x && bun run test",
      'bun run test -t "name"',
    ];
    for (const command of pure) expect(isPureEvidenceRunner(command), command).toBe(true);
    for (const command of bound) expect(isPureEvidenceRunner(command), command).toBe(false);

    for (const command of [PURE, "bun test x"]) {
      writeLog([logLine({ command })]);
      git("commit", "--allow-empty", "-m", "same bytes");
      expect(validate(command).ok, command).toBe(command === PURE);
    }

    // A line without `fp` validates with the legacy fingerprint (`progress/` included).
    mkdirSync(join(cwd, "progress"), { recursive: true });
    writeFileSync(join(cwd, "progress/current.txt"), "state\n");
    const legacy = fingerprintTree(cwd, undefined, { legacy: true });
    const current = fingerprintTree(cwd);
    if (!legacy.ok || !current.ok) throw new Error("fingerprint failed");
    expect(legacy.tree).not.toBe(current.tree);
    const { fp: _fp, ...withoutFp } = logLine({ worktreeTree: legacy.tree });
    writeLog([withoutFp]);
    expect(validate(COMMAND).ok).toBe(true);
    writeLog([logLine({ worktreeTree: legacy.tree })]);
    expect(validate(COMMAND).ok).toBe(false);
    writeLog([logLine({ worktreeTree: current.tree })]);
    expect(validate(COMMAND).ok).toBe(true);
  });

  // Covers: R20
  it("editar progress/ no invalida la evidencia", () => {
    mkdirSync(join(cwd, "progress"), { recursive: true });
    writeFileSync(join(cwd, "progress/current.txt"), "one\n");
    writeLog([logLine()]);
    expect(validate().ok).toBe(true);
    writeFileSync(join(cwd, "progress/current.txt"), "two\n");
    writeFileSync(join(cwd, "progress/new.txt"), "new\n");
    expect(validate().ok).toBe(true);
    writeFileSync(join(cwd, "a.txt"), "code\n");
    expect(validate().ok).toBe(false);
  });
});

describe("fingerprintTree with bounded processes (spec 0054 R35)", () => {
  /** Puts a logging `git` first on PATH; returns how many times `fn` spawned it. */
  function countGitSpawns(fn: () => void): number {
    const shim = mkdtempSync(join(tmpdir(), "navori-git-shim-"));
    const log = join(shim, "spawns.log");
    const real = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    writeFileSync(join(shim, "git"), `#!/bin/sh\necho x >> "${log}"\nexec "${real}" "$@"\n`, {
      mode: 0o755,
    });
    writeFileSync(log, "");
    const saved = process.env.PATH;
    process.env.PATH = `${shim}:${saved ?? ""}`;
    try {
      fn();
      return readFileSync(log, "utf8").split("\n").filter(Boolean).length;
    } finally {
      process.env.PATH = saved;
      rmSync(shim, { recursive: true, force: true });
    }
  }

  // Covers: R35
  it("fingerprintTree produce la misma huella con procesos acotados", () => {
    writeFileSync(join(cwd, ".gitignore"), "ignored.txt\n");
    mkdirSync(join(cwd, "dir with space"), { recursive: true });
    writeFileSync(join(cwd, "dir with space/file name.txt"), "spaced\n");
    writeFileSync(join(cwd, "tracked-deleted.txt"), "gone\n");
    writeFileSync(join(cwd, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync("a.txt", join(cwd, "tracked-link"));
    git("add", "-A");
    git("commit", "-m", "fixtures");
    const mutations: Array<() => void> = [
      () => undefined,
      () => writeFileSync(join(cwd, "a.txt"), "modified\n"),
      () => writeFileSync(join(cwd, "untracked.txt"), "new\n"),
      () => rmSync(join(cwd, "tracked-deleted.txt")),
      () => symlinkSync("dir with space", join(cwd, "untracked-link")),
      () => writeFileSync(join(cwd, "dir with space/other file.txt"), "x\n"),
      () => writeFileSync(join(cwd, "ignored.txt"), "ignored\n"),
      () => {
        mkdirSync(join(cwd, ".navori/state"), { recursive: true });
        writeFileSync(join(cwd, ".navori/state/x"), "state\n");
      },
    ];
    let spawns = 0;
    let first = 0;
    for (const [index, mutate] of mutations.entries()) {
      mutate();
      let result: ReturnType<typeof fingerprintTree> | undefined;
      spawns = countGitSpawns(() => {
        result = fingerprintTree(cwd, undefined, { legacy: true });
      });
      if (index === 0) first = spawns;
      if (!result?.ok) throw new Error("fingerprint failed");
      expect(result.tree, `step ${index}`).toBe(referenceFingerprint(cwd));
    }
    for (let i = 0; i < 60; i++) writeFileSync(join(cwd, `bulk-${i}.txt`), `${i}\n`);
    const many = countGitSpawns(() => {
      fingerprintTree(cwd);
    });
    expect(many).toBe(first);
    expect(many).toBeLessThanOrEqual(2);
    expect(spawns).toBeLessThanOrEqual(2);
  });
});
