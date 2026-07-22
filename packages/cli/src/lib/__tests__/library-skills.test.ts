import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LIBRARY_SKILLS,
  MIGRATION_PAIRS,
  detectLibrarySkills,
  librarySkillById,
  detectMigrations,
  trackedDepNames,
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
    // Stripe activates from the server SDK, the JS client, or the React bindings.
    expect(detectLibrarySkills(["stripe"])).toEqual(["stripe"]);
    expect(detectLibrarySkills(["@stripe/stripe-js"])).toEqual(["stripe"]);
    expect(detectLibrarySkills(["@stripe/react-stripe-js"])).toEqual(["stripe"]);
    // RN/Expo stack libraries.
    expect(detectLibrarySkills(["@apollo/client"])).toEqual(["apollo-client"]);
    expect(detectLibrarySkills(["zustand"])).toEqual(["zustand"]);
    expect(detectLibrarySkills(["tamagui"])).toEqual(["tamagui"]);
    expect(detectLibrarySkills(["@tamagui/core"])).toEqual(["tamagui"]);
    expect(detectLibrarySkills(["bullmq"])).toEqual(["bullmq"]);
    // The React SPA stack (issue #92).
    expect(detectLibrarySkills(["react-router-dom"])).toEqual(["react-router"]);
    expect(detectLibrarySkills(["react-router"])).toEqual(["react-router"]);
    expect(detectLibrarySkills(["axios"])).toEqual(["axios"]);
    expect(detectLibrarySkills(["@mantine/form"])).toEqual(["mantine-form"]);
    expect(detectLibrarySkills(["mantine-form-zod-resolver"])).toEqual(["mantine-form"]);
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

  describe("adoption gate (import counts)", () => {
    it("drops a skill whose dep is imported below the threshold (react-hook-form @ 2)", () => {
      // The reported false positive: RHF declared but used in only 2 files.
      const counts = new Map([["react-hook-form", 2]]);
      expect(detectLibrarySkills(["react-hook-form"], counts)).toEqual([]);
    });

    it("keeps a skill once its dep clears the threshold (react-router @ 121)", () => {
      const counts = new Map([["react-router-dom", 121]]);
      expect(detectLibrarySkills(["react-router-dom"], counts)).toEqual(["react-router"]);
    });

    it("keeps a declared dep with NO observed imports (empty repo / benefit of doubt)", () => {
      // Counts provided but the dep scans to 0 (fresh repo, or used via non-import
      // means): we never suppress on mere absence of evidence.
      const counts = new Map([["mongoose", 0]]);
      expect(detectLibrarySkills(["mongoose"], counts)).toEqual(["mongoose"]);
    });

    it("sums usage across a skill's alias deps before gating", () => {
      // @mantine/form=1 + resolver=2 = 3 → clears the floor together.
      const counts = new Map([
        ["@mantine/form", 1],
        ["mantine-form-zod-resolver", 2],
      ]);
      expect(detectLibrarySkills(["@mantine/form", "mantine-form-zod-resolver"], counts)).toEqual([
        "mantine-form",
      ]);
    });
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

  it("flags the new UI-kit and yup→zod pairs (issue #87)", () => {
    expect(detectMigrations(["antd", "@mantine/core"])).toEqual([
      { legacy: "antd", preferred: "@mantine/core", domain: "UI" },
    ]);
    expect(detectMigrations(["@chakra-ui/react", "@mantine/core"])).toEqual([
      { legacy: "@chakra-ui/react", preferred: "@mantine/core", domain: "UI" },
    ]);
    expect(detectMigrations(["yup", "zod"])).toEqual([
      { legacy: "yup", preferred: "zod", domain: "Validación" },
    ]);
  });

  describe("dominance gate (import counts)", () => {
    it("does NOT flag when the preferred side is an incidental peer dep (moment 23 vs dayjs 3)", () => {
      // Real bonum-dashboard case: dayjs is a peer of @mantine/dates, not the
      // migration target (that's luxon, not in the pair). 3 < 23*0.5 → skip.
      const counts = new Map([
        ["moment", 23],
        ["dayjs", 3],
      ]);
      expect(detectMigrations(["moment", "dayjs"], counts)).toEqual([]);
    });

    it("does NOT flag when the preferred side is below the absolute floor (formik 26 vs rhf 2)", () => {
      const counts = new Map([
        ["formik", 26],
        ["react-hook-form", 2],
      ]);
      expect(detectMigrations(["formik", "react-hook-form"], counts)).toEqual([]);
    });

    it("flags a genuine mid-migration where the preferred side is well adopted", () => {
      const counts = new Map([
        ["moment", 10],
        ["dayjs", 8],
      ]);
      expect(detectMigrations(["moment", "dayjs"], counts)).toEqual([
        { legacy: "moment", preferred: "dayjs", domain: "Fechas" },
      ]);
    });

    it("orders multiple preferred candidates by usage, dominant first", () => {
      const counts = new Map([
        ["moment", 20],
        ["dayjs", 6],
        ["date-fns", 18],
      ]);
      expect(detectMigrations(["moment", "dayjs", "date-fns"], counts)).toEqual([
        { legacy: "moment", preferred: "date-fns / dayjs", domain: "Fechas" },
      ]);
    });

    it("flags on presence when the preferred side has no observed imports (benefit of doubt)", () => {
      const counts = new Map([
        ["moment", 12],
        ["dayjs", 0],
      ]);
      expect(detectMigrations(["moment", "dayjs"], counts)).toEqual([
        { legacy: "moment", preferred: "dayjs", domain: "Fechas" },
      ]);
    });
  });
});

describe("trackedDepNames", () => {
  it("includes every dep referenced by the skill and migration registries", () => {
    const tracked = new Set(trackedDepNames());
    for (const skill of LIBRARY_SKILLS) {
      for (const d of skill.deps) expect(tracked.has(d)).toBe(true);
    }
    for (const pair of MIGRATION_PAIRS) {
      for (const d of [...pair.legacy, ...pair.preferred]) expect(tracked.has(d)).toBe(true);
    }
  });

  it("is deduped (a dep shared by a skill and a migration appears once)", () => {
    const names = trackedDepNames();
    expect(names.length).toBe(new Set(names).size);
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
