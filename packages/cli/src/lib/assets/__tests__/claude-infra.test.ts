import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectClaudeInfra } from "../claude-infra.ts";

/**
 * #1053 — a repo that only has navori's own `progress/` (bootstrapped
 * create-if-missing, never overwritten by render — see planBootstrapFile in
 * engines/claude/index.ts) must not be treated as foreign infra: `present`
 * has to stay false so `init --full`/`--yes` renders instead of forcing
 * coexist. `specsDirs` is a different category (render never touches
 * specs/, so it can be content genuinely foreign to navori) and keeps
 * counting toward `present`.
 */
describe("detectClaudeInfra — progress/ vs specs/ (#1053)", () => {
  let repo: string;

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("progress/ with files only → present is false", () => {
    repo = mkdtempSync(join(tmpdir(), "navori-infra-"));
    const progressDir = join(repo, "progress");
    mkdirSync(progressDir);
    writeFileSync(join(progressDir, "current.md"), "# state");
    writeFileSync(join(progressDir, "history.md"), "# history");

    const infra = detectClaudeInfra(repo);

    expect(infra.progressFiles).toBe(2);
    expect(infra.present).toBe(false);
  });

  it("progress/ + CLAUDE.md → present is true (another real signal)", () => {
    repo = mkdtempSync(join(tmpdir(), "navori-infra-"));
    const progressDir = join(repo, "progress");
    mkdirSync(progressDir);
    writeFileSync(join(progressDir, "current.md"), "# state");
    writeFileSync(join(repo, "CLAUDE.md"), "# project instructions");

    const infra = detectClaudeInfra(repo);

    expect(infra.progressFiles).toBe(1);
    expect(infra.hasClaudeMd).toBe(true);
    expect(infra.present).toBe(true);
  });

  it("specs/ with a subdir → present is true (specs/ is never render-managed)", () => {
    repo = mkdtempSync(join(tmpdir(), "navori-infra-"));
    mkdirSync(join(repo, "specs", "some-feature"), { recursive: true });

    const infra = detectClaudeInfra(repo);

    expect(infra.specsDirs).toBe(1);
    expect(infra.present).toBe(true);
  });
});

describe("detectClaudeInfra — foreignHarness (#1111)", () => {
  let repo: string;

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it("CLAUDE.md only → present but not foreign", () => {
    repo = mkdtempSync(join(tmpdir(), "navori-infra-"));
    writeFileSync(join(repo, "CLAUDE.md"), "# mine");

    const infra = detectClaudeInfra(repo);

    expect(infra.present).toBe(true);
    expect(infra.foreignHarness).toBe(false);
  });

  it("AGENTS.md only → present but not foreign", () => {
    repo = mkdtempSync(join(tmpdir(), "navori-infra-"));
    writeFileSync(join(repo, "AGENTS.md"), "# mine");

    const infra = detectClaudeInfra(repo);

    expect(infra.present).toBe(true);
    expect(infra.foreignHarness).toBe(false);
  });

  it(".claude/settings.json only → present but not foreign", () => {
    repo = mkdtempSync(join(tmpdir(), "navori-infra-"));
    mkdirSync(join(repo, ".claude"));
    writeFileSync(join(repo, ".claude", "settings.json"), "{}");

    const infra = detectClaudeInfra(repo);

    expect(infra.present).toBe(true);
    expect(infra.foreignHarness).toBe(false);
  });

  it("an agent file → foreign", () => {
    repo = mkdtempSync(join(tmpdir(), "navori-infra-"));
    mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
    writeFileSync(join(repo, ".claude", "agents", "foo.md"), "# foo");

    expect(detectClaudeInfra(repo).foreignHarness).toBe(true);
  });

  it("a skill dir → foreign", () => {
    repo = mkdtempSync(join(tmpdir(), "navori-infra-"));
    mkdirSync(join(repo, ".claude", "skills", "bar"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "bar", "SKILL.md"), "# bar");

    expect(detectClaudeInfra(repo).foreignHarness).toBe(true);
  });
});
