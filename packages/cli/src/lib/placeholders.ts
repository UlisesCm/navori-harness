/**
 * Fallback text for an unresolved `{{path}}` placeholder, shared by both
 * interpolators (lib/render-plan for CLAUDE.md managed blocks, and
 * engines/claude/interpolate for agents/skills files).
 *
 * Known-optional paths (qualityGate.*) render prose that points at the fix:
 * templates reference them inline as commands (e.g. `corre \`{{qualityGate.fast}}\``),
 * so a raw `<not configured: qualityGate.fast>` reads like a command to run.
 * Everything else keeps the `<not configured: path>` hint — still useful for
 * spotting a typo'd placeholder in a template.
 */
const SOFT_FALLBACKS: Record<string, string> = {
  "qualityGate.fast": "(quality gate sin configurar — corre 'navori configure quality-gate')",
  "qualityGate.full": "(quality gate sin configurar — corre 'navori configure quality-gate')",
};

export function placeholderFallback(path: string): string {
  return SOFT_FALLBACKS[path] ?? `<not configured: ${path}>`;
}
