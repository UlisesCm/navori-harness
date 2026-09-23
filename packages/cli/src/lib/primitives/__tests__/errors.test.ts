import { describe, it, expect } from "vitest";
import { NavoriError, HomeError, InstallError } from "../errors.ts";
import { ConfigError } from "../config.ts";
import { PluginNotFoundError } from "../plugins.ts";

/**
 * Spec 0003 §3.4.5 — every navori error is a NavoriError with a stable `code`
 * and a name derived from its subclass.
 */
describe("typed errors (spec 0003 §3.4.5)", () => {
  it("NavoriError carries a code and derives name from the subclass", () => {
    const e = new HomeError("nope");
    expect(e).toBeInstanceOf(NavoriError);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("home-unresolved");
    expect(e.name).toBe("HomeError");
    expect(e.message).toBe("nope");
  });

  it("InstallError has its own code", () => {
    expect(new InstallError("x").code).toBe("install-failed");
  });

  it("domain errors extend NavoriError with a stable code", () => {
    const cfg = new ConfigError("bad");
    expect(cfg).toBeInstanceOf(NavoriError);
    expect(cfg.code).toBe("config-invalid");
    expect(cfg.name).toBe("ConfigError");

    const plugin = new PluginNotFoundError("ghost");
    expect(plugin).toBeInstanceOf(NavoriError);
    expect(plugin.code).toBe("plugin-not-found");
    expect(plugin.pluginId).toBe("ghost");
  });
});
