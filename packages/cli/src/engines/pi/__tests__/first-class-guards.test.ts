import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { ENGINE_OUTPUTS } from "../../../lib/diagnose/health.ts";
import { PI_PARITY, piParityKey, type PiDirectParity } from "../../shared/pi-parity.ts";
import { PI_HOOK_BINDINGS } from "../hook-bindings.ts";
import { renderPiEngine } from "../index.ts";
import { load } from "./fixtures/load-extension.ts";

interface Ctx {
  cwd: string;
  hasUI?: boolean;
  ui?: { select: ReturnType<typeof vi.fn> };
  sessionManager: { getSessionId: () => string };
}
type Env = Record<string, string>;

const PARENT: Env = {};
const CHILD: Env = { NAVORI_PI_CHILD_DEPTH: "1", NAVORI_PI_CHILD_ROLE: "implementer" };
const NESTED: Env = { NAVORI_PI_CHILD_DEPTH: "2", NAVORI_PI_CHILD_ROLE: "reviewer" };

// Every call runs the real scripts under bash; a saturated machine needs room.
vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A git repo rendered for Pi with every shipped hook binding and the real shared guard copy. */
function piProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-pi-guards-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q", dir]);
  renderPiEngine(
    dir,
    NavoriConfigSchema.parse({
      name: "pi-guards",
      preset: "custom",
      engines: ["pi"],
      branchBase: "main",
      // A gate that passes: these tests are about the guards, not about the gate (first-class-gate.test.ts).
      qualityGate: { fast: "true", full: "true" },
    }),
  );
  return dir;
}

const ctxFor = (cwd: string, hasUI = false, answer = true): Ctx => ({
  cwd,
  hasUI,
  ...(hasUI
    ? {
        ui: {
          select: vi.fn(async (_t: string, options: string[]) =>
            answer ? options[1] : options[0],
          ),
        },
      }
    : {}),
  sessionManager: { getSessionId: () => "sess-g" },
});
const call = (toolName: string, input: Record<string, unknown>): Record<string, unknown> => ({
  toolName,
  toolCallId: "call-g",
  input,
});
const bash = (command: string): Record<string, unknown> => call("bash", { command });
const reasonOf = (result: unknown): string => (result as { reason: string }).reason;

/** The extension of each thread kind is loaded once per file: it keeps no state a verdict depends on. */
const loaded = new Map<string, ReturnType<typeof load>>();

/** The tool_call verdict of one call, from the loaded extension of the given thread. */
async function verdict(
  env: Env,
  cwd: string,
  event: Record<string, unknown>,
  ctx: Ctx = ctxFor(cwd),
): Promise<unknown> {
  const key = JSON.stringify(env);
  if (!loaded.has(key)) loaded.set(key, load({ env }));
  return loaded.get(key)!.get("tool_call")!(event, ctx);
}

const SCRIPT_BLOCK = /BLOCKED by guard-destructive/;

