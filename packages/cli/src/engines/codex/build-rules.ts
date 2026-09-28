import type { ShellPermissionRules } from "../shared/permission-rules.ts";

/**
 * Spec 0035 D5/T6 (R9, R10) — translates the shell `Bash(<pattern>)` `ask`/
 * `deny` entries `collectShellPermissionRules` returns into Codex's
 * `.codex/rules/navori.rules` (`prefix_rule(pattern=[...], decision=...)`,
 * confirmed against `codex-rs/execpolicy/README.md` in `rust-v0.157.0`:
 * `.rules` is the real extension — `codex_home.join("rules").join(
 * "default.rules")` in `core/src/exec_policy.rs` and every
 * `core/tests/suite/*.rs` fixture agree, `.codexpolicy` in
 * `execpolicy/examples/` is illustrative only — comments use `#`, and
 * `prefix_rule` ALWAYS matches as a prefix regardless of how the pattern was
 * derived: `pattern=["git","status"]` still matches `git status -sb`.
 *
 * `allow` is NEVER translated (review finding, Lote C round 1): in Codex, a
 * command matching an `allow` rule runs **outside the sandbox**
 * (`core/src/exec_policy.rs`: `Decision::Allow` →
 * `ExecApprovalRequirement::Skip { bypass_sandbox }`). Under Claude, `allow`
 * only skips the confirmation prompt — the two are not the same axis.
 * Translating the allow-list could also bypass a prompt the active runtime
 * would otherwise require. The adapter's `danger-full-access` default does
 * not make an `allow` rule safe or restore the old workspace sandbox.
 * Allow entries are skipped by DESIGN, not by failure — they never reach
 * `translatePattern` and never count toward `dropped`.
 *
 * Because matching is always-prefix, the only real translation decision left
 * is WHICH TOKENS survive, not "prefix vs exact":
 *
 *   - ask→prompt, deny→forbidden.
 *   - A trailing ` *` or `:*` means "whatever follows" and is simply dropped —
 *     `Bash(git reset --hard:*)` → `["git", "reset", "--hard"]`.
 *   - A pattern with NO wildcard at all (Claude compares it exact) still
 *     becomes a prefix rule, because `prefix_rule` always compares by prefix.
 *     That is STRICTER than Claude for `prompt`/`forbidden` — safe,
 *     uncounted.
 *   - A `*` glued to the LAST token (`Bash(git push --force*)`,
 *     `Bash(rm -rf /*)`) is replaced by the exact token without the
 *     asterisk. Claude's glued form also matches token variants sharing the
 *     prefix (`--force-with-lease` for `--force*`, `/usr` for `/*`); Codex's
 *     tokenizer does not, so the translated rule only matches the literal
 *     token — LESS strict than Claude, since a variant that should have
 *     prompted/forbidden now falls through this rule entirely. Reported as
 *     "narrowed" in the aggregated warning; `guard-destructive` still
 *     catches those variants at hook time regardless.
 *   - Any wildcard (`*`, `?`, `[`) left anywhere else means the pattern can't
 *     be expressed as a token prefix; the rule is dropped (R10).
 *   - A rule that isn't `Bash(...)` (`Agent(orchestrator)`, …) is dropped
 *     (R10) — Codex's rules file only governs terminal commands.
 */

export interface DroppedCodexRule {
  readonly pattern: string;
  readonly reason: "not-bash" | "inner-wildcard";
}

export interface NarrowedCodexRule {
  readonly pattern: string;
  readonly decision: "prompt" | "forbidden";
}

export interface CodexRulesResult {
  readonly body: string;
  readonly dropped: readonly DroppedCodexRule[];
  readonly narrowed: readonly NarrowedCodexRule[];
}

/** `allow` is excluded entirely (see module doc) — this is the decision space
 *  a rule can actually translate to. */
type TranslatedDecision = "prompt" | "forbidden";

interface Translated {
  readonly tokens: readonly string[];
  readonly narrowed: boolean;
}

/** D4 (R5): what `pr-publisher-confirm` used to ask under Claude — Codex hooks
 *  can't emit `ask`, so the confirmation moves here as a standing rule. */
