import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nestedGitignoreEntries, renderNestedGitignore } from "../nested-gitignore-harness.ts";
import { EPHEMERAL_HARNESS_PATHS } from "../ephemeral-paths.ts";
import { writeConfig } from "../../../lib/config/config.ts";
import { runRender } from "../../../commands/render.ts";

/**
 * #1024/#1039 — the nested `.claude/.gitignore` / `.codex/.gitignore`.
 * Unlike the root `.gitignore`'s Cubo A (`gitignore-harness.test.ts`), this
 * block is unconditional: `renderNestedGitignore` takes no `gitignoreHarness`
 * mode at all, so there is no "off" branch to test here by construction.
 */
describe("nestedGitignoreEntries — pure derivation", () => {
  it("lists only .claude/'s own ephemeral entries, relative to .claude/", () => {
    expect(nestedGitignoreEntries(".claude")).toEqual(
      EPHEMERAL_HARNESS_PATHS.filter((p) => p.startsWith(".claude/")).map((p) =>
        p.slice(".claude/".length),
      ),
    );
    expect(nestedGitignoreEntries(".claude")).toEqual([
      "settings.local.json",
      "worktrees/",
      "progress/",
      // Legacy (#1024 round 2): neither hook writes these anymore, but a repo
      // onboarded on navori <=0.10.0 still has the files on disk.
      ".managed-drift-stamp",
      ".routing-watch/",
    ]);
  });

  it("lists only .codex/'s own ephemeral entries", () => {
    expect(nestedGitignoreEntries(".codex")).toEqual(["progress/"]);
  });

  it("never lists anything a claude/codex engine needs to function", () => {
    const entries = [...nestedGitignoreEntries(".claude"), ...nestedGitignoreEntries(".codex")];
    for (const owned of ["agents/", "hooks/", "skills/", "settings.json", "config.toml"]) {
      expect(entries).not.toContain(owned);
    }
  });

  it("empty for a dir EPHEMERAL_HARNESS_PATHS names nothing under", () => {
    expect(nestedGitignoreEntries(".cursor")).toEqual([]);
  });

  it("accepts a trailing-slash dir the same as a bare one", () => {
    expect(nestedGitignoreEntries(".claude/")).toEqual(nestedGitignoreEntries(".claude"));
  });
});

let cwd: string;

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-nested-gitignore-"));
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
  return dir;
}

describe("renderNestedGitignore", () => {
  it("returns null and writes nothing when the dir owns no ephemeral entries", () => {
    cwd = tempRepo();
    expect(renderNestedGitignore(cwd, ".cursor", { lang: "es" })).toBeNull();
  });

  it("first render: status 'created', body matches nestedGitignoreEntries", () => {
    cwd = tempRepo();
    const result = renderNestedGitignore(cwd, ".claude", { lang: "es" });
    expect(result?.status).toBe("created");
    expect(result?.path).toBe(join(".claude", ".gitignore"));

    const body = readFileSync(join(cwd, ".claude", ".gitignore"), "utf-8");
    for (const entry of nestedGitignoreEntries(".claude")) expect(body).toContain(entry);
  });

  it("re-render is a no-op", () => {
    cwd = tempRepo();
    renderNestedGitignore(cwd, ".claude", { lang: "es" });
    const before = readFileSync(join(cwd, ".claude", ".gitignore"), "utf-8");

    const second = renderNestedGitignore(cwd, ".claude", { lang: "es" });
    expect(second?.status).toBe("unchanged");
    expect(readFileSync(join(cwd, ".claude", ".gitignore"), "utf-8")).toBe(before);
  });

  it("preserves user content outside the managed block", () => {
    cwd = tempRepo();
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", ".gitignore"), "# my own note\nscratch/\n");

    renderNestedGitignore(cwd, ".claude", { lang: "es" });

    const body = readFileSync(join(cwd, ".claude", ".gitignore"), "utf-8");
    expect(body).toContain("# my own note");
    expect(body).toContain("scratch/");
    expect(body).toContain("progress/");
  });

  it("a hand-edited block is preserved unless force is set", () => {
    cwd = tempRepo();
    renderNestedGitignore(cwd, ".claude", { lang: "es" });
    const rendered = readFileSync(join(cwd, ".claude", ".gitignore"), "utf-8");
    writeFileSync(
      join(cwd, ".claude", ".gitignore"),
      rendered.replace("progress/", "progress/\nmine/"),
    );

    const result = renderNestedGitignore(cwd, ".claude", { lang: "es" });
    expect(result?.status).toBe("user-modified-skipped");
    expect(readFileSync(join(cwd, ".claude", ".gitignore"), "utf-8")).toContain("mine/");
  });

  it("stays inert under the Bonum shape: git status --porcelain shows nothing new", () => {
    cwd = tempRepo();
    writeFileSync(join(cwd, ".gitignore"), ".claude/\n");
    execFileSync("git", ["-C", cwd, "add", "-A"], { stdio: "ignore" });
    execFileSync(
      "git",
      ["-C", cwd, "-c", "user.email=t@t.io", "-c", "user.name=t", "commit", "-q", "-m", "init"],
      { stdio: "ignore" },
    );

    renderNestedGitignore(cwd, ".claude", { lang: "es" });

    const status = execFileSync("git", ["-C", cwd, "status", "--porcelain"], {
      encoding: "utf-8",
    });
    expect(status.trim()).toBe("");
  });
});