describe("Pi guards: destructive commands, deny rules and the control plane", () => {
  // Covers: R2, R18
  it("destructive and deny rules blocked in parent child and nested", async () => {
    const dir = piProject();
    const blocked = [
      "rm -rf /",
      "rm -rf ~/",
      "git commit --no-verify -m x",
      "git push --force origin main",
      "sudo rm -rf build",
      "mkfs /dev/sda1",
      "engram delete obs-1",
      "rm -rf --no-preserve-root /",
      "cd /tmp && sudo rm x",
      "pi --no-extensions",
      "pi -p hi --no-extensions",
      "/usr/local/bin/pi -ne",
    ];
    for (const env of [PARENT, CHILD, NESTED]) {
      for (const command of blocked) {
        const result = await verdict(env, dir, bash(command));
        expect(result, `${command} (${JSON.stringify(env)})`).toMatchObject({ block: true });
        expect(reasonOf(result)).toMatch(SCRIPT_BLOCK);
      }
      for (const command of ["git status", "ls -la .pi", "echo hello", "pi --version"]) {
        expect(await verdict(env, dir, bash(command)), command).toBeUndefined();
      }
    }
    // A shared deny rule names itself; a variant it does not match is left to the numbered rules.
    expect(reasonOf(await verdict(PARENT, dir, bash("sudo rm x")))).toContain("'sudo rm'");
    expect(await verdict(PARENT, dir, bash("sudo ls"))).toBeUndefined();
  });

  // Covers: R2
  it("the Pi control plane is protected across every shell verb and inline interpreter", async () => {
    const dir = piProject();
    const writes = [
      "echo x > .pi/navori.json",
      "echo x >> .pi/navori/hooks/guard-destructive.sh",
      "echo x >| .pi/settings.json",
      `echo x > ${dir}/.pi/extensions/navori.ts`,
      'echo x > "$PWD"/.pi/navori.json',
      "echo x > ./.PI/NAVORI.JSON",
      "cat <<EOF > .pi/navori.json\nx\nEOF",
      "tee .pi/extensions/navori.ts < /dev/null",
      "echo x | tee -a .pi/navori/hooks/guard-destructive.sh",
      "sed -i 's/a/b/' .pi/settings.json",
      "sed -i '' 's/a/b/' .pi/navori.json",
      "rm .pi/navori/hooks/guard-destructive.sh",
      "rm -f .pi/extensions/navori.ts",
      "rm -rf .pi/navori",
      "mv .pi/navori.json /tmp/x",
      "cp /tmp/x .pi/extensions/navori.ts",
      "ln -sf /dev/null .pi/settings.json",
      "dd if=/dev/zero of=.pi/navori.json",
      "install -m 755 /tmp/x .pi/navori/hooks/guard-destructive.sh",
      "truncate -s 0 .pi/navori.json",
      "chmod 000 .pi/navori/hooks/guard-destructive.sh",
      "git checkout -- .pi/settings.json",
      "git restore .pi/navori.json",
      "touch .pi/extensions/evil.ts",
      "python3 -c \"open('.pi/navori.json','w').write('')\"",
      "node -e \"require('fs').writeFileSync('.pi/settings.json','')\"",
      "perl -i -pe 's/a/b/' .pi/navori.json",
      "ruby -e \"File.write('.pi/navori.json','')\"",
      "php -r \"file_put_contents('.pi/navori.json','');\"",
      "echo ok && echo x > .pi/navori.json",
      "true; rm .pi/navori.json",
    ];
    const allowed = [
      "cat .pi/navori.json",
      "ls .pi/navori/hooks",
      "grep -r guard .pi/navori",
      "git diff -- .pi/settings.json",
      "echo x > .pi/agents/helper.md",
      "echo x > .pi/navori-notes.txt",
      "echo x > ~/.pi/agent/settings.json",
      "python3 script.py .pi/navori.json",
      'node -e "console.log(1)"',
      "echo 'docs: edit .pi/navori.json by hand' > notes.txt",
      "git commit -m 'rm .pi/navori.json from docs'",
    ];
    for (const env of [PARENT, CHILD]) {
      for (const command of writes) {
        const result = await verdict(env, dir, bash(command));
        expect(result, command).toMatchObject({ block: true });
        // Navori's own files hit the managed-file rule, the rest of the plane its own: both name the render.
        expect(reasonOf(result), command).toMatch(/Pi control plane|navori-managed file/);
        expect(reasonOf(result)).toContain("navori render --apply");
      }
      for (const command of allowed) {
        expect(await verdict(env, dir, bash(command)), command).toBeUndefined();
      }
    }
    // A role file Navori renders has its own rule and message; a foreign one stays free.
    const managed = await verdict(PARENT, dir, bash("echo x > .pi/agents/implementer.md"));
    expect(reasonOf(managed)).toContain("navori-managed file");
  });

  // Covers: R2
  it("a command too large to inspect is blocked, never waved through", async () => {
    const dir = piProject();
    const huge = await verdict(PARENT, dir, bash("echo " + "x".repeat(140_000)));
    expect(huge).toMatchObject({ block: true });
    expect(reasonOf(huge)).toMatch(/too large to inspect/);
  });

  // Covers: R2, R15
  it("the guard runs before the --approved-by confirmation, so the user is never asked first", async () => {
    const dir = piProject();
    const ctx = ctxFor(dir, true, true);
    const result = await verdict(
      PARENT,
      dir,
      bash("rm -rf / # navori master close --approved-by user"),
      ctx,
    );
    expect(result).toMatchObject({ block: true });
    expect(reasonOf(result)).toMatch(SCRIPT_BLOCK);
    expect(ctx.ui!.select).not.toHaveBeenCalled();
    // A command the guard accepts reaches the confirmation, once.
    const asked = ctxFor(dir, true, true);
    expect(
      await verdict(PARENT, dir, bash("navori master close --approved-by user"), asked),
    ).toBeUndefined();
    expect(asked.ui!.select).toHaveBeenCalledOnce();
  });
});

