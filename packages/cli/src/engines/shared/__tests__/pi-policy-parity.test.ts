import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { getCoreRoot } from "../../../lib/render/bundled-assets.ts";
import { acrossShells, HOOK_SHELLS } from "../../../lib/__tests__/helpers/shells.ts";
import {
  createHookBatch,
  type HookBatch,
  type HookCase,
} from "../../../__tests__/helpers/hook-batch.ts";
import { buildCodexRules } from "../../codex/build-rules.ts";
import { renderPiEngine } from "../../pi/index.ts";
import { renderManagedFile } from "../render-managed-file.ts";
import {
  GUARD_GOLDEN,
  NO_BACKGROUND_GOLDEN,
  STATE_SCRIPT_GOLDEN,
} from "./fixtures/claude-verdict-cases.ts";
import {
  buildPiDenyRules,
  buildPiPermissionRules,
  collectShellPermissionRules,
  translateShellPattern,
} from "../permission-rules.ts";

/**
 * Spec 0048 D3/D15 (R2, R16, R18): the Pi copy of a shared hook script may only ADD blocks to what the
 * Claude copy decides, and the shared `deny` rules have one source for Claude, Codex and Pi.
 */
const config = NavoriConfigSchema.parse({
  name: "pi-policy",
  preset: "custom",
  engines: ["claude", "pi"],
  branchBase: "main",
  qualityGate: { fast: "bun test", full: "bun test" },
});

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const hooksRoot = resolve(getCoreRoot(), "core-assets/hooks");
const hookMeta = { source: "@navori/core", version: "0.0.0-test" };

interface Copies {
  /** Project root of the Pi render (also the payload `cwd`). */
  project: string;
  claude: (script: string) => string;
  pi: (script: string) => string;
}

/** The same shared script rendered as a Claude copy (`.claude/hooks`) and as the Pi copy (`.pi/navori/hooks`). */
function renderCopies(): Copies {
  const project = mkdtempSync(join(tmpdir(), "navori-pi-policy-"));
  dirs.push(project);
  execFileSync("git", ["init", "-q", project]);
  renderPiEngine(project, config);
  mkdirSync(join(project, ".claude/hooks"), { recursive: true });
  const claude = (script: string): string => {
    const dest = join(project, ".claude/hooks", `${script}.sh`);
    writeFileSync(
      dest,
      renderManagedFile({
        assetPath: join(hooksRoot, `${script}.sh`),
        existingContent: null,
        managedId: `${script}-base`,
        meta: hookMeta,
        config,
        commentStyle: "shell",
        engine: "claude",
      }).content,
    );
    return dest;
  };
  return { project, claude, pi: (script) => join(project, ".pi/navori/hooks", `${script}.sh`) };
}

const batches = new Map<string, HookBatch>();
const batchOf = (script: string): HookBatch => {
  let batch = batches.get(script);
  if (batch === undefined) batches.set(script, (batch = createHookBatch(script)));
  return batch;
};
const caseOf = (cwd: string, payload: Record<string, unknown>): HookCase => ({
  input: JSON.stringify({ cwd, ...payload }),
  cwd,
});

/** Runs a table of payloads for one script in ONE shell process per shell (spec 0055 R18). */
function prime(script: string, cwd: string, payloads: readonly Record<string, unknown>[]): void {
  batchOf(script).prime(
    HOOK_SHELLS,
    payloads.map((payload) => caseOf(cwd, payload)),
  );
}

/** Exit code of one script run on a payload, the same under bash and zsh (batched when primed). */
function exitOf(script: string, cwd: string, payload: Record<string, unknown>): number {
  return acrossShells((shell) => batchOf(script).run(shell, caseOf(cwd, payload)).status);
}

const bash = (command: string): Record<string, unknown> => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});
const inChild = (command: string): Record<string, unknown> => ({
  ...bash(command),
  agent_id: "pi-implementer",
  agent_type: "implementer",
});

