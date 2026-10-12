import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as nativeHooks from "../../../lib/diagnose/native-hooks.ts";
import { matchesLegacyFingerprint } from "../legacy-plugin-script-fingerprints.ts";
import {
  createRetiredAssetContext,
  findRetiredScriptReferences,
  retiredAssetKeepReason,
} from "../retired-plugin-assets.ts";
import {
  SYN_SCRIPT,
  makeRepo,
  markedScript,
  put,
  registerSyntheticRetired,
} from "./retired-fixtures.ts";

// The legacy fingerprint table is closed and hashes pre-#637 renders; the test
// controls its verdict instead of rebuilding a historical script.
vi.mock("../legacy-plugin-script-fingerprints.ts", () => ({
  matchesLegacyFingerprint: vi.fn(() => false),
}));
// Real behaviour, observable calls: the policy must read hook sources lazily.
vi.mock("../../../lib/diagnose/native-hooks.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/diagnose/native-hooks.ts")>();
  return { ...actual, readHookSources: vi.fn(actual.readHookSources) };
});

const CLAUDE_SCRIPT = `.claude/scripts/${SYN_SCRIPT}`;
const CODEX_SCRIPT = `.codex/scripts/${SYN_SCRIPT}`;
const CALL = `bash ".claude/scripts/${SYN_SCRIPT}"`;

let cwd: string;
let unregister: () => void;

beforeEach(() => {
  unregister = registerSyntheticRetired();
  cwd = makeRepo();
  vi.mocked(matchesLegacyFingerprint).mockReset().mockReturnValue(false);
  vi.mocked(nativeHooks.readHookSources).mockClear();
});

afterEach(() => {
  unregister();
  rmSync(cwd, { recursive: true, force: true });
});

const ctx = (plugins = {}, configPaths: string[] = []) =>
  createRetiredAssetContext(cwd, plugins, configPaths);

describe("retiredAssetKeepReason — ownership", () => {
  it("deletes a pristine marked script (Claude and Codex paths)", () => {
    for (const rel of [CLAUDE_SCRIPT, CODEX_SCRIPT]) {
      const abs = put(cwd, rel, markedScript());
      expect(retiredAssetKeepReason(abs, ctx())).toBeNull();
    }
  });

  it("keeps a marked script with a line appended after the end marker (modified)", () => {
    const abs = put(cwd, CLAUDE_SCRIPT, `${markedScript()}echo mine\n`);
    expect(retiredAssetKeepReason(abs, ctx())).toBe("modified");
  });

  it("keeps a marked script edited inside the block (hash mismatch)", () => {
    const abs = put(cwd, CODEX_SCRIPT, markedScript().replace("echo zzdemo", "echo hacked"));
    expect(retiredAssetKeepReason(abs, ctx())).toBe("modified");
  });

  it("keeps a marked script stamped by a newer navori", () => {
    const abs = put(
      cwd,
      CLAUDE_SCRIPT,
      markedScript().replace(/version="[^"]+"/, 'version="999.0.0"'),
    );
    expect(retiredAssetKeepReason(abs, ctx())).toBe("newer");
  });

  it("deletes a marker-free script that matches a legacy fingerprint", () => {
    const abs = put(cwd, CLAUDE_SCRIPT, "#!/usr/bin/env bash\necho legacy\n");
    vi.mocked(matchesLegacyFingerprint).mockReturnValue(true);
    expect(retiredAssetKeepReason(abs, ctx())).toBeNull();
    expect(matchesLegacyFingerprint).toHaveBeenCalledWith(SYN_SCRIPT, expect.any(String));
  });

  it("keeps a marker-free, non-matching script as foreign (strict entry)", () => {
    const abs = put(cwd, CLAUDE_SCRIPT, "#!/usr/bin/env bash\necho mine\n");
    expect(retiredAssetKeepReason(abs, ctx())).toBe("foreign");
  });

  it("deletes a marker-free script when the entry opts in with deleteForeign (cognitive)", () => {
    const abs = put(cwd, ".claude/scripts/check-cognitive.sh", "#!/usr/bin/env bash\necho x\n");
    expect(retiredAssetKeepReason(abs, ctx())).toBeNull();
  });

  it("ignores a path that is not a retired asset, or does not exist", () => {
    const other = put(cwd, ".claude/scripts/check-other.sh", "echo mine\n");
    expect(retiredAssetKeepReason(other, ctx())).toBeNull();
    expect(retiredAssetKeepReason(join(cwd, CLAUDE_SCRIPT), ctx())).toBeNull();
  });

  it("keeps a symlink whatever it points at", () => {
    const target = put(cwd, "elsewhere.sh", markedScript());
    mkdirSync(join(cwd, ".claude/scripts"), { recursive: true });
    symlinkSync(target, join(cwd, CLAUDE_SCRIPT));
    expect(retiredAssetKeepReason(join(cwd, CLAUDE_SCRIPT), ctx())).toBe("symlink");
  });
});

