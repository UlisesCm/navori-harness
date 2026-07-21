import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLocalSkillPath } from "../skill-meta.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-localskill-"));
  mkdirSync(join(cwd, ".claude", "skills"), { recursive: true });
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("resolveLocalSkillPath", () => {
  it("resolves a flat <id>.md skill file", () => {
    writeFileSync(join(cwd, ".claude/skills/flat.md"), "# flat");
    expect(resolveLocalSkillPath(cwd, "flat")).toBe(".claude/skills/flat.md");
  });

  it("resolves a skill DIRECTORY via <id>/SKILL.md", () => {
    mkdirSync(join(cwd, ".claude/skills/big/references"), { recursive: true });
    writeFileSync(join(cwd, ".claude/skills/big/SKILL.md"), "# big");
    expect(resolveLocalSkillPath(cwd, "big")).toBe(".claude/skills/big/SKILL.md");
  });

  it("returns null when neither the file nor the directory form exists", () => {
    expect(resolveLocalSkillPath(cwd, "ghost")).toBeNull();
  });

  it("prefers the flat file when both shapes somehow exist", () => {
    writeFileSync(join(cwd, ".claude/skills/dup.md"), "# flat");
    mkdirSync(join(cwd, ".claude/skills/dup"), { recursive: true });
    writeFileSync(join(cwd, ".claude/skills/dup/SKILL.md"), "# dir");
    expect(resolveLocalSkillPath(cwd, "dup")).toBe(".claude/skills/dup.md");
  });

  it("does not treat a directory without SKILL.md as present", () => {
    mkdirSync(join(cwd, ".claude/skills/empty"), { recursive: true });
    expect(resolveLocalSkillPath(cwd, "empty")).toBeNull();
  });

  it("rejects ids with path traversal or separators (no escaping the skills root)", () => {
    // Even if the traversal target exists on disk, the id must not resolve.
    writeFileSync(join(cwd, ".claude/skills/real.md"), "# real");
    expect(resolveLocalSkillPath(cwd, "../../../../etc/hosts")).toBeNull();
    expect(resolveLocalSkillPath(cwd, "..")).toBeNull();
    expect(resolveLocalSkillPath(cwd, "nested/skill")).toBeNull();
    expect(resolveLocalSkillPath(cwd, "a\\b")).toBeNull();
    expect(resolveLocalSkillPath(cwd, "  real  ")).toBeNull();
    expect(resolveLocalSkillPath(cwd, "")).toBeNull();
    // a legit flat slug next to it still resolves
    expect(resolveLocalSkillPath(cwd, "real")).toBe(".claude/skills/real.md");
  });
});