/**
 * Wiring through `render.ts` (#1024/#1039): unconditional in every
 * `gitignoreHarness` mode including the default "off", and `.codex/.gitignore`
 * exists only when the codex engine is configured.
 */
describe("render.ts wiring", () => {
  it("writes .claude/.gitignore even under gitignoreHarness: 'off' (the default)", () => {
    cwd = mkdtempSync(join(tmpdir(), "navori-nested-render-"));
    writeConfig(join(cwd, "navori.config.json"), {
      name: "nested-off",
      engines: ["claude"],
      preset: "custom",
      qualityGate: { fast: "pnpm lint", full: "pnpm test" },
    });

    const result = runRender(cwd);
    expect(result.ok).toBe(true);
    expect(result.claudeGitignore?.status).toBe("created");
    // The root Cubo A block stays untouched — mode is "off" by default.
    expect(result.gitignore).toBeNull();
  });

  it("does not write .codex/.gitignore when codex isn't configured", () => {
    cwd = mkdtempSync(join(tmpdir(), "navori-nested-render-"));
    writeConfig(join(cwd, "navori.config.json"), {
      name: "no-codex",
      engines: ["claude"],
      preset: "custom",
      qualityGate: { fast: "pnpm lint", full: "pnpm test" },
    });

    const result = runRender(cwd);
    expect(result.codexGitignore).toBeNull();
  });

  it("writes .codex/.gitignore when codex is configured", () => {
    cwd = mkdtempSync(join(tmpdir(), "navori-nested-render-codex-"));
    writeConfig(join(cwd, "navori.config.json"), {
      name: "with-codex",
      engines: ["claude", "codex"],
      preset: "custom",
      qualityGate: { fast: "pnpm lint", full: "pnpm test" },
    });

    const result = runRender(cwd);
    expect(result.codexGitignore?.status).toBe("created");
    const body = readFileSync(join(cwd, ".codex", ".gitignore"), "utf-8");
    expect(body).toContain("progress/");
  });
});

/**
 * #1024 round 2 — the regression the orchestrator reproduced: a repo onboarded
 * on navori <=0.10.0 already has `.claude/.managed-drift-stamp` and
 * `.claude/.routing-watch/<session>` on disk (the old hooks wrote them
 * unconditionally, and neither hook ever deletes what it wrote). Removing
 * those two entries from `EPHEMERAL_HARNESS_PATHS` — round 1's fix — made
 * rendering this branch UNTRACK them retroactively: `git status` started
 * reporting them as untracked, `git check-ignore` stopped matching. Both
 * entries are back as LEGACY (see `ephemeral-paths.ts`'s module doc), so a
 * render with pre-existing leftovers must leave them exactly as ignored as
 * they were before the upgrade, in every `gitignoreHarness` mode.
 */
