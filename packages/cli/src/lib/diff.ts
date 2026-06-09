/**
 * Minimal line-level diff renderer for terminal output.
 * Not Myers diff — just a sequential a/b comparison good enough for
 * showing a "your version" vs "core version" side-by-side hint.
 */
export function formatLineDiff(
  current: string | null,
  proposed: string | null,
  options: { context?: number } = {},
): string {
  const a = (current ?? "").split("\n");
  const b = (proposed ?? "").split("\n");
  const max = Math.max(a.length, b.length);
  const lines: string[] = [];
  for (let i = 0; i < max; i++) {
    const ai = a[i] ?? "";
    const bi = b[i] ?? "";
    if (ai === bi) {
      lines.push(`   ${ai}`);
    } else {
      if (i < a.length) lines.push(`- ${ai}`);
      if (i < b.length) lines.push(`+ ${bi}`);
    }
  }
  return lines.join("\n");
}
