import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  LIBRARY_SKILLS,
  MIGRATION_PAIRS,
  REMOVED_LIB_SKILLS,
  REMOVED_LIB_SKILL_SUCCESSORS,
  detectLibrarySkills,
  librarySkillById,
  detectMigrations,
  migrationDepNames,
  unknownLibraries,
  parseMajorVersion,
} from "../library-skills.ts";

const here = dirname(fileURLToPath(import.meta.url));
const coreAssets = resolve(here, "..", "..", "..", "..", "..", "core", "core-assets");

describe("detectLibrarySkills", () => {
  it("returns the skill id when its dependency is present", () => {
    expect(detectLibrarySkills(["socket.io"])).toEqual(["socketio-server"]);
    expect(detectLibrarySkills(["react-hook-form"])).toEqual(["react-hook-form"]);
  });

  // #324: `socket.io` and `socket.io-client` are different libraries. A single
  // skill keyed on both handed a React SPA a server guide about namespaces and
  // handshake auth, and nothing about the client bugs (listeners that leak per
  // render, module singletons, missing cleanup).
  it("maps each side of Socket.IO to its own skill", () => {
    expect(detectLibrarySkills(["socket.io-client"])).toEqual(["socketio-client"]);
    expect(detectLibrarySkills(["socket.io", "socket.io-client"])).toEqual([
      "socketio-server",
      "socketio-client",
    ]);
  });

  it("detects the library skills added for the mobile / SQL stacks (#322, #327)", () => {
    expect(detectLibrarySkills(["drizzle-orm"])).toEqual(["drizzle-orm"]);
    expect(detectLibrarySkills(["drizzle-kit"])).toEqual(["drizzle-orm"]);
    expect(detectLibrarySkills(["@react-navigation/native"])).toEqual(["react-navigation"]);
    expect(detectLibrarySkills(["react-i18next"])).toEqual(["i18next"]);
    expect(detectLibrarySkills(["cypress"])).toEqual(["cypress"]);
    // The Cypress binding of Testing Library earns those conventions too.
    expect(detectLibrarySkills(["@testing-library/cypress"])).toEqual(["testing-library"]);
  });

  it("detects the Expo UI-stack skills: local DB, Uniwind, React Native Reusables", () => {
    expect(detectLibrarySkills(["expo-sqlite"])).toEqual(["expo-sqlite"]);
    expect(detectLibrarySkills(["expo-sqlite", "drizzle-orm"])).toEqual([
      "drizzle-orm",
      "expo-sqlite",
    ]);
    expect(detectLibrarySkills(["uniwind"])).toEqual(["uniwind"]);
    // RNR ships no package of its own — components are copied in — so its runtime
    // primitives are the only dependency trace it leaves.
    expect(detectLibrarySkills(["@rn-primitives/portal"])).toEqual(["react-native-reusables"]);
    expect(detectLibrarySkills(["@rn-primitives/slot"])).toEqual(["react-native-reusables"]);
  });

  // nativewind is retired (REMOVED_LIB_SKILLS) — Uniwind is the boilerplate's
  // actual RN styling library, and a different one, not a rename.
  it("no longer detects nativewind — it is retired", () => {
    expect(detectLibrarySkills(["nativewind"])).toEqual([]);
    expect(REMOVED_LIB_SKILLS).toContain("nativewind");
  });

  it("detects the Expo/EAS-stack skills: expo-router, eas-release", () => {
    expect(detectLibrarySkills(["expo-router"])).toEqual(["expo-router"]);
  });

  it("detects the Hono/Better-Auth/React-Email backend-stack skills", () => {
    expect(detectLibrarySkills(["hono"])).toEqual(["hono"]);
    expect(detectLibrarySkills(["better-auth"])).toEqual(["better-auth"]);
    expect(detectLibrarySkills(["@react-email/components"])).toEqual(["react-email"]);
    expect(detectLibrarySkills(["resend"])).toEqual(["react-email"]);
  });

  it("detects the Vite/web-stack skills: TanStack Router, shadcn Base UI, Tailwind v4", () => {
    expect(detectLibrarySkills(["@tanstack/react-router"])).toEqual(["tanstack-router"]);
    expect(detectLibrarySkills(["@base-ui/react"])).toEqual(["shadcn-base-ui"]);
    expect(detectLibrarySkills(["shadcn"])).toEqual(["shadcn-base-ui"]);
    expect(detectLibrarySkills(["tailwindcss"])).toEqual(["tailwind-v4"]);
  });

  it.each([
    "@tanstack/react-table",
    "mantine-react-table",
    "mantine-datatable",
    "ag-grid-react",
    "react-admin",
    "@refinedev/core",
  ])("detects admin dashboards by their data-table or admin kit (%s)", (dep) => {
    expect(detectLibrarySkills([dep])).toEqual(["dashboard-patterns"]);
  });

  it("does not detect dashboards from a UI kit alone or from legacy antd", () => {
    expect(detectLibrarySkills(["@mantine/core"])).toEqual([]);
    expect(detectLibrarySkills(["antd"])).toEqual([]);
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
      "socketio-server",
      "react-hook-form",
    ]);
  });

  it("returns [] when no dependency matches", () => {
    expect(detectLibrarySkills([])).toEqual([]);
    expect(detectLibrarySkills(["express", "react", "typescript"])).toEqual([]);
  });

  it("is presence-only — a declared tracked dep always earns its skill, however few its uses", () => {
    // Product decision: usage counts weigh migrations, never whether a lib is
    // worth teaching. A two-file mongoose backend still gets the mongoose skill.
    expect(detectLibrarySkills(["react-hook-form"])).toEqual(["react-hook-form"]);
    expect(detectLibrarySkills(["mongoose"])).toEqual(["mongoose"]);
  });

  it("detects testing-tool skills by their runner/assertion deps", () => {
    expect(detectLibrarySkills(["vitest"])).toEqual(["vitest"]);
    expect(detectLibrarySkills(["jest"])).toEqual(["jest"]);
    expect(detectLibrarySkills(["jest-expo"])).toEqual(["jest"]);
    expect(detectLibrarySkills(["@playwright/test"])).toEqual(["playwright"]);
    expect(detectLibrarySkills(["playwright"])).toEqual(["playwright"]);
    expect(detectLibrarySkills(["supertest"])).toEqual(["supertest"]);
    expect(detectLibrarySkills(["@testing-library/react"])).toEqual(["testing-library"]);
    expect(detectLibrarySkills(["@testing-library/react-native"])).toEqual(["testing-library"]);
    expect(detectLibrarySkills(["@testing-library/user-event"])).toEqual(["testing-library"]);
  });

  it("detects the CLI tooling skills navori itself ships (citty + clack)", () => {
    expect(detectLibrarySkills(["citty"])).toEqual(["citty"]);
    expect(detectLibrarySkills(["@clack/prompts"])).toEqual(["clack"]);
  });

  it("materializes the real testing stacks of the target repos (mobile + medusa)", () => {
    // alertaciudadana_app (RN/Expo): jest + React Native Testing Library.
    expect(detectLibrarySkills(["jest", "jest-expo", "@testing-library/react-native"])).toEqual([
      "jest",
      "testing-library",
    ]);
    // moonar storefront: vitest + RTL + playwright e2e.
    expect(detectLibrarySkills(["vitest", "@testing-library/react", "@playwright/test"])).toEqual([
      "vitest",
      "testing-library",
      "playwright",
    ]);
    // alertaciudadana_backend (bun): vitest + supertest.
    expect(detectLibrarySkills(["vitest", "supertest"])).toEqual(["vitest", "supertest"]);
  });
});

