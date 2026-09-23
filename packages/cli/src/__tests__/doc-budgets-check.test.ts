import { describe, it, expect, afterEach } from "vitest";
import { spawnSync, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  COMPUTED_BLOCKS_WITHOUT_BUDGET,
  COMPUTED_BLOCK_FORMULAS,
  DOC_BUDGETS,
  MANAGED_ASSET_PATHSPECS,
  MARKER_PAIR_WORDS,
  PROSE_WRAPPER_CEILINGS,
  SESSION_CONTEXT_DELIVERY_BUDGET_CHARS,
  computedBlockCeiling,
  countWords,
  managedBlockCeilings,
  simulateContextDelivery,
} from "../lib/doc-budgets.ts";

/**
 * #815 — `pnpm check:doc-budgets` → `packages/cli/scripts/check-doc-budgets.mjs`.
 *
 * The script reads its ceilings from `src/lib/doc-budgets.ts` (a path resolved
 * relative to itself, #917) and shells out to `git ls-files` in the real repo
 * (there is no `--cwd`/`--repo` override, unlike `check-render.mjs`), so these
 * tests run it against a throwaway REPO whose layout mimics the pieces it
 * reads: a git repo with a budgets module, a `CLAUDE.md`, and the managed
 * trees it discovers — a copy of the real script per fixture, since the script
 * hardcodes its own `..`-relative REPO_ROOT from `import.meta.url`.
 *
 * The fixture's budgets module is a STUB, not the real one: the ceilings are
 * what each case is exercising. The real module is asserted directly in the
 * last describe block.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REAL_SCRIPT = resolve(__dirname, "..", "..", "scripts", "check-doc-budgets.mjs");
const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");

interface RunResult {
  status: number;
  combined: string;
}

function run(args: string[], cwd: string): RunResult {
  const script = join(cwd, "packages/cli/scripts/check-doc-budgets.mjs");
  const r = spawnSync("node", [script, ...args], { encoding: "utf-8", cwd });
  return {
    status: r.status ?? -1,
    combined: (r.stdout ?? "") + (r.stderr ?? ""),
  };
}

let dirs: string[] = [];

/**
 * Build a throwaway repo shaped like the pieces this script reads.
 *
 * `extraFiles` maps a repo-relative path to its content, for the cases that
 * need a plugin or preset asset on top of the baseline core block (#917).
 */
