import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * #506 — **if an asset orders a command, the settings must pre-approve it.**
 *
 * The harness's prose and hooks tell the agent to run things (`navori doctor` at
 * session start, `navori audit --start` from a hook, `jscpd` and `semgrep`
 * before approving a change). None of them was in `permissions.allow`, so every
 * one of them opened a prompt — and the harness's own circuit-breaker rule
 * ("permission not pre-approved → 0 retries, stop") tells the agent to abandon
 * the flow. A gate the harness orders and the harness itself blocks is a gate
 * that does not exist: jscpd and semgrep never ran.
 *
 * This test is the automatic cross-check the issue asks for, and it is the same
 * family as #499 (`git push`) and #490 (an asset citing an unpublished
 * subcommand): the asset promises something the environment does not deliver.
 *
 * WHAT IT READS — the rendered tree, because that is what an agent actually
 * loads: `CLAUDE.md`, `.claude/agents/*.md`, `.claude/skills/**.md`,
 * `.claude/hooks/*.sh`, `.claude/context/*.md`, checked against
 * `.claude/settings.json`.
 *
 * SCOPE, and why each boundary is drawn where it is:
 *
 *  - **Managed regions only.** navori can only fix what navori generates; a
 *    repo's own prose is the repo's business (and per-machine permissions belong
 *    in the gitignored `settings.local.json`).
 *  - **A vocabulary of binaries, derived — not hardcoded.** `navori` (the CLI
 *    this repo ships), `git`, the configured package manager, and the
 *    `externalTool.checkBinary` of every ENABLED plugin. Nothing here reads the
 *    allowlist, so the check cannot pass by construction; and a new plugin that
 *    declares a tool is covered the day it lands.
 *  - **Citations, not prose.** In markdown, only code spans and fenced shell
 *    blocks; in hooks, only the double-quoted message strings the hook injects
 *    into the agent's context (a hook's own shell never passes through the
 *    permission layer, and its `#` comments are notes to a human).
 *
 * KNOWN BOUNDARY: the vocabulary means a shell utility cited inside an example
 * (`xargs`, `sed`) is not judged. Widening to "every leading token in every
 * fenced block" was measured at 425 false positives — shell keywords and JS —
 * and the stopword list needed to tame it would be so broad the check could no
 * longer fail. Precision was chosen over reach on purpose.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/cli/src/__tests__ → repo root is four levels up.
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

/** A command an asset orders, with every rendered file that orders it. */
type Citations = Map<string, Set<string>>;

function walk(dir: string, match: RegExp, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, match, out);
    else if (match.test(entry)) out.push(abs);
  }
  return out;
}

function renderedAssets(): string[] {
  return [
    join(REPO_ROOT, "CLAUDE.md"),
    ...walk(join(REPO_ROOT, ".claude", "agents"), /\.md$/),
    ...walk(join(REPO_ROOT, ".claude", "skills"), /\.md$/),
    ...walk(join(REPO_ROOT, ".claude", "hooks"), /\.sh$/),
    // Blocks routed to the orchestrator (spec 0015, #573). They left CLAUDE.md
    // but they still ORDER commands, and the SessionStart hook still delivers
    // them — so leaving this directory out of the scan would silently retire
    // the check for every command the routing doctrine gives.
    ...walk(join(REPO_ROOT, ".claude", "context"), /\.md$/),
  ].filter(existsSync);
}

const HTML_OPEN = /<!--\s*navori:managed\s+id="([^"]+)"[^>]*-->/g;
const SHELL_OPEN = /#\s*navori:managed\s+start\s+id="([^"]+)"/g;
const USER_SECTION = "<!-- navori:user-section -->";

/**
 * The slices of a rendered file that navori owns. Marker blocks when the file
 * has them (CLAUDE.md, hooks); otherwise everything before the user-section
 * sentinel (agents and skills, which are managed whole).
 */
