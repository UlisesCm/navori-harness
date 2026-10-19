import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { NavoriConfigSchema, type NavoriConfig } from "../config/schema.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { renderCodexEngine } from "../../engines/codex/index.ts";
import { renderClaudeEngine } from "../../engines/claude/index.ts";
import { buildRolePolicyShell } from "../../engines/shared/role-policy.ts";
import { acrossShells } from "./helpers/shells.ts";
import { checkReviewEditOutputs } from "../handoff/review-edit-binding.ts";

/**
 * Behavioral tests for `role-guard.sh` (spec 0041 T8/T9). Each case renders the
 * REAL Codex hook (includes expanded, `{{rolePolicy}}` compiled from the roster)
 * into a temp repo and drives it with its PreToolUse payload on stdin, under
 * every available shell (#391).
 */
const ASSET = resolve(getCoreRoot(), "core-assets/hooks/role-guard.sh");

function config(extra: Record<string, unknown> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "role-guard-demo",
    engines: ["codex"],
    preset: "custom",
    branchBase: "main",
    qualityGate: { fast: "pnpm test", full: "pnpm test" },
    ...extra,
  });
}

let repo: string;
let script: string;

function install(cfg: NavoriConfig = config()): void {
  renderCodexEngine(repo, cfg);
  script = join(repo, ".codex/hooks/role-guard.sh");
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "navori-role-guard-")));
  install();
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

interface Outcome {
  status: number;
  stderr: string;
}

/** The rendered policy fragment (case patterns, globbing, word-splitting) is not in the corpus, which replays unrendered source. */
const POLICY_SENSITIVE = {
  sensitive:
    "generated policy fragment: case patterns, globbing and word-splitting differ between bash and zsh",
};

function run(payload: Record<string, unknown>, env?: NodeJS.ProcessEnv): Outcome {
  return acrossShells((shell) => {
    const r = spawnSync(shell, [script], {
      cwd: repo,
      input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: repo, ...payload }),
      encoding: "utf-8",
      env,
    });
    return { status: r.status ?? -1, stderr: r.stderr ?? "" };
  }, POLICY_SENSITIVE);
}

/** An `apply_patch` call touching `files` (one `Add File` header each). */
function patch(role: string | undefined, ...files: string[]): Record<string, unknown> {
  const command = [
    "*** Begin Patch",
    ...files.flatMap((f) => [`*** Add File: ${f}`, "+x"]),
    "*** End Patch",
  ].join("\n");
  return {
    tool_name: "apply_patch",
    tool_input: { command },
    ...(role === undefined ? {} : { agent_type: role }),
  };
}

const HANDOFF = ".navori/state/handoffs/impl_x.json";

interface LinkedReviewFixture {
  host: string;
  target: string;
  state: string;
  thread: string;
  index: string;
  md: string;
  json: string;
}

