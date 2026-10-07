/**
 * Reads the requirement ids of a spec's `requirements.md` (spec 0044 R11).
 * A requirement is a list item that opens with `**R<n>**`; fenced regions are
 * ignored, like in `tasks.md`.
 */
import { visibleLines } from "./tasks.ts";

const REQUIREMENT_ITEM = /^\s*[-*]\s+\*\*(R\d+)\*\*/;

/** Ids (`R1`, `R2`, ...) in order of appearance, without duplicates. */
export function parseRequirementIds(text: string): string[] {
  const ids: string[] = [];
  for (const line of visibleLines(text)) {
    const id = REQUIREMENT_ITEM.exec(line.text)?.[1];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}
