import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultCodexCatalogPath,
  highestOfFamily,
  readCodexCatalogSlugs,
  resolveCodexModelValue,
} from "../model-catalog.ts";

function catalog(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "navori-catalog-")), "models_cache.json");
  writeFileSync(path, content);
  return path;
}

const SLUGS = [
  "gpt-6-sol",
  "gpt-6.1-sol",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-6-luna",
  "gpt-reserve",
  "codex-auto-review",
];
const fixture = (): string => catalog(JSON.stringify({ models: SLUGS.map((slug) => ({ slug })) }));

describe("codex model catalog (spec 0041 R32)", () => {
  const prev = process.env.CODEX_HOME;
  afterEach(() => {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  });

  // Covers: R32
  it("compares versions numerically: 6.1 > 6 > 5.6", () => {
    expect(highestOfFamily("sol", SLUGS)).toBe("gpt-6.1-sol");
    expect(highestOfFamily("luna", SLUGS)).toBe("gpt-6-luna");
    expect(highestOfFamily("sol", ["gpt-5.6-sol", "gpt-6-sol"])).toBe("gpt-6-sol");
    expect(highestOfFamily("sol", ["gpt-6.9-sol", "gpt-6.10-sol"])).toBe("gpt-6.10-sol");
    expect(highestOfFamily("astra", SLUGS)).toBeNull();
  });

  // Covers: R32
  it("resolves a family from the catalog and pins a full id verbatim", () => {
    const path = fixture();
    expect(resolveCodexModelValue("sol", path)).toEqual({ model: "gpt-6.1-sol", source: "family" });
    expect(resolveCodexModelValue("gpt-5.6-sol", path)).toEqual({
      model: "gpt-5.6-sol",
      source: "pin",
    });
  });

  // Covers: R32
  it("falls back to the last-known id when the catalog is missing, malformed or lacks the family", () => {
    const expected = { model: "gpt-6-astra", source: "fallback", family: "astra" };
    expect(resolveCodexModelValue("astra", fixture())).toEqual(expected);
    expect(resolveCodexModelValue("astra", "/nonexistent/models_cache.json")).toEqual(expected);
    expect(resolveCodexModelValue("astra", null)).toEqual(expected);
    expect(resolveCodexModelValue("astra", catalog("{not json"))).toEqual(expected);
    expect(resolveCodexModelValue("astra", catalog('{"models": 3}'))).toEqual(expected);
    expect(resolveCodexModelValue("astra", catalog("[]"))).toEqual(expected);
  });

  // Covers: R32
  it("ignores malformed entries and unparseable slugs without throwing", () => {
    const path = catalog(
      JSON.stringify({
        models: [null, 7, { slug: 3 }, { slug: "gpt-x-sol" }, { slug: "gpt-6-sol" }],
      }),
    );
    expect(readCodexCatalogSlugs(path)).toEqual(["gpt-x-sol", "gpt-6-sol"]);
    expect(resolveCodexModelValue("sol", path).model).toBe("gpt-6-sol");
  });

  // Covers: R32
  it("keeps an unknown family verbatim with a fallback source", () => {
    expect(resolveCodexModelValue("terra", fixture())).toEqual({
      model: "terra",
      source: "fallback",
      family: "terra",
    });
  });

  // Covers: R32
  it("respects CODEX_HOME and never throws on a relative one", () => {
    process.env.CODEX_HOME = "/tmp/codex-home-x";
    expect(defaultCodexCatalogPath()).toBe("/tmp/codex-home-x/models_cache.json");
    process.env.CODEX_HOME = "relative/dir";
    expect(defaultCodexCatalogPath()).toBeNull();
    expect(resolveCodexModelValue("sol").model).toBe("gpt-6-sol");
  });

  // Covers: R32
  it("never downgrades: keeps a same-family previous id >= fallback when the catalog gives nothing", () => {
    expect(resolveCodexModelValue("sol", null, "gpt-6.1-sol")).toEqual({
      model: "gpt-6.1-sol",
      source: "rendered",
    });
    expect(resolveCodexModelValue("sol", null, "gpt-6-sol").model).toBe("gpt-6-sol");
    // No previous, older previous, other family or pin: fallback applies.
    for (const previous of [null, "gpt-5.6-sol", "gpt-6.1-luna", "custom-pin"]) {
      expect(resolveCodexModelValue("sol", null, previous)).toMatchObject({
        model: "gpt-6-sol",
        source: "fallback",
      });
    }
  });

  // Covers: R32
  it("with a catalog match the highest wins over the previous id", () => {
    expect(resolveCodexModelValue("sol", fixture(), "gpt-6-sol")).toEqual({
      model: "gpt-6.1-sol",
      source: "family",
    });
  });

  // Covers: R32
  it("a stale catalog does not downgrade a newer same-family previous id", () => {
    const stale = catalog(JSON.stringify({ models: [{ slug: "gpt-6-sol" }] }));
    expect(resolveCodexModelValue("sol", stale, "gpt-6.1-sol")).toEqual({
      model: "gpt-6.1-sol",
      source: "rendered",
    });
  });

  // Covers: R32
  it("a newer or equal catalog wins over previous; another family's previous is ignored", () => {
    const path = fixture();
    expect(resolveCodexModelValue("sol", path, "gpt-6.1-sol")).toEqual({
      model: "gpt-6.1-sol",
      source: "family",
    });
    expect(resolveCodexModelValue("sol", path, "gpt-7-luna")).toEqual({
      model: "gpt-6.1-sol",
      source: "family",
    });
  });
});