function managedRegions(text: string, style: "html" | "shell"): string[] {
  const open = style === "shell" ? SHELL_OPEN : HTML_OPEN;
  const out: string[] = [];
  open.lastIndex = 0;
  let match: RegExpExecArray | null = open.exec(text);
  while (match !== null) {
    const id = match[1] ?? "";
    const close =
      style === "shell" ? `# navori:managed end id="${id}"` : `<!-- /navori:managed id="${id}" -->`;
    const start = match.index + match[0].length;
    const end = text.indexOf(close, start);
    out.push(text.slice(start, end < 0 ? text.length : end));
    match = open.exec(text);
  }
  if (out.length > 0) return out;
  const cut = text.indexOf(USER_SECTION);
  return [cut < 0 ? text : text.slice(0, cut)];
}

const SHELL_FENCE_LANGS = new Set(["", "bash", "sh", "shell", "console", "zsh"]);

/**
 * Code the markdown presents as such: inline `spans` plus the lines of fenced
 * shell blocks. Comment lines and trailing `# …` comments are dropped — a
 * comment describes a command, it does not order one.
 */
function markdownCitations(region: string): string[] {
  const spans: string[] = [];
  let fenceLang: string | null = null;
  for (const line of region.split("\n")) {
    const fence = line.match(/^\s*(?:```|~~~)\s*([a-zA-Z0-9]*)/);
    if (fence) {
      fenceLang = fenceLang === null ? (fence[1] ?? "").toLowerCase() : null;
      continue;
    }
    if (fenceLang !== null) {
      if (!SHELL_FENCE_LANGS.has(fenceLang) || /^\s*#/.test(line)) continue;
      spans.push(line.replace(/\s+#\s.*$/, ""));
      continue;
    }
    for (const inline of line.matchAll(/`([^`]+)`/g)) spans.push(inline[1] ?? "");
  }
  return spans;
}

/** A hook's agent-facing message strings — what it injects into the context. */
function hookCitations(region: string): string[] {
  const spans: string[] = [];
  for (const line of region.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    for (const str of line.matchAll(/"((?:[^"\\]|\\.)*)"/g)) spans.push(str[1] ?? "");
  }
  return spans;
}

interface NavoriConfigShape {
  packageManager?: string;
  plugins?: Record<string, { enabled?: boolean } | undefined>;
}

/**
 * The binaries whose citations are judged: navori itself, git, the configured
 * package manager, and the external tool of every enabled plugin. Derived from
 * the config and the manifests — never from the allowlist this check validates.
 */
function commandVocabulary(): Set<string> {
  const config = JSON.parse(
    readFileSync(join(REPO_ROOT, "navori.config.json"), "utf-8"),
  ) as NavoriConfigShape;
  const vocab = new Set(["navori", "git"]);
  if (config.packageManager) vocab.add(config.packageManager);
  for (const [id, entry] of Object.entries(config.plugins ?? {})) {
    if (entry?.enabled === false) continue;
    const manifestPath = join(REPO_ROOT, "packages", "plugins", id, "plugin.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      externalTool?: { checkBinary?: string };
    };
    const binary = manifest.externalTool?.checkBinary;
    if (binary) vocab.add(binary);
  }
  return vocab;
}

/** Subcommands the CLI registers — the same parse `check-asset-commands.mjs` does. */
function navoriSubcommands(): Set<string> {
  const source = readFileSync(join(REPO_ROOT, "packages/cli/src/index.ts"), "utf-8");
  const block = source.match(/subCommands:\s*\{([\s\S]*?)\n\s*\},/)?.[1] ?? "";
  return new Set([...block.matchAll(/^\s*([a-z][\w-]*)\s*:/gm)].map((m) => m[1] ?? ""));
}

// Where a captured command ends: shell operators, quoting, substitution,
// brackets and the em-dash/ellipsis that only ever appear in prose.
const COMMAND_END = /[`"'|&;)(<>$\n[\]{}#,\\]|\s—|…|\.\.\./;
// An argument or subcommand — lowercase-initial, no path separator. Anything
// else after the binary means the sentence was prose ("git C-quotes a path…").
const ARGUMENT = /^(--?[a-z0-9][\w.:=-]*|[a-z][\w.:=-]*)$/;

/**
 * Read one invocation out of a citation, starting at the binary. Returns null
 * when what follows is not an invocation: a bare mention, an English sentence,
 * or (for navori) a token that is not a registered subcommand — which is what
 * keeps log prefixes like `[navori audit-mode]` out of the results.
 */
function captureCommand(
  span: string,
  binary: string,
  at: number,
  subcommands: Set<string>,
): string | null {
  const rest = span.slice(at);
  const end = rest.search(COMMAND_END);
  const raw = (end < 0 ? rest : rest.slice(0, end)).trim().replace(/\s+/g, " ");
  const tokens = raw.replace(/[.,:;!?*]+$/, "").split(" ");
  const first = tokens[1];
  if (tokens.length < 2 || first === undefined) return null;
  if (!ARGUMENT.test(first)) return null;
  if (binary === "navori" && !subcommands.has(first)) return null;
  return tokens.join(" ");
}

function collectCitations(): Citations {
  const vocab = commandVocabulary();
  const subcommands = navoriSubcommands();
  const found: Citations = new Map();
  for (const file of renderedAssets()) {
    const isHook = file.endsWith(".sh");
    const text = readFileSync(file, "utf-8");
    for (const region of managedRegions(text, isHook ? "shell" : "html")) {
      const spans = isHook ? hookCitations(region) : markdownCitations(region);
      for (const span of spans) {
        for (const binary of vocab) {
          const re = new RegExp(`(?<![\\w./:-])${binary}(?![\\w./:\\]-])`, "g");
          let hit: RegExpExecArray | null = re.exec(span);
          while (hit !== null) {
            const command = captureCommand(span, binary, hit.index, subcommands);
            if (command !== null) {
              const where = found.get(command) ?? new Set<string>();
              where.add(file.slice(REPO_ROOT.length + 1));
              found.set(command, where);
            }
            hit = re.exec(span);
          }
        }
      }
    }
  }
  return found;
}

/**
 * Claude Code's permission-rule semantics, as the settings use them:
 * `Bash(x:*)` covers `x` and anything after it, `Bash(x*)` is a raw prefix, and
 * a bare `Bash(x)` is exact. Rules match the command from its first character,
 * which is why `Bash(git diff*)` does NOT cover `git -c k=v diff`.
 */
function ruleMatches(command: string, rule: string): boolean {
  const inner = rule.match(/^Bash\((.*)\)$/)?.[1];
  if (inner === undefined) return false;
  if (inner.endsWith(":*")) {
    const prefix = inner.slice(0, -2);
    return command === prefix || command.startsWith(`${prefix} `);
  }
  if (inner.endsWith("*")) return command.startsWith(inner.slice(0, -1));
  return command === inner;
}

interface RenderedPermissions {
  allow: string[];
  ask: string[];
  deny: string[];
}

function renderedPermissions(): RenderedPermissions {
  const settings = JSON.parse(
    readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf-8"),
  ) as { permissions?: Partial<RenderedPermissions> };
  return {
    allow: settings.permissions?.allow ?? [],
    ask: settings.permissions?.ask ?? [],
    deny: settings.permissions?.deny ?? [],
  };
}

/**
 * Commands an asset orders that are deliberately NOT pre-approved. Each entry is
 * a command prefix plus the reason it stays behind a prompt. Short and audited
 * on purpose: a test below fails if an entry stops matching any citation, so the
 * list can never quietly grow into a filter that makes the check unfailable.
 */
const EXPECTED_PROMPTS: ReadonlyArray<readonly [string, string]> = [
  [
    "codegraph init",
    "belongs to the codegraph plugin's settingsFragment, not to core settings — same class as #506, reported separately",
  ],
  [
    "codegraph sync",
    "belongs to the codegraph plugin's settingsFragment, not to core settings — same class as #506, reported separately",
  ],
  [
    "gh api",
    "the same call POSTs, PATCHes and DELETEs; a prefix rule cannot pin the HTTP method, so arbitrary repo writes would ride along",
  ],
  ["gh auth login", "interactive credential flow — the prose addresses the human, not the agent"],
  [
    "git checkout",
    "cited as a CAUSE of drift, not ordered; a bare checkout discards local changes, so only `git checkout -b` is pre-approved",
  ],
  [
    "git grep",
    "`git grep -O<pager>` runs an arbitrary pager — the same escape that keeps `rg --pre` and `find -exec` out of the allowlist",
  ],
  [
    "git worktree remove",
    "deletes a full checkout; the orchestrator block orders asking the user first, so the prompt IS the intended gate",
  ],
  [
    "git worktree prune",
    "the other half of the worktree cleanup the user must confirm — see `git worktree remove`",
  ],
  ["navori configure", "writes navori.config.json — a config mutation stays behind the prompt"],
  ["navori dominio reindex", "rewrites DOMINIO.md in the workspace — a write, not a read"],
  [
    "navori sync",
    "reconciles managed blocks against the user's edits — the resolution is a write, and which side wins is the user's call (#530)",
  ],
  [
    "navori render --apply",
    "rewrites the harness mirror in the user's repo — the write the whole managed-block guard exists to route through a decision, so the prompt IS the gate (#530)",
  ],
];

function isExpectedPrompt(command: string): string | null {
  for (const [prefix, why] of EXPECTED_PROMPTS) {
    if (command === prefix || command.startsWith(`${prefix} `)) return why;
  }
  return null;
}

const citations = collectCitations();
const permissions = renderedPermissions();

describe("assets order only commands the settings pre-approve (#506)", () => {
  // ---- anti-false-green ---------------------------------------------------
  // A check that found nothing is indistinguishable from a broken one, so the
  // machinery is pinned before the verdict. #504's lesson, applied to the case
  // it missed: the check must not be able to SKIP ITSELF either — nothing here
  // returns early on a missing file, it fails.

  it("scans the rendered tree it claims to scan", () => {
    const files = renderedAssets().map((f) => f.slice(REPO_ROOT.length + 1));
    expect(files, "CLAUDE.md must be scanned — it is where the gates are ordered").toContain(
      "CLAUDE.md",
    );
    expect(files.filter((f) => f.startsWith(".claude/agents/")).length).toBeGreaterThanOrEqual(5);
    expect(files.filter((f) => f.startsWith(".claude/skills/")).length).toBeGreaterThanOrEqual(5);
    expect(files.filter((f) => f.startsWith(".claude/hooks/")).length).toBeGreaterThanOrEqual(3);
  });

  it("reads real managed regions, not an empty slice", () => {
    const claudeMd = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf-8");
    const regions = managedRegions(claudeMd, "html");
    expect(regions.length, "CLAUDE.md must expose several managed blocks").toBeGreaterThan(3);
    expect(regions.some((r) => r.includes("semgrep"))).toBe(true);
  });

  it("derives a vocabulary that covers the CLI and the enabled plugins", () => {
    const vocab = commandVocabulary();
    for (const binary of ["navori", "git", "jscpd", "semgrep"]) expect(vocab).toContain(binary);
    expect(navoriSubcommands().size).toBeGreaterThanOrEqual(15);
  });

  it("extracts the commands the harness is known to order", () => {
    // If the extractor breaks, THIS is what tells you — not a green verdict.
    const commands = [...citations.keys()];
    expect(
      commands.length,
      "no command extracted at all — the extractor is broken",
    ).toBeGreaterThan(20);
    for (const known of [
      "navori doctor", // CLAUDE.md, session-startup block
      // `navori audit --start` used to be here, ordered by audit-mode-trigger.sh.
      // Spec 0013 removed that message: the hook no longer proposes activating
      // audit-mode from the prompt text, so no asset orders the command any more.
      // The permission rule for it stays in settings.json — the operator still
      // runs it by hand — but this canary tracks what ASSETS order, not what is
      // allowed.
      "jscpd --silent", // CLAUDE.md, duplication gate
      "semgrep scan --config=p/default --error --metrics=off", // CLAUDE.md, security gate
      "git push -u origin HEAD", // commit-pr-pilot.md, PR flow step 4 (#499)
    ]) {
      expect(commands, `the extractor no longer finds "${known}"`).toContain(known);
    }
  });

  it("matches rules the way Claude Code does — including the cases that must NOT match", () => {
    // The negative controls: without them a matcher that returns true for
    // everything would make the verdict below vacuous.
    expect(ruleMatches("git status --short", "Bash(git status*)")).toBe(true);
    expect(ruleMatches("navori doctor", "Bash(navori doctor:*)")).toBe(true);
    expect(ruleMatches("navori doctorx", "Bash(navori doctor:*)")).toBe(false);
    expect(ruleMatches("totally-unapproved --run", "Bash(git status*)")).toBe(false);
    // The exact miss that made the reviewer's own command prompt (#506).
    expect(ruleMatches("git -c core.quotepath=false diff", "Bash(git diff*)")).toBe(false);
    expect(permissions.allow.length, "the rendered allowlist is empty").toBeGreaterThan(30);
  });

  // ---- the cross-check ----------------------------------------------------

  it("every command a managed asset orders is pre-approved, gated or documented", () => {
    const violations: string[] = [];
    for (const [command, where] of [...citations].sort()) {
      if (permissions.allow.some((rule) => ruleMatches(command, rule))) continue;
      // Cited as an example of what the harness BLOCKS (`git reset --hard`):
      // landing in ask/deny is the intended outcome, not a gap.
      if (permissions.ask.some((rule) => ruleMatches(command, rule))) continue;
      if (permissions.deny.some((rule) => ruleMatches(command, rule))) continue;
      if (isExpectedPrompt(command) !== null) continue;
      violations.push(`  "${command}"\n      ordered by ${[...where].sort().join(", ")}`);
    }
    expect(
      violations,
      [
        "",
        "  These commands are ordered by a managed asset but no allow rule covers them.",
        "  Every one of them opens a prompt, and the harness's circuit-breaker rule",
        "  tells the agent to STOP at a prompt — so the instruction that orders them",
        "  is dead on arrival (#506).",
        "",
        "  Fix one of two ways:",
        "    - add a scoped rule to packages/core/core-assets/settings/settings-base.json",
        "      (enumerate read-only subcommands; never wildcard a binary that writes), or",
        "    - if it must keep prompting, add it to EXPECTED_PROMPTS with the reason.",
        "",
        violations.join("\n"),
        "",
      ].join("\n"),
    ).toEqual([]);
  });

  it("keeps the documented-prompt list short and alive", () => {
    // A stale entry hides nothing and silently widens the filter, so it must be
    // deleted. This is what stops EXPECTED_PROMPTS from becoming the escape
    // hatch that makes the check unfailable.
    const stale = EXPECTED_PROMPTS.filter(
      ([prefix]) =>
        ![...citations.keys()].some((cmd) => cmd === prefix || cmd.startsWith(`${prefix} `)),
    ).map(([prefix]) => prefix);
    expect(stale, `no asset orders these any more — delete them: ${stale.join(", ")}`).toEqual([]);
    expect(EXPECTED_PROMPTS.length, "the exception list is growing into a filter").toBeLessThan(15);
    for (const [prefix, why] of EXPECTED_PROMPTS) {
      expect(why.length, `${prefix} needs a real reason, not a placeholder`).toBeGreaterThan(30);
    }
  });
});

describe("the rendered allowlist never pre-approves `sg` (#495)", () => {
  it("carries no `sg` rule — on Linux that is shadow-utils, not ast-grep", () => {
    // The source asset is covered by build-settings.test.ts; this is the mirror
    // every onboarded repo actually loads, and the render is what propagates the
    // fix. `sg <group> -c "<command>"` executes an arbitrary command through
    // /bin/sh, so the rule would pre-approve everything deny/guard exist to stop.
    const offenders = permissions.allow.filter((rule) => /^Bash\(\s*sg\b/.test(rule));
    expect(offenders, `remove ${offenders.join(", ")} — spell \`ast-grep\` instead`).toEqual([]);
    expect(permissions.allow).toContain("Bash(ast-grep:*)");
  });
});
