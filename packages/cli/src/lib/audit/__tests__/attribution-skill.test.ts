import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentRun } from "../parse.ts";

/**
 * `attributionSkill` — the span the host marks while a skill is active (#725).
 *
 * It was in every transcript and nothing read it. What made it worth reading is
 * that it is INHERITED BY SUBAGENTS: measured on this repo, 249 subagent records
 * worked under `solution-design` against two `Skill` tool calls, so the sources
 * that only see tool calls were blind to almost all of it.
 *
 * The field is undocumented, and the host's own docs say the transcript format
 * "is internal to Claude Code and changes between versions, so scripts that
 * parse these files directly can break on any release". Every read is therefore
 * defensive AND COUNTED — the count is what keeps a dropped field from reading
 * as an idle harness.
 */

/** A transcript file from raw records, as the parser will find it on disk. */
function transcript(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-attr-"));
  const file = join(dir, "agent-abc123.jsonl");
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"), "utf-8");
  return file;
}

/** An assistant record, optionally attributed, with its own usage. */
function assistant(over: Record<string, unknown> = {}): object {
  return {
    type: "assistant",
    timestamp: "2026-09-12T10:00:00.000Z",
    message: { model: "claude-opus-5", usage: { output_tokens: 100 }, content: [] },
    ...over,
  };
}

describe("collectSkills — el tramo atribuido por el host (#725)", () => {
  it("ve una skill que el subagente heredó sin invocarla nunca", () => {
    // El caso que motiva todo: cero `Skill` tool_use, y aun así el subagente
    // trabajó bajo la skill. Antes esto era exactamente "0 skills".
    const run = parseAgentRun(
      transcript([
        assistant({ attributionSkill: "solution-design" }),
        assistant({ attributionSkill: "solution-design" }),
        assistant(),
      ]),
    );
    expect(run?.skills).toEqual([
      expect.objectContaining({
        slug: "solution-design",
        source: "attribution",
        attributedRecords: 2,
        attributedOutputTokens: 200,
      }),
    ]);
  });

  it("no le gana a una invocación explícita en ESTE transcript", () => {
    // Una invocación aquí es evidencia directa de que esta corrida la pidió;
    // un tramo heredado dice que la pidió el padre. El orden importa porque la
    // etiqueta del reporte sale de ahí.
    const run = parseAgentRun(
      transcript([
        {
          type: "assistant",
          message: {
            model: "m",
            usage: { output_tokens: 0 },
            content: [
              { type: "tool_use", id: "t1", name: "Skill", input: { skill: "review-diff" } },
            ],
          },
        },
        assistant({ attributionSkill: "review-diff" }),
      ]),
    );
    expect(run?.skills[0]?.source).toBe("skill-tool");
    // El tramo se conserva aunque no decida la fuente: es el único dato que
    // dice cuánto trabajo ocurrió bajo la skill.
    expect(run?.skills[0]?.attributedRecords).toBe(1);
  });

  it("cuenta los records atribuidos, que es lo que distingue ciego de vacío", () => {
    const blind = parseAgentRun(transcript([assistant(), assistant()]));
    expect(blind?.skillAttributionRecords).toBe(0);
    const seen = parseAgentRun(transcript([assistant({ attributionSkill: "dominio" })]));
    expect(seen?.skillAttributionRecords).toBe(1);
  });

  it("ignora el campo cuando no es un string útil", () => {
    // Lectura defensiva: el formato es interno al host y puede cambiar en
    // cualquier release. Un campo con otra forma no debe inventar una skill ni
    // tumbar el parseo.
    const run = parseAgentRun(
      transcript([
        assistant({ attributionSkill: "" }),
        assistant({ attributionSkill: 42 }),
        assistant({ attributionSkill: null }),
        assistant({ attributionSkill: { name: "x" } }),
      ]),
    );
    expect(run?.skills).toEqual([]);
    expect(run?.skillAttributionRecords).toBe(0);
  });

  it("solo mira records 'assistant'", () => {
    // El campo vive ahí. Aceptarlo en cualquier record haría que un eco del
    // valor en otro tipo de línea contara como trabajo.
    const run = parseAgentRun(
      transcript([{ type: "user", attributionSkill: "ticket-intake", message: { content: [] } }]),
    );
    expect(run?.skills).toEqual([]);
  });

  it("suma varias skills por separado", () => {
    const run = parseAgentRun(
      transcript([
        assistant({ attributionSkill: "a-skill" }),
        assistant({ attributionSkill: "b-skill" }),
        assistant({ attributionSkill: "a-skill" }),
      ]),
    );
    const bySlug = Object.fromEntries(
      (run?.skills ?? []).map((s) => [s.slug, s.attributedRecords]),
    );
    expect(bySlug).toEqual({ "a-skill": 2, "b-skill": 1 });
    expect(run?.skillAttributionRecords).toBe(3);
  });
});
