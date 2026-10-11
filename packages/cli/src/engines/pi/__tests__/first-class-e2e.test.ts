import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { ENGINE_CAPABILITIES } from "../../shared/engine-capabilities.ts";
import { MIN_PI_VERSION } from "../runtime-version.ts";
import { serializePiSource } from "../owned-file.ts";

/**
 * Credential-free first-class cycle on the pinned Pi 1.1.0 runtime.
 *
 * Real: this checkout's compiled CLI (render/plan), the real Pi SDK agent loop and tool pipeline for the parent
 * session (in process), real `pi` child processes spawned by the rendered extension, Pi's built-in bash/write
 * tools, git and the filesystem. Deterministic stand-in: the model only (pi-ai's fauxProvider, loaded as a Pi
 * extension fixture). Limits, stated rather than hidden:
 *  - no live model: faux proves the pipeline, never model compliance;
 *  - the parent runs in process (SDK), not as an interactive TUI/RPC process: approval is driven through Pi's
 *    real ExtensionRunner with a stub `ui.confirm`, so the dialog rendering itself is not exercised;
 *  - "receipt" is the shared `plan update ... cumplido` closure over the host-recorded evidence.
 */
const PKG = resolve(import.meta.dirname, "../../../..");
const PI_PACKAGE = join(PKG, "node_modules/@earendil-works/pi-coding-agent");
const PI_CLI = join(PI_PACKAGE, "dist/bundle/cli.js");
const NAVORI_CLI = join(PKG, "dist/index.js");
const FAUX_FIXTURE = join(import.meta.dirname, "fixtures/faux-provider.ts");
const DIR = ".navori/state/handoffs";
const FEATURE = "demo";
const A1 = "echo e2e-a1";
const A2 = "exit 3";
const A3 = "echo e2e-a3";
const CLAIM = "echo operator-approved --approved-by tester";
const BIG = 300 * 1024;
const ENV_KEYS = [
  "HOME",
  "PATH",
  "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR",
  "NAVORI_FAUX_SCRIPT",
  "NAVORI_PI_CHILD_DEPTH",
  "NAVORI_PI_CHILD_ROLE",
  "PI_SESSION_ID",
] as const;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs one named phase; a failure keeps the phase name plus whatever diagnostic the caller supplies. */
async function phase<T>(
  name: string,
  diagnostic: () => string,
  run: () => Promise<T> | T,
): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`[phase: ${name}] ${reason}\n--- diagnostic ---\n${diagnostic()}`, { cause });
  }
}

interface ToolOutcome {
  toolName: string;
  isError: boolean;
  text: string;
  details?: { truncated?: boolean };
}
/** Tool results the session produced since `from`, in order. */
function outcomes(session: AgentSession, from: number): ToolOutcome[] {
  return session.messages.slice(from).flatMap((message): ToolOutcome[] => {
    const m = message as unknown as {
      role: string;
      toolName?: string;
      isError?: boolean;
      details?: { truncated?: boolean };
      content?: Array<{ type: string; text?: string }>;
    };
    if (m.role !== "toolResult") return [];
    const text = (m.content ?? []).map((part) => part.text ?? "").join("");
    return [{ toolName: m.toolName ?? "?", isError: m.isError === true, text, details: m.details }];
  });
}

const call = (name: string, args: Record<string, string>) => ({ calls: [{ name, args }] });
const bash = (command: string) => call("bash", { command });
const dispatch = (role: string, task: string) =>
  call("navori_subagent", { role, task, feature: FEATURE });

