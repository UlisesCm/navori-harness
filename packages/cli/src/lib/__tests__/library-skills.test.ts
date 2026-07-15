import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIBRARY_SKILLS,
  detectLibrarySkills,
  librarySkillById,
  detectMigrations,
} from "../library-skills.ts";

const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "core", "core-assets");

describe("detectLibrarySkills", () => {
  it("returns the skill id when its dependency is present", () => {
    expect(detectLibrarySkills(["socket.io"])).toEqual(["socketio"]);
    expect(detectLibrarySkills(["react-hook-form"])).toEqual(["react-hook-form"]);
  });

  it("matches any of a skill's alias deps", () => {
    expect(detectLibrarySkills(["@nestjs/mongoose"])).toEqual(["mongoose"]);
    expect(detectLibrarySkills(["winston"])).toEqual(["winston-logging"]);
    expect(detectLibrarySkills(["redux"])).toEqual(["redux-toolkit"]);
  });

  it("is additive — a repo can match several skills at once (no exclusivity)", () => {
    // The old validator flag was zod-XOR-joi; library skills have no such rule.
    expect(detectLibrarySkills(["zod", "mongoose", "winston"])).toEqual([
      "mongoose",
      "zod-validation",
      "winston-logging",
    ]);
  });

  it("returns ids in registry order regardless of dep order", () => {
    expect(detectLibrarySkills(["react-hook-form", "socket.io"])).toEqual([
      "socketio",
      "react-hook-form",
    ]);
  });

  it("returns [] when no dependency matches", () => {
    expect(detectLibrarySkills([])).toEqual([]);
    expect(detectLibrarySkills(["express", "react", "typescript"])).toEqual([]);
  });
});

describe("detectMigrations", () => {
  it("flags a migration only when legacy AND successor are both present", () => {
    expect(detectMigrations(["moment", "dayjs"])).toEqual([
      { legacy: "moment", preferred: "dayjs", domain: "Fechas" },
    ]);
  });

  it("does NOT flag a legacy lib with no successor present", () => {
    expect(detectMigrations(["moment"])).toEqual([]);
    expect(detectMigrations(["formik"])).toEqual([]);
    expect(detectMigrations(["joi"])).toEqual([]);
  });

  it("does NOT flag a successor with no legacy present", () => {
    expect(detectMigrations(["dayjs", "react-hook-form", "zod"])).toEqual([]);
  });

  it("names the specific successor deps present, joined", () => {
    expect(detectMigrations(["moment", "dayjs", "date-fns"])).toEqual([
      { legacy: "moment", preferred: "dayjs / date-fns", domain: "Fechas" },
    ]);
  });

  it("matches legacy aliases (joi / @hapi/joi) against the zod successor", () => {
    expect(detectMigrations(["@hapi/joi", "zod"])).toEqual([
      { legacy: "@hapi/joi", preferred: "zod", domain: "Validación" },
    ]);
  });

  it("detects several active migrations at once, in registry order", () => {
    expect(detectMigrations(["formik", "react-hook-form", "moment", "dayjs"])).toEqual([
      { legacy: "moment", preferred: "dayjs", domain: "Fechas" },
      { legacy: "formik", preferred: "react-hook-form", domain: "Forms" },
    ]);
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
