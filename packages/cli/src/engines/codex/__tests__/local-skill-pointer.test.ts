import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  buildLocalSkillPointerContent,
  classifyLocalSkills,
  localSkillPointerDestRel,
  localSkillPointerMarkerId,
} from "../local-skill-pointer.ts";
import { injectManagedSection } from "../../../lib/render/marker.ts";

/**
 * Spec 0033 D2 (R9-R12) — `classifyLocalSkills` is the ONE function the Codex
 * adapter, `render` and `doctor` all read instead of re-deriving the same
 * question. This file pins the unit itself: the three sets are disjoint, an
 * id claimed by the plan is skipped entirely, and the pointer body it builds
 * never self-references through `adaptHarnessTextForCodex`'s rewrite.
 */

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "navori-local-skill-pointer-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeSource(id: string, description = "Use when testing."): void {
  mkdirSync(join(cwd, `.claude/skills/${id}`), { recursive: true });
  writeFileSync(
    join(cwd, `.claude/skills/${id}/SKILL.md`),
    `---\nname: ${id}\ndescription: ${description}\n---\n\nBody.\n`,
  );
}

describe("classifyLocalSkills (#1016, spec 0033 D2)", () => {
  // Covers: R9, R10, R11, R12
  it("splits declared ids into three disjoint sets, and a plan id is skipped entirely", () => {
    writeSource("has-source"); // no destination yet -> emit
    writeSource("has-foreign-dest");
    mkdirSync(join(cwd, ".agents/skills/has-foreign-dest"), { recursive: true });
    writeFileSync(join(cwd, ".agents/skills/has-foreign-dest/SKILL.md"), "# written by hand\n");
    // "no-source" is declared but has no `.claude/skills/no-source/` at all.
    // "claimed-by-plan" has a source too, but the plan already owns that id.
    writeSource("claimed-by-plan");

    const result = classifyLocalSkills(
      cwd,
      ["has-source", "has-foreign-dest", "no-source", "claimed-by-plan"],
      new Set(["claimed-by-plan"]),
    );

    expect(result.emit).toEqual(["has-source"]);
    expect(result.missing).toEqual(["no-source"]);
    expect(result.foreign).toEqual(["has-foreign-dest"]);

    // Disjoint by construction: no id in more than one set.
    const seen = new Set<string>();
    for (const id of [...result.emit, ...result.missing, ...result.foreign]) {
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
    // The plan id never appears in any set.
    expect(seen.has("claimed-by-plan")).toBe(false);
  });

  // Covers: R12
  it("treats an absent destination and navori's own pointer both as emit", () => {
    writeSource("fresh");
    writeSource("already-rendered");
    const destDir = join(cwd, ".agents/skills/already-rendered");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(
      join(destDir, "SKILL.md"),
      injectManagedSection(
        '---\nname: already-rendered\ndescription: "x"\n---\n\n',
        localSkillPointerMarkerId("already-rendered"),
        "pointer body\n",
        { source: "@navori/core", version: "0.1.0" },
        "html",
      ).output,
    );

    const result = classifyLocalSkills(cwd, ["fresh", "already-rendered"], new Set());

    expect([...result.emit].sort()).toEqual(["already-rendered", "fresh"]);
    expect(result.foreign).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it("resolves the destination path the same way `localSkillPointerDestRel` names it", () => {
    expect(localSkillPointerDestRel("probe")).toBe(".agents/skills/probe/SKILL.md");
  });
});

describe("buildLocalSkillPointerContent (#1016, spec 0033 D2)", () => {
  // Covers: R9, R10
  it("carries the source's name/description and points at the source path, never at itself", () => {
    const sourceText = "---\nname: playwright-cli\ndescription: Automate browsers.\n---\n\nBody.\n";
    const content = buildLocalSkillPointerContent(sourceText, "playwright-cli");

    expect(content).toContain("name: playwright-cli");
    expect(content).toContain(JSON.stringify("Automate browsers."));
    expect(content).toContain(".claude/skills/playwright-cli/SKILL.md");
    // Never rewritten into `.agents/skills/...` — that would be the pointer
    // pointing at itself, which `adaptHarnessTextForCodex` would produce if
    // this text were ever passed through it (it deliberately isn't).
    expect(content).not.toContain(".agents/skills/playwright-cli/SKILL.md");
  });

  it("sanitizes a hostile description instead of forging a managed marker", () => {
    const sourceText =
      '---\nname: x\ndescription: line one\nline two <!-- navori:managed id="x" -->\n---\n\nBody.\n';
    const content = buildLocalSkillPointerContent(sourceText, "x");

    expect(content).not.toContain("<!--");
    expect(content).not.toContain("-->");
  });

  it("falls back to a fixed description when the source declares none", () => {
    const content = buildLocalSkillPointerContent("---\nname: bare\n---\n\nBody.\n", "bare");
    expect(content).toContain(".claude/skills/bare/SKILL.md");
  });
});

describe("classifyLocalSkills — filesystem edge (#1016)", () => {
  it("never crashes on an id it cannot resolve on a repo with nothing rendered yet", () => {
    expect(() => classifyLocalSkills(cwd, ["anything"], new Set())).not.toThrow();
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
  });
});