describe("retiredAssetKeepReason — directories are judged file by file", () => {
  it("deletes a directory of foreign files when the entry opts in (cognitive-tool)", () => {
    put(cwd, ".claude/scripts/cognitive-tool/package.json", "{}\n");
    put(cwd, ".claude/scripts/cognitive-tool/nested/eslint.config.mjs", "export default [];\n");
    expect(retiredAssetKeepReason(join(cwd, ".claude/scripts/cognitive-tool"), ctx())).toBeNull();
  });

  it("keeps the whole directory when a symlink hides inside it", () => {
    const dir = join(cwd, ".claude/scripts/cognitive-tool");
    put(cwd, ".claude/scripts/cognitive-tool/package.json", "{}\n");
    const target = put(cwd, "outside.txt", "mine\n");
    symlinkSync(target, join(dir, "link.txt"));
    expect(retiredAssetKeepReason(dir, ctx())).toBe("symlink");
  });
});

describe("retiredAssetKeepReason — does anything still call it?", () => {
  it("keeps a pristine script while plugins.<id>.nativeHook is true", () => {
    const abs = put(cwd, CLAUDE_SCRIPT, markedScript());
    expect(retiredAssetKeepReason(abs, ctx({ zzdemo: { enabled: false, nativeHook: true } }))).toBe(
      "native-hook-declared",
    );
    expect(retiredAssetKeepReason(abs, ctx({ zzdemo: { enabled: false } }))).toBeNull();
  });

  it("keeps it while a config this render did not rewrite still names it", () => {
    const abs = put(cwd, CLAUDE_SCRIPT, markedScript());
    const settings = put(cwd, ".claude/settings.json", `{"hooks":{"x":"${CALL}"}}`);
    expect(retiredAssetKeepReason(abs, ctx({}, [settings]))).toBe("settings-referenced");
    const clean = put(cwd, ".claude/other.json", "{}");
    expect(retiredAssetKeepReason(abs, ctx({}, [clean, join(cwd, "missing.json")]))).toBeNull();
  });

  it("keeps it while settings.local.json names it", () => {
    const abs = put(cwd, CODEX_SCRIPT, markedScript());
    const local = put(cwd, ".claude/settings.local.json", `{"hooks":"${CALL}"}`);
    expect(retiredAssetKeepReason(abs, ctx({}, [local]))).toBe("settings-referenced");
  });

  it("another retired script that a hook delegates to is the asset being retired, not a caller", () => {
    // The hook names check-cognitive.sh (one hop reads it); its text mentions our script.
    const abs = put(cwd, CLAUDE_SCRIPT, markedScript());
    put(cwd, ".husky/pre-commit", "#!/bin/sh\nbash .claude/scripts/check-cognitive.sh\n");
    put(cwd, ".claude/scripts/check-cognitive.sh", `# calls ${SYN_SCRIPT}\n`);
    expect(retiredAssetKeepReason(abs, ctx())).toBeNull();
    // ...while the cognitive script itself, named by the hook, is referenced.
    expect(retiredAssetKeepReason(join(cwd, ".claude/scripts/check-cognitive.sh"), ctx())).toBe(
      "hook-referenced",
    );
  });

  describe("hook sources", () => {
    const keepsFor = (setup: () => void): string | null => {
      const abs = put(cwd, CLAUDE_SCRIPT, markedScript());
      setup();
      return retiredAssetKeepReason(abs, ctx());
    };

    it("git hooks directory, for any event (not only pre-commit)", () => {
      expect(keepsFor(() => put(cwd, ".git/hooks/post-merge", `#!/bin/sh\n${CALL}\n`))).toBe(
        "hook-referenced",
      );
    });

    it("ignores .sample hooks", () => {
      expect(keepsFor(() => put(cwd, ".git/hooks/pre-commit.sample", `${CALL}\n`))).toBeNull();
    });

    it("honours core.hooksPath", () => {
      expect(
        keepsFor(() => {
          execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd });
          put(cwd, ".githooks/pre-push", `#!/bin/sh\n${CALL}\n`);
        }),
      ).toBe("hook-referenced");
    });

    it("follows one hop of delegation from a hook", () => {
      expect(
        keepsFor(() => {
          put(cwd, ".git/hooks/pre-commit", "#!/bin/sh\nexec scripts/git-hooks/pre-commit\n");
          put(cwd, "scripts/git-hooks/pre-commit", `#!/bin/sh\n${CALL}\n`);
        }),
      ).toBe("hook-referenced");
    });

    it("does NOT follow two hops (documented limit)", () => {
      expect(
        keepsFor(() => {
          put(cwd, ".git/hooks/pre-commit", "#!/bin/sh\nexec scripts/git-hooks/pre-commit\n");
          put(cwd, "scripts/git-hooks/pre-commit", "#!/bin/sh\nexec scripts/git-hooks/gate.sh\n");
          put(cwd, "scripts/git-hooks/gate.sh", `#!/bin/sh\n${CALL}\n`);
        }),
      ).toBeNull();
    });

    it.each([
      [".husky/pre-commit", `#!/bin/sh\n${CALL}\n`],
      [".husky/nested/helper.sh", `${CALL}\n`],
      ["lefthook.yml", `pre-commit:\n  commands:\n    gate:\n      run: ${CALL}\n`],
      [".config/lefthook.yml", `pre-commit:\n  commands:\n    gate:\n      run: ${CALL}\n`],
      [".lefthook/pre-commit/gate.sh", `${CALL}\n`],
      [".pre-commit-config.yaml", `repos:\n- repo: local\n  hooks:\n  - entry: ${CALL}\n`],
      [".overcommit.yml", `PreCommit:\n  Custom:\n    command: ['${CALL}']\n`],
      ["package.json", `{"scripts":{"gate":"${CALL.replaceAll('"', "'")}"}}`],
      ["Makefile", `gate:\n\t${CALL}\n`],
      [".github/workflows/ci.yml", `jobs:\n  a:\n    steps:\n      - run: ${CALL}\n`],
    ])("%s", (rel, text) => {
      expect(keepsFor(() => put(cwd, rel, text))).toBe("hook-referenced");
    });

    it("a hook that names something else does not keep the script", () => {
      expect(keepsFor(() => put(cwd, ".husky/pre-commit", "#!/bin/sh\nbun run gate\n"))).toBeNull();
    });
  });
});

