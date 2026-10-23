import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const partial = readFileSync(
  new URL("../../../../core/core-assets/hooks/_partials/copy-dest.sh", import.meta.url),
  "utf8",
);
const script = `nv_project_dir="$NAVORI_TEST_ROOT"
nv_owned_paths='CLAUDE.md'
live="$NAVORI_TEST_COMMAND"
payload_field() { printf %s "$NAVORI_TEST_ROOT"; }
${partial}
navori_copy_dest_safe`;

const bashAvailable = spawnSync("bash", ["--version"]).status === 0;

describe.runIf(bashAvailable)("owned copy destinations across path spellings", (): void => {
  // Covers: R8
  it.each(["/repo", "C:/repo", String.raw`C:\repo`, "C:/my repo"])(
    "protects relative and absolute destinations with root %s",
    (root: string): void => {
      const forwardRoot = root.replaceAll("\\", "/");
      const cases: ReadonlyArray<readonly [string, number]> = [
        ["cp source CLAUDE.md", 2],
        [`cp source '${root}/CLAUDE.md'`, 2],
        [`cp source '${forwardRoot}/CLAUDE.md'`, 2],
        [`cp source "${root}/CLAUDE.md"`, 2],
        ["mv CLAUDE.md elsewhere", 2],
        ["cp CLAUDE.md elsewhere", 0],
        ["cp source docs/CLAUDE.md", 0],
        ["command -v cp", 0],
        ["command -V rm", 0],
        ["command -v git > /tmp/path", 0],
        ["env --chdir /tmp git status", 0],
        ["env --chdir /tmp cp source CLAUDE.md", 2],
        ["command -v cp && cp source CLAUDE.md", 2],
        ["cp --version", 0],
        ["mv --help", 0],
        ["install --version", 0],
        ["ln --help", 0],
        ["cp --help && cp source CLAUDE.md", 2],
        ["git -c advice.statusHints=false log --grep mv", 0],
        ["git -c advice.statusHints=false mv source CLAUDE.md", 2],
        ["env -S 'cp /tmp/source CLAUDE.md'", 2],
        [String.raw`cp source 'dir\..\CLAUDE.md'`, root.startsWith("/") ? 0 : 2],
        [`cp source '${forwardRoot}-other/CLAUDE.md'`, 0],
      ];
      for (const [command, expected] of cases) {
        const result = spawnSync("bash", ["-c", script], {
          env: { ...process.env, NAVORI_TEST_ROOT: root, NAVORI_TEST_COMMAND: command },
          encoding: "utf8",
          timeout: 5_000,
        });
        expect(result.error, command).toBeUndefined();
        expect(result.status, command + result.stderr).toBe(expected);
      }
    },
  );
});