// #1052 — parseMajorVersion is the dependency-free semver-major reader that
// `minMajor` gating relies on (alternative B: no new runtime dependency).
describe("parseMajorVersion", () => {
  // Covers: A1
  it("resolves the common range shapes to their leading major", () => {
    expect(parseMajorVersion("^3.3.5")).toBe(3);
    expect(parseMajorVersion("~3")).toBe(3);
    expect(parseMajorVersion("3.x")).toBe(3);
    expect(parseMajorVersion(">=3")).toBe(3);
    expect(parseMajorVersion("^4.0.0")).toBe(4);
  });

  // Covers: A1
  it("returns null for ranges with no resolvable major (fail-open cases)", () => {
    expect(parseMajorVersion("workspace:*")).toBeNull();
    expect(parseMajorVersion("catalog:")).toBeNull();
    expect(parseMajorVersion("latest")).toBeNull();
    expect(parseMajorVersion("*")).toBeNull();
    expect(parseMajorVersion("git+https://github.com/tailwindlabs/tailwindcss.git")).toBeNull();
  });
});

// #1052 — tailwind-v4 used to activate on ANY tailwindcss dep, guidance that is
// actively wrong for a Tailwind 3 repo. `minMajor` gates it by the resolved
// major of the matched dep's declared range, fail-open when unresolved.
describe("detectLibrarySkills — minMajor gating (#1052)", () => {
  // Covers: A1
  it("does NOT activate tailwind-v4 when the declared range resolves to v3", () => {
    expect(
      detectLibrarySkills(["tailwindcss"], undefined, new Map([["tailwindcss", "^3.3.5"]])),
    ).toEqual([]);
    expect(
      detectLibrarySkills(["tailwindcss"], undefined, new Map([["tailwindcss", "~3"]])),
    ).toEqual([]);
    expect(
      detectLibrarySkills(["tailwindcss"], undefined, new Map([["tailwindcss", "3.x"]])),
    ).toEqual([]);
    expect(
      detectLibrarySkills(["tailwindcss"], undefined, new Map([["tailwindcss", ">=3"]])),
    ).toEqual([]);
  });

  // Covers: A1
  it("activates tailwind-v4 when the declared range resolves to v4", () => {
    expect(
      detectLibrarySkills(["tailwindcss"], undefined, new Map([["tailwindcss", "^4.0.0"]])),
    ).toEqual(["tailwind-v4"]);
  });

  // Covers: A1
  it("activates tailwind-v4 (fail-open) when the range does not resolve", () => {
    for (const range of ["workspace:*", "catalog:", "latest", "*", "git+https://x/y.git"]) {
      expect(
        detectLibrarySkills(["tailwindcss"], undefined, new Map([["tailwindcss", range]])),
      ).toEqual(["tailwind-v4"]);
    }
  });

  // Covers: A1
  it("activates tailwind-v4 (fail-open) when depVersions has no entry for the matched dep", () => {
    expect(detectLibrarySkills(["tailwindcss"], undefined, new Map())).toEqual(["tailwind-v4"]);
    expect(detectLibrarySkills(["tailwindcss"])).toEqual(["tailwind-v4"]);
  });
});

