import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENGINE_CAPABILITIES } from "../../shared/engine-capabilities.ts";
import { PI_EXTENSION_SOURCE } from "../extension-source.ts";
import { serializePiAgent, serializePiManifest } from "../owned-file.ts";

type Role = "implementer" | "reviewer";
interface NavoriReply {
  code?: number;
  body?: unknown;
  /** Emit a spawn error instead of running (navori not installed). */
  unavailable?: boolean;
}
interface Outcome {
  isError?: boolean;
  content: Array<{ text: string }>;
}
interface Tool {
  execute: (
    id: string,
    params: { role: Role; task: string; feature: string },
    signal: AbortSignal,
    update: () => void,
    ctx: { cwd: string; isProjectTrusted: () => boolean; model: { provider: string; id: string } },
  ) => Promise<Outcome>;
}

const FEATURE = "pi_first";
const HANDOFFS = ".navori/state/handoffs";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function project(scribeOwnsMarkdown = true): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-pi-handoff-"));
  dirs.push(cwd);
  mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
  mkdirSync(join(cwd, HANDOFFS), { recursive: true });
  writeFileSync(
    join(cwd, ".pi/navori.json"),
    serializePiManifest({
      schemaVersion: 2,
      agents: scribeOwnsMarkdown
        ? ["scout", "implementer", "reviewer", "scribe"]
        : ["scout", "implementer", "reviewer"],
      controls: { planTiers: false, masterPlan: false, scribeOwnsMarkdown },
      hooks: [],
      ownedPaths: [],
      permissionRules: { ask: [], deny: [] },
    }),
  );
  for (const role of ["scout", "implementer", "reviewer", "scribe"] as const) {
    writeFileSync(
      join(cwd, `.pi/agents/${role}.md`),
      serializePiAgent({
        name: role,
        description: role,
        instructions: `# ${role}`,
        tools: ["read"],
      }),
    );
  }
  // The reviewer dispatch precondition: an implementer handoff that already exists.
  writeFileSync(
    join(cwd, HANDOFFS, `impl_${FEATURE}.${scribeOwnsMarkdown ? "json" : "md"}`),
    '{"round":0}',
  );
  return cwd;
}

/** Loads the generated extension with a scripted `navori` and a controllable Pi child. */
function load(reply: (args: string[]) => NavoriReply) {
  const navori: string[][] = [];
  const children: Array<{ child: EventEmitter & { stdout: PassThrough } }> = [];
  const spawn = (program: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 7,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(),
    });
    if (program === "navori") {
      navori.push(args);
      const answer = reply(args);
      setImmediate(() => {
        if (answer.unavailable) return child.emit("error", new Error("spawn navori ENOENT"));
        if (answer.body !== undefined) child.stdout.write(JSON.stringify(answer.body));
        child.emit("close", answer.code ?? 0);
      });
    } else children.push({ child });
    return child;
  };
  let tool: Tool | undefined;
  const modules: Record<string, unknown> = {
    "node:child_process": { spawn },
    "node:fs": { existsSync, readFileSync, statSync },
    "node:path": { join },
    "@earendil-works/pi-ai": { Type: new Proxy({}, { get: () => () => ({}) }) },
    "@earendil-works/pi-coding-agent": { VERSION: "1.1.0", defineTool: (value: unknown) => value },
  };
  const exports: Record<string, unknown> = {};
  runInNewContext(
    stripTypeScriptTypes(PI_EXTENSION_SOURCE)
      .replace(/^import \{ (.+) \} from "(.+)";$/gm, 'const { $1 } = require("$2");')
      .replace("export default function", "exports.default = function"),
    {
      exports,
      require: (id: string): unknown => modules[id],
      process: {
        env: {},
        platform: "win32",
        versions: { node: "22.19.0" },
        stderr: { write: () => true },
      },
      Buffer,
      setTimeout,
      clearTimeout,
    },
  );
  (exports.default as (pi: unknown) => void)({
    on: () => () => {},
    exec: async () => ({ code: 0, stdout: "" }),
    registerTool: (value: Tool) => {
      tool = value;
    },
  });
  return { tool: tool!, navori, children };
}

