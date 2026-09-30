// Covers: A1, A2, A3 (master_plan_ux F1-F3)
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UX_ID_PATTERNS, UxContractSchema } from "../schema.ts";
import {
  checkUxArtifacts,
  checkUxContent,
  checkUxDecision,
  frameworkNames,
  visualLiterals,
  type UxContext,
} from "../ux.ts";
import { seedUxSources, validUxJson, validUxMd, writeUxTemplateFixture } from "./test-utils.ts";
import type { AssetLanguage } from "../../render/render-plan.ts";

let cwd: string;
let language: AssetLanguage = "es";
const stage = (): string => join(cwd, "01-mvp");

const ctxFor = (ux?: "none" | "md" | "md-json"): UxContext => ({
  cwd,
  specsDir: "specs",
  language,
  templatesRoot: cwd,
  stagePath: stage(),
  stage: { dir: "01-mvp" },
  state: { ux },
});

const writeMd = (overrides: Record<string, string> = {}): void =>
  writeFileSync(join(stage(), "UX.md"), validUxMd(language, cwd, overrides));
const writeJson = (mutate: (doc: Record<string, unknown>) => void = () => {}): void => {
  const doc = validUxJson("01-mvp");
  mutate(doc);
  writeFileSync(join(stage(), "ux.json"), JSON.stringify(doc));
};
const content = (): string => checkUxContent(ctxFor("md-json")).join("\n");