// #331 — tools that install no npm package (Maestro is a standalone binary)
// can never be detected from deps. A skill may declare `paths`: repo-relative
// signals checked against the `cwd` handed to the detector, in OR with `deps`.
describe("detectLibrarySkills — filesystem signals (paths)", () => {
  const withDirs = (...dirs: string[]): string => {
    const dir = mkdtempSync(join(tmpdir(), "navori-libskills-"));
    for (const d of dirs) mkdirSync(join(dir, d), { recursive: true });
    return dir;
  };

  it("splits Supabase by what the repo holds: client deps, CLI folders, Docker stack", () => {
    expect(detectLibrarySkills(["@supabase/supabase-js"])).toEqual(["supabase"]);
    expect(detectLibrarySkills(["supabase"])).toEqual(["supabase"]);
    const project = withDirs("supabase/migrations", "supabase/functions");
    const server = withDirs("volumes/api/envoy/lds.template.yaml");
    const legacyServer = withDirs("volumes/api/kong.yml");
    const vendored = withDirs("docker/volumes/api/envoy/lds.template.yaml");
    try {
      expect(detectLibrarySkills(["@supabase/supabase-js"], project)).toEqual([
        "supabase",
        "supabase-postgres",
        "supabase-edge-functions",
      ]);
      expect(detectLibrarySkills([], server)).toEqual(["supabase-selfhost"]);
      expect(detectLibrarySkills([], legacyServer)).toEqual(["supabase-selfhost"]);
      expect(detectLibrarySkills([], vendored)).toEqual(["supabase-selfhost"]);
      const functionsHost = withDirs("volumes/functions/main/index.ts");
      try {
        expect(detectLibrarySkills([], functionsHost)).toEqual([
          "supabase-edge-functions",
          "supabase-selfhost",
        ]);
      } finally {
        rmSync(functionsHost, { recursive: true });
      }
    } finally {
      for (const d of [project, server, legacyServer, vendored]) rmSync(d, { recursive: true });
    }
  });

  it("activates a skill when its path signal exists in cwd", () => {
    const dir = withDirs(".maestro");
    try {
      expect(detectLibrarySkills([], dir)).toEqual(["maestro"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("does NOT activate it when the path is absent", () => {
    const dir = withDirs("src");
    try {
      expect(detectLibrarySkills([], dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // eas-release keys on `eas.json`, not the bare `expo` dep — most Expo apps
  // ship `expo` without ever running an EAS build.
  it("activates eas-release from eas.json, not from the bare expo dep", () => {
    const dir = mkdtempSync(join(tmpdir(), "navori-libskills-"));
    writeFileSync(join(dir, "eas.json"), "{}");
    try {
      expect(detectLibrarySkills([], dir)).toEqual(["eas-release"]);
      expect(detectLibrarySkills(["expo"], dir)).toEqual(["eas-release"]);
      expect(detectLibrarySkills(["expo"])).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  // The whole point of `cwd` being optional: a dep-only caller keeps a pure
  // function over `deps`, with no filesystem branch to evaluate.
  it("does NOT activate it without a cwd — the fs branch is simply not evaluated", () => {
    expect(detectLibrarySkills([])).toEqual([]);
    expect(detectLibrarySkills(["zod"])).toEqual(["zod-validation"]);
  });

  it("ORs with deps — dep matches and path matches accumulate, in registry order", () => {
    const dir = withDirs(".maestro");
    try {
      expect(detectLibrarySkills(["cypress", "zod"], dir)).toEqual([
        "zod-validation",
        "cypress",
        "maestro",
      ]);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("leaves dep-only skills unaffected by a cwd that holds no signal", () => {
    const dir = withDirs("src");
    try {
      expect(detectLibrarySkills(["mongoose"], dir)).toEqual(["mongoose"]);
    } finally {
      rmSync(dir, { recursive: true });
    }
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

    it("SUPPRESSES when the scan is trustworthy but the preferred side has zero imports", () => {
      // Monotonicity: a widely-used legacy (moment 12) with a zero-import peer
      // dep (dayjs) is NOT a migration — zero use is evidence of non-adoption,
      // not benefit of the doubt. Less adoption must never yield more flagging.
      const counts = new Map([
        ["moment", 12],
        ["dayjs", 0],
      ]);
      expect(detectMigrations(["moment", "dayjs"], counts)).toEqual([]);
    });

    it("falls back to presence only when nothing was scanned (legacy also has zero imports)", () => {
      // Both sides declared but neither observed in code (empty / unscannable
      // repo). No trustworthy signal → keep the presence-based rule.
      const counts = new Map([
        ["moment", 0],
        ["dayjs", 0],
      ]);
      expect(detectMigrations(["moment", "dayjs"], counts)).toEqual([
        { legacy: "moment", preferred: "dayjs", domain: "Fechas" },
      ]);
    });
  });
});

describe("migrationDepNames", () => {
  it("includes every dep referenced by the migration registry", () => {
    const tracked = new Set(migrationDepNames());
    for (const pair of MIGRATION_PAIRS) {
      for (const d of [...pair.legacy, ...pair.preferred]) expect(tracked.has(d)).toBe(true);
    }
  });

  it("is deduped (a dep shared by several pairs appears once)", () => {
    const names = migrationDepNames();
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

// Audit v0.5.1 A1: an id in `project.libraries` the registry doesn't know is
// silently skipped by the render plan AND its managed skill is pruned from
// disk. This helper feeds the warning render/doctor must emit so an upgrade
// without `navori update` (the socketio split) never loses guidance silently.
describe("unknownLibraries", () => {
  it("returns [] when every id is known (and for an empty/absent selection)", () => {
    expect(unknownLibraries(["mongoose", "vitest"])).toEqual([]);
    expect(unknownLibraries([])).toEqual([]);
    expect(unknownLibraries(undefined)).toEqual([]);
  });

  it("flags a KNOWN retired id with its successors (the socketio split, #324)", () => {
    expect(unknownLibraries(["socketio"])).toEqual([
      { id: "socketio", removed: true, successors: ["socketio-server", "socketio-client"] },
    ]);
  });

  it("flags a retired id with no successor (formik) without inventing one", () => {
    expect(unknownLibraries(["formik"])).toEqual([{ id: "formik", removed: true, successors: [] }]);
  });

  it("flags a plain unknown id as not-removed", () => {
    expect(unknownLibraries(["not-a-lib"])).toEqual([
      { id: "not-a-lib", removed: false, successors: [] },
    ]);
  });

  it("mixes known, retired and unknown ids, keeping only the problematic ones", () => {
    expect(unknownLibraries(["mongoose", "socketio", "bogus"]).map((l) => l.id)).toEqual([
      "socketio",
      "bogus",
    ]);
  });
});

describe("REMOVED_LIB_SKILL_SUCCESSORS integrity", () => {
  it("every key is a retired id and every successor exists in the live registry", () => {
    for (const [id, successors] of Object.entries(REMOVED_LIB_SKILL_SUCCESSORS)) {
      expect(REMOVED_LIB_SKILLS, `'${id}' must be in REMOVED_LIB_SKILLS`).toContain(id);
      for (const successor of successors) {
        expect(librarySkillById(successor), `successor '${successor}' of '${id}'`).not.toBeNull();
      }
    }
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