describe("Pi credential-free first-class cycle", () => {
  // Covers: R15, R16, R17, R18, R19
  it("credential-free first-class cycle", { timeout: 180_000 }, async () => {
    // Under the OS temp dir, never inside the checkout; registered before anything can fail so afterEach
    // removes it on assertion failure and on timeout alike.
    const root = realpathSync(mkdtempSync(join(tmpdir(), "navori-pi-e2e-")));
    dirs.push(root);
    // The fixture extension imports pi-ai: resolve it from this checkout's dependencies, not the network.
    symlinkSync(join(PKG, "node_modules"), join(root, "node_modules"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    const home = join(root, "home");
    const bin = join(root, "bin");
    for (const dir of [cwd, agentDir, home, bin]) mkdirSync(dir);
    const logPath = join(root, "faux.log");
    writeFileSync(logPath, "");
    const modelLog = (): Array<{ role: string; provider: string; model: string }> =>
      readFileSync(logPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { role: string; provider: string; model: string });
    const diagnostic = (): string => `faux model calls: ${JSON.stringify(modelLog())}`;

    // Shims: the extension spawns `navori` and `pi` by name; point them at this checkout and the pinned Pi.
    for (const [name, entry] of [
      ["pi", PI_CLI],
      ["navori", NAVORI_CLI],
    ] as const) {
      writeFileSync(join(bin, name), `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`);
      chmodSync(join(bin, name), 0o755);
    }
    const cleanEnv: NodeJS.ProcessEnv = {
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
      NAVORI_FAUX_SCRIPT: join(root, "script.json"),
    };
    const sh = (program: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
      spawnSync(program, args, {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...cleanEnv, ...env },
      });
    const navori = (args: string[], env: NodeJS.ProcessEnv = {}) =>
      sh(process.execPath, [NAVORI_CLI, ...args], env);
    const git = (...args: string[]): string =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

    // ---- 1. Pinned runtime + install with this checkout's CLI (R15, R16) -------------------------------
    await phase("pinned runtime", diagnostic, () => {
      const pkg: unknown = JSON.parse(readFileSync(join(PI_PACKAGE, "package.json"), "utf8"));
      expect(pkg).toMatchObject({ version: "1.1.0" });
    });
    const config = NavoriConfigSchema.parse({
      name: "pi-e2e",
      preset: "custom",
      engines: ["pi"],
      branchBase: "main",
      qualityGate: { fast: "true", full: "true" },
      harness: { scribeOwnsMarkdown: true },
    });
    writeFileSync(join(cwd, "navori.config.json"), JSON.stringify(config, null, 2));
    await phase("install (navori render --apply)", diagnostic, () => {
      const rendered = navori(["render", "--apply"]);
      expect(rendered.status, rendered.stderr + rendered.stdout).toBe(0);
      // Pi-only: nothing another engine would contribute.
      // (Both engines' directories hold only the `.gitignore` every render writes; nothing else.)
      expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false);
      for (const dir of [".claude", ".codex"]) {
        expect(readdirSync(join(cwd, dir)), `${dir} contents`).toEqual([".gitignore"]);
      }
      expect(existsSync(join(cwd, ".pi/extensions/navori.ts"))).toBe(true);
      expect(readFileSync(join(cwd, ".pi/navori.json"), "utf8")).toContain("scribe");
    });

    // A repo of its own before anything resolves a state root: otherwise the enclosing checkout answers.
    git("init", "-b", "main");
    git("config", "user.name", "e2e");
    git("config", "user.email", "e2e@example.com");
    const installedExtension = readFileSync(join(cwd, ".pi/extensions/navori.ts"), "utf8");

    // Project fixture: previous-session state, the faux provider extension, a pending workplan and its index.
    mkdirSync(join(cwd, "progress"));
    writeFileSync(join(cwd, "progress/current.md"), "Resume the e2e demo feature.\n");
    writeFileSync(join(cwd, ".pi/extensions/zz-faux.ts"), readFileSync(FAUX_FIXTURE, "utf8"));
    mkdirSync(join(cwd, DIR), { recursive: true });
    writeFileSync(
      join(cwd, DIR, `workplan_${FEATURE}.json`),
      JSON.stringify({
        feature: FEATURE,
        level: 1,
        classification: { score: 2, level: 1, signals: [] },
        objective: "Credential-free e2e cycle.",
        acceptance: [
          { id: "A1", description: "passes", command: A1, expected: "exit0" },
          { id: "A2", description: "fails", command: A2, expected: "exit0" },
          { id: "A3", description: "child run", command: A3, expected: "exit0" },
        ],
        outOfScope: [],
        files: [],
        progress: { A1: "pendiente", A2: "pendiente", A3: "pendiente" },
        decisions: [],
      }),
    );
    await phase("approved plan (acceptance index)", diagnostic, () => {
      // `plan update` is the CLI write path that refreshes the acceptance index the extension reads.
      const planned = navori([
        "plan",
        "update",
        FEATURE,
        "--decision",
        "approved",
        "--date",
        "2026-10-10",
        "--cwd",
        cwd,
      ]);
      expect(planned.status, planned.stderr + planned.stdout).toBe(0);
      expect(existsSync(join(cwd, DIR, "acceptance-index"))).toBe(true);
    });
    git("add", "-A");
    git("commit", "-m", "baseline");
    const branch = git("branch", "--show-current");

    // ---- scripted model: the parent and every child role --------------------------------------------------
    const docsPath = ["docs", "feature.md"].join("/");
    const handoff = {
      feature: FEATURE,
      status: "DONE",
      worktree: cwd,
      branch,
      commits: [],
      filesTouched: ["src/feature.ts"],
      verification: { command: "true", exitCode: 0, summary: "smoke" },
      markdownRequests: [
        { path: docsPath, intent: "document feature", evidence: "src/feature.ts:1" },
      ],
    };
    writeFileSync(
      join(root, "script.json"),
      JSON.stringify({
        log: logPath,
        scripts: {
          parent: [
            bash(CLAIM), // no UI
            { text: "turn: no ui" },
            bash(CLAIM), // UI denies
            { text: "turn: denied" },
            bash(CLAIM), // UI approves
            { text: "turn: approved" },
            dispatch("scout", "stream a lot"),
            { text: "turn: scout" },
            dispatch("implementer", "write the code"),
            { text: "turn: implementer" },
            dispatch("scribe", "write the docs"),
            { text: "turn: scribe" },
            dispatch("reviewer", "review the combined diff"),
            { text: "turn: reviewer" },
            bash(A1),
            bash(A2),
            { text: "turn: evidence" },
          ],
          scout: [{ bigText: BIG }],
          implementer: [
            call("write", { path: "src/feature.ts", content: "export const feature = 1;\n" }),
            call("write", { path: "README.md", content: "# direct markdown\n" }),
            bash(CLAIM),
            call("write", {
              path: `${DIR}/impl_${FEATURE}.json`,
              content: JSON.stringify(handoff),
            }),
            { echoAll: "implementer results:" },
          ],
          scribe: [
            call("write", { path: docsPath, content: "# Feature\n\nIt exists.\n" }),
            { echoAll: "scribe results:" },
          ],
          reviewer: [
            bash("git status --porcelain --untracked-files=all"),
            bash(A3),
            { echoAll: "reviewer results:" },
          ],
        },
      }),
    );
    // The global default differs from the parent's model: only an explicit --model can carry the parent's.
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "faux", defaultModel: "role-model" }),
    );

    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    let session: AgentSession | undefined;
    try {
      Object.assign(process.env, cleanEnv);
      delete process.env.NAVORI_PI_CHILD_DEPTH;
      delete process.env.NAVORI_PI_CHILD_ROLE;

      // ---- 2. Context present: AGENTS.md discovered, extension loaded, startup snapshot (R16) ---------
      const loader = new DefaultResourceLoader({ cwd, agentDir });
      await loader.reload({ resolveProjectTrust: async () => true });
      await phase("context", diagnostic, () => {
        expect(loader.getExtensions().errors).toEqual([]);
        const agents = loader.getAgentsFiles().agentsFiles.map((file) => file.path);
        expect(agents).toContain(join(cwd, "AGENTS.md"));
      });
      const runtime = await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      });
      const created = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        modelRuntime: runtime,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: SettingsManager.inMemory({
          defaultProvider: "faux",
          defaultModel: "role-model",
        }),
      });
      session = created.session;
      const active = session;
      // Extension-registered providers and session_start handlers take effect when the session binds them.
      await active.bindExtensions({});
      const parent = runtime.getModel("faux", "parent-model");
      if (!parent) throw new Error("faux provider not registered by the fixture extension");
      await active.setModel(parent);
      await phase("context", diagnostic, () => {
        expect(active.systemPrompt).toContain("AGENTS.md");
        const tools = active.extensionRunner?.getAllRegisteredTools().map((t) => t.definition.name);
        expect(tools).toContain("navori_subagent");
        const snapshot = active.sessionManager
          .getBranch()
          .find((entry) => (entry as { customType?: string }).customType === "navori-context") as
          | { content?: string }
          | undefined;
        expect(snapshot?.content).toContain("Resume the e2e demo feature.");
      });

      const turn = async (
        name: string,
        ui?: Partial<ExtensionUIContext>,
      ): Promise<ToolOutcome[]> => {
        const from = active.messages.length;
        await active.bindExtensions({ uiContext: ui as ExtensionUIContext | undefined });
        await phase(name, diagnostic, () => active.prompt(name));
        await active.waitForIdle();
        return outcomes(active, from);
      };

      // ---- 3. Approval boundary: absent UI, denial, then explicit consent ----------------------------
      const noUi = await turn("approval without UI");
      await phase("approval without UI", diagnostic, () => {
        expect(noUi[0]).toMatchObject({ toolName: "bash", isError: true });
        expect(noUi[0]?.text).toContain("no interactive UI");
      });
      const denied = await turn("approval denied", { confirm: async () => false });
      await phase("approval denied", diagnostic, () => {
        expect(denied[0]).toMatchObject({ isError: true });
        expect(denied[0]?.text).toContain("denied or cancelled");
      });
      const allowed = await turn("approval granted", { confirm: async () => true });
      await phase("approval granted (positive control)", diagnostic, () => {
        expect(allowed[0]).toMatchObject({ toolName: "bash", isError: false });
        expect(allowed[0]?.text).toContain("operator-approved");
      });

      // ---- 4. Long stream (R19) -----------------------------------------------------------------------
      const scout = await turn("long stream child");
      await phase("long stream (>256 KiB child output)", diagnostic, () => {
        expect(BIG).toBeGreaterThan(256 * 1024);
        expect(scout[0]).toMatchObject({ toolName: "navori_subagent", isError: false });
        expect(scout[0]?.details?.truncated).toBe(true);
        // Truncated to the 64 KiB contract, not cancelled for volume.
        expect(Buffer.byteLength(scout[0]!.text)).toBeLessThanOrEqual(65_536);
        expect(scout[0]!.text.length).toBeGreaterThan(60_000);
      });

      // ---- 5. Code + documentation, then joint review (R18) -------------------------------------------
      const implemented = await turn("implementer child");
      await phase("implementer child", diagnostic, () => {
        expect(implemented[0]).toMatchObject({ toolName: "navori_subagent", isError: false });
        expect(implemented[0]?.text).toContain("scribe owns Markdown");
        expect(implemented[0]?.text).toContain("headless Navori children cannot approve");
        expect(readFileSync(join(cwd, "src/feature.ts"), "utf8")).toContain("feature = 1");
        expect(existsSync(join(cwd, "README.md"))).toBe(false);
      });
      const scribed = await turn("scribe child");
      await phase("scribe child", diagnostic, () => {
        expect(scribed[0]).toMatchObject({ toolName: "navori_subagent", isError: false });
        expect(readFileSync(join(cwd, docsPath), "utf8")).toContain("It exists.");
      });
      const reviewed = await turn("reviewer child");
      await phase("joint review", diagnostic, () => {
        expect(reviewed[0]).toMatchObject({ toolName: "navori_subagent", isError: false });
        expect(reviewed[0]?.text).toContain("src/feature.ts");
        expect(reviewed[0]?.text).toContain(docsPath);
      });

      // R17: every child ran on the parent's exact provider/model, not the global default.
      await phase("effective model", diagnostic, () => {
        const children = modelLog().filter((entry) => entry.role !== "parent");
        expect(children.map((entry) => entry.role)).toEqual(
          expect.arrayContaining(["scout", "implementer", "scribe", "reviewer"]),
        );
        for (const entry of children) {
          expect(entry).toMatchObject({ provider: "faux", model: "parent-model" });
        }
      });

      // ---- 6. Evidence: exact success recorded, failing run not ----------------------------------------
      const evidence = await turn("evidence runs");
      await phase("evidence recorded", diagnostic, () => {
        expect(evidence.map((o) => [o.toolName, o.isError])).toEqual([
          ["bash", false],
          ["bash", true],
        ]);
        const lines = readFileSync(join(cwd, DIR, `workplan_${FEATURE}.evidence.jsonl`), "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, string>);
        expect(lines.map((line) => line.id).sort()).toEqual(["A1", "A3"]);
        expect(lines.find((line) => line.id === "A1")).toMatchObject({
          command: A1,
          sessionId: active.sessionId,
        });
        expect(lines.find((line) => line.id === "A3")).toMatchObject({
          command: A3,
          agentId: "pi-reviewer",
        });
      });

      // ---- 7. Receipt: the shared closure accepts the exact run and rejects the failing one --------------
      const piSession = { PI_SESSION_ID: active.sessionId };
      await phase("receipt", diagnostic, () => {
        const bad = navori(
          ["plan", "update", FEATURE, "--progress", "A2=cumplido", "--json", "--cwd", cwd],
          piSession,
        );
        expect(bad.status).toBe(1);
        expect(bad.stderr + bad.stdout).toContain(A2);
        const good = navori(
          ["plan", "update", FEATURE, "--progress", "A1=cumplido", "--json", "--cwd", cwd],
          piSession,
        );
        expect(good.status, good.stderr + good.stdout).toBe(0);
        const plan = JSON.parse(readFileSync(join(cwd, DIR, `workplan_${FEATURE}.json`), "utf8"));
        expect(plan.progress).toMatchObject({ A1: "cumplido", A2: "pendiente" });
        expect(plan.evidence.A1).toMatchObject({ kind: "recorded", command: A1 });
      });

      // No real credentials or accounts: nothing stored, only the fixture provider ever answered.
      await phase("credential-free", diagnostic, () => {
        const authPath = join(agentDir, "auth.json");
        const stored: unknown = existsSync(authPath)
          ? JSON.parse(readFileSync(authPath, "utf8") || "{}")
          : {};
        expect(stored).toEqual({});
        expect(new Set(modelLog().map((entry) => entry.provider))).toEqual(new Set(["faux"]));
      });
    } finally {
      session?.dispose();
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }

    // ---- 8. Upgrade: an older owned generation is refreshed and still loads in real Pi --------------------
    await phase("upgrade", diagnostic, () => {
      const extension = join(cwd, ".pi/extensions/navori.ts");
      writeFileSync(extension, serializePiSource("export default function navori(): void {}\n"));
      const upgraded = navori(["render", "--apply"]);
      expect(upgraded.status, upgraded.stderr + upgraded.stdout).toBe(0);
      expect(readFileSync(extension, "utf8")).toBe(installedExtension);
      const listed = sh(process.execPath, [PI_CLI, "--approve", "--list-models"]);
      expect(listed.status, listed.stderr).toBe(0);
      expect(listed.stderr).not.toContain("Failed to load extension");
    });

    // ---- 9. Disable: only owned resources are pruned ---------------------------------------------------------
    await phase("disable", diagnostic, () => {
      writeFileSync(join(cwd, ".pi/agents", ["mine", "md"].join(".")), "# my own agent\n");
      writeFileSync(
        join(cwd, "navori.config.json"),
        JSON.stringify({ ...config, engines: ["cursor"] }, null, 2),
      );
      const pruned = navori(["render", "--apply", "--prune"]);
      expect(pruned.status, pruned.stderr + pruned.stdout).toBe(0);
      for (const owned of [".pi/navori.json", ".pi/extensions/navori.ts", ".pi/agents/scribe.md"]) {
        expect(existsSync(join(cwd, owned)), `${owned} should be pruned`).toBe(false);
      }
      // Foreign files and the work product survive.
      expect(existsSync(join(cwd, ".pi/agents/mine.md"))).toBe(true);
      expect(existsSync(join(cwd, ".pi/extensions/zz-faux.ts"))).toBe(true);
      expect(existsSync(join(cwd, "src/feature.ts"))).toBe(true);
      expect(existsSync(join(cwd, docsPath))).toBe(true);
    });
  });
});

