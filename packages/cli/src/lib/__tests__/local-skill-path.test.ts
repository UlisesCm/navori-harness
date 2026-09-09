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
  it("NO resuelve un `<id>.md` plano: el host no lo carga (#626)", () => {
    // La tabla "Choose where skills load" del host lista cinco ubicaciones y
    // todas son `<skill-name>/SKILL.md`; el plano pertenece a
    // `.claude/commands/`, que es otra cosa. Resolverlo hacía que navori leyera
    // su description y la publicara en el índice de CLAUDE.md — anunciando una
    // skill que nunca iba a existir. `scanFlatSkills` reporta el archivo para
    // que el usuario sepa POR QUÉ su skill enmudeció.
    writeFileSync(join(cwd, ".claude/skills/flat.md"), "# flat");
    expect(resolveLocalSkillPath(cwd, "flat")).toBeNull();
  });

  it("resolves a skill DIRECTORY via <id>/SKILL.md", () => {
    mkdirSync(join(cwd, ".claude/skills/big/references"), { recursive: true });
    writeFileSync(join(cwd, ".claude/skills/big/SKILL.md"), "# big");
    expect(resolveLocalSkillPath(cwd, "big")).toBe(".claude/skills/big/SKILL.md");
  });

  it("returns null when neither the file nor the directory form exists", () => {
    expect(resolveLocalSkillPath(cwd, "ghost")).toBeNull();
  });

  it("con las dos formas presentes, gana el directorio — el plano ya no cuenta", () => {
    // Antes ganaba el plano, que es justo el caso que ocultó una divergencia en
    // campo: dos definiciones del mismo nombre y la que cargaba no era la que
    // navori estaba leyendo.
    writeFileSync(join(cwd, ".claude/skills/dup.md"), "# flat");
    mkdirSync(join(cwd, ".claude/skills/dup"), { recursive: true });
    writeFileSync(join(cwd, ".claude/skills/dup/SKILL.md"), "# dir");
    expect(resolveLocalSkillPath(cwd, "dup")).toBe(".claude/skills/dup/SKILL.md");
  });

  it("does not treat a directory without SKILL.md as present", () => {
    mkdirSync(join(cwd, ".claude/skills/empty"), { recursive: true });
    expect(resolveLocalSkillPath(cwd, "empty")).toBeNull();
  });

  it("rejects ids with path traversal or separators (no escaping the skills root)", () => {
    // Even if the traversal target exists on disk, the id must not resolve.
    mkdirSync(join(cwd, ".claude/skills/real"), { recursive: true });
    writeFileSync(join(cwd, ".claude/skills/real/SKILL.md"), "# real");
    expect(resolveLocalSkillPath(cwd, "../../../../etc/hosts")).toBeNull();
    expect(resolveLocalSkillPath(cwd, "..")).toBeNull();
    expect(resolveLocalSkillPath(cwd, "nested/skill")).toBeNull();
    expect(resolveLocalSkillPath(cwd, "a\\b")).toBeNull();
    expect(resolveLocalSkillPath(cwd, "  real  ")).toBeNull();
    expect(resolveLocalSkillPath(cwd, "")).toBeNull();
    // un id legítimo al lado sigue resolviendo
    expect(resolveLocalSkillPath(cwd, "real")).toBe(".claude/skills/real/SKILL.md");
  });
});
