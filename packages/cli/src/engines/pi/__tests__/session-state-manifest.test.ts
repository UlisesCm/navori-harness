import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { renderPiEngine } from "../index.ts";
import { ownsPiManifest } from "../owned-file.ts";

/** Renders only the Pi manifest for a config with the given harness/audit overrides. */
function render(extra: Record<string, unknown> = {}): string {
  const target = mkdtempSync(join(tmpdir(), "navori-pi-session-state-"));
  try {
    renderPiEngine(
      target,
      NavoriConfigSchema.parse({ name: "pi-ss", preset: "custom", engines: ["pi"], ...extra }),
    );
    return readFileSync(join(target, ".pi/navori.json"), "utf8");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
}

describe("Pi manifest sessionState control (#1579)", () => {
  it("omits the key when absent or true, so the manifest is byte-identical to before", () => {
    const absent = render();
    expect(JSON.parse(absent).controls).not.toHaveProperty("sessionState");
    expect(render({ harness: { sessionState: true } })).toBe(absent);
    expect(ownsPiManifest(absent)).toBe(true);
  });

  it("emits sessionState: false after auditMode and keeps all four shapes owned", () => {
    const off = render({ harness: { sessionState: false } });
    expect(JSON.parse(off).controls.sessionState).toBe(false);
    expect(Object.keys(JSON.parse(off).controls)).toEqual([
      "planTiers",
      "masterPlan",
      "scribeOwnsMarkdown",
      "sessionState",
    ]);
    const both = render({ harness: { sessionState: false }, audit: { mode: "always" } });
    expect(Object.keys(JSON.parse(both).controls)).toEqual([
      "planTiers",
      "masterPlan",
      "scribeOwnsMarkdown",
      "auditMode",
      "sessionState",
    ]);
    const shapes = [render(), render({ audit: { mode: "always" } }), off, both];
    for (const manifest of shapes) expect(ownsPiManifest(manifest)).toBe(true);
  });

  it("rejects a sessionState value the writer never emits", () => {
    const off = render({ harness: { sessionState: false } });
    expect(ownsPiManifest(off.replace('"sessionState": false', '"sessionState": true'))).toBe(
      false,
    );
    expect(ownsPiManifest(off.replace('"sessionState": false', '"sessionState": "x"'))).toBe(false);
  });
});
