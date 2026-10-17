import { describe, expect, it, afterEach, beforeAll, afterAll } from "vitest";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { readProfileHookInput } from "../codex-profile.ts";
import { resolveCodexHooks } from "../../engines/codex/hook-registrations.ts";
import { NavoriConfigSchema } from "../../lib/config/schema.ts";
import { emptyRepo, type RepoTemplate } from "../../__tests__/helpers/repo-template.ts";

/** Repos built once per file and copied per case (spec 0055 D7). */
let repoTplMaster: RepoTemplate;
beforeAll(() => {
  repoTplMaster = emptyRepo({ branch: "master" });
});
afterAll(() => {
  repoTplMaster.dispose();
});

const script = fileURLToPath(
  new URL("../../../../core/core-assets/hooks/model-advisor.sh", import.meta.url),
);
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("fixed Codex profile hook", () => {
  // Covers: R13, R16, R18
  it("production fixed probe CLI reports pending opt-out without starting a native owner", () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "navori-profile-probe-cli-")));
    directories.push(directory);
    repoTplMaster.copyInto(directory);
    writeFileSync(
      join(directory, "navori.config.json"),
      JSON.stringify({ name: "fixture", preset: "custom", engines: ["codex"] }),
    );
    const output = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("../../../dist/index.js", import.meta.url)),
        "codex",
        "profile",
        "probe",
        "--cwd",
        directory,
      ],
      { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: "/usr/bin:/bin" } },
    );
    expect(output.status).toBe(1);
    expect(output.stdout, output.stderr).not.toBe("");
    expect(JSON.parse(output.stdout)).toMatchObject({
      status: "pending",
      scenario: "enabled-child-profile-creation-0.162.1",
      consumed: false,
      cleanup: "not-started",
      principalTurnsStarted: 0,
      childTurnsStarted: 0,
      pending: ["project-opt-in-required"],
    });
  });
  // Covers: R13, R18
  it("bounds stdin and preserves UTF8 split across native chunks", async () => {
    const stream = new PassThrough();
    const result = readProfileHookInput(stream, Date.now() + 1000);
    const bytes = Buffer.from(JSON.stringify({ message: "ñ" }));
    const split = bytes.indexOf(0xc3) + 1;
    stream.write(bytes.subarray(0, split));
    stream.end(bytes.subarray(split));
    expect(await result).toEqual({ message: "ñ" });
    const slow = new PassThrough();
    await expect(readProfileHookInput(slow, Date.now() + 20)).rejects.toThrow("unavailable");
    expect(slow.listenerCount("data")).toBe(0);
    const large = new PassThrough();
    const rejected = expect(readProfileHookInput(large, Date.now() + 1000)).rejects.toThrow(
      "too-large",
    );
    large.end(Buffer.alloc(1024 * 1024 + 1));
    await rejected;
  });
  // Covers: R13, R18
  it("appends only an opt-in registration with unchanged published positions and budget", () => {
    const config = NavoriConfigSchema.parse({
      name: "fixture",
      preset: "custom",
      engines: ["codex"],
    });
    const before = resolveCodexHooks(config);
    const after = resolveCodexHooks(
      NavoriConfigSchema.parse({
        ...config,
        harness: { ...config.harness, codexIntegration: true },
      }),
    );
    expect(after.slice(0, -1)).toEqual(before);
    expect(after.at(-1)).toMatchObject({
      event: "PreToolUse",
      script: "model-advisor",
      args: "codex-pretool-profile",
      timeout: 15,
    });
    expect(before.some((row) => row.args === "codex-pretool-profile")).toBe(false);
  });
  // Covers: R13, R18
  it.each(["allow", "deny", "help", "nonzero", "signal", "mutation", "missing"])(
    "fixed shell supervisor validates %s CLI output before native rewriting",
    (mode: string) => {
      const directory = mkdtempSync(join(tmpdir(), "navori-profile-shell-"));
      directories.push(directory);
      symlinkSync(process.execPath, join(directory, "node"));
      const input = { agent_type: "local", message: { opaque: "encrypted" }, other: [null, false] };
      const updated = { ...input, model: "gpt-6.1-sol", reasoning_effort: "medium" };
      const wire = {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: mode === "deny" ? "deny" : "allow",
          permissionDecisionReason: "test",
          updatedInput: mode === "mutation" ? { ...updated, message: "changed" } : updated,
        },
      };
      if (mode !== "missing")
        writeFileSync(
          join(directory, "navori"),
          `#!/bin/sh\ncat >/dev/null\n${mode === "signal" ? "kill -KILL $$" : `printf '%s\\n' '${mode === "help" ? "navori help" : JSON.stringify(wire)}'\nexit ${mode === "nonzero" ? 1 : 0}`}\n`,
          { mode: 0o755 },
        );
      const output = spawnSync("/bin/bash", [script, "codex-pretool-profile"], {
        input: JSON.stringify({
          cwd: directory,
          session_id: "session",
          tool_use_id: "call",
          tool_name: "Agent",
          tool_input: input,
        }),
        env: { ...process.env, PATH: `${directory}${delimiter}/bin` },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(output.status).toBe(0);
      expect(output.stdout.trim().split("\n")).toHaveLength(1);
      const result = JSON.parse(output.stdout) as {
        hookSpecificOutput: { permissionDecision: string; updatedInput?: unknown };
      };
      expect(result.hookSpecificOutput.permissionDecision).toBe(
        mode === "allow" ? "allow" : "deny",
      );
      if (mode === "allow") expect(result.hookSpecificOutput.updatedInput).toEqual(updated);
    },
  );
  // Covers: R13, R18
  it("large opaque native input exceeds environment argument limits without losing a denial wire", () => {
    const directory = mkdtempSync(join(tmpdir(), "navori-profile-large-"));
    directories.push(directory);
    symlinkSync(process.execPath, join(directory, "node"));
    writeFileSync(join(directory, "navori"), "#!/bin/sh\ncat >/dev/null\nexit 127\n", {
      mode: 0o755,
    });
    const output = spawnSync("/bin/bash", [script, "codex-pretool-profile"], {
      input: JSON.stringify({ tool_input: { message: "x".repeat(512 * 1024) } }),
      env: { ...process.env, PATH: `${directory}${delimiter}/bin` },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(output.status).toBe(0);
    expect(JSON.parse(output.stdout)).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
  });
  // Covers: R13, R18
  it.each(["[]", "true", "false", "0", "1", "null", '""', '"text"', "{}"])(
    "only an exact empty object opts out; CLI JSON %s is validated",
    (value: string) => {
      const directory = mkdtempSync(join(tmpdir(), "navori-profile-json-"));
      directories.push(directory);
      symlinkSync(process.execPath, join(directory, "node"));
      writeFileSync(
        join(directory, "navori"),
        `#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' '${value}'\n`,
        { mode: 0o755 },
      );
      const output = spawnSync("/bin/bash", [script, "codex-pretool-profile"], {
        input: JSON.stringify({ tool_input: { agent_type: "local", message: "opaque" } }),
        env: { ...process.env, PATH: `${directory}${delimiter}/bin` },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(output.status).toBe(0);
      expect(output.stdout.trim().split("\n")).toHaveLength(1);
      const response = JSON.parse(output.stdout) as unknown;
      if (value === "{}") expect(response).toEqual({});
      else
        expect(response).toMatchObject({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
        });
    },
  );
  // Covers: R13, R18
  it.each(["missing", "fatal", "signal"])(
    "supervisor %s yields one denial on truly restricted PATH",
    (mode: string) => {
      const directory = mkdtempSync(join(tmpdir(), "navori-profile-supervisor-"));
      directories.push(directory);
      if (mode !== "missing")
        writeFileSync(
          join(directory, "node"),
          `#!/bin/sh\nprintf '%s' '{"partial":'\n${mode === "fatal" ? "exit 1" : "kill -KILL $$"}\n`,
          { mode: 0o755 },
        );
      const output = spawnSync("/bin/bash", [script, "codex-pretool-profile"], {
        input: JSON.stringify({ tool_input: { agent_type: "local", message: "opaque" } }),
        env: { ...process.env, PATH: mode === "missing" ? "/bin" : `${directory}${delimiter}/bin` },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(output.status).toBe(0);
      expect(output.stdout.trim().split("\n")).toHaveLength(1);
      expect(JSON.parse(output.stdout)).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "profile-hook-supervisor-unavailable; effective-selection-pending",
        },
      });
    },
  );
});
