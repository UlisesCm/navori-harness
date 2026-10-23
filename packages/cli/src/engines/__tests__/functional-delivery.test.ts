import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../lib/config/schema.ts";
import { renderClaudeEngine } from "../claude/index.ts";
import { renderCodexEngine } from "../codex/index.ts";

/** #1312: compare shipped instructions, without claiming native model compliance. */
describe("functional delivery evidence across engines", () => {
  it.each(["claude", "codex"] as const)(
    "%s receives planning, review and publication evidence requirements",
    (engine: "claude" | "codex"): void => {
      const cwd = mkdtempSync(join(tmpdir(), "navori-functional-delivery-"));
      try {
        const config = NavoriConfigSchema.parse({
          name: "functional-delivery",
          preset: "custom",
          engines: [engine],
          branchBase: "main",
          sdd: { enabled: true },
        });
        if (engine === "claude") renderClaudeEngine(cwd, config);
        else renderCodexEngine(cwd, config);
        const context = readFileSync(
          join(cwd, engine === "claude" ? "CLAUDE.md" : "AGENTS.md"),
          "utf8",
        );
        expect(context).toContain("**Functional deliveries:**");
        expect(context).toContain("prCount");
        expect(context).toContain("independently usable capabilities");
        expect(context).toContain("runtime consumers");
        expect(context).toContain("executable acceptance");
        const extension = engine === "claude" ? "md" : "toml";
        const reviewer = readFileSync(join(cwd, `.${engine}/agents/reviewer.${extension}`), "utf8");
        expect(reviewer).toContain("**Functional delivery**");
        expect(reviewer).toContain("runtime entry → consumer → contract");
        expect(reviewer).toContain("executed `A<n>` command/result");
        expect(reviewer).toContain("helper-to-helper calls");
        expect(reviewer).toContain("consumer in the same PR");
        expect(reviewer).toContain("Missing evidence → `SPEC_MISS`");
        const publisher = readFileSync(
          join(cwd, `.${engine}/agents/publisher.${extension}`),
          "utf8",
        );
        expect(publisher).toContain("**Functional delivery** evidence");
        expect(publisher).toContain("no PR; return to review");
        expect(publisher).toContain("Classification alone");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