function seedRepo(
  budgets: Record<string, number>,
  extraFiles: Record<string, string> = {},
): string {
  const repo = mkdtempSync(join(tmpdir(), "navori-doc-budgets-"));
  dirs.push(repo);

  mkdirSync(join(repo, "packages/cli/scripts"), { recursive: true });
  mkdirSync(join(repo, "packages/cli/src/lib"), { recursive: true });
  mkdirSync(join(repo, "packages/core/core-assets/managed"), { recursive: true });

  // The real script, copied verbatim so REPO_ROOT and its budgets-module import
  // resolve inside the fixture instead of the real navori-harness checkout.
  const scriptSrc = readFileSync(REAL_SCRIPT, "utf-8");
  writeFileSync(join(repo, "packages/cli/scripts/check-doc-budgets.mjs"), scriptSrc);
  writeFileSync(
    join(repo, "packages/cli/src/lib/doc-budgets.ts"),
    [
      `export const DOC_BUDGETS: Readonly<Record<string, number>> = ${JSON.stringify(budgets, null, 2)};`,
      `export const COMPUTED_BLOCKS_WITHOUT_BUDGET = ${JSON.stringify(COMPUTED_BLOCKS_WITHOUT_BUDGET)} as const;`,
      `export const MANAGED_ASSET_PATHSPECS: readonly string[] = ${JSON.stringify(MANAGED_ASSET_PATHSPECS)};`,
      "export function countWords(body: string): number {",
      "  const trimmed = body.trim();",
      '  return trimmed === "" ? 0 : trimmed.split(/\\s+/).length;',
      "}",
      // #919 — mirrored inline rather than re-imported from the real module:
      // this fixture already copies the SCRIPT verbatim (see the comment
      // above this function), so this is the same strategy applied to its
      // one other import — a drift here is caught by the tests below, not by
      // trusting the copy.
      `export const SESSION_CONTEXT_DELIVERY_BUDGET_CHARS = ${SESSION_CONTEXT_DELIVERY_BUDGET_CHARS};`,
      "export function simulateContextDelivery(files: { path: string; chars: number }[], budgetChars: number) {",
      "  let ctx = 0;",
      "  const results = [];",
      "  for (const file of files) {",
      "    ctx += 1;",
      "    const ctxCharsBefore = ctx;",
      "    if (ctx + file.chars <= budgetChars) {",
      '      results.push({ ...file, delivered: "inline", ctxCharsBefore });',
      "      ctx += file.chars + 1;",
      "    } else {",
      "      const pointer = `[navori] '${file.path}' no cabe en el contexto de arranque (${file.chars} caracteres). LÉELO con Read antes de decidir cómo abordar la tarea: contiene doctrina que ninguna otra vía te entrega.`;",
      '      results.push({ ...file, delivered: "pointer", ctxCharsBefore });',
      "      ctx += pointer.length + 1;",
      "    }",
      "  }",
      "  return results;",
      "}",
      "",
    ].join("\n"),
  );

  writeFileSync(join(repo, "CLAUDE.md"), "one two three four five\n");
  writeFileSync(join(repo, "packages/core/core-assets/managed/foo.md"), "alpha beta gamma\n");

  for (const [rel, content] of Object.entries(extraFiles)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), content);
  }

  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-qm", "seed"], {
    cwd: repo,
  });
  return repo;
}

