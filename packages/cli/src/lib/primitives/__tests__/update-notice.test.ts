import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { runUpdateNotice, runUpdateNoticeWorker } from "../update-notice.ts";

const originalHome = process.env.HOME;
const originalCI = process.env.CI;
const originalArgv = process.argv[1];
const originalOutTTY = process.stdout.isTTY;
const originalErrTTY = process.stderr.isTTY;
const nodeEntry = join(import.meta.dirname, "../../../../dist/index.js");
const bunEntry = join(import.meta.dirname, "../../../index.ts");
let home: string;
let dir: string;
let output: ReturnType<typeof vi.spyOn>;

function put(name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value));
}

function state(name: string): unknown {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
}

function processFixture(runtime: "node" | "bun"): {
  env: NodeJS.ProcessEnv;
  events: string;
} {
  const preload = join(home, "preload.mjs");
  const events = join(home, "events.jsonl");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";
const events = ${JSON.stringify(events)};
const record = (kind) => appendFileSync(events, JSON.stringify({ kind, pid: process.pid, at: Date.now() }) + "\\n");
Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
process.on("exit", () => record(process.argv[2] === "--navori-private-update-worker" ? "worker-exit" : "parent-exit"));
globalThis.fetch = async (_url, options) => {
  record("fetch-start");
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 1200);
    options?.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(options.signal.reason);
    }, { once: true });
  });
  record("fetch-end");
  return new Response(JSON.stringify({ version: "999.0.0" }), {
    headers: { "content-type": "application/json" },
  });
};`,
  );
  const flag = `--import=${pathToFileURL(preload).href}`;
  return {
    events,
    env: {
      ...process.env,
      HOME: home,
      NODE_OPTIONS:
        runtime === "node" ? `${process.env.NODE_OPTIONS ?? ""} ${flag}` : process.env.NODE_OPTIONS,
      BUN_OPTIONS:
        runtime === "bun"
          ? `${process.env.BUN_OPTIONS ?? ""} --preload=${preload}`
          : process.env.BUN_OPTIONS,
    },
  };
}

function invoke(
  runtime: "node" | "bun",
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number | null> {
  return new Promise((done) => {
    const child = spawn(runtime, args, { env, stdio: "ignore" });
    child.once("exit", (code) => done(code));
    child.once("error", () => done(-1));
  });
}

function processEvents(path: string): { kind: string; pid: number; at: number }[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string; pid: number; at: number });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "navori-notice-"));
  dir = join(home, ".navori", "update-notice");
  process.env.HOME = home;
  delete process.env.CI;
  delete process.env.NAVORI_NO_UPDATE_NOTIFIER;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: true });
  output = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  output.mockRestore();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalCI === undefined) delete process.env.CI;
  else process.env.CI = originalCI;
  delete process.env.NAVORI_NO_UPDATE_NOTIFIER;
  process.argv[1] = originalArgv!;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalOutTTY });
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: originalErrTTY });
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("daily update notice", () => {
  it("performs no optional I/O for CI, opt-out, JSON and non-interactive output", () => {
    process.env.CI = "1";
    runUpdateNotice("0.1.0", ["status"]);
    delete process.env.CI;
    process.env.NAVORI_NO_UPDATE_NOTIFIER = "1";
    runUpdateNotice("0.1.0", ["status"]);
    delete process.env.NAVORI_NO_UPDATE_NOTIFIER;
    runUpdateNotice("0.1.0", ["status", "--json"]);
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    runUpdateNotice("0.1.0", ["status"]);
    expect(() => readFileSync(join(dir, "attempt.json"))).toThrow();
    expect(output).not.toHaveBeenCalled();
  });

  it("prints a fresh newer cache once and reserves a single daily attempt", () => {
    const now = Date.now();
    put("latest.json", { at: now, version: "0.2.0" });
    put("attempt.json", { at: now, token: null });
    runUpdateNotice("0.1.0", ["status"]);
    runUpdateNotice("0.1.0", ["status"]);
    expect(output).toHaveBeenCalledTimes(1);
    expect(String(output.mock.calls[0]?.[0])).toContain("0.2.0");
    expect(state("notice.json")).toMatchObject({ at: expect.any(Number) });
  });

  it("uses the explicit target locale and safe npx recommendation", () => {
    const target = join(home, "project");
    mkdirSync(target);
    writeFileSync(join(target, "navori.config.json"), JSON.stringify({ language: "en" }));
    put("latest.json", { at: Date.now(), version: "0.2.0" });
    put("attempt.json", { at: Date.now(), token: null });
    process.env.npm_command = "exec";
    try {
      runUpdateNotice("0.1.0", ["status", "--cwd", target]);
      const text = String(output.mock.calls[0]?.[0]);
      expect(text).toContain("npx navori@latest <command>");
      expect(text).toContain("/en/releases/");
      expect(text).toContain("navori render --apply");
    } finally {
      delete process.env.npm_command;
    }
  });

  it("does not announce an equal, older, expired or malformed release", () => {
    put("attempt.json", { at: Date.now(), token: null });
    for (const version of ["0.1.0", "0.0.9", "0.2.0-beta.1", "999999999999999999999.0.0"]) {
      put("latest.json", { at: Date.now(), version });
      runUpdateNotice("0.1.0", ["status"]);
    }
    put("latest.json", { at: Date.now() - 86_400_000, version: "0.2.0" });
    runUpdateNotice("0.1.0", ["status"]);
    expect(output).not.toHaveBeenCalled();
  });

  it("uses a rolling 24-hour notice window under a fake clock", () => {
    vi.useFakeTimers();
    try {
      const start = 1_800_000_000_000;
      vi.setSystemTime(start);
      put("latest.json", { at: start, version: "0.2.0" });
      put("attempt.json", { at: start, token: null });
      runUpdateNotice("0.1.0", ["status"]);
      vi.setSystemTime(start + 86_400_000 - 1);
      put("latest.json", { at: Date.now(), version: "0.2.0" });
      runUpdateNotice("0.1.0", ["status"]);
      expect(output).toHaveBeenCalledTimes(1);
      vi.setSystemTime(start + 86_400_000);
      put("attempt.json", { at: Date.now(), token: null });
      runUpdateNotice("0.1.0", ["status"]);
      expect(output).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed on a future stamp and orphan lock", () => {
    put("latest.json", { at: Date.now(), version: "0.2.0" });
    put("notice.json", { at: Date.now() + 1_000 });
    put("attempt.json", { at: Date.now() + 1_000, token: null });
    runUpdateNotice("0.1.0", ["status"]);
    expect(output).not.toHaveBeenCalled();
    mkdirSync(join(dir, "lock"));
    runUpdateNotice("0.1.0", ["status"]);
    expect(output).not.toHaveBeenCalled();
  });

  it("recovers an orphan lock older than a minute on the following run", () => {
    put("latest.json", { at: Date.now(), version: "0.2.0" });
    mkdirSync(join(dir, "lock"));
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(join(dir, "lock"), old, old);
    runUpdateNotice("0.1.0", ["status"]);
    expect(output).not.toHaveBeenCalled();
    runUpdateNotice("0.1.0", ["status"]);
    expect(String(output.mock.calls[0]?.[0])).toContain("0.2.0");
  });

  it("consumes a duplicate worker token before the only registry request", async () => {
    const token = "00000000-0000-4000-8000-000000000000";
    put("attempt.json", { at: Date.now(), token });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ version: "0.2.0" })));
    await Promise.all([runUpdateNoticeWorker(token), runUpdateNoticeWorker(token)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state("latest.json")).toMatchObject({ version: "0.2.0" });
    await runUpdateNoticeWorker(token);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the previous cache when the registry is offline", async () => {
    const token = "00000000-0000-4000-8000-000000000000";
    put("attempt.json", { at: Date.now(), token });
    put("latest.json", { at: Date.now(), version: "0.2.0" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await runUpdateNoticeWorker(token);
    expect(state("latest.json")).toMatchObject({ version: "0.2.0" });
  });

  it("bounds a stalled response body with the same two-second deadline", async () => {
    const token = "00000000-0000-4000-8000-000000000000";
    put("attempt.json", { at: Date.now(), token });
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      signal = options?.signal ?? undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => controller.error(new Error("deadline")), {
              once: true,
            });
          },
        }),
      );
    });
    await runUpdateNoticeWorker(token);
    expect(signal?.aborted).toBe(true);
    expect(() => state("latest.json")).toThrow();
  });

  it("rejects direct private worker calls without persisted authorization", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await runUpdateNoticeWorker("00000000-0000-4000-8000-000000000000");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exits promptly in real Node and Bun private modes without an authorization", () => {
    const entries = [
      ["node", join(import.meta.dirname, "../../../../dist/index.js")],
      ["bun", join(import.meta.dirname, "../../../index.ts")],
    ] as const;
    for (const [runtime, entry] of entries) {
      const result = spawnSync(runtime, [entry, "--navori-private-update-worker", "invalid"], {
        env: { ...process.env, HOME: home },
        timeout: 5_000,
        encoding: "utf8",
      });
      expect(result.status, `${runtime}: ${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  for (const [runtime, entry] of [
    ["node", nodeEntry],
    ["bun", bunEntry],
  ] as const) {
    it(`${runtime} parent launches its actual detached worker and exits before fetch completes`, async () => {
      const { env, events } = processFixture(runtime);
      await invoke(runtime, [entry, "status", "--cwd", home], env);
      await vi.waitFor(() => expect(state("latest.json")).toMatchObject({ version: "999.0.0" }), {
        timeout: 8_000,
        interval: 100,
      });
      const recorded = processEvents(events);
      expect(recorded.filter((event) => event.kind === "fetch-start")).toHaveLength(1);
      expect(recorded.filter((event) => event.kind === "fetch-end")).toHaveLength(1);
      expect(recorded.find((event) => event.kind === "parent-exit")?.at).toBeLessThan(
        recorded.find((event) => event.kind === "fetch-end")!.at,
      );
      expect(state("attempt.json")).toMatchObject({ token: null });
    }, 15_000);

    it(`${runtime} consumes one token across two real private-worker processes`, async () => {
      const token = "00000000-0000-4000-8000-000000000000";
      put("attempt.json", { at: Date.now(), token });
      const { env, events } = processFixture(runtime);
      expect(
        await Promise.all([
          invoke(runtime, [entry, "--navori-private-update-worker", token], env),
          invoke(runtime, [entry, "--navori-private-update-worker", token], env),
        ]),
      ).toEqual([0, 0]);
      expect(processEvents(events).filter((event) => event.kind === "fetch-start")).toHaveLength(1);
      expect(state("latest.json")).toMatchObject({ version: "999.0.0" });
      expect(state("attempt.json")).toMatchObject({ token: null });
    }, 15_000);
  }
});
