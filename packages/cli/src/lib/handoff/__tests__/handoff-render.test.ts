// Covers: R30
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHandoff } from "../render.ts";

const workspaces: string[] = [];
afterEach(() =>
  workspaces.splice(0).forEach((path) => rmSync(path, { force: true, recursive: true })),
);

const STATE = ".navori/state/handoffs";

/** A git checkout with `harness.scribeOwnsMarkdown` set as asked. */
function repo(scribeOwnsMarkdown: boolean | null = true): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "navori-handoff-render-")));
  workspaces.push(root);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  writeFileSync(
    join(root, "navori.config.json"),
    JSON.stringify({
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      harness: scribeOwnsMarkdown === null ? {} : { scribeOwnsMarkdown },
    }),
  );
  mkdirSync(join(root, STATE), { recursive: true });
  return root;
}

const impl = (feature: string): Record<string, unknown> => ({
  feature,
  status: "DONE",
  worktree: "/tmp/wt",
  branch: "feat/demo",
  commits: ["abc1234"],
  head: "a".repeat(40),
  filesTouched: ["src/a.ts"],
  verification: { command: "bun run check:fast", exitCode: 0, summary: "12 tests" },
  acceptance: [{ id: "A1", command: "bun test", exitCode: 0, excerpt: "ok" }],
  doubts: [{ file: "src/a.ts", reason: "edge case" }],
  markdownRequests: [{ path: "docs/x", intent: "document it", evidence: "src/a.ts:1" }],
  blockers: [],
});

function write(root: string, feature: string, content: unknown): void {
  writeFileSync(
    join(root, STATE, `impl_${feature}.json`),
    typeof content === "string" ? content : JSON.stringify(content),
  );
}

describe("renderHandoff", () => {
  // Covers: R30
  it("snapshot y rechazos, incluida la contención de ruta", () => {
    const root = repo();
    write(root, "demo", impl("demo"));
    const ok = renderHandoff({ cwd: root, feature: "demo" });
    expect(ok.status).toBe("ok");
    const md = readFileSync(join(root, STATE, "impl_demo.md"), "utf8");
    expect(md).toMatchInlineSnapshot(`
      "# Implementation handoff: demo

      - Status: DONE
      - Worktree: /tmp/wt
      - Branch: feat/demo
      - Head: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      - Commits: abc1234

      ## Files touched

      - \`src/a.ts\`

      ## Verification

      - Command: \`bun run check:fast\`
      - Exit code: 0
      - Summary: 12 tests

      ## Acceptance

      - A1: \`bun test\` exit 0 — ok

      ## Doubts

      - \`src/a.ts\`: edge case

      ## Blockers

      (none)

      ## Markdown requests

      - \`docs/x\`: document it (evidence: src/a.ts:1)
      "
    `);

    const refuses = (setup: (r: string) => void, feature = "demo", expected?: string): void => {
      const r = repo();
      setup(r);
      const result = renderHandoff({ cwd: r, feature });
      expect(result.status).toBe("error");
      if (expected !== undefined && result.status === "error") {
        expect(result.message).toContain(expected);
      }
      expect(existsSync(join(r, STATE, `impl_${feature}.md`))).toBe(false);
    };
    refuses(() => {}, "demo", "not found");
    refuses((r) => write(r, "demo", "{ not json"), "demo", "not valid JSON");
    refuses((r) => write(r, "demo", { feature: "demo" }), "demo", "invalid");
    refuses((r) => write(r, "demo", impl("other")), "demo", "belongs to feature");
    refuses(() => {}, "../escape", "invalid feature slug");

    // scribeOwnsMarkdown false (explicit or defaulted): the implementer's .md is untouched.
    for (const flag of [false, null]) {
      const r = repo(flag);
      write(r, "demo", impl("demo"));
      writeFileSync(join(r, STATE, "impl_demo.md"), "implementer wrote this\n");
      const result = renderHandoff({ cwd: r, feature: "demo" });
      expect(result).toMatchObject({ status: "error" });
      expect(readFileSync(join(r, STATE, "impl_demo.md"), "utf8")).toBe("implementer wrote this\n");
    }

    // Containment: a --dir that climbs out, and a JSON or .md that is a symlink out of the root.
    const r = repo();
    expect(renderHandoff({ cwd: r, feature: "demo", dir: "../outside" }).status).toBe("error");
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "navori-handoff-outside-")));
    workspaces.push(outside);
    writeFileSync(join(outside, "impl.json"), JSON.stringify(impl("demo")));
    symlinkSync(join(outside, "impl.json"), join(r, STATE, "impl_demo.json"));
    expect(renderHandoff({ cwd: r, feature: "demo" }).status).toBe("error");
    rmSync(join(r, STATE, "impl_demo.json"));
    write(r, "demo", impl("demo"));
    symlinkSync(join(outside, "target.txt"), join(r, STATE, "impl_demo.md"));
    // A symlinked .md is replaced by the rename, never written through.
    renderHandoff({ cwd: r, feature: "demo" });
    expect(existsSync(join(outside, "target.txt"))).toBe(false);
    expect(lstatSync(join(r, STATE, "impl_demo.md")).isSymbolicLink()).toBe(false);
  });

  // Covers: R30
  it("has the narrow allow rule in settings-base.json", () => {
    const settings = readFileSync(
      join(import.meta.dirname, "../../../../../core/core-assets/settings/settings-base.json"),
      "utf8",
    );
    expect(settings).toContain('"Bash(navori handoff render:*)"');
  });
});