/** Value of a `- <label>: **x.y.z**` line in the Pi guide, undefined when absent. */
function documentedVersion(doc: string, label: string): string | undefined {
  return new RegExp(`^- ${label}: \\*\\*(\\d+\\.\\d+\\.\\d+)\\*\\*\\s*$`, "m").exec(doc)?.[1];
}

/** `| `key` | state |` rows under a `## <heading>` section of the Pi guide, as key -> state. */
function documentedRows(doc: string, heading: string): Map<string, string> {
  const start = doc.indexOf(`\n## ${heading}\n`);
  const section = start < 0 ? "" : (doc.slice(start + 1).split(/\n## /)[0] ?? "");
  const rows = new Map<string, string>();
  for (const m of section.matchAll(/^\| `([a-z-]+)` \| ([a-z-]+) \|/gm)) {
    rows.set(m[1] as string, m[2] as string);
  }
  return rows;
}

describe("Pi documented support", () => {
  // Covers: R1, R2, R15
  it("documented support matches admitted runtime controls", () => {
    const doc = readFileSync(join(PKG, "../../docs/pi.md"), "utf8");
    const installed = (
      JSON.parse(readFileSync(join(PI_PACKAGE, "package.json"), "utf8")) as { version: string }
    ).version;

    // Versions: the documented floor is the admitted floor; the tested version is the pinned runtime.
    expect(documentedVersion(doc, "Minimum supported Pi version")).toBe(MIN_PI_VERSION);
    expect(documentedVersion(doc, "Tested Pi version")).toBe(installed);

    // Controls: every Pi control documented with exactly the declared state, and no extra rows.
    const controls = Object.fromEntries(
      Object.entries(ENGINE_CAPABILITIES.pi.controls).map(([id, c]) => [id, c.state]),
    );
    expect(Object.fromEntries(documentedRows(doc, "Support matrix"))).toEqual(controls);

    // Runtime admissions: same rule for the admitted/deferred child runtime capabilities.
    const admissions = Object.fromEntries(
      (ENGINE_CAPABILITIES.pi.runtimeAdmissions ?? []).map((r) => [r.capability, r.decision]),
    );
    expect(Object.fromEntries(documentedRows(doc, "Runtime admissions"))).toEqual(admissions);
  });
});