function seedLegacyLeftovers(cwd: string): void {
  mkdirSync(join(cwd, ".claude", ".routing-watch"), { recursive: true });
  writeFileSync(join(cwd, ".claude", ".managed-drift-stamp"), "deadbeef  CLAUDE.md\n");
  writeFileSync(join(cwd, ".claude", ".routing-watch", "s1"), "path:/x.ts\n");
}

describe("upgrade regression: pre-existing legacy stamps stay ignored (#1024 round 2)", () => {
  it("gitignoreHarness: 'off' — render does not untrack the leftovers", () => {
    const upgraded = mkdtempSync(join(tmpdir(), "navori-legacy-off-"));
    execFileSync("git", ["-C", upgraded, "init", "-q"], { stdio: "ignore" });
    writeConfig(join(upgraded, "navori.config.json"), {
      name: "legacy-off",
      engines: ["claude"],
      preset: "custom",
      qualityGate: { fast: "pnpm lint", full: "pnpm test" },
    });
    seedLegacyLeftovers(upgraded);

    const result = runRender(upgraded);
    expect(result.ok).toBe(true);

    const status = execFileSync("git", ["-C", upgraded, "status", "--porcelain"], {
      encoding: "utf-8",
    });
    expect(status).not.toContain(".managed-drift-stamp");
    expect(status).not.toContain(".routing-watch");
  });

  it("gitignoreHarness: 'local' — root cubo A keeps both legacy entries, no content drift, leftovers stay ignored", () => {
    const upgraded = mkdtempSync(join(tmpdir(), "navori-legacy-local-"));
    execFileSync("git", ["-C", upgraded, "init", "-q"], { stdio: "ignore" });
    writeConfig(join(upgraded, "navori.config.json"), {
      name: "legacy-local",
      engines: ["claude"],
      preset: "custom",
      qualityGate: { fast: "pnpm lint", full: "pnpm test" },
      gitignoreHarness: "local",
    });
    seedLegacyLeftovers(upgraded);

    const result = runRender(upgraded);
    expect(result.ok).toBe(true);
    expect(result.gitignore?.status).toBe("created");

    const rootBody = readFileSync(join(upgraded, ".gitignore"), "utf-8");
    expect(rootBody).toContain(".claude/.managed-drift-stamp");
    expect(rootBody).toContain(".claude/.routing-watch/");

    const status = execFileSync("git", ["-C", upgraded, "status", "--porcelain"], {
      encoding: "utf-8",
    });
    expect(status).not.toContain(".managed-drift-stamp");
    expect(status).not.toContain(".routing-watch");
  });

  it("a second render on an already-onboarded 'local' repo is a no-op — no content drift on a version bump", () => {
    const upgraded = mkdtempSync(join(tmpdir(), "navori-legacy-nodrift-"));
    execFileSync("git", ["-C", upgraded, "init", "-q"], { stdio: "ignore" });
    writeConfig(join(upgraded, "navori.config.json"), {
      name: "legacy-nodrift",
      engines: ["claude"],
      preset: "custom",
      qualityGate: { fast: "pnpm lint", full: "pnpm test" },
      gitignoreHarness: "local",
    });
    seedLegacyLeftovers(upgraded);
    runRender(upgraded);

    const second = runRender(upgraded);
    // Same entries, same order as before round 1 ever touched the list — the
    // body hash is unchanged, so a version-only bump reports "unchanged", not
    // "updated" (which would mean content drift, not just a version restamp).
    expect(second.gitignore?.status).toBe("unchanged");
  });
});
