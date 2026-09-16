import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import {
  BASELINE_REVISION,
  DATABASE_URL_MARKER,
  HIDDEN_MARKER,
  IGNORED_MARKER,
  NEW_FILE_MARKER,
  UPDATED_REVISION,
  writeFixture,
} from "./fixture.mjs";
import { McpTestClient } from "./mcp-client.mjs";

/**
 * search-v2 §8 — runtime tests against the real `tgrep` and `codegraph`
 * binaries. No LLM, no mocks: this is deterministic evidence that the
 * contracts §8.3 (tgrep, T01-T11) and §8.4 (codegraph MCP, G01-G10) describe
 * actually hold for the installed binaries.
 *
 * NOT part of `pnpm check` — requires binaries installed locally (D-note in
 * §8.1). Run explicitly:
 *   node --test --test-concurrency=1 scripts/search-v2/runtime.test.mjs
 */

// ---------------------------------------------------------------------------
// Executable resolution — resolved before any HOME isolation (§8.1).
// Absence of a binary is a precondition failure, not a skipped/green test.
// ---------------------------------------------------------------------------
function resolveBin(name) {
  const result = spawnSync("which", [name], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error(
      `Precondition failed: '${name}' not found on PATH. Install it before running scripts/search-v2/runtime.test.mjs.`,
    );
  }
  return result.stdout.trim();
}

const TGREP_BIN = resolveBin("tgrep");
const CODEGRAPH_BIN = resolveBin("codegraph");

// ---------------------------------------------------------------------------
// Child process registry + cleanup protocol (§8.1): register every spawned
// process; in cleanup, close stdin, SIGTERM, wait up to 3s, SIGKILL only the
// process we own if still alive, then wait for exit. Never pkill/killall,
// never touch a PID we didn't spawn ourselves.
// ---------------------------------------------------------------------------
const liveChildren = new Set();

function registerChild(child) {
  liveChildren.add(child);
  child.once("exit", () => liveChildren.delete(child));
  return child;
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    liveChildren.delete(child);
    return;
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    child.stdin?.end();
  } catch {
    // stdin may already be closed/destroyed
  }
  child.kill("SIGTERM");
  const timedOut = await Promise.race([
    exited.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 3_000)),
  ]);
  if (timedOut) {
    child.kill("SIGKILL");
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
  }
  liveChildren.delete(child);
}

function trackChild(workspace, child) {
  workspace.children.add(child);
  registerChild(child);
  child.once("exit", () => workspace.children.delete(child));
  return child;
}

