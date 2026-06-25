import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIBRARY_SKILLS,
  detectLibrarySkills,
  librarySkillById,
} from "../library-skills.ts";

const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "core", "core-assets");

describe("detectLibrarySkills", () => {
  it("returns the skill id when its dependency is present", () => {
    expect(detectLibrarySkills(["socket.io"])).toEqual(["socketio"]);
    expect(detectLibrarySkills(["formik"])).toEqual(["formik"]);
  });

  it("matches any of a skill's alias deps", () => {
    expect(detectLibrarySkills(["@nestjs/mongoose"])).toEqual(["mongoose"]);
    expect(detectLibrarySkills(["@hapi/joi"])).toEqual(["joi-validation"]);
    expect(detectLibrarySkills(["redux"])).toEqual(["redux-toolkit"]);
  });

  it("is additive — a repo can match several skills at once (no exclusivity)", () => {
    // The old validator flag was zod-XOR-joi; library skills have no such rule.
    expect(detectLibrarySkills(["zod", "joi", "mongoose"])).toEqual([
      "mongoose",
      "zod-validation",
      "joi-validation",
    ]);
  });

  it("returns ids in registry order regardless of dep order", () => {
    expect(detectLibrarySkills(["formik", "socket.io"])).toEqual(["socketio", "formik"]);
  });

  it("returns [] when no dependency matches", () => {
    expect(detectLibrarySkills([])).toEqual([]);
    expect(detectLibrarySkills(["express", "react", "typescript"])).toEqual([]);
  });
});

describe("librarySkillById", () => {
  it("resolves a known id to its registry entry", () => {
    expect(librarySkillById("mongoose")?.label).toBe("Mongoose ODM");
  });

  it("returns null for an unknown id", () => {
    expect(librarySkillById("does-not-exist")).toBeNull();
  });
});

describe("library-skills registry integrity", () => {
  it("every registry id has a backing asset in core-assets/lib-skills/", () => {
    for (const skill of LIBRARY_SKILLS) {
      const path = resolve(coreAssets, "lib-skills", `${skill.id}.md`);
      expect(existsSync(path), `missing asset for library skill '${skill.id}': ${path}`).toBe(true);
    }
  });
});