const GH_PR_CREATE_RULE = {
  tokens: ["gh", "pr", "create"] as const,
  decision: "prompt" as const,
  justification: "Confirma antes de publicar un PR (reemplaza pr-publisher-confirm).",
};

const BASH_RE = /^Bash\((.*)\)$/;
/** Any character that still needs Claude's glob semantics Codex can't express
 *  as a literal token prefix. */
const WILDCARD_RE = /[*?[]/;

/**
 * Translate one `Bash(<pattern>)` permission string (always `ask` or `deny`
 * — never `allow`, see module doc) into its token sequence, or `null` if it
 * can't be expressed as a Codex prefix rule (R10) — the caller records the
 * drop with its reason.
 */
function translatePattern(pattern: string): Translated | null {
  const match = BASH_RE.exec(pattern);
  if (!match) return null; // not-bash — caller records the reason
  let inner = match[1] ?? "";
  let narrowed = false;

  if (inner.endsWith(" *")) {
    inner = inner.slice(0, -2);
  } else if (inner.endsWith(":*")) {
    inner = inner.slice(0, -2);
  } else {
    const lastSpace = inner.lastIndexOf(" ");
    const lastToken = lastSpace === -1 ? inner : inner.slice(lastSpace + 1);
    // A `*` glued directly onto the last token (no preceding space/colon,
    // already ruled out above) and nowhere else inside that token.
    if (lastToken.length > 1 && lastToken.endsWith("*") && !lastToken.slice(0, -1).includes("*")) {
      inner = inner.slice(0, -1);
      narrowed = true; // always reported now — the only decisions left are prompt/forbidden
    }
  }

  if (WILDCARD_RE.test(inner)) return null; // inner-wildcard — caller records the reason

  const tokens = inner.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;
  return { tokens, narrowed };
}

function starlarkString(value: string): string {
  return JSON.stringify(value);
}

function serializeRule(
  tokens: readonly string[],
  decision: TranslatedDecision,
  justification?: string,
): string {
  const lines = [
    "prefix_rule(",
    `    pattern = [${tokens.map(starlarkString).join(", ")}],`,
    `    decision = ${starlarkString(decision)},`,
  ];
  if (justification) lines.push(`    justification = ${starlarkString(justification)},`);
  lines.push(")");
  return lines.join("\n");
}

/**
 * `.codex/rules/navori.rules` body (no managed-marker header — the render
 * pipeline's `renderManagedFile` adds that, same as `config.toml`) plus the
 * drop/narrow ledger the render's aggregated warning (R10) and `--json`
 * consumers read. `rules.allow` is intentionally never read — see the module
 * doc (translating it would run commands outside Codex's sandbox).
 */
export function buildCodexRules(rules: ShellPermissionRules): CodexRulesResult {
  const dropped: DroppedCodexRule[] = [];
  const narrowed: NarrowedCodexRule[] = [];
  // Dedupe identical (tokens, decision) pairs — several Claude patterns can
  // translate to the same Codex rule (e.g. `git tag -l*` / `git tag --list*`
  // stay distinct, but a repeated source pattern would not).
  const seen = new Set<string>();
  const blocks: string[] = [];

  const layers: ReadonlyArray<{ patterns: readonly string[]; decision: TranslatedDecision }> = [
    { patterns: rules.ask, decision: "prompt" },
    { patterns: rules.deny, decision: "forbidden" },
  ];

  for (const { patterns, decision } of layers) {
    for (const pattern of patterns) {
      const translated = translatePattern(pattern);
      if (!translated) {
        const reason: DroppedCodexRule["reason"] = BASH_RE.test(pattern)
          ? "inner-wildcard"
          : "not-bash";
        dropped.push({ pattern, reason });
        continue;
      }
      if (translated.narrowed) {
        narrowed.push({ pattern, decision });
      }
      const key = `${decision}:${JSON.stringify(translated.tokens)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      blocks.push(serializeRule(translated.tokens, decision));
    }
  }

  blocks.push(
    serializeRule(
      [...GH_PR_CREATE_RULE.tokens],
      GH_PR_CREATE_RULE.decision,
      GH_PR_CREATE_RULE.justification,
    ),
  );

  return { body: blocks.join("\n\n") + "\n", dropped, narrowed };
}
