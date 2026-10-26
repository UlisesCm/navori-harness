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

  // Covers: R8
  it("tokenizes accented text and multi-line quotes, and never skips lines after <<", () => {
    const cases: ReadonlyArray<readonly [string, number]> = [
      ["echo diacríticos", 0],
      ['git commit -m "función"', 0],
      ["cp source CLAUDE.md # función", 2],
      ["cp source función CLAUDE.md", 2],
      ["git commit -m \"$(cat <<'EOF'\nfeat: título\n\nsegunda línea\nEOF\n)\"", 0],
      ['echo "uno\ndos"', 0],
      ["cat <<'EOF'\nbody\nEOF\ncp source CLAUDE.md", 2],
      ["cat <<'A' <<'B'\nx\nA\ny\nB\ncp source CLAUDE.md", 2],
      ["cat <<'EOF'\nbody\nEOF\ncp source CLAUDE.md\n", 2],
      ["bash <<'EOF'\ncp source CLAUDE.md\nEOF", 2],
      ["sudo -u me bash <<'EOF'\ncp source CLAUDE.md\nEOF", 2],
      ["cat <<'EOF' | sh\ncp source CLAUDE.md\nEOF", 2],
      ["python3 - <<'EOF'\ncp source CLAUDE.md\nEOF", 2],
      ["cat <<EOF\n$(cp source CLAUDE.md)\nEOF", 2],
      ["cat <<< 'cp source CLAUDE.md'", 0],
      // `<<` as an arithmetic shift must never swallow the next line.
      [": $((1<<2))\ncp source CLAUDE.md", 2],
      ["echo $(( 1<<2 ))\ncp source CLAUDE.md", 2],
      ["x=$((1<<2))\ncp source CLAUDE.md", 2],
      ["let x=1<<3\ncp source CLAUDE.md", 2],
      ["let x = 1 << 3\ncp source CLAUDE.md", 2],
      [": $((1<<x))\nx\ncp source CLAUDE.md", 2],
      [": $(( 1 << x ))\nx\ncp source CLAUDE.md", 2],
      ["(( y = 1 << z ))\nz\ncp source CLAUDE.md", 2],
      ["((y=1<<z))\nz\ncp source CLAUDE.md", 2],
      ["a[1<<2]=x\ncp source CLAUDE.md", 2],
      ["echo ${x:1 << 2}\n2}\ncp source CLAUDE.md", 2],
      ["cat <<'EOF'\ncp source CLAUDE.md", 2],
      ["echo '<<EOF'\ncp source CLAUDE.md", 2],
      ["echo 'unclosed", 2],
      ['echo "unclosed\nstill open', 2],
      ["cp source \\\nCLAUDE.md", 2],
    ];
    for (const [command, expected] of cases) {
      // The UTF-8 locale reproduces the macOS awk multibyte abort; the guard must not depend on it.
      for (const locale of ["en_US.UTF-8", "C.UTF-8", "C"]) {
        const result = spawnSync("bash", ["-c", script], {
          env: {
            ...process.env,
            LC_ALL: locale,
            NAVORI_TEST_ROOT: "/repo",
            NAVORI_TEST_COMMAND: command,
          },
          encoding: "utf8",
          timeout: 5_000,
        });
        expect(result.error, command).toBeUndefined();
        expect(result.status, `${locale} ${JSON.stringify(command)} ${result.stderr}`).toBe(
          expected,
        );
      }
    }
  });
});