describe("Pi guards: edit and write of Navori-generated files", () => {
  const agentsBlock = (dir: string): { text: string; inside: string; outside: string } => {
    const text = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const open = text.indexOf("<!-- navori:managed");
    const afterOpen = text.indexOf("\n", open) + 1;
    return { text, inside: text.slice(afterOpen, afterOpen + 40), outside: "" };
  };

  // Covers: R3
  it("managed writes blocked, foreign agent files and the user section stay editable", async () => {
    const dir = piProject();
    const manifest = JSON.parse(readFileSync(join(dir, ".pi/navori.json"), "utf8")) as {
      ownedPaths: string[];
    };
    for (const env of [PARENT, CHILD]) {
      // Every generated destination and the control plane: edit and write both blocked, by any spelling of the path.
      for (const tool of ["write", "edit"]) {
        const input = (path: string): Record<string, unknown> =>
          tool === "write"
            ? { path, content: "x" }
            : { path, edits: [{ oldText: "a", newText: "b" }] };
        for (const path of [
          ".pi/navori.json",
          "@.pi/navori.json",
          "./.pi/navori/hooks/guard-destructive.sh",
          join(dir, ".pi/extensions/navori.ts"),
          ".pi/settings.json",
          ".pi/extensions/other.ts",
          ".PI/NAVORI.JSON",
          ...manifest.ownedPaths,
        ]) {
          const result = await verdict(env, dir, call(tool, input(path)));
          expect(result, `${tool} ${path}`).toMatchObject({ block: true });
          expect(reasonOf(result)).toMatch(/control plane|generated by Navori/);
        }
      }
      // A foreign agent file and a plain project file are the user's.
      expect(
        await verdict(env, dir, call("write", { path: ".pi/agents/helper.md", content: "x" })),
      ).toBeUndefined();
      expect(
        await verdict(env, dir, call("write", { path: "src/new.ts", content: "x" })),
      ).toBeUndefined();
    }
    // The role files are named by the manifest, existing or not: a missing one is still a destination.
    const missing = ".pi/agents/scout.md";
    rmSync(join(dir, missing));
    expect(manifest.ownedPaths).toContain(missing);
    expect(
      await verdict(PARENT, dir, call("write", { path: missing, content: "x" })),
    ).toMatchObject({
      block: true,
    });
  });

  // Covers: R3
  it("normalizes the path like Pi: @, ~, absolute, dot segments and symlinks", async () => {
    const dir = piProject();
    const home = join(dir, "fake-home");
    mkdirSync(home);
    const probes = [
      "@.pi/navori.json",
      `@${join(dir, ".pi/navori.json")}`,
      "~/../.pi/navori.json",
      ".pi/navori.json",
      join(dir, "src/../.pi/navori.json"),
    ];
    // Pi 1.1.0 hands tool_call the raw argument: ~ is only expanded by the tool itself.
    const asHome = load({ env: { HOME: dir } }).get("tool_call")!;
    expect(
      await asHome(call("write", { path: "~/.pi/navori.json", content: "x" }), ctxFor(dir)),
    ).toMatchObject({ block: true });
    for (const path of probes.filter((p) => !p.startsWith("~"))) {
      expect(await verdict(PARENT, dir, call("write", { path, content: "x" })), path).toMatchObject(
        {
          block: true,
        },
      );
    }
    // A symlink that points into the control plane resolves to its target; so does a symlinked directory.
    symlinkSync(join(dir, ".pi/navori.json"), join(dir, "alias.json"));
    symlinkSync(join(dir, ".pi"), join(dir, "pi-dir"));
    for (const path of ["alias.json", "pi-dir/navori.json", "pi-dir/extensions/new.ts"]) {
      expect(await verdict(PARENT, dir, call("write", { path, content: "x" })), path).toMatchObject(
        {
          block: true,
        },
      );
    }
    // A path outside the project is not Navori's to guard here.
    expect(
      await verdict(PARENT, dir, call("write", { path: join(home, "notes.txt"), content: "x" })),
    ).toBeUndefined();
    // No path at all cannot be evaluated: blocked.
    expect(await verdict(PARENT, dir, call("write", { content: "x" }))).toMatchObject({
      block: true,
    });
  });

  // Covers: R3
  it("a mixed file is blocked only where a real managed block is", async () => {
    const dir = piProject();
    const { text, inside } = agentsBlock(dir);
    expect(text).toContain("<!-- /navori:managed");
    appendFileSync(join(dir, "AGENTS.md"), "\n## My notes\nhello world\n");
    const edit = (edits: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> =>
      call("edit", { path: "AGENTS.md", edits, ...extra });
    // Inside the block: blocked, however the edit arrives (edits array or the legacy top-level pair).
    const hit = await verdict(PARENT, dir, edit([{ oldText: inside, newText: "tampered" }]));
    expect(hit).toMatchObject({ block: true });
    expect(reasonOf(hit)).toContain("navori-agents");
    expect(reasonOf(hit)).toContain("navori render --apply");
    expect(
      await verdict(
        PARENT,
        dir,
        call("edit", { path: "AGENTS.md", oldText: inside, newText: "tampered" }),
      ),
    ).toMatchObject({ block: true });
    // An edit that starts outside and reaches into the block is still a hit.
    expect(
      await verdict(
        PARENT,
        dir,
        edit([{ oldText: "AGENTS.md\n\n<!-- navori:managed", newText: "x" }]),
      ),
    ).toMatchObject({ block: true });
    // The user section and the text around the block are editable.
    expect(
      await verdict(PARENT, dir, edit([{ oldText: "hello world", newText: "bye" }])),
    ).toBeUndefined();
    expect(
      await verdict(
        PARENT,
        dir,
        call("edit", { path: "AGENTS.md", oldText: "hello world", newText: "bye" }),
      ),
    ).toBeUndefined();
    // An oldText that is not there exactly, and a shape the lane does not know, cannot be evaluated.
    expect(
      await verdict(PARENT, dir, edit([{ oldText: "nowhere-to-be-found", newText: "x" }])),
    ).toMatchObject({ block: true });
    for (const edits of [
      "not-a-list",
      [{ old: "a", new: "b" }],
      [],
      [{ oldText: "", newText: "x" }],
    ]) {
      expect(await verdict(PARENT, dir, edit(edits)), JSON.stringify(edits)).toMatchObject({
        block: true,
      });
    }
    // write replaces the whole file: blocked while a block is in it.
    expect(
      await verdict(PARENT, dir, call("write", { path: "AGENTS.md", content: "mine" })),
    ).toMatchObject({ block: true });
    // The same through a symlink elsewhere.
    symlinkSync(join(dir, "AGENTS.md"), join(dir, "context-link.md"));
    expect(
      await verdict(PARENT, dir, call("write", { path: "context-link.md", content: "mine" })),
    ).toMatchObject({ block: true });
  });

  // Covers: R3
  it("a file that quotes the marker grammar without a real block stays editable", async () => {
    const dir = piProject();
    const skill = join(dir, ".agents/skills/mine");
    mkdirSync(skill, { recursive: true });
    const open = '<!-- navori:managed id="x" hash="00000000" -->';
    const close = '<!-- /navori:managed id="x" -->';
    const fence = "`".repeat(3);
    writeFileSync(
      join(skill, "SKILL.md"),
      [
        "# Mine",
        `Inline mention of ${open} in a sentence, and of ${close} too.`,
        "  " + open + " indented, not anchored",
        '<!-- navori:managed id="orphan" -->',
        fence,
        open,
        "quoted inside a fence",
        close,
        fence,
        "tail",
        "",
      ].join("\n"),
    );
    const path = ".agents/skills/mine/SKILL.md";
    expect(
      await verdict(PARENT, dir, call("write", { path, content: "rewritten" })),
    ).toBeUndefined();
    expect(
      await verdict(
        PARENT,
        dir,
        call("edit", { path, edits: [{ oldText: "tail", newText: "x" }] }),
      ),
    ).toBeUndefined();
    // Once a real block (anchored open and close, outside any fence) is in it, the same file holds one.
    appendFileSync(join(skill, "SKILL.md"), "\n" + open + "\nmanaged body\n" + close + "\n");
    expect(await verdict(PARENT, dir, call("write", { path, content: "rewritten" }))).toMatchObject(
      { block: true },
    );
  });

  // Covers: R3, R15
  it("an unreadable manifest blocks edit and write (fail closed)", async () => {
    const dir = piProject();
    rmSync(join(dir, ".pi/navori.json"));
    expect(
      await verdict(PARENT, dir, call("write", { path: "src/a.ts", content: "x" })),
    ).toMatchObject({ block: true });
  });
});

describe("Pi guards: backgrounding in children", () => {
  // Covers: R8
  it("background operators are blocked in a Pi child and in a nested one, not in the parent", async () => {
    const dir = piProject();
    const background = [
      "sleep 30 &",
      "sleep 30 & echo started",
      "nohup sleep 30",
      "setsid sleep 30",
      "echo hi; disown",
      "sudo nohup sleep 1",
    ];
    for (const env of [CHILD, NESTED]) {
      for (const command of background) {
        const result = await verdict(env, dir, bash(command));
        expect(result, command).toMatchObject({ block: true });
        expect(reasonOf(result)).toContain("subagent-no-background");
      }
      for (const command of [
        "git status && echo done",
        "ls 2>&1",
        "echo a || echo b",
        "cat file 2>&1 | head",
        "echo 'a & b'",
        "cat <<EOF\nnohup x &\nEOF",
        "git commit -m 'run it with nohup &'",
      ]) {
        expect(await verdict(env, dir, bash(command)), command).toBeUndefined();
      }
    }
    // Backgrounding in the parent is the documented path for a long gate: out of scope for this control.
    expect(await verdict(PARENT, dir, bash("sleep 1 &"))).toBeUndefined();
  });
});

/** Runs a rendered hook copy with a payload, from the project root. */
function runHook(
  dir: string,
  script: string,
  payload: Record<string, unknown>,
): { status: number; stderr: string } {
  const run = spawnSync("bash", [join(dir, ".pi/navori/hooks", script + ".sh")], {
    cwd: dir,
    input: JSON.stringify({ cwd: dir, ...payload }),
    encoding: "utf8",
  });
  return { status: run.status ?? -1, stderr: run.stderr };
}

/** Marker-bearing files a Pi project holds for one `ENGINE_OUTPUTS.pi` source, relative to the root. */
function markerFiles(
  dir: string,
  source: (typeof ENGINE_OUTPUTS)[number]["markers"][number],
): string[] {
  if (source.kind === "file") return existsSync(join(dir, source.path)) ? [source.path] : [];
  const found: string[] = [];
  const walk = (rel: string): void => {
    if (!existsSync(join(dir, rel))) return;
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const child = rel + "/" + entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(source.ext)) found.push(child);
    }
  };
  walk(source.dir);
  return found;
}

