import { describe, it, expect } from "vitest";
import { stripManagedBlocks } from "../removable.ts";
import { signNativeScript } from "../native-hook.ts";
import { injectManagedSection } from "../marker.ts";

/**
 * `render --prune` (#1604) cuts navori's blocks and keeps the user's text. A hook the
 * migration checkout signs carries `# navori:native-hook …` on its first line, outside every
 * block: it is navori's too, so the cut drops it instead of reading it as user text.
 */

const REL = ".claude/hooks/guard-destructive.sh";
const IMPL = `sha256:${"a".repeat(64)}`;
const block = injectManagedSection(
  "",
  "guard-destructive-base",
  "#!/usr/bin/env bash\nexit 0",
  { source: "@navori/core", version: "0.12.5" },
  "shell",
).output;

describe("stripManagedBlocks with a native signature", () => {
  it("cuts the signature with the blocks of an unchanged signed hook", () => {
    const signed = signNativeScript(block, IMPL, []);
    expect(signed.startsWith("# navori:native-hook v=1 file=sha256:")).toBe(true);
    const cut = stripManagedBlocks(REL, signed);
    expect(cut.kind).toBe("ok");
    expect(cut.kind === "ok" ? cut.stripped.trim() : null).toBe("");
  });

  it("keeps the user's text outside the blocks and drops the signature", () => {
    const signed = signNativeScript(`${block}\n# user: fixture check\n`, IMPL, []);
    const cut = stripManagedBlocks(REL, signed);
    expect(cut.kind).toBe("ok");
    const stripped = cut.kind === "ok" ? cut.stripped : "";
    expect(stripped).toContain("# user: fixture check");
    expect(stripped).not.toContain("navori:native-hook");
  });

  it("leaves an unsigned hook exactly as before", () => {
    const withUser = `${block}\n# user: fixture check\n`;
    const cut = stripManagedBlocks(REL, withUser);
    expect(cut).toEqual({ kind: "ok", stripped: "\n# user: fixture check\n" });
  });
});
