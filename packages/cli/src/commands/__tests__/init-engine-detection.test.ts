import { describe, it, expect, vi } from "vitest";

/**
 * Regression guard for the engine-detection defect: `detectExistingEngines`
 * (lib/detect.ts) finds engines by artifact folder (.claude/, .cursor/,
 * AGENTS.md, copilot-instructions.md). A repo with only `.cursor/` used to
 * yield defaultEngines=["cursor"], silently dropping "claude" — the harness
 * then never renders CLAUDE.md/.claude/ and is dead in Claude Code sessions.
 * Detection must be additive (union with "claude"), never exclusive.
 */

vi.mock("@clack/prompts", () => ({
  log: { warn: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), message: vi.fn(), step: vi.fn() },
}));

import * as p from "@clack/prompts";
import { resolveDefaultEngines, warnIfClaudeMissing } from "../init.ts";
import { t } from "../../lib/i18n.ts";

describe("resolveDefaultEngines", () => {
  it("unions detected engines with claude when detection finds only cursor", () => {
    expect(resolveDefaultEngines(undefined, ["cursor"])).toEqual(["claude", "cursor"]);
  });

  it("falls back to claude alone when detection finds nothing", () => {
    expect(resolveDefaultEngines(undefined, [])).toEqual(["claude"]);
  });

  it("does not duplicate claude when detection already includes it", () => {
    expect(resolveDefaultEngines(undefined, ["claude", "cursor"])).toEqual(["claude", "cursor"]);
  });

  it("leaves an explicit workspace default untouched, even without claude", () => {
    // Explicit config is the user's call — it must win as-is over detection,
    // with no union/dedupe applied.
    expect(resolveDefaultEngines(["cursor"] as never, ["claude"])).toEqual(["cursor"]);
  });

  it("treats an explicit empty workspace default as unconfigured", () => {
    // Empty engines would crash writeConfig on the schema's engines.min(1);
    // it must fall back to detection ∪ claude instead of passing through.
    expect(resolveDefaultEngines([] as never, ["cursor"])).toEqual(["claude", "cursor"]);
  });
});

describe("warnIfClaudeMissing", () => {
  const tr = t("en");

  it("warns once when the final engine selection drops claude", () => {
    vi.mocked(p.log.warn).mockClear();
    warnIfClaudeMissing(["cursor"] as never, tr);
    expect(p.log.warn).toHaveBeenCalledTimes(1);
    expect(p.log.warn).toHaveBeenCalledWith(tr.claudeEngineMissingWarning);
  });

  it("does not warn when claude is part of the final selection", () => {
    vi.mocked(p.log.warn).mockClear();
    warnIfClaudeMissing(["claude", "cursor"] as never, tr);
    expect(p.log.warn).not.toHaveBeenCalled();
  });
});
