import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

/**
 * Single-copy invariants of the protocol prose.
 *
 * A coherence audit plus a measured run on a real ticket found the same fact
 * written in several assets, with the copies drifted: a ticket touching auth
 * fired both "start from a spec" and "R3 is opt-in", the PR pre-flight demanded
 * a clean tree the pilot's own trigger contradicts, and the PR side of the delegation rule had
 * three wordings. Every drift cost a re-read or a re-decision at runtime.
 *
 * The rule these tests pin: when two documents state the same fact, ONE is
 * canonical and the other points at it. Assertions target the load-bearing
 * tokens and the ABSENCE of the retired wording — rephrasing stays free,
 * re-duplicating does not.
 */
const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "core", "core-assets");

const read = (rel: string): string => readFileSync(resolve(coreAssets, rel), "utf-8");

/** The line of `file` that contains `needle` (for row/bullet-scoped assertions). */
function lineWith(file: string, needle: string): string {
  const line = read(file)
    .split("\n")
    .find((l) => l.includes(needle));
  expect(line, `no line of ${file} contains "${needle}"`).toBeDefined();
  return line!;
}

/** The body of a `## <heading>` section of `file`, up to the next `##` heading. */
function section(file: string, heading: string): string {
  const body = read(file).split(`\n## ${heading}\n`)[1];
  expect(body, `${file} has no "## ${heading}" section`).toBeDefined();
  return body!.split("\n## ")[0]!;
}

describe("SDD threshold — one formulation, and it's a proposal (F2)", () => {
  it("sdd.md owns the threshold and hands the decision to the user", () => {
    const sdd = read("managed/sdd.md");
    expect(sdd).toMatch(/recommendation you put to the user/i);
    // The gate is R3's opt-in: an agent must not self-assign a spec.
    expect(sdd).toMatch(/opt-in/i);
    expect(sdd).toMatch(/explicit request or accepted proposal/i);
    // The imperative that contradicted R3 must not come back.
    expect(sdd).not.toMatch(/^Start from a spec/im);
  });

  it("the R3 route and spec-bootstrap reference that threshold, never restate it", () => {
    // "> ~2 days" is the fingerprint of the threshold list: exactly one asset.
    const owners = ["managed/sdd.md", "managed/orquestacion.md", "skills/spec-bootstrap.md"].filter(
      (f) => read(f).includes("~2 days"),
    );
    expect(owners).toEqual(["managed/sdd.md"]);

    expect(read("managed/orquestacion.md")).toContain("don't duplicate its criteria");
    expect(read("skills/spec-bootstrap.md")).toMatch(/threshold and its opt-in gate live in ONE/i);
  });
});

