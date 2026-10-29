import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyPath } from "../../../packages/cli/src/lib/diagnose/source-classify.ts";
import {
  classify,
  declaredFlagsFromSignals,
  matchesCriticalPaths,
  normalizeRepoPath,
} from "../../../packages/cli/src/lib/plan/classify.ts";
import { parseExpected } from "../../../packages/cli/src/lib/plan/expected.ts";
import { locateSpecDir } from "../../../packages/cli/src/lib/spec/locate.ts";
import { parseTasks } from "../../../packages/cli/src/lib/spec/tasks.ts";
import { NON_IMPLEMENTER_ROLES } from "../../../packages/cli/src/engines/shared/roster.ts";

/**
 * Spec 0059 T10: the TS answers for the pure plan helpers `plan gate` uses, written as a table the
 * Rust tests replay (`crates/navori-core/tests/plan_tables.rs`). Inputs are the cross product of
 * small axes, so one table checks every rule against the same oracle.
 *
 * Usage: node scripts/js/rust-oracle/plan-tables.mjs [--check]
 *   --check exits 1 when the committed table differs from a fresh one.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TABLE = join(REPO_ROOT, "crates", "navori-core", "tests", "fixtures", "plan_tables.json");

const PATHS = [
  "src/a.ts",
  "./src/a.ts",
  "src\\win\\b.rs",
  "src//x/../y.py",
  "src/",
  ".",
  "",
  "  src/padded.go  ",
  "/abs/x.ts",
  "C:/abs/x.ts",
  "../up.ts",
  "..",
  "a/../../b.ts",
  ".claude/progress/x.md",
  ".claude/worktrees/w/x.ts",
  "scratchpad/x.ts",
  "pkg/node_modules/x.js",
  "packages/cli/dist/index.js",
  ".claude/agents/x.md",
  ".claude/skills/local/SKILL.md",
  ".claude/skills/other/SKILL.md",
  "CLAUDE.md",
  "sub/AGENTS.md",
  ".mcp.json",
  "x/__golden__/a.ts",
  "x/y.snap",
  "Cargo.lock",
  "bun.lockb",
  "a/fixtures/f.ts",
  "src/a.test.ts",
  "src/a.spec.mjs",
  "src/__tests__/a.ts",
  "crates/x/tests/t.rs",
  "test_a.py",
  "pkg/a_test.go",
  "package.json",
  "tsconfig.base.json",
  ".gitignore",
  "navori.config.json",
  "docs/a.ts",
  "specs/x/tasks.md",
  "README.es.md",
  "progress/current.md",
  "packages/core/core-assets/agents/implementer.md",
  "packages/plugins/x/skills/y.md",
  "packages/core/core-assets/hooks/x.sh",
  "notes.txt",
  "a.ipynb",
  "deep/a/b/c/d.sql",
  "line\nbreak.ts",
  "ñ/ü.ts",
];

const GLOBS = [
  [],
  ["src/**"],
  ["**/secrets/*.ts"],
  ["src/*.ts"],
  ["*"],
  ["**"],
  ["a*b*c/x"],
  ["src/p*y.py", "crates/**/t.rs"],
  ["ab*b"],
  ["**/d.sql"],
];

const EXPECTED = [
  "exit 0",
  "exit 255",
  "exit 256",
  "exit 007",
  "exit -1",
  "exit +3",
  "exit 1 ",
  "exit ١",
  "contains: ok",
  "contains: two\nlines",
  "contains:",
  "contains:x",
  "matches: /a+/",
  "matches: /a/gi",
  "matches: /a/ii",
  "matches: /a/imsu",
  "matches: /(/",
  "matches: //",
  "matches:",
  "pasa todo",
  "",
];

const FILE_SETS = [
  [],
  ["src/a.ts"],
  ["src/a.ts", "src/a.test.ts"],
  ["src/a.test.ts", "src/b.test.ts"],
  ["src/a.ts", "src/b.ts", "lib/c.ts"],
  ["a/x.ts", "b/x.ts", "c/x.ts", "d/x.ts", "e/x.ts"],
  Array.from({ length: 9 }, (_, i) => `pkg${i}/m/f${i}.rs`),
  ["docs/a.md", "README.md"],
  ["src/payments/pay.ts"],
  [".claude/skills/local/SKILL.md", ".claude/skills/other/SKILL.md"],
  ["./src/a.ts", "src/a.ts", "", "/abs.ts"],
];

const FLAG_SETS = [
  {},
  { bugWithoutRootCause: true },
  { criticalArea: true },
  { sharedContract: true },
  { moneyCredentialsPii: true, multiRepo: true },
  { newExternalDependency: true, dataSchemaMigration: true, bugWithoutRootCause: true },
];