/** Commands a developer or an agent runs all day; none of them may be blocked, or fail the script. */
const BENIGN = [
  "git status",
  "git status --short && git diff --stat",
  "git log --oneline -n 5",
  "git add -A && git commit -m 'fix: handle rm -rf / in docs'",
  "git checkout -b feature/x",
  "git push -u origin feature/x",
  "ls -la",
  "ls 2>&1 | head",
  "cat README.md",
  "cat .pi/navori.json",
  "ls .pi/navori/hooks",
  "grep -rn TODO src | head -20",
  "find . -name '*.ts' -not -path './node_modules/*' | xargs wc -l",
  "sed -n 1,20p package.json",
  "echo hello > /tmp/navori-scratch.txt",
  "cd packages/cli && bun run test",
  "bun run check:fast",
  "npm run build",
  "mkdir -p build && touch build/.keep",
  "rm -rf node_modules/.cache",
  "rm -rf ./dist",
  "rm -f /tmp/navori-scratch.txt",
  "cp README.md /tmp/README.copy",
  "pi --version",
  "pi -p 'summarize the repo'",
  "python3 script.py --flag",
  'node -e "console.log(1)"',
  "cat <<'EOF' > notes.txt\nrm -rf /\nnohup x &\nEOF",
  "sudo ls",
  "docker run --rm -v /var/run/docker.sock:/var/run/docker.sock alpine true",
  "echo 'a & b' && echo done",
];