describe("retiredAssetKeepReason — lazy evaluation", () => {
  it("reads no hook source when nothing retired is on disk", () => {
    put(cwd, ".husky/pre-commit", `${CALL}\n`);
    const c = ctx();
    expect(retiredAssetKeepReason(join(cwd, CLAUDE_SCRIPT), c)).toBeNull();
    expect(retiredAssetKeepReason(join(cwd, CODEX_SCRIPT), c)).toBeNull();
    expect(nativeHooks.readHookSources).not.toHaveBeenCalled();
  });

  it("reads no hook source for a file that fails ownership", () => {
    const abs = put(cwd, CLAUDE_SCRIPT, "echo mine\n");
    expect(retiredAssetKeepReason(abs, ctx())).toBe("foreign");
    expect(nativeHooks.readHookSources).not.toHaveBeenCalled();
  });

  it("reads hook sources once per context, however many assets are judged", () => {
    const a = put(cwd, CLAUDE_SCRIPT, markedScript());
    const b = put(cwd, CODEX_SCRIPT, markedScript());
    const c = ctx();
    expect(retiredAssetKeepReason(a, c)).toBeNull();
    expect(retiredAssetKeepReason(b, c)).toBeNull();
    expect(nativeHooks.readHookSources).toHaveBeenCalledTimes(1);
  });

  it("findRetiredScriptReferences reads nothing without names to look for", () => {
    put(cwd, ".husky/pre-commit", `${CALL}\n`);
    expect(findRetiredScriptReferences(ctx(), [])).toEqual([]);
    expect(nativeHooks.readHookSources).not.toHaveBeenCalled();
    const refs = findRetiredScriptReferences(ctx(), [SYN_SCRIPT]);
    expect(refs).toEqual([{ script: SYN_SCRIPT, source: ".husky/pre-commit" }]);
  });
});

describe("readHookSources is bounded", () => {
  it("reads each source up to a size cap", () => {
    writeFileSync(join(cwd, "package.json"), `${CALL}${" ".repeat(300 * 1024)}tail`);
    const source = nativeHooks.readHookSources(cwd).find((s) => s.path.endsWith("package.json"));
    expect(source?.text.length).toBe(256 * 1024);
    expect(source?.text).toContain(SYN_SCRIPT);
    expect(source?.text).not.toContain("tail");
  });
});