describe("verifying a subagent's evidence — bounded subset, after the handoff (F3)", () => {
  it("the rule names WHAT to re-check and WHEN", () => {
    // Since spec 0019 the rule lives in `leader.md` (renamed `orchestrator.md`
    // in spec 0026 T12) (§ Anti-broken-telephone), the depth reference the
    // orchestrator opens when a `done -> file` lands.
    const block = read("agents/orchestrator.md");
    // Scope: only the claims the next decision rests on.
    expect(block).toMatch(/load-bearing claims/i);
    // Timing: after the handoff — re-checking in flight is the duplication the
    // platform already forbids, and it serialized a whole run.
    expect(block).toMatch(/after\*{0,2} its `done -> file`/i);
    // And an explicit ceiling, or "verify" reads as "re-run everything".
    expect(block).toMatch(/don't re-run its investigation/i);
    // The unbounded wording is what produced the conflict.
    expect(block).not.toContain("Verify the diff/evidence yourself");
  });
});

describe("PR pre-flight — one list, no clean-tree requirement (A3, M5)", () => {
  const row = (): string => lineWith("skills/verify-before-done.md", "PR creatable");

  it("verify-before-done stops demanding a clean status", () => {
    // The pilot's trigger IS the uncommitted diff: a clean-tree gate would abort
    // the normal case. Guard the whole skill, not just the row.
    expect(read("skills/verify-before-done.md")).not.toMatch(/clean status/i);
    expect(row()).toMatch(/no clean working tree required/i);
  });

  it("verify-before-done's row is the harness's pre-flight, gate evidence included", () => {
    expect(row()).toContain("protected base branch");
    expect(row()).toContain("gh auth status");
    // Fresh evidence over the shipping diff, by route: reviewer's Pass 2 (bound
    // by the receipt) in R2+, your own run in R1.
    expect(row()).toMatch(/receipt/i);
    expect(row()).toMatch(/declared-inline change, your own run/i);
  });

  it("the pilot's own trigger list demands no clean tree either", () => {
    // The pilot reads this list FIRST; a surviving clean-tree clause here aborts
    // the normal case (a dirty tree IS the trigger) no matter what the skill says.
    const trigger = section("agents/publisher.md", "When to trigger");
    expect(trigger).not.toMatch(/clean (working tree|status|tree)/i);
    // What replaces it: evidence over the diff that ships, not a git-state check.
    expect(trigger).toMatch(/fresh `\{\{qualityGate\.full\}\}` evidence over the shipping diff/i);
  });

  it("the leader's pre-flight matches orquestacion's and adds no gate re-run", () => {
    const step = lineWith("agents/orchestrator.md", "Pre-flight on you before invoking");
    expect(step).toContain("{{branchBase}}");
    expect(step).toContain("gh auth status");
    // In R2+ the reviewer already ran the gate over these bytes; asking the
    // orchestrator for a fresh `fast` green duplicates it.
    expect(step).not.toContain("{{qualityGate.fast}}");
    expect(step).toMatch(/no gate re-run on you/i);
  });
});

describe("R1 → PR boundary — defined once, by the agent that applies it (M6)", () => {
  it("the pilot owns the PR side of the delegation rule", () => {
    const pilot = read("agents/publisher.md");
    expect(pilot).toMatch(/this is where the PR side of it is enforced/);
    // The criterion itself stays here — and since #502.3 there is exactly ONE
    // of them (the non-trivial-file count), defined in that same paragraph
    // instead of borrowed. `commit-pr-pilot-contract.test.ts` owns the shape of
    // the definition; what this line pins is that it lives in the pilot.
    // El definiendum "non-trivial" se retiró con la escalera: decidía un waiver
    // por conteo que ya no existe. Vuelve cuando vuelva el ruling, como código
    // compartido y no como prosa (ver leader.md).
    expect(pilot).toContain("delegation was genuinely impossible");
    expect(pilot).toMatch(/an APPROVED review, or a declared impossibility/);
  });

  it("orquestacion apunta a esa excepción con una sola redacción", () => {
    // La escalera se retiró: el bloque ya no enumera rutas ni nombra una
    // excepción por conteo. Lo que debe seguir apuntando al pilot es la
    // salida declarada, que es la única que deja pasar un diff sin review.
    expect(
      lineWith("managed/orquestacion.md", "When delegation is genuinely impossible"),
    ).toBeTruthy();
    expect(read("managed/orquestacion.md")).toContain("`publisher` will require");
  });
});

describe(".claude/progress/ is created, never assumed (F9)", () => {
  // Covers: R6, R7, R8, R9
  it("delegates receipt directory creation to the receipt command", () => {
    const reviewer = read("agents/reviewer.md");
    expect(reviewer).toContain("navori receipt sign");
    expect(reviewer).toContain("--dir .claude/progress");
    expect(reviewer).not.toContain("> .claude/progress/receipt.txt");
  });

  it("the audit pre-flights tolerate an absent directory", () => {
    const agent = read("agents/auditor.md");
    expect(agent, "agents/auditor.md pre-flight assumes the dir exists").toContain(
      "mkdir -p .claude/progress",
    );
    expect(agent).toMatch(/never a pre-flight failure/i);
  });

  it("`mkdir -p` is pre-approved — it's a verb of every handoff", () => {
    const settings = JSON.parse(read("settings/settings-base.json")) as {
      permissions: { allow: string[] };
    };
    expect(settings.permissions.allow).toContain("Bash(mkdir -p:*)");
  });
});

/**
 * #issue agents-background-wait — a gate that outlives the Bash timeout moves
 * to background (per Claude Code docs), and an agent with no wait primitive
 * improvises a `pgrep`/`ps | grep` loop. That loop matches its own command
 * line (it contains the pattern it's polling for) and other sessions'
 * processes too, so it never exits — the reviewer looked stuck for ~10 min
 * with 9 orphaned background tasks.
 *
 * Fix: the three agents that run a quality gate carry `Monitor`/`TaskStop`,
 * `verify-before-done` owns the wait rule, and no asset anywhere prescribes
 * the polling loop.
 */
describe("background-gate wait (no orphaned processes)", () => {
  const GATE_AGENTS = ["reviewer", "implementer", "publisher"];

  it.each(GATE_AGENTS)("%s declares Monitor and TaskStop in its tools", (id) => {
    const body = read(`agents/${id}.md`);
    const toolsLine = lineWith(`agents/${id}.md`, "tools:");
    expect(toolsLine, `${id}.md tools: line missing Monitor`).toContain("Monitor");
    expect(toolsLine, `${id}.md tools: line missing TaskStop`).toContain("TaskStop");
    // The agent must also point to the shared wait rule where it runs the gate.
    expect(body).toContain("verify-before-done/SKILL.md");
  });

  it("verify-before-done carries the background-wait rule and forbids process polling", () => {
    const skill = read("skills/verify-before-done.md");
    expect(skill).toMatch(/run_in_background/);
    expect(skill).toMatch(/Monitor/);
    expect(skill).toMatch(/TaskStop/);
    expect(skill).toMatch(/pgrep/);
  });

  /**
   * Detects the exact anti-pattern that caused the bug: a `until`/`while` loop
   * polling a process table to wait for a command to finish. Scoped to the
   * loop construct (not a bare `pgrep`/`ps | grep` mention) so the rule text
   * in `verify-before-done.md` that names the anti-pattern in prose — to
   * forbid it — doesn't trip its own check.
   */
  const PROCESS_POLL_WAIT = /\b(?:until|while)\b[^\n]*\b(?:pgrep|ps\s+(?:\S+\s+)*\|\s*grep)\b/i;

  function markdownFilesUnder(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...markdownFilesUnder(full));
      else if (entry.name.endsWith(".md")) out.push(full);
    }
    return out;
  }

  it("the detector actually flags a pgrep/ps-grep wait loop (seeded violation)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "navori-poll-check-"));
    try {
      const bad = join(tmp, "seeded.md");
      writeFileSync(bad, "until ! pgrep -f vitest; do sleep 5; done\n");
      expect(PROCESS_POLL_WAIT.test(readFileSync(bad, "utf-8"))).toBe(true);
      const alsoBad = join(tmp, "seeded-ps.md");
      writeFileSync(alsoBad, 'while ps aux | grep -q "pnpm check"; do sleep 5; done\n');
      expect(PROCESS_POLL_WAIT.test(readFileSync(alsoBad, "utf-8"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no distributed asset prescribes a pgrep/ps-grep wait loop", () => {
    const pluginsDir = resolve(coreAssets, "..", "..", "plugins");
    const files = [...markdownFilesUnder(coreAssets), ...markdownFilesUnder(pluginsDir)];
    expect(files.length).toBeGreaterThan(0);
    const offenders = files
      .filter((f) => PROCESS_POLL_WAIT.test(readFileSync(f, "utf-8")))
      .map((f) => f.replace(resolve(coreAssets, "..", "..", ".."), ""));
    expect(offenders).toEqual([]);
  });
});

/**
 * Spec 0026 T12 (R24, R25) — the orchestrator playbook has no route by which
 * the orchestrator edits source itself, and no duplicate design gate that
 * contradicts `solution-design`'s (the orchestrator owns the verdict there,
 * not the user).
 */
// Covers: R24, R25
describe("orchestrator playbook has no inline-edit route and one design gate", () => {
  const playbook = read("agents/orchestrator.md");

  it("carries no brainstorm gate that hands approval to the user", () => {
    expect(playbook).not.toContain("Brainstorm gate");
    expect(playbook).not.toMatch(/Wait for approval of ONE approach/i);
  });

  it("does not let the orchestrator fix a finding itself instead of a fresh implementer", () => {
    expect(playbook).not.toMatch(/Fix a minor finding yourself/i);
  });

  it("does not carve out docs/.claude or a single trivial line as self-editable source", () => {
    expect(playbook).not.toMatch(/Changes in `docs\/`, `\.claude\/progress\/`, `CLAUDE\.md`/);
    expect(playbook).not.toMatch(/A single trivial line in a known file/i);
  });
});

/**
 * Spec 0026 T14 (R29, R30) — `debug-failure` merges `debug-error` and
 * `loop-back-debug` into one cycle. R30's step 6 is the fact this test pins:
 * the escalation channel after two failed attempts depends on WHERE the skill
 * runs, because a subagent has no `AskUserQuestion` — `loop-back-debug.md:60`
 * used to tell `implementer` (a subagent) to ask the user directly, a route
 * that skill literally cannot take.
 */
describe("debug-failure escalates through BLOCKED inside a subagent", () => {
  const skill = read("skills/debug-failure.md");

  // Covers: R29
  it("debug-failure ships as the single core debug skill, no leftover split", () => {
    expect(existsSync(resolve(coreAssets, "skills/debug-failure.md"))).toBe(true);
    expect(existsSync(resolve(coreAssets, "skills/debug-error.md"))).toBe(false);
    expect(existsSync(resolve(coreAssets, "skills/loop-back-debug.md"))).toBe(false);
  });

  // Covers: R30
  it("names both escalation channels and ties each to where it runs", () => {
    expect(skill).toMatch(/inside a subagent/i);
    expect(skill).toMatch(/no `AskUserQuestion`/);
    expect(skill).toMatch(/report `BLOCKED`/);
    expect(skill).toMatch(/in the main agent/i);
    expect(skill).toMatch(/ask the user directly/i);
  });

  // Covers: R30
  it("gates escalation on two failed attempts, not one", () => {
    expect(skill).toMatch(/two failed attempts/i);
  });

  // Covers: R30
  it("implementer (a subagent) cites debug-failure, not the retired debug-error/loop-back-debug ids", () => {
    const implementer = read("agents/implementer.md");
    expect(implementer).toContain(".claude/skills/debug-failure/SKILL.md");
    expect(implementer).not.toContain("debug-error/SKILL.md");
    expect(implementer).not.toContain("loop-back-debug/SKILL.md");
  });
});
