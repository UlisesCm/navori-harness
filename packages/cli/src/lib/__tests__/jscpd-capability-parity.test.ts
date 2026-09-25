import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { loadPlugin } from "../config/plugins.ts";

/**
 * #1060 — condition the challenge added to the workplan's A6: `jscpd/plugin.json`'s
 * `capabilityProbe` (this implementer's file) and `check-jscpd.sh` (the other
 * implementer's file, Phase 1) must agree on the same three facts, or the
 * hook and the manifest can silently drift apart:
 *
 *  (a) every `mustContain` string the manifest declares is the exact string
 *      the script's probe checks for — a rename on either side breaks this.
 *  (b) `capabilityProbe.minVersion` appears literally in the script's
 *      upgrade message — the version floor lives in three hand-written
 *      places (manifest, script message, install commands) with no shared
 *      source; this pins one edge of that triangle.
 *  (c) every `install.*` command in the manifest is pinned to
 *      `@^<minVersion>` — the other edge of the same triangle.
 *
 * This reads both files as plain text/JSON (not by executing anything), so it
 * has no dependency on jscpd being installed. It is EXPECTED to fail until
 * Phase 1 (implementer A)'s `check-jscpd.sh` lands: this repo's copy of the
 * script still has the pre-#1060 threshold-based gate, with no capability
 * probe of its own to check (a)/(b) against.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(__dirname, "../../../../plugins/jscpd/scripts/check-jscpd.sh");

describe("jscpd manifest <-> check-jscpd.sh capability parity (#1060)", () => {
  const tool = loadPlugin("jscpd").manifest.externalTool;
  const probe = tool?.capabilityProbe;
  const script = readFileSync(scriptPath, "utf-8");

  it("the manifest declares a capabilityProbe (test premise)", () => {
    expect(probe).toBeDefined();
  });

  it.each(probe?.mustContain ?? [])("mustContain %s appears in check-jscpd.sh", (needle) => {
    expect(script).toContain(needle);
  });

  it("capabilityProbe.minVersion appears literally in the script's upgrade message", () => {
    expect(script).toContain(probe?.minVersion ?? "<unset>");
  });

  it.each(Object.entries(tool?.install ?? {}))(
    "install.%s is pinned to @^<minVersion>",
    (_platform, command) => {
      expect(command).toContain(`@^${probe?.minVersion}`);
    },
  );
});
