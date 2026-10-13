/** End-of-line helpers. Dependency-free so any layer can use them. */

export type Eol = "\n" | "\r\n";

/** Converts CRLF and lone CR line endings to LF. */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Detects which EOL `text` uses: `"\r\n"` when the first line break is CRLF,
 * `"\n"` otherwise (LF, lone CR or no line break at all).
 */
export function detectEol(text: string): Eol {
  const i = text.indexOf("\n");
  return i > 0 && text[i - 1] === "\r" ? "\r\n" : "\n";
}
