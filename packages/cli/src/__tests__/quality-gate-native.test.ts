import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getCoreRoot } from "../lib/render/bundled-assets.ts";
import { expandHookIncludes } from "../lib/render/hook-includes.ts";
import { interpolate } from "../lib/render/interpolate.ts";
import { NavoriConfigSchema, type NavoriConfig } from "../lib/config/schema.ts";
import { PROGRESS_HARD_CAP_BYTES } from "../lib/assets/doc-budgets.ts";
import { acrossShells } from "../lib/__tests__/helpers/shells.ts";

/**
 * `qualityGate.nativeHooks` (spec 0045 D1): the hook keeps its ratchet and its
 * user-section and drops only the gate step. The script is rendered through the
 * real `interpolate`, so the `{{navori.nativeHooks}}` wiring is under test too.
 */
const HOOK_SRC = resolve(getCoreRoot(), "core-assets/hooks/quality-gate-pre-commit.sh");
const BASE_PATH = "/usr/bin:/bin";
const MARKER = "RAN-THE-GATE";
const STATE_FILE = "progress/current.md";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-qg-native-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function config(nativeHooks: boolean | undefined): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    branchBase: "main",
    qualityGate: {
      // `printf` lives in /usr/bin, so the gate really runs under BASE_PATH.
      fast: `printf ${MARKER}`,
      full: "true",
      ...(nativeHooks === undefined ? {} : { nativeHooks }),
    },
  });
}

/** Render the hook as `navori render` does; `userSection` is appended after the marker. */
function render(cfg: NavoriConfig, userSection = ""): string {
  const raw = expandHookIncludes(readFileSync(HOOK_SRC, "utf-8"));
  const rendered = interpolate(raw, cfg);
  return userSection === ""
    ? rendered
    : rendered.replace("# navori:user-section", `# navori:user-section\n${userSection}`);
}

/** Install under `.claude/hooks` or `.codex/hooks`: the path decides `nv_engine`. */
function install(engine: "claude" | "codex", script: string): string {
  const hooksDir = join(dir, `.${engine}`, "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const path = join(hooksDir, "quality-gate-pre-commit.sh");
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

function git(...args: string[]): void {
  execFileSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, stdio: "pipe" },
  );
}

function run(engine: "claude" | "codex", hook: string) {
  const payload = { tool_input: { command: "git commit -m x" }, cwd: dir };
  return acrossShells((shell) => {
    const r = spawnSync(shell, [hook], {
      cwd: dir,
      input: JSON.stringify(payload),
      encoding: "utf-8",
      env: {
        PATH: BASE_PATH,
        HOME: dir,
        ...(engine === "claude" ? { CLAUDE_PROJECT_DIR: dir } : {}),
      },
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  });
}

function initRepo(): void {
  git("init", "-q");
  writeFileSync(join(dir, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-q", "-m", "base");
}

describe.each(["claude", "codex"] as const)(
  "quality-gate-pre-commit with nativeHooks (%s)",
  (engine) => {
    // Covers: R2, R3
    it("tope, user-section y gate omitido en claude y codex", () => {
      initRepo();
      const hook = install(engine, render(config(true), '  echo "USER-SECTION-RAN" >&2'));

      // Normal commit: the gate is skipped (no marker, no start line), the user-section runs.
      const ok = run(engine, hook);
      expect(ok.status).toBe(0);
      expect(ok.stdout).not.toContain(MARKER);
      expect(ok.stderr).not.toContain("running quality-gate fast");
      expect(ok.stderr).toContain("skipped: qualityGate.nativeHooks");
      expect(ok.stderr).toContain("USER-SECTION-RAN");

      // The progress ceiling still blocks: it is not a gate step.
      mkdirSync(join(dir, "progress"), { recursive: true });
      writeFileSync(join(dir, STATE_FILE), "a".repeat(PROGRESS_HARD_CAP_BYTES + 1000));
      git("add", STATE_FILE);
      const capped = run(engine, hook);
      expect(capped.status).toBe(2);
      expect(capped.stderr).toContain("Commit BLOCKED");
      git("rm", "-q", "--cached", STATE_FILE);
      rmSync(join(dir, "progress"), { recursive: true });

      // A user-section that blocks still blocks.
      const blocking = install(engine, render(config(true), "  exit 2"));
      expect(run(engine, blocking).status).toBe(2);
    });

    // Covers: R2
    it("runs the gate when nativeHooks is absent, false, or the script is an unrendered copy", () => {
      initRepo();
      const unrendered = expandHookIncludes(readFileSync(HOOK_SRC, "utf-8"))
        .replace("{{shq:qualityGate.fast}}", `'printf ${MARKER}'`)
        .replace("{{navori.progressHardCapBytes}}", String(PROGRESS_HARD_CAP_BYTES));
      for (const script of [render(config(undefined)), render(config(false)), unrendered]) {
        const r = run(engine, install(engine, script));
        expect(r.status).toBe(0);
        expect(r.stdout).toContain(MARKER);
        expect(r.stderr).toContain("running quality-gate fast");
      }
    });
  },
);