describe("check-doc-budgets (#815)", () => {
  afterEach(() => {
    for (const d of dirs) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    dirs = [];
  });

  it("exits 0 when every budgeted file is within its ceiling", () => {
    const repo = seedRepo({
      "CLAUDE.md": 10,
      "packages/core/core-assets/managed/foo.md": 10,
    });
    const result = run([], repo);
    expect(result.status).toBe(0);
    expect(result.combined).toContain("within their word ceiling");
  });

  it("fails when a budgeted file exceeds its word ceiling", () => {
    const repo = seedRepo({
      "CLAUDE.md": 2, // "one two three four five" is 5 words > 2
      "packages/core/core-assets/managed/foo.md": 10,
    });
    const result = run([], repo);
    expect(result.status).toBe(1);
    expect(result.combined).toContain("over their word ceiling");
    expect(result.combined).toContain("CLAUDE.md: 5 words > 2 ceiling");
  });

  it("fails when a budgeted file no longer exists, naming the manifest to fix", () => {
    const repo = seedRepo({
      "CLAUDE.md": 10,
      "packages/core/core-assets/managed/foo.md": 10,
      "packages/core/core-assets/managed/ghost.md": 10,
    });
    const result = run([], repo);
    expect(result.status).toBe(1);
    expect(result.combined).toContain("no longer exist");
    expect(result.combined).toContain("packages/core/core-assets/managed/ghost.md");
    expect(result.combined).toContain("update packages/cli/src/lib/doc-budgets.ts");
  });

  it("fails when a managed .md exists but is missing from the manifest", () => {
    const repo = seedRepo({
      "CLAUDE.md": 10,
      // "foo.md" intentionally omitted
    });
    const result = run([], repo);
    expect(result.status).toBe(1);
    expect(result.combined).toContain("missing from the manifest");
    expect(result.combined).toContain("packages/core/core-assets/managed/foo.md");
  });

  // #908 — the ≥5% headroom policy from #815 lived only in prose and eroded
  // silently across two ceiling raises. This warns (doesn't fail) when a
  // budgeted file's margin drops below 5% of its actual word count.
  it("warns (without failing) when a file's headroom drops below 5%", () => {
    const repo = seedRepo({
      "CLAUDE.md": 10, // "one two three four five" = 5 words, margin 5/5 = 100% headroom, fine
      "packages/core/core-assets/managed/foo.md": 4, // "alpha beta gamma" = 3 words, margin 1/3 = 33%, fine
    });
    const result = run([], repo);
    expect(result.status).toBe(0);
    expect(result.combined).not.toContain("below 5% headroom");
  });

  it("emits a WARNING when margin is under 5% of the actual word count, still exits 0", () => {
    const repo = seedRepo({
      // "one two three four five" = 5 words; ceiling 5 -> margin 0 -> 0% headroom
      "CLAUDE.md": 5,
      "packages/core/core-assets/managed/foo.md": 10,
    });
    const result = run([], repo);
    expect(result.status).toBe(0);
    expect(result.combined).toContain("below 5% headroom");
    expect(result.combined).toContain("CLAUDE.md: 5/5 words (0.0% headroom, < 5%)");
  });

  it("--list prints words/ceiling/margin per file and exits 0, even over budget", () => {
    const repo = seedRepo({
      "CLAUDE.md": 2,
      "packages/core/core-assets/managed/foo.md": 10,
    });
    const result = run(["--list"], repo);
    expect(result.status).toBe(0);
    expect(result.combined).toContain("CLAUDE.md: 5/2 words (margin -3)");
    expect(result.combined).toContain(
      "packages/core/core-assets/managed/foo.md: 3/10 words (margin 7)",
    );
  });

  // #917 — discovery used to sweep `core-assets/managed/` only, so 18 static
  // assets (6 plugin blocks + 12 preset `stack.md`) shipped with no ceiling.
  const PLUGIN_ASSET = "packages/plugins/demo/managed/demo-protocol.md";
  const PRESET_ASSET = "packages/core/core-assets/presets/demo/managed/stack.md";

  it("fails when a plugin managed block is missing from the budgets module", () => {
    const repo = seedRepo(
      { "CLAUDE.md": 10, "packages/core/core-assets/managed/foo.md": 10 },
      { [PLUGIN_ASSET]: "delta epsilon\n" },
    );
    const result = run([], repo);
    expect(result.status).toBe(1);
    expect(result.combined).toContain("missing from the manifest");
    expect(result.combined).toContain(PLUGIN_ASSET);
    expect(result.combined).toContain("add it to packages/cli/src/lib/doc-budgets.ts");
  });

  it("fails when a preset stack.md is missing from the budgets module", () => {
    const repo = seedRepo(
      { "CLAUDE.md": 10, "packages/core/core-assets/managed/foo.md": 10 },
      { [PRESET_ASSET]: "zeta eta theta\n" },
    );
    const result = run([], repo);
    expect(result.status).toBe(1);
    expect(result.combined).toContain("missing from the manifest");
    expect(result.combined).toContain(PRESET_ASSET);
  });

  it("measures plugin and preset assets once they carry a ceiling", () => {
    const repo = seedRepo(
      {
        "CLAUDE.md": 10,
        "packages/core/core-assets/managed/foo.md": 10,
        [PLUGIN_ASSET]: 1, // "delta epsilon" is 2 words > 1
        [PRESET_ASSET]: 10,
      },
      { [PLUGIN_ASSET]: "delta epsilon\n", [PRESET_ASSET]: "zeta eta theta\n" },
    );
    const result = run([], repo);
    expect(result.status).toBe(1);
    expect(result.combined).toContain("over their word ceiling");
    expect(result.combined).toContain(`${PLUGIN_ASSET}: 2 words > 1 ceiling`);
  });

  /**
   * #930 — the prose surface navori self-hosts. `AGENTS.md` matches no
   * `MANAGED_ASSET_PATHSPECS` glob (it is a rendered FILE, not a source
   * asset), so it is listed explicitly in `DOC_BUDGETS` — same standing as
   * `CLAUDE.md` — and the plain per-path loop hard-fails on it exactly the
   * same way. Closes the defect: before #930 nothing here even looked at
   * `AGENTS.md`, so it was "green" only because it was never checked.
   */
  it("fails when the self-hosted AGENTS.md exceeds its word ceiling", () => {
    const repo = seedRepo(
      {
        "CLAUDE.md": 10,
        "packages/core/core-assets/managed/foo.md": 10,
        "AGENTS.md": 2, // "one two three four five" is 5 words > 2
      },
      { "AGENTS.md": "one two three four five\n" },
    );
    const result = run([], repo);
    expect(result.status).toBe(1);
    expect(result.combined).toContain("over their word ceiling");
    expect(result.combined).toContain("AGENTS.md: 5 words > 2 ceiling");
  });

  /**
   * #919 — `.claude/context/` is delivered by the SessionStart hook under its
   * OWN accumulated, in-order budget (`SESSION_CONTEXT_DELIVERY_BUDGET_CHARS`),
   * not a per-file word ceiling. This is a WARNING, never a failure — this
   * repo's own surface is already over the delivery budget today, so a hard
   * fail here would turn the gate red from the day this ships.
   */
  it("warns when a .claude/context/ file would deliver as a pointer, still exits 0", () => {
    const first = "a".repeat(7889); // fits alone: 1 (separator) + 7889 = 7890 <= 8000
    const second = "b".repeat(189); // 7892 (separator after first) + 189 = 8081 > 8000
    const repo = seedRepo(
      { "CLAUDE.md": 10, "packages/core/core-assets/managed/foo.md": 10 },
      {
        ".claude/context/10-orquestacion.md": first,
        ".claude/context/40-cierre-sesion.md": second,
      },
    );
    const result = run([], repo);
    expect(result.status).toBe(0);
    expect(result.combined).toContain("would deliver as a POINTER");
    expect(result.combined).toContain(".claude/context/40-cierre-sesion.md");
    expect(result.combined).toContain("7892 chars");
    // The file that fits stays unmentioned as a culprit — only the degraded
    // one gets a line, and it names what came before it, not its own size.
    expect(result.combined).not.toContain(".claude/context/10-orquestacion.md: files ahead");
  });

  it("stays silent about .claude/context/ when every file delivers inline", () => {
    const repo = seedRepo(
      { "CLAUDE.md": 10, "packages/core/core-assets/managed/foo.md": 10 },
      { ".claude/context/10-orquestacion.md": "a".repeat(100) },
    );
    const result = run([], repo);
    expect(result.status).toBe(0);
    expect(result.combined).not.toContain("would deliver as a POINTER");
  });

  it("says nothing about .claude/context/ when the repo has no context dir", () => {
    const repo = seedRepo({
      "CLAUDE.md": 10,
      "packages/core/core-assets/managed/foo.md": 10,
    });
    const result = run([], repo);
    expect(result.status).toBe(0);
    expect(result.combined).not.toContain(".claude/context/");
  });

  /**
   * Confirms this repo's OWN `.claude/context/` is the live case the warning
   * exists for (#919's audit measured it at 12681 bytes against an 8000-char
   * budget) — this runs the REAL script against the REAL repo, not a
   * synthetic fixture, so a fix that shrinks the surface below the budget is
   * meant to flip this test green-without-the-warning, not break it: the
   * assertion that must survive is "degrades without failing", not the
   * specific file name.
   */
  it("warns about navori-harness's own .claude/context/ surface without failing the gate", () => {
    const result = run([], REPO_ROOT);
    expect(result.status).toBe(0);
    const files = readdirSync(join(REPO_ROOT, ".claude", "context"))
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => ({
        path: `.claude/context/${name}`,
        chars: readFileSync(join(REPO_ROOT, ".claude", "context", name), "utf-8").length,
      }));
    const delivery = simulateContextDelivery(files, SESSION_CONTEXT_DELIVERY_BUDGET_CHARS);
    const pointers = delivery.filter((f) => f.delivered === "pointer");
    if (pointers.length > 0) {
      expect(result.combined).toContain("would deliver as a POINTER");
      for (const f of pointers) expect(result.combined).toContain(f.path);
    } else {
      expect(result.combined).not.toContain("would deliver as a POINTER");
    }
  });

  it("passes when the self-hosted AGENTS.md is within its word ceiling", () => {
    const repo = seedRepo(
      {
        "CLAUDE.md": 10,
        "packages/core/core-assets/managed/foo.md": 10,
        "AGENTS.md": 10,
      },
      { "AGENTS.md": "one two three four five\n" },
    );
    const result = run([], repo);
    expect(result.status).toBe(0);
    expect(result.combined).toContain("within their word ceiling");
  });
});