beforeEach(() => {
  language = "es";
  cwd = mkdtempSync(join(tmpdir(), "navori-master-ux-"));
  seedUxSources(stage());
  writeUxTemplateFixture(cwd);
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("checkUxDecision", () => {
  it("fails naming the command when no decision is recorded, passes otherwise", () => {
    expect(checkUxDecision(ctxFor()).join("\n")).toContain("navori master ux");
    expect(checkUxDecision(ctxFor("none"))).toEqual([]);
  });
});

describe("checkUxArtifacts", () => {
  it("none + UX.md or ux.json fails; none alone passes", () => {
    expect(checkUxArtifacts(ctxFor("none"))).toEqual([]);
    writeMd();
    expect(checkUxArtifacts(ctxFor("none")).length).toBe(1);
    rmSync(join(stage(), "UX.md"));
    writeJson();
    expect(checkUxArtifacts(ctxFor("none")).length).toBe(1);
  });

  it("md requires UX.md, passes without ux.json and fails with a stray ux.json", () => {
    expect(checkUxArtifacts(ctxFor("md")).length).toBe(1);
    writeMd();
    expect(checkUxArtifacts(ctxFor("md"))).toEqual([]);
    writeJson();
    expect(checkUxArtifacts(ctxFor("md")).join("\n")).toContain("existe ux.json");
  });

  it("md-json requires UX.md and ux.json", () => {
    writeMd();
    expect(checkUxArtifacts(ctxFor("md-json")).length).toBe(1);
    writeJson();
    expect(checkUxArtifacts(ctxFor("md-json"))).toEqual([]);
  });

  it("legacy (no decision) only rejects ux.json without UX.md", () => {
    expect(checkUxArtifacts(ctxFor())).toEqual([]);
    writeMd();
    expect(checkUxArtifacts(ctxFor())).toEqual([]);
    rmSync(join(stage(), "UX.md"));
    writeJson();
    expect(checkUxArtifacts(ctxFor()).length).toBe(1);
  });
});

describe("UX.md coherence — one failing fixture per rule, the baseline passing", () => {
  it("accepts the baseline", () => {
    writeMd();
    expect(checkUxContent(ctxFor("md"))).toEqual([]);
  });

  const failing: [string, Record<string, string>, string][] = [
    ["dangling flow", { journeys: "### J01 — a\nFlows: F01, F09\n" }, "F09 se cita"],
    ["dangling screen", { flows: "### F01 — a\nPantallas: SCR-MOBILE-07\n" }, "SCR-MOBILE-07"],
    ["dangling actor", { actors: "### ACT-CLIENT — a\nVe ACT-GHOST.\n" }, "ACT-GHOST"],
    ["journey without flow", { journeys: "### J01 — a\nnada\n" }, "J01 no referencia ningún flow"],
    ["flow without screen", { flows: "### F01 — a\nnada\n" }, "F01 no referencia ninguna pantalla"],
    [
      "screen without requirement",
      { screens: "### SCR-MOBILE-01 — a\nnada\n" },
      "ningún RN/RF/RNF/P<n>",
    ],
    [
      "screen on undeclared surface",
      { screens: "### SCR-PARTNER-01 — a\nRF-1\n" },
      "superficie PARTNER",
    ],
    ["malformed id", { journeys: "### J1 — a\nF01\n" }, '"### J1 — a" no es un id de journeys'],
    ["duplicate id", { patterns: "### PT01 — a\n\n### PT01 — b\n" }, "id duplicado PT01"],
    ["RF absent from MASTER.md", { metadata: "Cita RF-99." }, "RF-99, que no existe en MASTER.md"],
    ["part absent from parts.json", { metadata: "Cita P7." }, "P7, que no existe en parts.json"],
    ["acceptance absent", { metadata: "Cita P1.A9." }, "P1.A9"],
    ["decision absent", { sources: "Cita D9." }, "D9, que no existe"],
    ["open questions", { "open-questions": "¿Qué pasa si expira?" }, 'debe decir "Ninguna"'],
    ["unchecked box", { checklist: "- [ ] a\n- [x] b" }, "casillas sin marcar"],
    ["checklist shrunk", { checklist: "- [x] a" }, "las 2 casillas"],
    [
      "handoff subheading missing",
      { "heron-handoff": "### Heron MUST preserve\nx\n" },
      "Heron MAY improve",
    ],
    ["hex color", { "global-states": "Fondo #1088ff." }, "#1088ff"],
    ["px unit", { navigation: "Ancho 16px." }, "16px"],
  ];
  it.each(failing)("fails: %s", (_name, overrides, expected) => {
    writeMd(overrides);
    expect(checkUxContent(ctxFor("md")).join("\n")).toContain(expected);
  });

  it("passes the narrowed cases that look like failures", () => {
    writeMd({
      "global-states":
        "Pulse F12 o C99 para depurar; ISO C11; el API y el MVP; #1088, #add; 16 pasos; `16px` y `#ff0000`.",
      sources: "Cita D1 y RN-2.",
      "out-of-scope": "Logo #ff0000 de 24px queda fuera.",
      metadata: "Stack existente: Mantine y React Native.",
      "heron-handoff":
        "### Heron MUST preserve\nx\n\n### Heron MAY improve\nx\n\n### Heron owns\ncolor #ff0000, 16px, Tailwind\n",
    });
    expect(checkUxContent(ctxFor("md"))).toEqual([]);
  });

  it("fails loudly when the template lacks a ux-kind marker", () => {
    writeMd();
    writeFileSync(
      join(cwd, "core-assets", "master-plan", "ux.md"),
      "## Solo\n<!-- ux-kind: surfaces -->\nx\n",
    );
    expect(content()).toContain("plantilla ux sin marcador ux-kind");
  });

  it("an en repo validates against en headings and needs None", () => {
    language = "en";
    writeMd();
    expect(checkUxContent(ctxFor("md"))).toEqual([]);
    writeMd({ "open-questions": "Ninguna" });
    expect(checkUxContent(ctxFor("md")).join("\n")).toContain('debe decir "None"');
  });
});

describe("denylist", () => {
  it.each(["#1088", "#add", "#123", "16 pasos", "`16px`", "color `#ff0000`", "```\n8rem\n```"])(
    "does not flag %s",
    (text) => expect(visualLiterals(text)).toEqual([]),
  );
  it.each([
    ["#ff0000", "#ff0000"],
    ["#FF000080", "#FF000080"],
    ["16px", "16px"],
    ["margen de 1.5rem", "1.5rem"],
  ])("flags %s", (text, hit) => expect(visualLiterals(text)).toEqual([hit]));
  it("finds framework names case-insensitively", () => {
    expect(frameworkNames("con Mantine y react native")).toEqual(["Mantine", "react native"]);
    expect(frameworkNames("un tablero")).toEqual([]);
  });
});

describe("ux.json", () => {
  beforeEach(() => writeMd());

  it("accepts a coherent contract", () => {
    writeJson();
    expect(checkUxContent(ctxFor("md-json"))).toEqual([]);
  });

  it("rejects malformed JSON and a wrong masterStage", () => {
    writeFileSync(join(stage(), "ux.json"), "{");
    expect(content()).toContain("no es JSON válido");
    writeJson((d) => (d.masterStage = "02-otra"));
    expect(content()).toContain("masterStage '02-otra'");
  });

  it("reports both sides of an ID-set mismatch with UX.md", () => {
    writeJson((d) => {
      d.patterns = [{ id: "PT02", name: "x", purpose: "p", screens: ["SCR-MOBILE-01"] }];
    });
    const out = content();
    expect(out).toContain("solo en UX.md: [PT01]");
    expect(out).toContain("solo en ux.json: [PT02]");
  });

  it("fails framework names and visual literals in string values, and unknown refs", () => {
    writeJson((d) => {
      (d.surfaces as { purpose: string }[])[0]!.purpose = "Usa Mantine con #ff0000 y 16px";
      (d.uxRequirements as { derivedFrom: string[] }[])[0]!.derivedFrom = ["RF-99"];
    });
    const out = content();
    for (const hit of ["Mantine", "#ff0000", "16px", "RF-99, que no existe en MASTER.md"])
      expect(out).toContain(hit);
  });
});

type Doc = Record<string, unknown>;
/** First item of the array at `key` (mutable view). */
const first = (d: Doc, key: string): Doc => (d[key] as Doc[])[0]!;

describe("UxContractSchema", () => {
  const parse = (mutate: (doc: Doc) => void) => {
    const doc = validUxJson("01-mvp");
    mutate(doc);
    return UxContractSchema.safeParse(doc);
  };

  it("accepts the baseline and SCR-MOBILE-09", () => {
    expect(parse(() => {}).success).toBe(true);
    expect(UX_ID_PATTERNS.screens.test("SCR-MOBILE-09")).toBe(true);
  });
  it("rejects unknown keys at the root and nested", () => {
    expect(parse((d) => (d.color = "red")).success).toBe(false);
    expect(parse((d) => (first(d, "surfaces").font = "x")).success).toBe(false);
  });
  it("rejects a wrong schemaVersion", () => {
    expect(parse((d) => (d.schemaVersion = 2)).success).toBe(false);
  });
  it.each([
    ["surface RN", (d: Doc) => (first(d, "surfaces").id = "RN")],
    ["surface API", (d: Doc) => (first(d, "surfaces").id = "API")],
    ["surface lowercase", (d: Doc) => (first(d, "surfaces").id = "mobile")],
    ["actor", (d: Doc) => (first(d, "actors").id = "CLIENT")],
    ["journey J1", (d: Doc) => (first(d, "journeys").id = "J1")],
    ["flow", (d: Doc) => (first(d, "flows").id = "F1")],
    ["screen M01", (d: Doc) => (first(d, "screens").id = "M01")],
    ["component", (d: Doc) => (first(d, "functionalComponents").id = "C1")],
    ["pattern", (d: Doc) => (first(d, "patterns").id = "PT1")],
    ["ux requirement", (d: Doc) => (first(d, "uxRequirements").id = "UX1")],
    ["requirement ref", (d: Doc) => (first(d, "screens").requirements = ["REQ-1"])],
  ])("rejects a malformed %s id", (_name, mutate) => {
    expect(parse(mutate).success).toBe(false);
  });
  it("rejects duplicate ids, a screen not embedding its surface and dangling references", () => {
    expect(parse((d) => (d.patterns as Doc[]).push(first(d, "patterns"))).success).toBe(false);
    expect(parse((d) => (first(d, "screens").surface = "WEB")).success).toBe(false);
    expect(parse((d) => (first(d, "journeys").flows = ["F09"])).success).toBe(false);
    expect(parse((d) => (first(d, "flows").screens = ["SCR-MOBILE-09"])).success).toBe(false);
  });
});
