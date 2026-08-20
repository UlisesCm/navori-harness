import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanEmptyUserSections } from "../skill-user-section.ts";

/**
 * #369 — `security-guidance` contributed nothing to a real security ticket
 * because its stack section was still the blank template. The skill declares
 * the dependency itself ("without the rules specific to your stack, the review
 * only covers the universal layer"), so navori can surface the debt.
 */
let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-usersection-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const MANAGED = [
  '<!-- navori:managed id="demo-base" hash="abc" version="0.6.0" source="@navori/core" -->',
  "# Demo",
  "body",
  '<!-- /navori:managed id="demo-base" -->',
].join("\n");

/** Write a rendered skill directory with `tail` after the managed block. */
function skill(id: string, tail: string): void {
  const dir = join(cwd, ".claude/skills", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `${MANAGED}\n${tail}`);
}

const TEMPLATE = [
  "",
  "## Your stack's rules",
  "",
  "<!-- user: document here what the model CAN'T infer from code. Suggestions:",
  "     - AUTHORIZATION: the mandatory server-side guard.",
  "-->",
  "",
].join("\n");

describe("scanEmptyUserSections (#369)", () => {
  it("flags a skill whose user-section is still the rendered template", () => {
    skill("security-guidance", TEMPLATE);
    expect(scanEmptyUserSections(cwd, [".claude/skills"])).toEqual([
      { id: "security-guidance", path: ".claude/skills/security-guidance/SKILL.md" },
    ]);
  });

  it("does not flag one the repo actually filled in", () => {
    skill("review-diff", `${TEMPLATE}- Never import the legacy client in new code.\n`);
    expect(scanEmptyUserSections(cwd, [".claude/skills"])).toEqual([]);
  });

  it("does not flag a skill that declares no user-section at all", () => {
    skill("structural-search", "");
    expect(scanEmptyUserSections(cwd, [".claude/skills"])).toEqual([]);
  });

  it("counts a code fence as filled — judging the CONTENT is not doctor's job", () => {
    skill("debug-error", `${TEMPLATE}\n\`\`\`bash\npnpm codegen\n\`\`\`\n`);
    expect(scanEmptyUserSections(cwd, [".claude/skills"])).toEqual([]);
  });

  it("reads the flat skill shape too, and sorts by id", () => {
    mkdirSync(join(cwd, ".claude/skills"), { recursive: true });
    writeFileSync(join(cwd, ".claude/skills/zeta.md"), `${MANAGED}\n${TEMPLATE}`);
    skill("alpha", TEMPLATE);
    expect(scanEmptyUserSections(cwd, [".claude/skills"]).map((s) => s.id)).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("returns nothing when the skills dir doesn't exist", () => {
    expect(scanEmptyUserSections(cwd, [".claude/skills", ".agents/skills"])).toEqual([]);
  });
});