/**
 * #917 — the ceilings are a library module, not a JSON under `scripts/`: npm
 * publishes `["dist", "README.md"]`, so a manifest there could never be read
 * by `doctor` inside a consumer repo (phase 2). These assert the module's own
 * contract, independent of the gate script.
 */
describe("doc-budgets module (#917)", () => {
  it("is the single source of truth — the scripts/ manifest is gone", () => {
    expect(existsSync(join(REPO_ROOT, "packages/cli/scripts/doc-budgets.manifest.json"))).toBe(
      false,
    );
    expect(Object.keys(DOC_BUDGETS).length).toBeGreaterThan(20);
    expect(countWords("alpha beta gamma")).toBe(3);
  });

  it("names the computed blocks it deliberately leaves unbudgeted", () => {
    expect([...COMPUTED_BLOCKS_WITHOUT_BUDGET]).toEqual([
      "skills-index",
      "contexto-proyecto",
      "agentes-disponibles",
    ]);
    for (const id of COMPUTED_BLOCKS_WITHOUT_BUDGET) {
      expect(Object.keys(DOC_BUDGETS)).not.toContain(id);
    }
  });

  it("gives every discovered managed asset a ceiling with ≥5% headroom", () => {
    const discovered = execFileSync("git", ["ls-files", "--", ...MANAGED_ASSET_PATHSPECS], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    })
      .split("\n")
      .filter(Boolean);
    expect(discovered.length).toBeGreaterThan(20);

    const thin: string[] = [];
    for (const rel of discovered) {
      const ceiling = DOC_BUDGETS[rel];
      expect(ceiling, `${rel} has no ceiling`).toBeDefined();
      const words = countWords(readFileSync(join(REPO_ROOT, rel), "utf-8"));
      // `ceiling` is defined per the assertion above; the guard is for the type.
      if (ceiling !== undefined && (ceiling - words) / words < 0.05) thin.push(rel);
    }
    expect(thin, "managed assets below the 5% headroom policy").toEqual([]);
  });

  /**
   * Phase 2 reads the ceilings by RENDERED BLOCK ID, and that mapping is
   * derived from the same paths — never a second table to keep in sync. Preset
   * blocks are the one non-obvious case: every `presets/*.json` declares its
   * extra as `stack-<preset>`, not `stack`.
   */
  it("maps every ceiling onto the block id that renders it", () => {
    const byId = managedBlockCeilings();
    expect(byId["operaciones-seguras"]).toBe(
      DOC_BUDGETS["packages/core/core-assets/managed/operaciones-seguras.md"]! + MARKER_PAIR_WORDS,
    );
    expect(byId["gh-protocol"]).toBe(
      DOC_BUDGETS["packages/plugins/gh/managed/gh-protocol.md"]! + MARKER_PAIR_WORDS,
    );
    expect(byId["stack-vite-react-ts-mantine"]).toBe(
      DOC_BUDGETS["packages/core/core-assets/presets/vite-react-ts-mantine/managed/stack.md"]! +
        MARKER_PAIR_WORDS,
    );
    // `CLAUDE.md` is a FILE ceiling, not a block: it must not leak in as an id.
    expect(byId["CLAUDE.md"]).toBeUndefined();
  });

  /**
   * The gap phase 1 declared and could not close: the ceilings were in `src/`
   * but tree-shaken out of `dist/index.js`, because nothing in `src/` imported
   * them. `doctor` does now, so the artifact npm publishes carries them — and a
   * refactor that drops that import would silently take the budget report out
   * of every installed navori.
   */
  it("ships the ceilings inside the published bundle", () => {
    const bundle = readFileSync(join(REPO_ROOT, "packages/cli/dist/index.js"), "utf-8");
    expect(bundle).toContain("packages/core/core-assets/presets/medusa/managed/stack.md");
  });

  it("gives each computed block a formula, since it can have no constant", () => {
    for (const id of COMPUTED_BLOCKS_WITHOUT_BUDGET) {
      expect(COMPUTED_BLOCK_FORMULAS[id], `${id} has no formula`).toBeDefined();
      expect(computedBlockCeiling(id, 0)).toBe(COMPUTED_BLOCK_FORMULAS[id]!.base);
    }
    expect(computedBlockCeiling("operaciones-seguras", 3)).toBeNull();
  });

  /**
   * `bonum-dashboard` renders `contexto-proyecto` at 335 words over 9 rows, and
   * the user ruled that LEGITIMATE use of `project.*`. The formula exists to
   * price a config entry, not to punish one: if this ever fails, the `k` was
   * tightened into a false positive against a real repo.
   */
  it("keeps the computed ceilings generous enough for real consumer configs", () => {
    expect(computedBlockCeiling("contexto-proyecto", 9)!).toBeGreaterThan(335);
    // `bonum-webapp`: 32 skill rows / 208 words measured on a 0.9.0 render.
    expect(computedBlockCeiling("skills-index", 32)!).toBeGreaterThan(208);
  });

  /**
   * The characters budget is the hook's, mirrored here so `doctor` can report
   * against it without parsing a shell script. Mirrors drift; this is the guard.
   */
  it("mirrors the SessionStart hook's own delivery budget", () => {
    const hook = readFileSync(
      join(REPO_ROOT, "packages/core/core-assets/hooks/session-start-context.sh"),
      "utf-8",
    );
    expect(hook).toContain(`NAVORI_CTX_BUDGET:-${SESSION_CONTEXT_DELIVERY_BUDGET_CHARS}`);
  });

  /**
   * #930 — the defect the issue names literally: before this, `AGENTS.md` had
   * no whole-file ceiling at all in `DOC_BUDGETS`, so `check-doc-budgets.mjs`
   * never even looked at it. `"AGENTS.md"` must carry ≥5% headroom over this
   * repo's real file, same policy as every other explicit entry.
   */
  it("gives the self-hosted AGENTS.md a whole-file ceiling with ≥5% headroom", () => {
    const ceiling = DOC_BUDGETS["AGENTS.md"];
    expect(ceiling, "AGENTS.md has no ceiling").toBeDefined();
    const words = countWords(readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf-8"));
    expect(words).toBeGreaterThan(0);
    expect((ceiling! - words) / words).toBeGreaterThanOrEqual(0.05);
  });

  /**
   * `navori-agents` — the id BOTH `codex` and `agents-md` stamp around the
   * whole prose body — is the one block id in `managedBlockCeilings()` with no
   * source asset path behind it. Confirms it merges in as-is (no
   * `MARKER_PAIR_WORDS`, unlike every path-derived entry): the number is
   * measured on the RENDERED file, markers already included.
   */
  it("merges PROSE_WRAPPER_CEILINGS into managedBlockCeilings without the marker-pair addend", () => {
    const byId = managedBlockCeilings();
    expect(byId["navori-agents"]).toBe(PROSE_WRAPPER_CEILINGS["navori-agents"]);
  });
});