describe("role-guard linked review outputs", () => {
  /** Creates an owned linked-worktree binding outside OS temp for each independent control. */
  function linkedReviewFixture(version: string = "0.162.1"): LinkedReviewFixture {
    // Outside OS temp: removing the exact binding must deny this same physical destination.
    rmSync(repo, { recursive: true, force: true });
    const runtimeState = resolve(getCoreRoot(), "../../.navori/state");
    mkdirSync(runtimeState, { recursive: true });
    repo = realpathSync(mkdtempSync(join(runtimeState, "role-binding-")));
    install();
    const host = join(repo, "host");
    const target = join(repo, "target");
    mkdirSync(host);
    const git = (cwd: string, ...args: string[]): string => {
      const result = spawnSync("git", args, { cwd, encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    git(host, "init", "-b", "main");
    git(
      host,
      "-c",
      "user.name=Guard",
      "-c",
      "user.email=guard@example.test",
      "commit",
      "--allow-empty",
      "-qm",
      "base",
    );
    git(host, "worktree", "add", "-b", "review", target);
    const state = join(target, ".navori/state/handoffs");
    mkdirSync(state, { recursive: true });
    const thread = "20000000-0000-0000-0000-000000000003";
    const nonce = "20000000-0000-0000-0000-000000000004";
    const actor = {
      host: "codex",
      version,
      thread,
      root: nonce,
      parent: nonce,
      role: "reviewer",
      sourceCwd: host,
      sourceHash: "a".repeat(64),
    };
    const handoff = "{}\n";
    const ownership = createHash("sha256").update(handoff).digest("hex");
    writeFileSync(join(state, "impl_demo.json"), handoff);
    writeFileSync(
      join(state, "ownership_demo.json"),
      JSON.stringify({
        feature: "demo",
        cwd: target,
        target: "main",
        fingerprint: "b".repeat(64),
        base: null,
        handoff: ownership,
        actors: [{ ...actor, thread: "20000000-0000-0000-0000-000000000002", role: "implementer" }],
      }),
    );
    writeFileSync(
      join(state, `review_demo.${nonce}.begin.json`),
      JSON.stringify({
        v: 1,
        alg: "navori-content/v1",
        feature: "demo",
        nonce,
        reviewer: actor,
        ownership,
        fingerprint: "b".repeat(64),
        base: null,
        editBinding: {
          v: 1,
          checkout: target,
          target: "main",
          stateDir: ".navori/state/handoffs",
          gitDir: realpathSync(git(target, "rev-parse", "--path-format=absolute", "--git-dir")),
          commonDir: realpathSync(
            git(target, "rev-parse", "--path-format=absolute", "--git-common-dir"),
          ),
        },
      }),
    );
    const index = join(state, `review_demo.${thread}.edit.json`);
    writeFileSync(index, JSON.stringify({ v: 1, feature: "demo", thread, nonce }));
    const md = join(state, "review_demo.md");
    const json = join(state, "review_demo.json");
    return { host, target, state, thread, index, md, json };
  }

  it.each(["0.162.1", "0.163.0"])(
    "authorizes registered linked-worktree review outputs for supported Codex %s",
    (version: string) => {
      const { host, thread, md, json } = linkedReviewFixture(version);
      const result = run({ ...patch("reviewer", md, json), cwd: host, agent_id: thread });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("bound-review-output");
    },
  );

  it.each(["Add File", "Update File", "Delete File", "Move to"])(
    "authorizes registered linked-worktree review outputs through the binding branch with %s headers",
    (header: string) => {
      const { host, thread, md, json } = linkedReviewFixture();
      const command = `*** Begin Patch\n*** ${header}: ${md}\n*** Add File: ${json}\n*** End Patch`;
      const result = run({
        cwd: host,
        agent_id: thread,
        agent_type: "reviewer",
        tool_name: "apply_patch",
        tool_input: { command },
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toContain("bound-review-output");
    },
  );

  it.each(["review-first", "scratch-first"])(
    "authorizes registered review output mixed with scratch in %s order",
    (order: string) => {
      const { host, thread, md } = linkedReviewFixture();
      const scratch = join(realpathSync(tmpdir()), "navori-bound-review-scratch.md");
      const files = order === "review-first" ? [md, scratch] : [scratch, md];
      const mixed = run({ ...patch("reviewer", ...files), cwd: host, agent_id: thread });
      expect(mixed.status, JSON.stringify(mixed)).toBe(0);
      expect(mixed.stderr).toContain("bound-review-output");
    },
  );

  it.each(["review-first", "source-first"])(
    "denies source mixed with review output and scratch in %s order",
    (order: string) => {
      const { host, target, thread, md } = linkedReviewFixture();
      const scratch = join(realpathSync(tmpdir()), "navori-bound-review-scratch.md");
      const source = join(target, "source.ts");
      const files = order === "review-first" ? [md, scratch, source] : [source, scratch, md];
      expect(run({ ...patch("reviewer", ...files), cwd: host, agent_id: thread }).status).toBe(2);
    },
  );

  it("denies traversal into the registered linked-worktree review output", () => {
    const { host, thread } = linkedReviewFixture();
    const traversal = run({
      ...patch("reviewer", "../target/.navori/state/handoffs/review_demo.md"),
      cwd: host,
      agent_id: thread,
    });
    expect(traversal.status, JSON.stringify(traversal)).toBe(2);
  });

  it.each(["", "20000000-0000-0000-0000-000000000009"])(
    "denies review output for an unbound identity %j",
    (agentId: string) => {
      const { host, md } = linkedReviewFixture();
      expect(run({ ...patch("reviewer", md), cwd: host, agent_id: agentId }).status).toBe(2);
    },
  );

  it("denies registered review output to an auditor", () => {
    const { host, thread, md } = linkedReviewFixture();
    expect(run({ ...patch("auditor", md), cwd: host, agent_id: thread }).status).toBe(2);
  });

  it("denies a registered review output mixed with source", () => {
    const { host, target, thread, md } = linkedReviewFixture();
    expect(
      run({ ...patch("reviewer", md, join(target, "source.ts")), cwd: host, agent_id: thread })
        .status,
    ).toBe(2);
  });

  it("denies a registered review output mixed with another feature output", () => {
    const { host, state, thread, md } = linkedReviewFixture();
    expect(
      run({
        ...patch("reviewer", md, join(state, "review_other.json")),
        cwd: host,
        agent_id: thread,
      }).status,
    ).toBe(2);
  });

  it("denies moving a registered review output into source", () => {
    const { host, target, thread, md } = linkedReviewFixture();
    const move = `*** Begin Patch\n*** Update File: ${md}\n*** Move to: ${join(target, "source.ts")}\n*** End Patch`;
    expect(
      run({
        cwd: host,
        agent_id: thread,
        agent_type: "reviewer",
        tool_name: "apply_patch",
        tool_input: { command: move },
      }).status,
    ).toBe(2);
  });

  it("fails closed without Node for linked output and preserves ordinary handoffs", () => {
    const { host, thread, md } = linkedReviewFixture();
    const bin = join(repo, "bin");
    mkdirSync(bin);
    for (const command of [
      "bash",
      "zsh",
      "jq",
      "cat",
      "git",
      "tr",
      "sed",
      "dirname",
      "readlink",
      "date",
    ]) {
      const located = spawnSync("which", [command], { encoding: "utf8" }).stdout.trim();
      if (located) symlinkSync(located, join(bin, command));
    }
    const noNode = run(
      { ...patch("reviewer", md), cwd: host, agent_id: thread },
      { ...process.env, PATH: bin },
    );
    expect(noNode.status).toBe(2);
    expect(noNode.stderr).toContain("node-unavailable");
    expect(
      run({ ...patch("reviewer", HANDOFF), cwd: host }, { ...process.env, PATH: bin }).status,
    ).toBe(0);
  });

  it("revokes the same physical review destination when its binding index is removed", () => {
    const { host, target, thread, index, md } = linkedReviewFixture();
    const bound = run({ ...patch("reviewer", md), cwd: host, agent_id: thread });
    expect(bound.status).toBe(0);
    expect(bound.stderr).toContain("bound-review-output");
    expect(
      checkReviewEditOutputs({ hostCwd: host, thread, outputs: [md, join(target, "source.ts")] })
        .status,
    ).toBe("error");
    rmSync(index);
    expect(checkReviewEditOutputs({ hostCwd: host, thread, outputs: [md] }).status).toBe("error");
    const samePath = run({ ...patch("reviewer", md), cwd: host, agent_id: thread });
    expect(samePath.stderr).not.toContain("bound-review-output");
    expect(samePath.status).toBe(2);
  });
});

// Covers: R6, R8
describe("role-guard apply_patch — allowed callers", () => {
  it("lets the main thread (no agent_type) patch anything", () => {
    expect(run(patch(undefined, "src/app.ts")).status).toBe(0);
  });

  it("lets implementer and scribe patch outside any role prefix", () => {
    expect(run(patch("implementer", "src/app.ts", "README.md")).status).toBe(0);
    expect(run(patch("scribe", "docs/a.md")).status).toBe(0);
  });

  it("ignores tools it does not cover", () => {
    const r = run({
      tool_name: "Bash",
      tool_input: { command: "echo hi > src/a.ts" },
      agent_type: "reviewer",
    });
    expect(r.status).toBe(0);
  });
});

// Covers: R6, R7
describe("role-guard apply_patch — role containment", () => {
  it("lets a restricted role patch its handoff and denies other paths naming role and path", () => {
    expect(run(patch("reviewer", HANDOFF)).status).toBe(0);
    const r = run(patch("reviewer", "src/app.ts"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("BLOCKED by role-guard");
    expect(r.stderr).toContain("reviewer");
    expect(r.stderr).toContain("src/app.ts");
  });

  it("denies a multi-file patch when ONE file is outside the role", () => {
    const r = run(patch("reviewer", HANDOFF, "src/app.ts"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("src/app.ts");
  });

  it("gives scout, auditor and architect the specs dir; reviewer and publisher not", () => {
    for (const role of ["scout", "auditor", "architect"]) {
      expect(run(patch(role, "specs/0001/design.md")).status, role).toBe(0);
    }
    for (const role of ["reviewer", "publisher"]) {
      expect(run(patch(role, "specs/0001/design.md")).status, role).toBe(2);
    }
  });

  it("compares by path component, not by text prefix", () => {
    expect(run(patch("scout", "specs-evil/a.md")).status).toBe(2);
    expect(run(patch("scout", ".navori/state/handoffs-x/a.json")).status).toBe(2);
  });

  it("takes the specs dir from sdd.specsDir", () => {
    install(config({ sdd: { specsDir: "docs/specs" } }));
    expect(run(patch("scout", "docs/specs/a.md")).status).toBe(0);
    expect(run(patch("scout", "specs/a.md")).status).toBe(2);
  });

  it("fails closed for the default and an unknown role", () => {
    for (const role of ["default", "mystery-role"]) {
      expect(run(patch(role, HANDOFF)).status, role).toBe(0);
      const denied = run(patch(role, "src/app.ts"));
      expect(denied.status, role).toBe(2);
      expect(denied.stderr).toContain(role);
      expect(run(patch(role, "specs/a.md")).status, role).toBe(2);
    }
  });

  it("lets a restricted role patch OS temp files", () => {
    expect(run(patch("reviewer", join(tmpdir(), "scratch.txt"))).status).toBe(0);
    expect(run(patch("reviewer", "/tmp/scratch.txt")).status).toBe(0);
  });
});

// Covers: R6
describe("role-guard apply_patch — path escapes", () => {
  it("denies a `..` that leaves the repo", () => {
    const up = "../".repeat(40);
    const r = run(patch("reviewer", `.navori/state/handoffs/${up}etc/passwd`));
    expect(r.status).toBe(2);
  });

  it("folds `..` inside the repo before comparing", () => {
    expect(run(patch("scout", "specs/../.navori/state/handoffs/ok.json")).status).toBe(0);
    expect(run(patch("reviewer", ".navori/state/handoffs/../../../src/x.ts")).status).toBe(2);
  });

  it("denies a symlink that leaves the repo", () => {
    mkdirSync(join(repo, ".navori/state/handoffs"), { recursive: true });
    symlinkSync("/etc", join(repo, ".navori/state/handoffs/out"));
    const r = run(patch("reviewer", ".navori/state/handoffs/out/hosts"));
    expect(r.status).toBe(2);
  });

  it("denies a leaf symlink pointing outside the repo", () => {
    mkdirSync(join(repo, ".navori/state/handoffs"), { recursive: true });
    symlinkSync("/etc/hosts", join(repo, ".navori/state/handoffs/leaf.json"));
    expect(run(patch("reviewer", ".navori/state/handoffs/leaf.json")).status).toBe(2);
  });

  it("denies an in-repo symlink that lands outside the role's prefixes", () => {
    mkdirSync(join(repo, ".navori/state/handoffs"), { recursive: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    symlinkSync(join(repo, "src"), join(repo, ".navori/state/handoffs/to-src"));
    expect(run(patch("reviewer", ".navori/state/handoffs/to-src/a.ts")).status).toBe(2);
  });
});

// Covers: R17, R31
describe("role-guard spawn branch", () => {
  const spawn = (tool: string, caller?: string, target = "implementer") => ({
    tool_name: tool,
    tool_input: { agent_type: target, message: "go" },
    ...(caller === undefined ? {} : { agent_type: caller }),
  });

  it("denies a spawn from a subagent, naming the caller role", () => {
    const r = run(spawn("spawn_agent", "architect"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("architect");
    expect(r.stderr).toContain("BLOCKED by role-guard");
  });

  it("denies a spawn from implementer and scribe too, and under a V2 tool name", () => {
    expect(run(spawn("spawn_agent", "implementer")).status).toBe(2);
    expect(run(spawn("collaborationspawn_agent", "scribe")).status).toBe(2);
    expect(run(spawn("spawn_agent", "default")).status).toBe(2);
  });

  it("allows a spawn from the main thread even when it targets a typed agent", () => {
    expect(run(spawn("spawn_agent")).status).toBe(0);
    expect(run(spawn("collaborationspawn_agent", undefined, "reviewer")).status).toBe(0);
  });
});

// Covers: R7
describe("role-guard policy source", () => {
  it("renders the fragment buildRolePolicyShell compiles and keeps the asset free of prefixes", () => {
    const rendered = readFileSync(script, "utf-8");
    expect(rendered).toContain(buildRolePolicyShell(config()));
    expect(rendered).not.toContain("{{rolePolicy}}");
    const asset = readFileSync(ASSET, "utf-8");
    expect(asset).toContain("{{rolePolicy}}");
    expect(asset).not.toContain(".navori/state/handoffs");
    expect(asset).not.toContain("specs/");
  });

  it("compiles roster writes into one arm per role with the common set as default", () => {
    const shell = buildRolePolicyShell(config());
    expect(shell).toContain("scout) printf '%s\\n' '.navori/state/handoffs/' 'specs/' ;;");
    expect(shell).toContain("reviewer) printf '%s\\n' '.navori/state/handoffs/' ;;");
    expect(shell).toContain("*) printf '%s\\n' '.navori/state/handoffs/' ;;");
    expect(shell).not.toContain("implementer)");
  });

  it("never lets an empty specsDir open the repo root to a restricted role", () => {
    const shell = buildRolePolicyShell(config({ sdd: { specsDir: "." } }));
    expect(shell).not.toMatch(/'\/'/);
    expect(shell).not.toContain("''");
  });

  it("quotes a hostile specsDir as one literal token", () => {
    const shell = buildRolePolicyShell(config({ sdd: { specsDir: "x'; touch /tmp/pwn; '" } }));
    expect(shell).toContain("'x'\\''; touch /tmp/pwn; '\\''/'");
  });

  it("is absent from the Claude render", () => {
    const claudeRepo = mkdtempSync(join(tmpdir(), "navori-role-guard-claude-"));
    try {
      renderClaudeEngine(claudeRepo, config({ engines: ["claude"] }));
      expect(existsSync(join(claudeRepo, ".claude/hooks/role-guard.sh"))).toBe(false);
    } finally {
      rmSync(claudeRepo, { recursive: true, force: true });
    }
  });
});

// Covers: R17
describe("hook-input spawn helpers never confuse caller and child (H16)", () => {
  function probe(payload: Record<string, unknown>, fn: string): string {
    const dir = join(repo, ".codex/hooks");
    const path = join(dir, "probe.sh");
    const partials = resolve(getCoreRoot(), "core-assets/hooks/_partials");
    writeFileSync(
      path,
      `payload=$(cat)\n${readFileSync(join(partials, "extract-cmd.sh"), "utf-8")}\n${readFileSync(
        join(partials, "hook-input.sh"),
        "utf-8",
      )}\n${fn}\n`,
    );
    const r = spawnSync("bash", [path], {
      cwd: repo,
      input: JSON.stringify(payload),
      encoding: "utf-8",
    });
    return r.stdout.trim();
  }

  it("reads the child from tool_input and the caller from the top level", () => {
    const pre = {
      hook_event_name: "PreToolUse",
      tool_name: "spawn_agent",
      agent_type: "architect",
      tool_input: { agent_type: "implementer" },
    };
    expect(probe(pre, "nv_spawn_target_type")).toBe("implementer");
    expect(probe(pre, "nv_event_agent_type")).toBe("architect");
    expect(probe(pre, "nv_is_spawn_tool && printf yes")).toBe("yes");
    expect(probe({ ...pre, tool_input: { message: "go" } }, "nv_spawn_target_type")).toBe("");
  });

  it("reads the finishing subagent on SubagentStop and recognizes V2 names", () => {
    const stop = { hook_event_name: "SubagentStop", agent_type: "scout" };
    expect(probe(stop, "nv_spawn_target_type")).toBe("scout");
    expect(probe({ tool_name: "ns_spawn_agent" }, "nv_is_spawn_tool && printf yes")).toBe("yes");
    expect(probe({ tool_name: "apply_patch" }, "nv_is_spawn_tool || printf no")).toBe("no");
  });
});

// Covers: #1022 role-guard
describe("role-guard nested worktrees (#1022)", () => {
  const git = (cwd: string, ...args: string[]): void => {
    const r = spawnSync(
      "git",
      ["-c", "user.name=Guard", "-c", "user.email=guard@example.test", ...args],
      { cwd, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(r.stderr);
  };
  let nested: string;

  beforeEach(() => {
    git(repo, "init", "-q", "-b", "main");
    git(repo, "commit", "-q", "--allow-empty", "-m", "base");
    nested = join(repo, ".navori/state/fixtures/live/native-dev");
    mkdirSync(join(repo, ".navori/state/fixtures/live"), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", "nested", nested);
  });

  it("lets the reviewer write the handoffs dir of a nested worktree", () => {
    const file = join(nested, ".navori/state/handoffs/review_x.md");
    expect(run(patch("reviewer", file)).status).toBe(0);
  });

  it("still blocks the reviewer outside its prefixes in the nested worktree and at the root", () => {
    expect(run(patch("reviewer", join(nested, "src/x.mjs"))).status).toBe(2);
    expect(run(patch("reviewer", join(repo, "src/x.mjs"))).status).toBe(2);
    expect(run(patch("reviewer", join(nested, ".navori/state/fixtures/x.md"))).status).toBe(2);
  });

  it("keeps implementer and scribe exempt in the nested worktree like at the root", () => {
    expect(run(patch("implementer", join(nested, "src/x.mjs"))).status).toBe(0);
    expect(run(patch("scribe", join(nested, "docs/a.md"))).status).toBe(0);
  });

  it("does not treat a plain dir with a forged .git file or dir as a worktree", () => {
    const fake = join(repo, "fake");
    mkdirSync(fake);
    writeFileSync(join(fake, ".git"), `gitdir: ${join(repo, ".git/worktrees/nope")}\n`);
    expect(run(patch("reviewer", join(fake, ".navori/state/handoffs/review_x.md"))).status).toBe(2);
    const fakeDir = join(repo, "fakedir");
    mkdirSync(join(fakeDir, ".git"), { recursive: true });
    expect(run(patch("reviewer", join(fakeDir, ".navori/state/handoffs/review_x.md"))).status).toBe(
      2,
    );
  });

  it("blocks a symlinked nested handoffs dir that points outside and `..` traversal", () => {
    // Target is a non-prefix dir of the root (inside OS temp, so the temp grant cannot mask a miss).
    const outside = join(repo, "src");
    mkdirSync(outside);
    {
      rmSync(join(nested, ".navori"), { recursive: true, force: true });
      mkdirSync(join(nested, ".navori/state"), { recursive: true });
      symlinkSync(outside, join(nested, ".navori/state/handoffs"));
      // Resolves outside the repo: external route, no binding -> blocked.
      expect(
        run(patch("reviewer", join(nested, ".navori/state/handoffs/review_x.md"))).status,
      ).toBe(2);
      expect(
        run(patch("reviewer", join(nested, ".navori/state/handoffs/../../../src/x.mjs"))).status,
      ).toBe(2);
    }
  });

  it("blocks an independent nested git repo (role escape through `git init`)", () => {
    const evil = join(repo, "packages/cli/src/evil");
    mkdirSync(evil, { recursive: true });
    git(evil, "init", "-q", "-b", "main");
    git(evil, "commit", "-q", "--allow-empty", "-m", "base");
    expect(run(patch("reviewer", join(evil, ".navori/state/handoffs/x.md"))).status).toBe(2);
  });

  it("blocks a nested linked worktree that belongs to a different repo", () => {
    const other = realpathSync(mkdtempSync(join(tmpdir(), "navori-role-other-")));
    try {
      git(other, "init", "-q", "-b", "main");
      git(other, "commit", "-q", "--allow-empty", "-m", "base");
      const foreign = join(repo, "packages/foreign");
      mkdirSync(join(repo, "packages"), { recursive: true });
      git(other, "worktree", "add", "-q", "-b", "foreign", foreign);
      expect(run(patch("reviewer", join(foreign, ".navori/state/handoffs/x.md"))).status).toBe(2);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});