/** Breaks the hash of the first managed block of a file by touching the first line of its body. */
function tamperFirstBlock(path: string): void {
  const lines = readFileSync(path, "utf8").split("\n");
  const open = lines.findIndex((line) =>
    /^(<!-- navori:managed|# navori:managed start) /.test(line),
  );
  expect(open, path).toBeGreaterThanOrEqual(0);
  lines[open + 1] += " tampered";
  writeFileSync(path, lines.join("\n"));
}

describe("Pi guards: the managed-path sources agree", () => {
  // Covers: R3, R9
  it("managed_path, drift roots, ownedPaths and ENGINE_OUTPUTS cover the same Navori outputs", () => {
    const dir = piProject();
    const { ownedPaths } = JSON.parse(readFileSync(join(dir, ".pi/navori.json"), "utf8")) as {
      ownedPaths: string[];
    };
    const guard = (command: string): number =>
      runHook(dir, "guard-destructive", { tool_name: "Bash", tool_input: { command } }).status;
    // Every destination Navori owns is out of reach of a shell write; a foreign agent file is not.
    for (const path of ownedPaths) expect(guard(`echo x > ${path}`), path).toBe(2);
    expect(guard("echo x > .pi/agents/helper.md")).toBe(0);
    // Every marker-bearing output of the Pi engine is a drift root: tamper each one, see it reported.
    const pi = ENGINE_OUTPUTS.find((outputs) => outputs.engine === "pi")!;
    const watch = (): { status: number; stderr: string } =>
      runHook(dir, "managed-drift-watch", { tool_name: "Bash", hook_event_name: "PostToolUse" });
    expect(watch().status).toBe(0); // baseline
    const tampered: string[] = [];
    for (const source of pi.markers) {
      for (const file of markerFiles(dir, source)) {
        tamperFirstBlock(join(dir, file));
        const report = watch();
        expect(report.status, file).toBe(2);
        expect(report.stderr, file).toContain(file);
        tampered.push(file);
      }
    }
    expect(tampered).toEqual(
      expect.arrayContaining(["AGENTS.md", ".pi/navori/hooks/guard-destructive.sh"]),
    );
    // The hook copies are generated destinations too: the same list the guard protects.
    for (const file of tampered.filter((path) => path.startsWith(".pi/"))) {
      expect(ownedPaths).toContain(file);
    }
  });
});

describe("Pi guards: the parity inventory follows the bindings", () => {
  // Covers: R2, R8, R9
  it("a script with a binding is never declared unsupported, and an unbound one is", () => {
    const bound = new Set(PI_HOOK_BINDINGS.map((binding) => binding.script));
    for (const script of ["guard-destructive", "subagent-no-background", "managed-drift-watch"]) {
      expect(bound.has(script), script).toBe(true);
    }
    for (const [key, row] of Object.entries(PI_PARITY)) {
      if (!key.startsWith("hook:") || "control" in row) continue;
      const script = key.slice("hook:".length);
      const declared = (row as PiDirectParity).state;
      if (bound.has(script)) expect(declared, key).toMatch(/^(enforced|advisory)$/);
      else if (declared === "enforced" || declared === "advisory") {
        // Only a row backed by the extension itself (not by a script binding) may be proven without one.
        expect((row as PiDirectParity).evidence, key).toMatch(/^pi-extension:/);
      }
    }
    for (const id of ["class:bash-deny"]) {
      expect((PI_PARITY[piParityKey("permission-rule", id)] as PiDirectParity).state).toBe(
        "enforced",
      );
    }
  });
});
