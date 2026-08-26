import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * #498, second layer: the INTEGRITY guard. An unclosed code fence duplicated
 * every managed block on each render, and every diagnostic reported OK — the
 * duplicate-id check (#274) walked the very parser that had gone blind.
 *
 * The guard is worth more than the parser fix precisely because it survives the
 * parser being wrong, so it is pinned end to end: seed duplicated ids and the
 * real CLI must fail — exit 2 — in BOTH surfaces. `--json` gets its own spec
 * because a check that only a human sees is the failure mode of #479.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(__dirname, "..", "..", "dist", "index.js");

/** Throwaway HOME so `init` can't self-register into the real ~/.navori (#404). */
const E2E_HOME = mkdtempSync(join(tmpdir(), "navori-doctor-dup-home-"));
afterAll(() => {
  rmSync(E2E_HOME, { recursive: true, force: true });
});

const dirs: string[] = [];

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): CliResult {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, HOME: E2E_HOME, FORCE_COLOR: "0" },
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

interface DoctorReport {
  ok: boolean;
  duplicateMarkers: Array<{ filePath: string; id: string; count: number }>;
}

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(`CLI not built at ${CLI}. Run 'pnpm build' before tests.`);
  }
});

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  dirs.length = 0;
});

/**
 * An onboarded repo whose CLAUDE.md carries the corruption the bug produced: a
 * stray ```bash fence in the user's prose, and a second copy of a managed block
 * appended below it (which is exactly what render did on every run).
 */
function seedDuplicatedRepo(): { repo: string; duplicatedId: string } {
  const repo = mkdtempSync(join(tmpdir(), "navori-doctor-dup-"));
  dirs.push(repo);
  expect(runCli(["init", "--recommended", "--cwd", repo]).status).toBe(0);
  expect(runCli(["render", "--apply", "--cwd", repo]).status).toBe(0);

  const claudeMd = join(repo, "CLAUDE.md");
  const content = readFileSync(claudeMd, "utf-8");
  const open = /<!-- navori:managed id="([^"]+)"[^\n]*-->/.exec(content);
  expect(open).not.toBeNull();
  const id = open![1]!;
  const close = `<!-- /navori:managed id="${id}" -->`;
  const blockStart = content.indexOf(open![0]);
  const block = content.slice(blockStart, content.indexOf(close, blockStart) + close.length);

  writeFileSync(claudeMd, `${content}\n## Mis notas\n\n\`\`\`bash\nnpm i\n\n${block}\n`, "utf-8");
  return { repo, duplicatedId: id };
}

describe("doctor fails on duplicated managed ids (#498)", () => {
  it("reports the duplicate in the human output and exits 2", () => {
    const { repo, duplicatedId } = seedDuplicatedRepo();

    // Sanity: this is the exact state the bug left behind, and doctor used to
    // answer "Everything is up to date — OK" (exit 0) over it.
    const r = runCli(["doctor", "--cwd", repo]);
    expect(r.status).toBe(2);
    expect(`${r.stdout}${r.stderr}`).toContain(`CLAUDE.md:${duplicatedId}`);
  });

  it("publishes the same finding in --json and exits 2", () => {
    const { repo, duplicatedId } = seedDuplicatedRepo();

    const r = runCli(["doctor", "--json", "--cwd", repo]);
    expect(r.status).toBe(2);
    const report = JSON.parse(r.stdout) as DoctorReport;
    expect(report.ok).toBe(false);
    // The real payload, not just the key: a hardcoded [] would pass a
    // key-presence assertion and publish nothing.
    expect(report.duplicateMarkers).toContainEqual({
      filePath: "CLAUDE.md",
      id: duplicatedId,
      count: 2,
    });
  });

  it("stays green on the same repo without the duplicate", () => {
    const repo = mkdtempSync(join(tmpdir(), "navori-doctor-dup-clean-"));
    dirs.push(repo);
    expect(runCli(["init", "--recommended", "--cwd", repo]).status).toBe(0);
    expect(runCli(["render", "--apply", "--cwd", repo]).status).toBe(0);
    // Same stray fence, no duplicate: the guard must not cry wolf over a typo.
    const claudeMd = join(repo, "CLAUDE.md");
    writeFileSync(
      claudeMd,
      `${readFileSync(claudeMd, "utf-8")}\n## Mis notas\n\n\`\`\`bash\nnpm i\n`,
      "utf-8",
    );

    const r = runCli(["doctor", "--json", "--cwd", repo]);
    expect(r.status).toBe(0);
    expect((JSON.parse(r.stdout) as DoctorReport).duplicateMarkers).toEqual([]);
  });
});