/** Edge cases of the `tasks.md` grammar; every real spec of the repo is added to them. */
const TASK_TEXTS = [
  "",
  "- [ ] one\n- [x] two\n- [ ] ~~T3~~ gone",
  "## E1 — A\n### M1 — B\n- [ ] **T1** (R1) — x\n- **A1** — y `cmd` → exit 0",
  "## E1 — A\n- [ ] **T1** orphan\n- **A1** orphan criterion\n### M1\n- [ ] no id\n- [ ] ~~T2~~",
  "## E1 (foundation)\nEstimated LOC: 1,200\n- [ ] **T9** after loc\n### M2 — x\n#### deeper\n- [ ] **T1** still in M2",
  "## E1\n### M1\n```\n## E2\n- [ ] no id in fence\n```\n- [ ] **T1** ok\n~~~~\n- [ ] x\n~~~\n- [ ] still fenced\n~~~~\n- [ ] after",
  "## E1\r\n### M1\r\n- [ ] **T1** crlf\r\n  - [ ] nested no id\r\n- [ ] top no id",
  "## E1\n### M1\n- [ ] **T1** x\n  continuation\n- [ ] **T2** y\n## Not a delivery\n- [ ] **T3** orphan after section",
  "## E12x title\n## E3: ok\n### M1: m\n### M2x not milestone\n- [ ] **T1** orphan?",
  "## E1 —\n### M1 #\n- [ ] **T1** a\n1. [ ] numbered\n* [ ] star\n- **Consumes:** a → b\n- [ ]  **T2** double space",
  "# Title\n## E1\n### M1\n- [X] **T1** upper x\n- [ ] **T2**(R1)\n### Other\n- [ ] **T3** orphan",
  "## E1\n\u2028### M1\n- [ ] **T1**",
  "## E1\n  estimated loc: ~42\n- **Estimated LOC:** 7\n### M1\n- [ ] **T1**",
];

/** Real specs, frozen into the table: a delivery-format one, a small one and a legacy one. */
const REAL_SPECS = ["0059-rust-sesion-engines", "0027-scribe-agent", "0012-solutioning"];

function realTasks() {
  return REAL_SPECS.map((name) => ({
    name,
    text: readFileSync(join(REPO_ROOT, "specs", name, "tasks.md"), "utf8"),
  }));
}

/** The structure `plan gate` reads of a parse. */
function structure(text) {
  const p = parseTasks(text);
  return {
    format: p.format,
    deliveries: p.deliveries.map((d) => ({ id: d.id, milestones: d.milestones.map((m) => m.id) })),
    orphanTasks: p.orphanTasks.length,
    orphanCriteria: p.orphanCriteria.length,
    malformed: p.malformed.length,
    legacyTaskCount: p.legacyTaskCount,
  };
}

/** @returns {object} */
function table() {
  return {
    classifyPath: PATHS.map((path) => ({
      path,
      kind: classifyPath(path, "", new Set(["local"])),
      kindNoSkills: classifyPath(path),
      kindRooted: classifyPath(path, "/repo/"),
    })),
    normalizeRepoPath: PATHS.map((input) => ({ input, ...normalizeRepoPath(input) })),
    matchesCriticalPaths: GLOBS.map((globs) => ({
      globs,
      hits: PATHS.filter((path) => matchesCriticalPaths([path], globs)),
    })),
    nonImplementerRoles: NON_IMPLEMENTER_ROLES,
    parseTasks: [
      ...TASK_TEXTS.map((text, i) => ({ name: `edge-${i}`, text })),
      ...realTasks(),
    ].map(({ name, text }) => ({ name, text, ...structure(text) })),
    locateSpecDir: ["specs", "./docs/../specs", "/abs/specs", "specs/"].flatMap((specsDir) =>
      ["0059-x", "a.b_c-d", "..", "a..b", "a/b", "-x", ".hidden", "", "ñ"].map((spec) => ({
        specsDir,
        spec,
        result: locateSpecDir("/repo", specsDir, spec),
      })),
    ),
    parseExpected: EXPECTED.map((text) => ({ text, result: parseExpected(text) })),
    classify: FILE_SETS.flatMap((files) =>
      FLAG_SETS.flatMap((flags) =>
        [undefined, ["src/payments/**"]].map((criticalPaths) => {
          const result = classify({ files, ...flags, criticalPaths, localSkillIds: ["local"] });
          return {
            files,
            flags,
            criticalPaths: criticalPaths ?? [],
            result,
            declared: declaredFlagsFromSignals(result.signals),
          };
        }),
      ),
    ),
  };
}

const fresh = `${JSON.stringify(table(), null, 2)}\n`;
if (process.argv.includes("--check")) {
  const committed = readFileSync(TABLE, "utf8");
  if (committed !== fresh) {
    process.stderr.write(`plan-tables: ${TABLE} is stale; regenerate it without --check\n`);
    process.exit(1);
  }
  process.stdout.write("plan-tables: up to date\n");
} else {
  writeFileSync(TABLE, fresh);
  process.stdout.write(`plan-tables: wrote ${TABLE}\n`);
}
