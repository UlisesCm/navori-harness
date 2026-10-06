import { Rolldown, type TsdownPlugin } from "tsdown";

type Parse = (code: string) => unknown;
type Span = readonly [number, number];
const positions = new Set(["start", "end", "loc", "range", "raw"]);

/** Compare executable structure independently of positions and literal spelling. */
function semanticJson(ast: unknown): string {
  return JSON.stringify(ast, (key: string, value: unknown): unknown =>
    positions.has(key) ? undefined : typeof value === "bigint" ? `${value}n` : value,
  );
}

/** Validate parser output and protect complete literal/template source spans. */
function protectedSpans(ast: unknown, length: number): Span[] {
  if (!ast || typeof ast !== "object" || !("type" in ast) || ast.type !== "Program") {
    throw new Error("Expected a parsed JavaScript Program");
  }
  const spans: Span[] = [];
  function visit(value: unknown): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    if ("type" in value && (value.type === "Literal" || value.type === "TemplateLiteral")) {
      if (
        !("start" in value) ||
        !("end" in value) ||
        typeof value.start !== "number" ||
        typeof value.end !== "number" ||
        !Number.isInteger(value.start) ||
        !Number.isInteger(value.end) ||
        value.start < 0 ||
        value.end <= value.start ||
        value.end > length
      ) {
        throw new Error("Invalid protected JavaScript source span");
      }
      spans.push([value.start, value.end]);
      return;
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(ast);
  spans.sort((left: Span, right: Span): number => left[0] - right[0]);
  for (let index = 1; index < spans.length; index++) {
    const current = spans[index];
    const previous = spans[index - 1];
    if (current && previous && current[0] < previous[1]) {
      throw new Error("Overlapping protected JavaScript source spans");
    }
  }
  return spans;
}

/** Deduplicate actual identical bang-block notices without changing tokens or maps. */
export function deduplicateLegalComments(code: string, parse: Parse): Rolldown.RolldownMagicString {
  const ast = parse(code);
  const spans = protectedSpans(ast, code.length);
  const seen = new Set<string>();
  const output = new Rolldown.RolldownMagicString(code);
  let cursor = 0;
  let spanIndex = 0;
  while (cursor < code.length) {
    while (spans[spanIndex] && (spans[spanIndex]?.[1] ?? code.length) <= cursor) spanIndex++;
    const span = spans[spanIndex];
    if (span && span[0] <= cursor) {
      cursor = span[1];
      continue;
    }
    if (code.startsWith("//", cursor)) {
      cursor += 2;
      while (cursor < code.length && !/[\r\n\u2028\u2029]/.test(code.charAt(cursor))) cursor++;
      continue;
    }
    if (!code.startsWith("/*", cursor)) {
      cursor++;
      continue;
    }
    const end = code.indexOf("*/", cursor + 2);
    if (end < 0) throw new Error("Unterminated JavaScript comment");
    const comment = code.slice(cursor, end + 2);
    if (comment.startsWith("/*!")) {
      if (seen.has(comment)) {
        output.overwrite(cursor, end + 2, comment.replace(/[^\r\n\u2028\u2029]/g, "") || " ");
      } else {
        seen.add(comment);
      }
    }
    cursor = end + 2;
  }
  if (semanticJson(ast) !== semanticJson(parse(output.toString()))) {
    throw new Error("Legal-comment deduplication changed executable JavaScript");
  }
  return output;
}

/** Use the bundler's parser and native mapped edits; no additional parser dependency. */
export function bundleCommentsPlugin(): TsdownPlugin<unknown> {
  return {
    name: "deduplicate-identical-legal-comments",
    renderChunk(code: string): Rolldown.RolldownMagicString {
      return deduplicateLegalComments(code, (source: string): unknown => this.parse(source));
    },
  };
}
