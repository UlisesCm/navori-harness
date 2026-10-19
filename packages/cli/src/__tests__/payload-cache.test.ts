import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const ASSETS = join(ROOT, "packages/core/core-assets/hooks");
const PARTIAL = join(ASSETS, "_partials/extract-cmd.sh");
const TREES = [".claude/hooks", ".codex/hooks", ".pi/navori/hooks"] as const;
const SHELLS = ["bash", "zsh"] as const;
const FIELDS = "tool_name tool_input.command cwd session_id tool_input.flag";
const temps: string[] = [];

afterEach(() => {
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Resolve real tools before installing transparent counting shims. */
function which(tool: string): string {
  const result = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
  if (!result.stdout.trim()) throw new Error(`Missing ${tool}`);
  return result.stdout.trim();
}

/** Make an isolated executable PATH, counting extraction separately from output jq. */
function fixture(tools = ["jq", "node", "sed"]): { dir: string; bin: string; log: string } {
  const dir = mkdtempSync(join(tmpdir(), "navori-cache-"));
  temps.push(dir);
  const bin = join(dir, "bin");
  const log = join(dir, "extract.log");
  mkdirSync(bin);
  for (const tool of tools) {
    if (tool === "jq") {
      writeFileSync(
        join(bin, tool),
        `#!/bin/sh\ncase "$1" in -n*|-c*n*) ;; *) printf 'jq\\n' >> '${log}' ;; esac\nexec '${which(tool)}' "$@"\n`,
      );
      chmodSync(join(bin, tool), 0o755);
    } else symlinkSync(which(tool), join(bin, tool));
  }
  return { dir, bin, log };
}

function calls(log: string): number {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
}

/** Run the primitive with argv transport so payload content cannot become shell code. */
function run(shell: string, bin: string, payload: string, script: string, extra = ""): string {
  const result = spawnSync(
    which(shell),
    [
      "-c",
      `payload=$1\n. '${PARTIAL}'\nnv_payload_fields='${FIELDS}'\n${script}`,
      "cache",
      payload,
      extra,
    ],
    { encoding: "utf8", env: { PATH: bin } },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe.each(SHELLS)("payload cache under %s", (shell) => {
  // Covers: R10, R13
  it("loads once in the parent and serves inherited subshells and batched callers", () => {
    const { bin, log } = fixture();
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { command: "echo hi" },
      cwd: "/a",
      session_id: "s",
    });
    expect(
      run(
        shell,
        bin,
        payload,
        `payload_load\npayload_load\npayload_fields cmd=tool_input.command dir=cwd\nprintf '%s|%s|%s|%s' "$cmd" "$dir" "$(extract_cmd)" "$(payload_field session_id)"`,
      ),
    ).toBe("echo hi|/a|echo hi|s");
    expect(calls(log)).toBe(1);
  });

  // Covers: R10, R13
  it("bypasses an old cache for acceptance input and reuses it after restoration", () => {
    const { bin, log } = fixture();
    const original = JSON.stringify({
      tool_input: { command: "original" },
      cwd: "/old",
      session_id: "old",
    });
    const replacement = JSON.stringify({
      tool_input: { command: "replacement" },
      cwd: "/new",
      session_id: "new",
    });
    expect(
      run(
        shell,
        bin,
        original,
        `payload_load\noriginal=$payload\npayload=$2\nprintf '%s|%s|%s|' "$(extract_cmd)" "$(payload_field cwd)" "$(payload_field session_id)"\npayload=$original\nprintf '%s|%s|%s' "$(extract_cmd)" "$(payload_field cwd)" "$(payload_field session_id)"`,
        replacement,
      ),
    ).toBe("replacement|/new|new|original|/old|old");
    expect(calls(log)).toBe(4);
    expect(
      run(
        shell,
        bin,
        original,
        `payload_load\npayload=$2\npayload_load\nprintf '%s' "$(extract_cmd)"`,
        replacement,
      ),
    ).toBe("replacement");
  });

  // Covers: R10, R13
  it.each([false, 0, "", "line\n\n", "quotes '\" $(touch forbidden) \\ ñ"])(
    "matches scalar extraction for %j",
    (value) => {
      const { bin, log } = fixture();
      const payload = JSON.stringify({ tool_input: { command: value, flag: value } });
      expect(
        run(
          shell,
          bin,
          payload,
          `before=$(payload_field tool_input.command)\npayload_load\nafter=$(payload_field tool_input.command)\n[ "$before" = "$after" ]\nprintf '%s' "$after"`,
        ),
      ).toBe(value === false ? "" : String(value).replace(/\n+$/, ""));
      expect(calls(log)).toBe(2);
    },
  );

  // Covers: R10, R13
  it.each(["ñ🙂\n内部\nEND", "ñ🙂\n内部\nEND" + "\n".repeat(8192), "\n".repeat(8192)])(
    "trims all trailing newlines while preserving Unicode and internal framing",
    (value) => {
      const { bin, log } = fixture();
      expect(
        run(
          shell,
          bin,
          JSON.stringify({ tool_input: { command: value }, cwd: "/safe" }),
          `payload_load\nprintf '%s|%s' "$_nv_pf_tool_input__command" "$_nv_pf_cwd"`,
        ),
      ).toBe(`${value.replace(/\n+$/, "")}|/safe`);
      expect(calls(log)).toBe(1);
    },
  );

  // Covers: R10, R13
  it("accepts a string tool_input in one jq and never executes path syntax", () => {
    const { bin, log } = fixture();
    expect(
      run(
        shell,
        bin,
        JSON.stringify({ tool_input: "opaque", cwd: "/a" }),
        `payload_load\nprintf '%s|%s' "$(extract_cmd)" "$(payload_field cwd)"\nnv_payload_fields='bad;exit'\n_nv_pf_loaded=0\nif payload_load; then exit 7; fi`,
      ),
    ).toBe("|/a");
    expect(calls(log)).toBe(1);
  });

  // Covers: R10, R13
  it("returns shell-looking payload values literally and refuses executable route syntax", () => {
    const { dir, bin } = fixture();
    const marker = join(dir, "executed");
    const command = `$(touch '${marker}') \`touch '${marker}'\` ' " ;`;
    expect(
      run(
        shell,
        bin,
        JSON.stringify({ tool_input: { command } }),
        `payload_load\nprintf '%s' "$(extract_cmd)"\nnv_payload_fields=$2\n_nv_pf_loaded=0\nif payload_load; then exit 7; fi`,
        `cwd;touch '${marker}'`,
      ),
    ).toBe(command);
    expect(existsSync(marker)).toBe(false);
  });

  // Covers: R10, R13
  it("preserves malformed-input fallback and reads undeclared fields outside the cache", () => {
    const { bin, log } = fixture(["jq", "sed"]);
    expect(
      run(
        shell,
        bin,
        '{"cwd":"/partial"',
        `before=$(payload_field cwd)\npayload_load\n[ "$before" = "$(payload_field cwd)" ]`,
      ),
    ).toBe("");
    writeFileSync(log, "");
    expect(
      run(shell, bin, '{"extra":"outside"}', `payload_load\nprintf '%s' "$(payload_field extra)"`),
    ).toBe("outside");
    expect(calls(log)).toBe(2);
  });

  // Covers: R10, R13
  it("matches the original reader for every declared scalar route", () => {
    const { bin } = fixture();
    const routes = [
      ...new Set(
        readdirSync(ASSETS)
          .filter((name) => name.endsWith(".sh"))
          .flatMap(
            (name) =>
              readFileSync(join(ASSETS, name), "utf8")
                .match(/^nv_payload_fields="([^"]*)"/m)?.[1]
                ?.split(" ") ?? [],
          ),
      ),
    ].filter(Boolean);
    for (const value of [false, 0, "", "tail\n\n"]) {
      const payload: Record<string, unknown> = {};
      for (const route of routes) {
        const [parent, leaf] = route.split(".");
        if (!parent) throw new Error("Empty payload route");
        if (leaf) {
          const object = payload[parent];
          const record: Record<string, unknown> =
            typeof object === "object" && object !== null
              ? (object as Record<string, unknown>)
              : {};
          record[leaf] = value;
          payload[parent] = record;
        } else payload[parent] = value;
      }
      const comparisons = routes
        .map(
          (route) =>
            `_nv_pf_loaded=0\nbefore=$(payload_field ${route})\n_nv_pf_loaded=1\nafter=$(payload_field ${route})\n[ "$before" = "$after" ] || { printf '%s' '${route}'; exit 1; }`,
        )
        .join("\n");
      expect(
        run(
          shell,
          bin,
          JSON.stringify(payload),
          `nv_payload_fields=$2\npayload_load\n${comparisons}`,
          routes.join(" "),
        ),
      ).toBe("");
    }
  });

  // Covers: R10, R13
  it.each([["node", "sed"], ["sed"]])("keeps fallback extraction with %j", (...tools) => {
    const { bin } = fixture(tools);
    expect(
      run(
        shell,
        bin,
        JSON.stringify({ tool_input: { command: "echo hi" }, cwd: "/a", session_id: "s" }),
        `payload_load\nprintf '%s|%s|%s' "$(extract_cmd)" "$(payload_field cwd)" "$(payload_field session_id)"`,
      ),
    ).toBe("echo hi|/a|s");
  });

  // Covers: R10, R13
  it("rejects NUL batches and a corrupt sentinel without shifting sibling values", () => {
    const { bin, log } = fixture(["jq", "sed"]);
    const payload = JSON.stringify({
      tool_input: { command: "a\u0000b" },
      cwd: "/safe",
      session_id: "safe",
    });
    expect(
      run(
        shell,
        bin,
        payload,
        `payload_load\nprintf '%s|%s' "$(payload_field cwd)" "$(payload_field session_id)"`,
      ),
    ).toBe("/safe|safe");
    expect(calls(log)).toBe(1 + FIELDS.split(" ").length);
    writeFileSync(
      join(bin, "jq"),
      `#!/bin/sh\nif [ "$1" = -j ]; then printf 'poison\\0wrong\\0'; else exec '${which("jq")}' "$@"; fi\n`,
    );
    expect(
      run(
        shell,
        bin,
        JSON.stringify({ tool_input: { command: "real" }, cwd: "/safe", session_id: "safe" }),
        `payload_load\nprintf '%s|%s|%s' "$(extract_cmd)" "$(payload_field cwd)" "$(payload_field session_id)"`,
      ),
    ).toBe("real|/safe|safe");
  });
});

describe("payload declarations and rendered extraction", () => {
  // Covers: R10, R13
  it("declares every literal from each rendered hook including its expanded partials", () => {
    const canonical = readdirSync(ASSETS).filter((name) => name.endsWith(".sh"));
    expect(canonical).toHaveLength(22);
    for (const name of canonical) {
      const source = readFileSync(join(ASSETS, name), "utf8");
      expect(source.indexOf("nv_payload_fields="), name).toBeLessThan(
        source.indexOf("# navori:include"),
      );
    }
    for (const tree of TREES) {
      for (const name of readdirSync(join(ROOT, tree)).filter((file) => file.endsWith(".sh"))) {
        const source = readFileSync(join(ROOT, tree, name), "utf8");
        const declaration = source.match(/^nv_payload_fields="([^"]*)"/m);
        expect(declaration, `${tree}/${name}`).not.toBeNull();
        const declared = declaration?.[1]?.split(" ") ?? [];
        const code = source
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("#"))
          .join("\n");
        for (const match of code.matchAll(
          /\bpayload_field\s+([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)/g,
        )) {
          expect(declared, `${tree}/${name}: ${match[1]}`).toContain(match[1]);
        }
      }
    }
  });

  // Covers: R10, R13
  it.each(SHELLS)(
    "uses at most one extraction jq per hook and engine under %s",
    (shell) => {
      const { dir, bin, log } = fixture(["jq"]);
      const project = join(dir, "project");
      mkdirSync(project);
      // A CLI stub keeps hooks local to this private fixture and cannot write session state.
      writeFileSync(join(bin, "navori"), "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, "navori"), 0o755);
      for (const tree of TREES) {
        cpSync(join(ROOT, tree), join(project, tree), { recursive: true });
        for (const name of readdirSync(join(project, tree)).filter((file) =>
          file.endsWith(".sh"),
        )) {
          writeFileSync(log, "");
          const result = spawnSync(which(shell), [join(project, tree, name)], {
            encoding: "utf8",
            cwd: project,
            input: JSON.stringify({
              tool_name: "Bash",
              tool_input: {
                command: "echo create review api comment approved-by",
                subagent_type: "general-purpose",
                agent_type: "general-purpose",
              },
              cwd: project,
              session_id: "cache-fixture",
              agent_id: "child-fixture",
              hook_event_name: "PreToolUse",
            }),
            env: {
              PATH: `${bin}:${process.env.PATH}`,
              HOME: dir,
              CLAUDE_PROJECT_DIR: project,
              NAVORI_AUDITS_ROOT: join(dir, "absent-audits"),
            },
            timeout: 10000,
          });
          expect(result.error, `${tree}/${name}: ${result.stderr}`).toBeUndefined();
          expect([0, 2], `${tree}/${name}: ${result.stderr}`).toContain(result.status);
          const count = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
          expect(count, `${tree}/${name}: ${result.stderr}`).toBeLessThanOrEqual(1);
        }
      }
    },
    120000,
  );
});
