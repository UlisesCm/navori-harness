import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { getCoreRoot } from "../bundled-assets.ts";

/**
 * #399: hosts like Claude Code inject the project CLAUDE.md into every
 * subagent's system prompt, so an unconditional "Read `CLAUDE.md`" step
 * duplicates ~8K tokens per spawn (~16-24K per R2 cycle). The instruction must
 * stay conditional: read from disk ONLY when the host did not inject it (e.g.
 * an engine without automatic injection).
 *
 * This sweep walks EVERY managed markdown asset — `agents/`, `skills/`,
 * `managed/`, `presets/`, `lib-skills/`, `progress/` — because the mandate
 * outlived #399 in a skill (`skills/ticket-intake.md`, phase 5 of the pipeline)
 * while the original guard only iterated `agents/`. Walking the tree also
 * covers assets added later, wherever they land.
 *
 * Criterion — a MANDATE is not a REFERENCE:
 *   - mandate: a read verb (`read` / `reads` / `reading` / `re-read`) AND
 *     `CLAUDE.md` on the SAME line. That's an asset telling an agent to open
 *     the file.
 *   - reference: the file merely named — where a rule lives ("see the SDD block
 *     in `CLAUDE.md`"), a routing target ("single-repo detail → that repo's
 *     `CLAUDE.md`") or commit hygiene ("never commit `CLAUDE.md`"). No read
 *     verb on the line, so nothing is re-read: allowed.
 *
 * The read verb is anchored on word boundaries on purpose: "already" contains
 * the substring "read", and every conditional clause written for #399 carries
 * an "already in your context".
 *
 * Escape hatch: a mandate is fine when its own paragraph scopes it to hosts
 * that do NOT inject — the wording #399 introduced. A future engine can still
 * be told to read the file from disk; it just can't be told unconditionally.
 */

const CORE_ASSETS = resolve(getCoreRoot(), "core-assets");

const READ_VERB = /\bread(s|ing)?\b/i;
const CLAUDE_MD = /CLAUDE\.md/;
const INJECTION_CONDITION = /already in your context|only if your host/i;

/** Every `.md` asset under `core-assets/`, recursively. */
function markdownAssets(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) markdownAssets(full, out);
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

/**
 * Lines of `raw` that order a CLAUDE.md read without scoping it to a host that
 * does not inject the file. Paragraphs (blank-line separated) are the unit of
 * the escape hatch: the caveat has to sit next to the instruction it qualifies,
 * not three sections away.
 */
function unconditionalMandates(raw: string): Array<{ line: number; text: string }> {
  const allLines = raw.split("\n");
  const offenders: Array<{ line: number; text: string }> = [];
  for (const paragraph of raw.split(/\n{2,}/)) {
    if (INJECTION_CONDITION.test(paragraph)) continue;
    for (const line of paragraph.split("\n")) {
      if (READ_VERB.test(line) && CLAUDE_MD.test(line)) {
        offenders.push({ line: allLines.indexOf(line) + 1, text: line.trim() });
      }
    }
  }
  return offenders;
}

describe("core managed assets — no unconditional CLAUDE.md read mandate (#399)", () => {
  const files = markdownAssets(CORE_ASSETS);

  it("sweeps the whole asset tree, not just agents/", () => {
    const dirs = new Set(files.map((f) => relative(CORE_ASSETS, f).split("/")[0]));
    expect(files.length).toBeGreaterThan(50);
    for (const dir of ["agents", "skills", "managed", "presets"]) {
      expect(dirs, `the sweep no longer reaches core-assets/${dir}/`).toContain(dir);
    }
  });

  it("no asset tells an agent to read CLAUDE.md unconditionally", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(CORE_ASSETS, file);
      for (const { line, text } of unconditionalMandates(readFileSync(file, "utf-8"))) {
        offenders.push(`${rel}:${line} — "${text}"`);
      }
    }
    expect(
      offenders,
      "the host already injects CLAUDE.md: drop the read, or scope it to hosts " +
        `that don't inject ("already in your context ... only if your host"):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
