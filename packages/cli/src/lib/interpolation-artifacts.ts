/**
 * Interpolation artifacts frozen in the rendered tree (#440).
 *
 * A rendered file's user zone is written ONCE: `renderManagedFile` interpolates
 * the user template only on the fresh-file branch, and `rerender` never receives
 * it (engines/shared/render-managed-file.ts:73-95). That's the contract — the
 * zone belongs to the user and re-interpolating it would overwrite what they
 * wrote — but it has a consequence nothing checked: any token the user zone
 * inherited from an interpolator bug stays there FOREVER, and fixing the
 * interpolator never reaches an already-onboarded repo, no matter how often it
 * re-renders.
 *
 * Measured case: after #375 this repo's own mirror still carried 9
 * `<not configured: project.*>` tokens in the user zones of its rendered agents
 * and skills. They were fixed by hand in that PR; every other onboarded repo is
 * still broken and nothing tells them.
 *
 * So: detect and warn, never rewrite. The strings we look for are DERIVED from
 * `placeholderFallback` (not copied) so a change to a fallback keeps the check
 * honest instead of silently blind.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NavoriConfig } from "./config.ts";
import { collectMarkerFiles } from "./health.ts";
import { DEFAULT_LANG, SUPPORTED_LANGS } from "./i18n.ts";
import { placeholderFallback } from "./placeholders.ts";

export type ArtifactReason =
  /** The hard fallback: a `{{path}}` that resolved to nothing reached the prose. */
  | "unresolved-placeholder"
  /** The soft fallback for `qualityGate.*`: published prose saying "not configured". */
  | "unconfigured-gate";

export interface InterpolationArtifact {
  /** Repo-relative path of the rendered file. */
  path: string;
  /** 1-based line number, so the user can jump straight to it. */
  line: number;
  /** The exact text found — greppable, and it names the unresolved path. */
  token: string;
  reason: ArtifactReason;
}

/**
 * A placeholder path no config declares and `SOFT_FALLBACKS` has no entry for,
 * so whatever `placeholderFallback` returns for it IS the hard fallback's shape.
 * Learning it at runtime is the whole point of the check: a change to the
 * fallback's wording must not need an edit here to keep being detected.
 */
const PROBE_PATH = "navoriDoctorProbePath";

/**
 * Config paths whose soft fallback is a DIAGNOSTIC rather than a generic default.
 * `placeholders.ts` draws that line itself: `project.criticalAreas` /
 * `project.legacyPaths` render "the sensible baseline list every repo has"
 * (legitimate published prose), while the `qualityGate.*` ones read
 * "run 'navori configure quality-gate'" — in a published file that means the
 * same thing the hard fallback does: the config was never filled in.
 */
const DIAGNOSTIC_SOFT_PATHS = ["qualityGate.fast", "qualityGate.full"] as const;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A matcher for the hard fallback, derived from `placeholderFallback` by probing
 * it with a path that has no soft entry and reading the shape it wraps around it
 * (today `<not configured: …>`). Returns null when the shape carries no prefix or
 * no suffix to anchor on — matching a bare path would flag half the prose.
 */
function hardFallbackMatcher(): RegExp | null {
  const sample = placeholderFallback(PROBE_PATH, DEFAULT_LANG);
  const at = sample.indexOf(PROBE_PATH);
  if (at <= 0) return null;
  const prefix = sample.slice(0, at);
  const suffix = sample.slice(at + PROBE_PATH.length);
  if (suffix === "") return null;
  return new RegExp(`${escapeRegExp(prefix)}[^\\n]*?${escapeRegExp(suffix)}`, "g");
}

/**
 * The distinct soft-fallback strings worth reporting. One that no longer has a
 * soft entry renders the hard shape instead, which `hard` already matches — so
 * it's dropped here rather than reported twice.
 *
 * EVERY supported locale is probed, not `config.language` (#445). What we look
 * for was written in the PAST — a frozen user zone keeps the wording of the
 * render that created it — so a repo that started in `es` and later switched to
 * `en` still carries the Spanish token, and scanning only the current locale
 * would go blind on exactly the repos this check exists for.
 */
function diagnosticSoftTokens(hard: RegExp | null): string[] {
  const probe = hard === null ? null : new RegExp(hard.source);
  const tokens = new Set<string>();
  for (const lang of SUPPORTED_LANGS) {
    for (const path of DIAGNOSTIC_SOFT_PATHS) {
      const text = placeholderFallback(path, lang);
      if (probe?.test(text)) continue;
      tokens.add(text);
    }
  }
  return [...tokens];
}

/**
 * Every interpolation artifact published in the rendered tree of the configured
 * engines — managed zone AND user zone alike, since the user zone is precisely
 * where `render` can no longer help.
 *
 * Scope is `collectMarkerFiles`: the files navori itself renders, per engine.
 * Ephemeral handoffs (`.claude/progress`, `.claude/worktrees`) are outside that
 * table by construction, which is what keeps an agent report quoting a token
 * from being reported as one.
 */
export function scanInterpolationArtifacts(
  cwd: string,
  config: NavoriConfig,
): InterpolationArtifact[] {
  const hard = hardFallbackMatcher();
  const soft = diagnosticSoftTokens(hard);
  if (hard === null && soft.length === 0) return [];

  const out: InterpolationArtifact[] = [];
  const seen = new Set<string>();
  const push = (artifact: InterpolationArtifact): void => {
    const key = `${artifact.path}:${artifact.line}:${artifact.token}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(artifact);
  };

  for (const { path } of collectMarkerFiles(cwd, undefined, config.engines)) {
    let content: string;
    try {
      content = readFileSync(join(cwd, path), "utf-8");
    } catch {
      continue; // unreadable — doctor never fails over a read
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (hard !== null) {
        for (const match of text.matchAll(hard)) {
          push({ path, line: i + 1, token: match[0], reason: "unresolved-placeholder" });
        }
      }
      for (const token of soft) {
        if (text.includes(token)) {
          push({ path, line: i + 1, token, reason: "unconfigured-gate" });
        }
      }
    }
  }
  return out;
}