/** Dispatches `role`, lets `during` act while the child runs (it writes the handoff), then ends the child. */
async function run(
  cwd: string,
  rt: ReturnType<typeof load>,
  role: Role,
  during: () => void = () => {},
): Promise<Outcome> {
  const pending = rt.tool.execute(
    "call",
    { role, task: "Do the scoped task", feature: FEATURE },
    new AbortController().signal,
    () => {},
    { cwd, isProjectTrusted: () => true, model: { provider: "p", id: "m" } },
  );
  await vi.waitFor(() => expect(rt.children).toHaveLength(1));
  during();
  const { child } = rt.children[0]!;
  child.stdout.write(
    `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "child said done" }] } })}\n`,
  );
  child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
  child.emit("close", 0);
  return pending;
}

const writeHandoff = (cwd: string, file: string, content = "{}"): void =>
  writeFileSync(join(cwd, HANDOFFS, file), content);
const check = (
  check: Partial<{ status: string; failures: unknown[]; warnings: unknown[] }> = {},
) => ({
  body: { feature: FEATURE, status: "ok", failures: [], warnings: [], ...check },
});

describe("Pi child handoff validation (spec 0048 R7, R15)", () => {
  // Covers: R7
  it("passes a valid fresh implementer handoff and a valid fresh reviewer handoff", async () => {
    const cwd = project();
    const impl = load(() => check());
    const done = await run(cwd, impl, "implementer", () =>
      writeHandoff(cwd, `impl_${FEATURE}.json`, '{"round":1}'),
    );
    expect(done.isError).toBeUndefined();
    expect(done.content[0]!.text).toBe("child said done");
    expect(impl.navori.at(-1)).toEqual(
      expect.arrayContaining(["handoff", "check", FEATURE, "--for", "orchestrator", "--json"]),
    );

    const review = load(() => check());
    const reviewed = await run(cwd, review, "reviewer", () =>
      writeHandoff(cwd, `review_${FEATURE}.json`),
    );
    expect(reviewed.isError).toBeUndefined();
    const args = review.navori.at(-1)!;
    expect(args).toEqual(
      expect.arrayContaining(["handoff", "check", FEATURE, "--produced-by", "reviewer", "--since"]),
    );
    expect(args[args.indexOf("--since") + 1]).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  // Covers: R7
  it("markdown mode (scribeOwnsMarkdown off) validates impl_<feature>.md and rejects a lone .json", async () => {
    const cwd = project(false);
    const md = load(() => check());
    const done = await run(cwd, md, "implementer", () =>
      writeHandoff(cwd, `impl_${FEATURE}.md`, "Status: DONE\n"),
    );
    expect(done.isError).toBeUndefined();
    expect(md.navori.at(-1)).toEqual(expect.arrayContaining(["handoff", "check", FEATURE]));

    rmSync(join(cwd, HANDOFFS, `impl_${FEATURE}.md`));
    const json = await run(
      cwd,
      load(() => check()),
      "implementer",
      () => writeHandoff(cwd, `impl_${FEATURE}.json`, '{"round":1}'),
    );
    expect(json.isError).toBe(true);
    expect(json.content[0]!.text).toContain("was not written");
  });

  // Covers: R7
  it("a manifest that disappears mid-run does not throw from handoff validation and defaults to markdown", async () => {
    const cwd = project(false);
    const outcome = await run(
      cwd,
      load(() => check()),
      "implementer",
      () => {
        rmSync(join(cwd, ".pi/navori.json"));
        writeHandoff(cwd, `impl_${FEATURE}.md`, "Status: DONE\n");
      },
    );
    expect(outcome.isError).toBeUndefined();
    expect(outcome.content[0]!.text).not.toContain("was not written");
  });

  // Covers: R7
  it("stale or invalid handoff fails child", async () => {
    const cwd = project();
    const failed = async (
      role: Role,
      reply: (args: string[]) => NavoriReply,
      during?: () => void,
    ): Promise<string> => {
      const outcome = await run(cwd, load(reply), role, during);
      expect(outcome.isError).toBe(true);
      expect(outcome.content[0]!.text).toContain("child said done");
      return outcome.content[0]!.text;
    };

    // Not written, and written before dispatch but untouched by the child (a previous round's file).
    rmSync(join(cwd, HANDOFFS, `impl_${FEATURE}.json`));
    expect(await failed("implementer", () => check())).toContain("was not written");
    writeHandoff(cwd, `impl_${FEATURE}.json`, '{"round":1}');
    expect(await failed("implementer", () => check())).toContain("is stale");

    const changed = (): void => writeHandoff(cwd, `impl_${FEATURE}.json`, '{"round":2}');
    // Shape failure from the shared validator, and its exit code.
    expect(
      await failed(
        "implementer",
        () => ({
          code: 2,
          ...check({ status: "findings", failures: [{ check: "parse", detail: "bad shape" }] }),
        }),
        changed,
      ),
    ).toContain("bad shape");
    expect(await failed("implementer", () => ({ code: 2, ...check() }), changed)).toContain(
      "did not pass",
    );
    // A moved HEAD is a failure for the implementer (the CLI only warns).
    expect(
      await failed(
        "implementer",
        () => check({ warnings: [{ check: "head", detail: "the checkout has moved" }] }),
        changed,
      ),
    ).toContain("the checkout has moved");
    // Unknown payload.
    expect(await failed("implementer", () => ({ body: { ok: true } }), changed)).toContain(
      "unknown payload",
    );

    // Reviewer: a sidecar left by an earlier round (unchanged) is stale; a sidecar without a review
    // begun after dispatch is rejected by the CLI's reviewer mode and reported as an error.
    writeHandoff(cwd, `review_${FEATURE}.json`, '{"verdict":"APPROVED"}');
    expect(await failed("reviewer", () => check())).toContain("is stale");
    expect(
      await failed(
        "reviewer",
        (args) => {
          // The dispatch precheck (orchestrator mode) passes; only the post-check is the reviewer mode.
          if (!args.includes("--produced-by")) return check();
          expect(args).toContain("--since");
          return {
            code: 2,
            ...check({
              status: "findings",
              failures: [{ check: "fresh", detail: "the review began before this dispatch" }],
            }),
          };
        },
        () => writeHandoff(cwd, `review_${FEATURE}.json`, '{"verdict":"APPROVED","n":2}'),
      ),
    ).toContain("began before this dispatch");
  });

  // Covers: R7, R15
  it("fails closed when the handoff check cannot run", async () => {
    const cwd = project();
    const outcome = await run(
      cwd,
      load((args) => (args.includes("--produced-by") ? { unavailable: true } : check())),
      "reviewer",
      () => writeHandoff(cwd, `review_${FEATURE}.json`),
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content[0]!.text).toContain("handoff validation unavailable");

    // The reviewer's dispatch precheck itself is also fail-closed (unchanged contract).
    const rt = load(() => ({ unavailable: true }));
    await expect(
      rt.tool.execute(
        "call",
        { role: "reviewer", task: "x", feature: FEATURE },
        new AbortController().signal,
        () => {},
        { cwd, isProjectTrusted: () => true, model: { provider: "p", id: "m" } },
      ),
    ).rejects.toThrow(/unavailable/);
  });

  // Covers: R7
  it("declares handoff-shape as enforced on the extension tool", () => {
    expect(ENGINE_CAPABILITIES.pi.controls["handoff-shape"]).toMatchObject({
      state: "enforced",
      evidence: { kind: "extension-tool", tool: "navori_subagent" },
    });
  });
});