describe("Pi policy parity: the Pi copy only adds blocks", () => {
  const copies = renderCopies();

  // Covers: R2, R8, R16
  it("benign commands exit 0 or 2 in both copies, never an error, and agree", () => {
    for (const script of ["guard-destructive", "subagent-no-background"]) {
      const claude = copies.claude(script);
      const pi = copies.pi(script);
      const payloadOf = (command: string): Record<string, unknown> =>
        script === "guard-destructive" ? bash(command) : inChild(command);
      prime(claude, copies.project, BENIGN.map(payloadOf));
      prime(pi, copies.project, BENIGN.map(payloadOf));
      for (const command of BENIGN) {
        const payload = payloadOf(command);
        const claudeExit = exitOf(claude, copies.project, payload);
        const piExit = exitOf(pi, copies.project, payload);
        expect([0, 2], `${script} claude: ${command}`).toContain(claudeExit);
        expect([0, 2], `${script} pi: ${command}`).toContain(piExit);
        // These are benign: neither copy blocks them, so the Pi copy added nothing.
        expect(claudeExit, `${script} claude: ${command}`).toBe(0);
        expect(piExit, `${script} pi: ${command}`).toBe(0);
      }
    }
    // 4 batches x shells (2 scripts x 2 copies), each one shell process for the whole corpus.
  }, 180_000);

  // Covers: R2, R16
  it("claude copy verdict unchanged: golden cases recorded against the pre-0048 scripts", () => {
    const claudeGuard = copies.claude("guard-destructive");
    const piGuard = copies.pi("guard-destructive");
    const guardPayloads = GUARD_GOLDEN.map(({ command }) => bash(command));
    prime(claudeGuard, copies.project, guardPayloads);
    prime(piGuard, copies.project, guardPayloads);
    for (const { command, exit } of GUARD_GOLDEN) {
      expect(exitOf(claudeGuard, copies.project, bash(command)), `claude: ${command}`).toBe(exit);
      // The Pi copy never allows what the Claude copy blocks; it may only block more.
      const piExit = exitOf(piGuard, copies.project, bash(command));
      expect([0, 2], `pi: ${command}`).toContain(piExit);
      if (exit === 2) expect(piExit, `pi: ${command}`).toBe(2);
    }
    const claudeNoBg = copies.claude("subagent-no-background");
    const piNoBg = copies.pi("subagent-no-background");
    const noBgPayloads = NO_BACKGROUND_GOLDEN.map(({ payload }) => payload);
    prime(claudeNoBg, copies.project, noBgPayloads);
    prime(piNoBg, copies.project, noBgPayloads);
    for (const { name, payload, exit } of NO_BACKGROUND_GOLDEN) {
      expect(exitOf(claudeNoBg, copies.project, payload), `claude: ${name}`).toBe(exit);
      const piExit = exitOf(piNoBg, copies.project, payload);
      if (exit === 2) expect(piExit, `pi: ${name}`).toBe(2);
      else expect([0, 2], `pi: ${name}`).toContain(piExit);
    }
    // Every other script the bridge binds: both copies exit 0 or 2, the Claude copy as before.
    for (const [script, cases] of Object.entries(STATE_SCRIPT_GOLDEN)) {
      const claude = copies.claude(script);
      const pi = copies.pi(script);
      const payloads = cases.map(({ payload }) => payload);
      prime(claude, copies.project, payloads);
      prime(pi, copies.project, payloads);
      for (const { name, payload, exit } of cases) {
        expect(exitOf(claude, copies.project, payload), `claude ${script}: ${name}`).toBe(exit);
        expect([0, 2], `pi ${script}: ${name}`).toContain(exitOf(pi, copies.project, payload));
      }
    }
  }, 180_000);

  // Covers: R2, R16, R18
  it(
    "the Pi copy adds blocks the Claude copy does not make, and keeps every block the Claude copy makes",
    { timeout: 120_000 },
    () => {
      const claude = copies.claude("guard-destructive");
      const pi = copies.pi("guard-destructive");
      const piOnly = [
        "echo x > .pi/settings.json",
        "pi --no-extensions",
        "sudo rm -rf build",
        "engram delete obs-1",
      ];
      const both = [
        "rm -rf /",
        "git commit --no-verify -m x",
        "git push --force origin main",
        "rm -rf --no-preserve-root /",
        ":(){ :|:& };:",
        "echo x > CLAUDE.md",
        "dd if=/dev/zero of=/dev/sda",
      ];
      prime(pi, copies.project, [...piOnly, ...both].map(bash));
      prime(claude, copies.project, [...piOnly.slice(0, 2), ...both].map(bash));
      // Added by the Pi arm only (the control plane, `pi --no-extensions`, the shared deny rules).
      for (const command of piOnly) {
        expect(exitOf(pi, copies.project, bash(command)), `pi: ${command}`).toBe(2);
      }
      expect(exitOf(claude, copies.project, bash("echo x > .pi/settings.json"))).toBe(0);
      expect(exitOf(claude, copies.project, bash("pi --no-extensions"))).toBe(0);
      // Every numbered rule the Claude copy enforces is enforced, with the same verdict, by the Pi copy.
      for (const command of both) {
        expect(exitOf(claude, copies.project, bash(command)), `claude: ${command}`).toBe(2);
        expect(exitOf(pi, copies.project, bash(command)), `pi: ${command}`).toBe(2);
      }
    },
  );

  // Covers: R2, R18
  it("the shared deny rules have one source: Codex and Pi derive them with the same translation", () => {
    const rules = collectShellPermissionRules(config, []);
    // What the Pi copy embeds is what the shared translation yields, nothing hand-written.
    const piScript = readFileSync(copies.pi("guard-destructive"), "utf8");
    const embedded = /nv_pi_rules='([^']*)'/.exec(piScript)?.[1];
    expect(embedded).toBe(buildPiPermissionRules(rules));
    // The Claude copy and any other copy carry only the "no rules" sentinel.
    expect(readFileSync(copies.claude("guard-destructive"), "utf8")).toContain("nv_pi_rules='-'");
    // Codex's forbidden prefix rules and Pi's deny lines are the same token sets.
    const codexForbidden = [
      ...buildCodexRules(rules).body.matchAll(
        /pattern = \[([^\]]*)\],\n\s*decision = "forbidden"/g,
      ),
    ].map((match) => (JSON.parse(`[${match[1]}]`) as string[]).join(" "));
    const piDeny = buildPiDenyRules(rules)
      .split("\n")
      .map((line) => line.replace(/^deny /, ""));
    expect([...new Set(codexForbidden)].sort()).toEqual([...new Set(piDeny)].sort());
    expect(piDeny.length).toBeGreaterThan(0);
    // Spec 0048 T11: the `ask` rules come from the same source as Codex's prompt rules.
    const codexPrompt = [
      ...buildCodexRules(rules).body.matchAll(/pattern = \[([^\]]*)\],\n\s*decision = "prompt"/g),
    ].map((match) => (JSON.parse(`[${match[1]}]`) as string[]).join(" "));
    const piAsk = buildPiPermissionRules(rules)
      .split("\n")
      .filter((line) => line.startsWith("ask "))
      .map((line) => line.replace(/^ask /, ""));
    // `gh pr create` is Codex's separate prompt rule; in Pi `pr-publisher-confirm` always asks for it.
    expect([...new Set(codexPrompt)].filter((rule) => rule !== "gh pr create").sort()).toEqual(
      [...new Set(piAsk)].sort(),
    );
    expect(piAsk).toContain("git reset --hard");
    // The manifest records the very rules the script was rendered from.
    const manifest = JSON.parse(readFileSync(join(copies.project, ".pi/navori.json"), "utf8")) as {
      permissionRules: { deny: string[] };
    };
    expect(manifest.permissionRules.deny).toEqual([...rules.deny]);
    // A pattern the translation cannot express is dropped by both engines, never guessed.
    expect(translateShellPattern("Agent(orchestrator)")).toBeNull();
    expect(translateShellPattern("Bash(rm -rf a*b)")).toBeNull();
    expect(translateShellPattern("Bash(git push --force*)")).toEqual({
      tokens: ["git", "push", "--force"],
      narrowed: true,
    });
  });
});
