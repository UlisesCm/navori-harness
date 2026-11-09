import { describe, it, expect } from "vitest";
import { parseAsset } from "../../../engines/claude/parse-asset.ts";
import type { NavoriConfig } from "../../config/config.ts";
import { isSeededZone, normalizeZone, scaffoldKindOf } from "../scaffold.ts";
import { interpolate } from "../interpolate.ts";

/**
 * The prune tells navori's seeded extension zone from the user's text with the
 * SAME parser the renderer uses, so the two cannot disagree on what a
 * `navori:user-section` line is (#1604).
 */
const CONFIG = { name: "demo", engines: ["claude"] } as unknown as NavoriConfig;

describe("scaffold zones and the renderer agree on the user-section sentinel", () => {
  it.each([
    ["html", "<!-- navori:user-section -->", "zone\n"],
    ["shell", "# navori:user-section", "zone\n"],
  ] as const)(
    "%s sentinel splits the asset where the prune reads the zone",
    (style, marker, tail) => {
      expect(parseAsset(`body\n${marker}\n${tail}`, style).userTemplate).toBe(tail);
    },
  );

  it("a shell sentinel must occupy a whole line, in the renderer and so in the prune", () => {
    expect(parseAsset("body\n  # navori:user-section\nzone\n", "shell").userTemplate).toBeNull();
  });

  it("a zone is scaffold only in its own pool, and only when it matches exactly", () => {
    const hook = normalizeZone(interpolate("# user: add extra guards here.\nexit 0\n", CONFIG));
    expect(isSeededZone("script", hook, CONFIG)).toBe(false);
    expect(isSeededZone("markdown", hook, CONFIG)).toBe(false);
  });

  it("only hook scripts and skill/agent files read a seeded zone", () => {
    expect(scaffoldKindOf(".claude/hooks/x.sh").seededZone).toBe("script");
    expect(scaffoldKindOf(".claude/agents/x.md").seededZone).toBe("markdown");
    expect(scaffoldKindOf(".cursor/rules/navori.mdc").seededZone).toBeNull();
    expect(scaffoldKindOf("AGENTS.md").seededZone).toBeNull();
  });
});