// ---------------------------------------------------------------------------
// One-shot process runner. A deadline that expires is a failure, not a
// silent success — never a fixed sleep-and-assume.
// ---------------------------------------------------------------------------
function runOnce(bin, args, { cwd, env, timeoutMs = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    registerChild(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `${bin} ${args.join(" ")} exceeded ${timeoutMs}ms deadline.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        ),
      );
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      reject(err);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Deadline polling for freshness/convergence assertions (§8.1: an
// observable condition with a deadline, never a fixed sleep).
// ---------------------------------------------------------------------------
async function pollUntil(
  check,
  { timeoutMs = 15_000, intervalMs = 250, description = "condition" } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await check();
    if (last?.ok) return last;
    if (Date.now() >= deadline) {
      throw new Error(
        `Deadline of ${timeoutMs}ms exceeded waiting for: ${description}. Last observation: ${JSON.stringify(last)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Workspace lifecycle: own temp dir per suite, with home/repo/outside
// subdirectories, isolated HOME/XDG_CONFIG_HOME, and a Git repo for ignore
// semantics (§8.1).
// ---------------------------------------------------------------------------
let workspaceCounter = 0;

async function createWorkspace({ dirName = "repo", fixture = true, fixtureOptions } = {}) {
  workspaceCounter += 1;
  const root = await mkdtemp(join(tmpdir(), `search-v2-${workspaceCounter}-`));
  const home = join(root, "home");
  const repo = join(root, dirName);
  const outside = join(root, "outside");
  await mkdir(home, { recursive: true });
  await mkdir(repo, { recursive: true });
  await mkdir(outside, { recursive: true });

  const gitInit = spawnSync("git", ["init", "-q"], { cwd: repo });
  if (gitInit.status !== 0) {
    throw new Error(`git init failed in ${repo}: ${gitInit.stderr}`);
  }

  const files = fixture ? await writeFixture(repo, fixtureOptions) : {};

  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
  };

  return {
    root,
    home,
    repo,
    outside,
    env,
    files,
    children: new Set(),
    async cleanup() {
      for (const child of [...this.children]) {
        await stopChild(child);
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

function liteWorkspace(repo, env) {
  return { repo, env, children: new Set() };
}

async function codegraphInit(workspace, path = workspace.repo) {
  const result = await runOnce(CODEGRAPH_BIN, ["init", "--yes", path], {
    cwd: path,
    env: { ...workspace.env, CODEGRAPH_TELEMETRY: "0", CODEGRAPH_NO_UPDATE_CHECK: "1" },
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `codegraph init failed (exit ${result.code}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

async function tgrepIndex(workspace, path = workspace.repo) {
  const result = await runOnce(TGREP_BIN, ["index", path], {
    cwd: path,
    env: workspace.env,
    timeoutMs: 120_000,
  });
  if (result.code !== 0) {
    throw new Error(
      `tgrep index failed (exit ${result.code}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}

async function startTgrepServer(workspace, { pollInterval = 1, extraArgs = [] } = {}) {
  const child = spawn(
    TGREP_BIN,
    ["serve", "--poll-interval", String(pollInterval), ...extraArgs, workspace.repo],
    { cwd: workspace.repo, env: workspace.env, shell: false, stdio: ["ignore", "pipe", "pipe"] },
  );
  trackChild(workspace, child);
  let combined = "";
  child.stdout.on("data", (chunk) => {
    combined += chunk;
  });
  child.stderr.on("data", (chunk) => {
    combined += chunk;
  });

  await pollUntil(async () => ({ ok: /serve ready/i.test(combined) }), {
    timeoutMs: 120_000,
    intervalMs: 250,
    description: "tgrep serve ready",
  });

  return {
    child,
    async stop() {
      await stopChild(child);
    },
  };
}

function startCodegraphMcp(
  workspace,
  { path = workspace.repo, extraEnv = {}, extraArgs = [] } = {},
) {
  const env = {
    ...workspace.env,
    CODEGRAPH_NO_DAEMON: "1",
    CODEGRAPH_EXPLORE_DEDUP: "0",
    CODEGRAPH_MCP_TOOLS: "explore",
    CODEGRAPH_TELEMETRY: "0",
    CODEGRAPH_NO_UPDATE_CHECK: "1",
    ...extraEnv,
  };
  const args = ["serve", "--mcp", ...extraArgs];
  if (path) args.push("--path", path);
  const child = spawn(CODEGRAPH_BIN, args, {
    cwd: workspace.repo,
    env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  trackChild(workspace, child);
  const client = new McpTestClient(child, {
    roots: [{ uri: `file://${path ?? workspace.repo}`, name: "repo" }],
  });
  return {
    child,
    client,
    async stop() {
      client.close();
      await stopChild(child);
    },
  };
}

function toolText(response) {
  return (response.result?.content ?? []).map((c) => c.text ?? "").join("\n");
}

// ---------------------------------------------------------------------------
// tgrep — T01-T03, T07-T11
// ---------------------------------------------------------------------------
describe("tgrep — T01-T03, T07-T11 (index lifecycle)", () => {
  let ws;

  before(async () => {
    ws = await createWorkspace({ dirName: "repo" });
  });

  after(async () => {
    await ws.cleanup();
  });

  test("T01 — sin índice, -F DATABASE_URL escanea, no crea índice, exit 0", async () => {
    const res = await runOnce(
      TGREP_BIN,
      ["search", "-F", "-n", "--", DATABASE_URL_MARKER, ws.repo],
      {
        cwd: ws.repo,
        env: ws.env,
      },
    );
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}\n${res.stderr}`);
    assert.match(res.stdout, /config\/app\.json/);
    assert.match(res.stdout, new RegExp(DATABASE_URL_MARKER));
    assert.match(res.stderr, /no index/i, "warning de scan conservado en stderr");
    assert.equal(existsSync(join(ws.repo, ".tgrep")), false, "buscar no debe crear índice");
  });

  test("T02 — índice en disco produce el mismo conjunto de matches que --no-index", async () => {
    await tgrepIndex(ws);
    assert.equal(existsSync(join(ws.repo, ".tgrep")), true);

    const indexed = await runOnce(
      TGREP_BIN,
      ["search", "-F", "-n", "--", DATABASE_URL_MARKER, ws.repo],
      {
        cwd: ws.repo,
        env: ws.env,
      },
    );
    const noIndex = await runOnce(
      TGREP_BIN,
      ["search", "-F", "-n", "--no-index", "--", DATABASE_URL_MARKER, ws.repo],
      { cwd: ws.repo, env: ws.env },
    );
    assert.equal(indexed.code, 0);
    assert.equal(noIndex.code, 0);

    const normalize = (out) =>
      out
        .trim()
        .split("\n")
        .map((line) => line.replace(ws.repo, "<ROOT>"))
        .sort();
    assert.deepEqual(normalize(indexed.stdout), normalize(noIndex.stdout));
  });

  test("T03 — --no-index encuentra un archivo nuevo tras indexar", async () => {
    const newFile = join(ws.repo, "src", "new-file.ts");
    await writeFile(newFile, `export const marker = '${NEW_FILE_MARKER}';\n`, "utf8");
    try {
      const fresh = await runOnce(
        TGREP_BIN,
        ["search", "-F", "-n", "--no-index", "--", NEW_FILE_MARKER, ws.repo],
        { cwd: ws.repo, env: ws.env },
      );
      assert.equal(fresh.code, 0);
      assert.match(fresh.stdout, /new-file\.ts/);
    } finally {
      await rm(newFile, { force: true });
    }
  });

  test("T07 — literales exactos con -F --, incluyendo un patrón que empieza con '-'", async () => {
    for (const literal of ["serve", "a+b[0]", "--literal-v2"]) {
      const res = await runOnce(
        TGREP_BIN,
        ["search", "-F", "-n", "--no-index", "--", literal, ws.repo],
        {
          cwd: ws.repo,
          env: ws.env,
        },
      );
      assert.equal(
        res.code,
        0,
        `literal "${literal}" should match (exit ${res.code}): ${res.stderr}`,
      );
      assert.match(res.stdout, /docs\/notes\.md/);
    }
  });

  test("T08 — regex TODO|FIXME con -l -t ts; -g '*.md' -C 2", async () => {
    const byType = await runOnce(
      TGREP_BIN,
      ["search", "-n", "-l", "-t", "ts", "--", "TODO|FIXME", ws.repo],
      {
        cwd: ws.repo,
        env: ws.env,
      },
    );
    assert.equal(byType.code, 0);
    assert.match(byType.stdout, /session\.ts/);
    assert.doesNotMatch(
      byType.stdout,
      /TODO SEARCH_V2_AUTH/,
      "-l no debe imprimir cuerpos de archivos",
    );

    const byGlob = await runOnce(
      TGREP_BIN,
      ["search", "-n", "-g", "*.md", "-C", "2", "--", "AuthService", ws.repo],
      { cwd: ws.repo, env: ws.env },
    );
    assert.equal(byGlob.code, 0);
    assert.match(byGlob.stdout, /notes\.md/);
    assert.match(byGlob.stdout, /serve/, "el contexto de 2 líneas debe incluir la línea siguiente");
  });

  test("T09 — exit 1 sin matches; exit 2 con regex inválida y stderr no vacío", async () => {
    const noMatch = await runOnce(
      TGREP_BIN,
      ["search", "-F", "-n", "--", "NOPE_NOPE_NOPE_SEARCH_V2", ws.repo],
      { cwd: ws.repo, env: ws.env },
    );
    assert.equal(noMatch.code, 1);

    const badRegex = await runOnce(TGREP_BIN, ["search", "-n", "--", "a[", ws.repo], {
      cwd: ws.repo,
      env: ws.env,
    });
    assert.equal(badRegex.code, 2);
    assert.notEqual(badRegex.stderr.trim(), "");
  });

  test("T10 — hidden/ignored: default los excluye; --hidden revela hidden, no dist ignorado", async () => {
    const defaultRun = await runOnce(
      TGREP_BIN,
      ["search", "-F", "-n", "--", HIDDEN_MARKER, ws.repo],
      {
        cwd: ws.repo,
        env: ws.env,
      },
    );
    assert.equal(defaultRun.code, 1, "sin --hidden, .hidden/ no debe aparecer");

    const hiddenRun = await runOnce(
      TGREP_BIN,
      ["search", "-F", "-n", "--hidden", "--", HIDDEN_MARKER, ws.repo],
      { cwd: ws.repo, env: ws.env },
    );
    assert.equal(hiddenRun.code, 0);
    assert.match(hiddenRun.stdout, /\.hidden\/config\.md/);

    const ignoredWithHidden = await runOnce(
      TGREP_BIN,
      ["search", "-F", "-n", "--hidden", "--", IGNORED_MARKER, ws.repo],
      { cwd: ws.repo, env: ws.env },
    );
    assert.equal(ignoredWithHidden.code, 1, "dist/ está gitignored; --hidden no debe revelarlo");
  });
});

// ---------------------------------------------------------------------------
// tgrep — T04-T06 (one server shared across the three cases, as the table
// chains them: start it in T04, mutate under it in T05, stop it in T06)
// ---------------------------------------------------------------------------
describe("tgrep — T04-T06 (server lifecycle, un solo child server)", () => {
  let ws;
  let server;

  before(async () => {
    ws = await createWorkspace({ dirName: "repo" });
    server = await startTgrepServer(ws);
  });

  after(async () => {
    if (server) await server.stop();
    await ws.cleanup();
  });

  test("T04 — serve sin índice previo construye el índice y responde consultas conocidas", async () => {
    assert.equal(ws.children.size, 1, "sólo un child server propio");
    const res = await runOnce(
      TGREP_BIN,
      ["search", "-F", "-n", "--", DATABASE_URL_MARKER, ws.repo],
      {
        cwd: ws.repo,
        env: ws.env,
      },
    );
    assert.equal(res.code, 0);
    assert.match(res.stdout, /config\/app\.json/);
  });

  test("T05 — con server activo, BASELINE→UPDATED y archivo nuevo convergen dentro del deadline", async () => {
    const sessionPath = join(ws.repo, "src", "session.ts");
    const original = await readFile(sessionPath, "utf8");
    await writeFile(sessionPath, original.replace(BASELINE_REVISION, UPDATED_REVISION), "utf8");
    const createdPath = join(ws.repo, "src", "created.ts");
    await writeFile(createdPath, `export const marker = '${NEW_FILE_MARKER}';\n`, "utf8");

    try {
      await pollUntil(
        async () => {
          const res = await runOnce(
            TGREP_BIN,
            ["search", "-F", "-n", "--", UPDATED_REVISION, ws.repo],
            {
              cwd: ws.repo,
              env: ws.env,
            },
          );
          return { ok: res.code === 0 && /session\.ts/.test(res.stdout), res };
        },
        {
          timeoutMs: 15_000,
          intervalMs: 250,
          description: "server search converges on UPDATED_V2",
        },
      );

      const noIndex = await runOnce(
        TGREP_BIN,
        ["search", "-F", "-n", "--no-index", "--", UPDATED_REVISION, ws.repo],
        { cwd: ws.repo, env: ws.env },
      );
      assert.equal(noIndex.code, 0, "--no-index refleja el cambio de inmediato");

      const noIndexCreated = await runOnce(
        TGREP_BIN,
        ["search", "-F", "-n", "--no-index", "--", NEW_FILE_MARKER, ws.repo],
        { cwd: ws.repo, env: ws.env },
      );
      assert.equal(noIndexCreated.code, 0);
    } finally {
      await rm(createdPath, { force: true });
      await writeFile(sessionPath, original, "utf8");
    }
  });

  test("T06 — al terminar el server propio, --no-index sigue correcto sin bloqueo", async () => {
    await server.stop();
    server = null;

    const sessionPath = join(ws.repo, "src", "session.ts");
    const original = await readFile(sessionPath, "utf8");
    await writeFile(sessionPath, original.replace(BASELINE_REVISION, UPDATED_REVISION), "utf8");
    try {
      const res = await runOnce(
        TGREP_BIN,
        ["search", "-F", "-n", "--no-index", "--", UPDATED_REVISION, ws.repo],
        { cwd: ws.repo, env: ws.env },
      );
      assert.equal(res.code, 0, "no debe bloquear ni fallar tras terminar el server propio");
    } finally {
      await writeFile(sessionPath, original, "utf8");
    }
  });
});

// ---------------------------------------------------------------------------
// tgrep — T11 (ROOT con espacios)
// ---------------------------------------------------------------------------
describe("tgrep — T11 (ROOT con espacios)", () => {
  let root;
  let env;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "search-v2-t11 space-"));
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  });

  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("T11 — ningún error de quoting; mismo conjunto de matches con y sin espacios", async () => {
    const spaced = join(root, "repo with space");
    const plain = join(root, "repo-plain");
    await mkdir(spaced, { recursive: true });
    await mkdir(plain, { recursive: true });
    const marker = "SPACE_ROOT_MARKER_V2";
    await writeFile(join(spaced, "note.md"), `${marker}\n`, "utf8");
    await writeFile(join(plain, "note.md"), `${marker}\n`, "utf8");

    const spacedRes = await runOnce(TGREP_BIN, ["search", "-F", "-n", "--", marker, spaced], {
      cwd: spaced,
      env,
    });
    const plainRes = await runOnce(TGREP_BIN, ["search", "-F", "-n", "--", marker, plain], {
      cwd: plain,
      env,
    });

    assert.equal(spacedRes.code, 0, `spaced path failed: ${spacedRes.stderr}`);
    assert.equal(plainRes.code, 0);

    const relative = (out, base) => out.trim().replace(base, "<ROOT>");
    assert.equal(relative(spacedRes.stdout, spaced), relative(plainRes.stdout, plain));
  });
});

// ---------------------------------------------------------------------------
// codegraph — G01-G04 (single project; G04 also opens a second connection)
// ---------------------------------------------------------------------------
describe("codegraph — G01-G04 (tools/list, explore, impact, dedup=0)", () => {
  let ws;
  let server;

  before(async () => {
    ws = await createWorkspace({ dirName: "repo" });
    await codegraphInit(ws);
    server = startCodegraphMcp(ws);
    await server.client.initialize();
  });

  after(async () => {
    if (server) await server.stop();
    await ws.cleanup();
  });

  test("G01 — tools/list expone únicamente codegraph_explore con query/projectPath", async () => {
    const tools = await server.client.listTools();
    assert.equal(tools.tools.length, 1);
    assert.equal(tools.tools[0].name, "codegraph_explore");
    const props = tools.tools[0].inputSchema.properties;
    assert.ok(props.query);
    assert.ok(props.projectPath);
  });

  test("G02 — explore trae source, líneas y relaciones de handleRequest/createSession/saveSession", async () => {
    const response = await server.client.callTool("codegraph_explore", {
      query: "handleRequest createSession saveSession",
      projectPath: ws.repo,
    });
    assert.equal(
      response.result?.isError,
      undefined,
      JSON.stringify(response.error ?? response.result),
    );
    const text = toolText(response);
    assert.match(text, /handleRequest \(src\/entry\.ts:2\)/);
    assert.match(text, /createSession \(src\/session\.ts:4\)/);
    assert.match(text, /saveSession \(src\/repository\.ts:1\)/);
    assert.match(text, /calls/);
  });

  test("G03 — impacto de createSession incluye handleRequest; no inventa unusedHelper", async () => {
    const response = await server.client.callTool("codegraph_explore", {
      query: "createSession",
      projectPath: ws.repo,
    });
    const text = toolText(response);
    assert.match(text, /handleRequest/);
    assert.doesNotMatch(text, /unusedHelper/);
  });

  test("G04 — dedup=0: source completo en llamadas repetidas, misma conexión y conexión nueva", async () => {
    const first = await server.client.callTool("codegraph_explore", {
      query: "createSession",
      projectPath: ws.repo,
    });
    const second = await server.client.callTool("codegraph_explore", {
      query: "createSession",
      projectPath: ws.repo,
    });
    assert.match(toolText(first), /export function createSession/);
    assert.match(
      toolText(second),
      /export function createSession/,
      "dedup=0: la segunda llamada en la misma conexión no debe omitir el source",
    );

    const otherServer = startCodegraphMcp(ws);
    try {
      await otherServer.client.initialize();
      const third = await otherServer.client.callTool("codegraph_explore", {
        query: "createSession",
        projectPath: ws.repo,
      });
      assert.match(
        toolText(third),
        /export function createSession/,
        "una conexión nueva también recibe el source",
      );
    } finally {
      await otherServer.stop();
    }
  });
});

// ---------------------------------------------------------------------------
// codegraph — G05 (server fuera de proyectos indexados, dos hijos indexados)
// ---------------------------------------------------------------------------
describe("codegraph — G05 (server sin proyecto default, dos hijos indexados)", () => {
  let ws;
  let server;
  let childA;
  let childB;

  before(async () => {
    ws = await createWorkspace({ dirName: "parent", fixture: false });
    childA = join(ws.repo, "child-a");
    childB = join(ws.repo, "child-b");
    await mkdir(join(childA, "src"), { recursive: true });
    await mkdir(join(childB, "src"), { recursive: true });
    await writeFile(
      join(childA, "src", "marker.ts"),
      "export const CHILD_A_MARKER_V2 = 1;\n",
      "utf8",
    );
    await writeFile(
      join(childB, "src", "marker.ts"),
      "export const CHILD_B_MARKER_V2 = 1;\n",
      "utf8",
    );
    await codegraphInit(ws, childA);
    await codegraphInit(ws, childB);
    server = startCodegraphMcp(ws, { path: ws.repo });
    await server.client.initialize();
  });

  after(async () => {
    if (server) await server.stop();
    await ws.cleanup();
  });

  test("G05 — explore sigue visible; projectPath de cada hijo responde desde el hijo correcto, sin default ambiguo", async () => {
    const tools = await server.client.listTools();
    assert.equal(tools.tools[0].name, "codegraph_explore");

    const fromA = await server.client.callTool("codegraph_explore", {
      query: "CHILD_A_MARKER_V2",
      projectPath: childA,
    });
    const textA = toolText(fromA);
    assert.match(textA, /CHILD_A_MARKER_V2/);
    assert.doesNotMatch(textA, /CHILD_B_MARKER_V2/);

    const fromB = await server.client.callTool("codegraph_explore", {
      query: "CHILD_B_MARKER_V2",
      projectPath: childB,
    });
    const textB = toolText(fromB);
    assert.match(textB, /CHILD_B_MARKER_V2/);
    assert.doesNotMatch(textB, /CHILD_A_MARKER_V2/);
  });
});

// ---------------------------------------------------------------------------
// codegraph — G06 (proyecto sin índice)
// ---------------------------------------------------------------------------
describe("codegraph — G06 (proyecto sin índice)", () => {
  let ws;
  let server;

  before(async () => {
    ws = await createWorkspace({ dirName: "repo", fixture: false });
    await mkdir(join(ws.repo, "src"), { recursive: true });
    await writeFile(join(ws.repo, "src", "a.ts"), "export const A = 1;\n", "utf8");
    server = startCodegraphMcp(ws, { path: ws.repo });
    await server.client.initialize();
  });

  after(async () => {
    if (server) await server.stop();
    await ws.cleanup();
  });

  test("G06 — mensaje recuperable/descriptivo, sin init automático; no depende de isError", async () => {
    const response = await server.client.callTool("codegraph_explore", {
      query: "A",
      projectPath: ws.repo,
    });
    const text = toolText(response);
    const errorText = response.error ? JSON.stringify(response.error) : "";
    const combined = `${text}${errorText}`;
    assert.match(
      combined,
      /index|indexed|init/i,
      `expected a descriptive not-indexed message, got: ${combined}`,
    );
    assert.equal(existsSync(join(ws.repo, ".codegraph")), false, "no debe haber init automático");
  });
});

// ---------------------------------------------------------------------------
// codegraph — G07 (watcher activo, converge tras edición)
// ---------------------------------------------------------------------------
describe("codegraph — G07 (watcher activo, converge tras edición)", () => {
  let ws;
  let server;

  before(async () => {
    ws = await createWorkspace({ dirName: "repo" });
    await codegraphInit(ws);
    server = startCodegraphMcp(ws);
    await server.client.initialize();
  });

  after(async () => {
    if (server) await server.stop();
    await ws.cleanup();
  });

  test("G07 — tras editar con watcher activo, converge a source nuevo dentro del deadline", async () => {
    const sessionPath = join(ws.repo, "src", "session.ts");
    const original = await readFile(sessionPath, "utf8");
    await writeFile(sessionPath, original.replace(BASELINE_REVISION, UPDATED_REVISION), "utf8");
    try {
      await pollUntil(
        async () => {
          const response = await server.client.callTool("codegraph_explore", {
            query: "createSession",
            projectPath: ws.repo,
          });
          const text = toolText(response);
          return { ok: text.includes(UPDATED_REVISION), text };
        },
        {
          timeoutMs: 15_000,
          intervalMs: 250,
          description: "codegraph watcher converges on UPDATED_V2",
        },
      );
    } finally {
      await writeFile(sessionPath, original, "utf8");
    }
  });
});

// ---------------------------------------------------------------------------
// codegraph — G08 (--no-watch: stale-or-disabled is acceptable, never a hard error)
// ---------------------------------------------------------------------------
describe("codegraph — G08 (--no-watch)", () => {
  let ws;
  let server;

  before(async () => {
    ws = await createWorkspace({ dirName: "repo" });
    await codegraphInit(ws);
    server = startCodegraphMcp(ws, { extraArgs: ["--no-watch"] });
    await server.client.initialize();
  });

  after(async () => {
    if (server) await server.stop();
    await ws.cleanup();
  });

  test("G08 — con --no-watch, la respuesta es coherente (current o stale), sin sync hook, sin error", async () => {
    const baseline = await server.client.callTool("codegraph_explore", {
      query: "createSession",
      projectPath: ws.repo,
    });
    assert.equal(baseline.result?.isError, undefined);

    const sessionPath = join(ws.repo, "src", "session.ts");
    const original = await readFile(sessionPath, "utf8");
    await writeFile(sessionPath, original.replace(BASELINE_REVISION, UPDATED_REVISION), "utf8");
    try {
      const afterEdit = await server.client.callTool("codegraph_explore", {
        query: "createSession",
        projectPath: ws.repo,
      });
      assert.equal(
        afterEdit.result?.isError,
        undefined,
        "no debe fallar; sirve stale o marca watcher desactivado",
      );
      assert.ok(toolText(afterEdit).length > 0);
    } finally {
      await writeFile(sessionPath, original, "utf8");
    }
  });
});

// ---------------------------------------------------------------------------
// codegraph — G09 (dos checkouts, literal distinto, sin mezclar)
// ---------------------------------------------------------------------------
describe("codegraph — G09 (dos checkouts, literal distinto)", () => {
  let root;
  let checkoutA;
  let checkoutB;
  let serverA;
  let serverB;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), "search-v2-g09-"));
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") };

    checkoutA = liteWorkspace(join(root, "checkout-a"), env);
    checkoutB = liteWorkspace(join(root, "checkout-b"), env);
    await mkdir(join(checkoutA.repo, "src"), { recursive: true });
    await mkdir(join(checkoutB.repo, "src"), { recursive: true });
    await writeFile(
      join(checkoutA.repo, "src", "literal.ts"),
      "export const LITERAL = 'CHECKOUT_A_V2';\n",
      "utf8",
    );
    await writeFile(
      join(checkoutB.repo, "src", "literal.ts"),
      "export const LITERAL = 'CHECKOUT_B_V2';\n",
      "utf8",
    );

    await codegraphInit(checkoutA);
    await codegraphInit(checkoutB);

    serverA = startCodegraphMcp(checkoutA);
    serverB = startCodegraphMcp(checkoutB);
    await serverA.client.initialize();
    await serverB.client.initialize();
  });

  after(async () => {
    if (serverA) await serverA.stop();
    if (serverB) await serverB.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("G09 — projectPath de cada checkout obtiene su propia variante, nunca mezcla source/rangos", async () => {
    const fromA = await serverA.client.callTool("codegraph_explore", {
      query: "LITERAL",
      projectPath: checkoutA.repo,
    });
    const fromB = await serverB.client.callTool("codegraph_explore", {
      query: "LITERAL",
      projectPath: checkoutB.repo,
    });
    const textA = toolText(fromA);
    const textB = toolText(fromB);
    assert.match(textA, /CHECKOUT_A_V2/);
    assert.doesNotMatch(textA, /CHECKOUT_B_V2/);
    assert.match(textB, /CHECKOUT_B_V2/);
    assert.doesNotMatch(textB, /CHECKOUT_A_V2/);
  });
});

// ---------------------------------------------------------------------------
// codegraph — G10: explicitly out of scope for this runtime suite. It
// requires a real Claude Code editor session (§9, "se verifica en §9: si el
// editor requiere Read previo..."), which this task excludes. Recorded here
// as a deliberate skip so it shows as NOT RUN, never as a false PASS.
// ---------------------------------------------------------------------------
test("G10 — source suficiente + operación Edit en Claude real (verificado en §9, fuera de alcance aquí)", {
  skip: "requires the §9 Claude Code real benchmark — out of scope for this runtime-only task",
}, () => {});
