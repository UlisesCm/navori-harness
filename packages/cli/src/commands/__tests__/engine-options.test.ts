import { describe, it, expect } from "vitest";
import { ENGINES } from "../../lib/config/schema.ts";
import { ENGINE_OPTIONS as INIT_OPTIONS } from "../init.ts";
import { ENGINE_OPTIONS as CONFIGURE_OPTIONS } from "../configure.ts";

describe("engine pickers", () => {
  for (const [name, options] of [
    ["init", INIT_OPTIONS],
    ["configure engines", CONFIGURE_OPTIONS],
  ] as const) {
    it(`${name} offers every schema engine, pi included`, () => {
      expect(options.map((o) => o.value).sort()).toEqual([...ENGINES].sort());
      expect(options.find((o) => o.value === "pi")?.label).toContain("Pi >= 1.1.0");
    });
  }
});
