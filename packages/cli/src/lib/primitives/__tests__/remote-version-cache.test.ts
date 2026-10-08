import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { locked, readBoundedJson, stableVersion } from "../remote-version-cache.ts";
import { runUpdateNotice, runUpdateNoticeWorker } from "../update-notice.ts";

// Characterization of the generic cache behaviour, observed through the only consumer today.
const TOKEN = "00000000-0000-4000-8000-000000000000";
const originalTTY = [process.stdout.isTTY, process.stderr.isTTY];
let home: string;
let dir: string;
let output: ReturnType<typeof vi.spyOn>;

function tty(values: (boolean | undefined)[]): void {
  [process.stdout, process.stderr].forEach((stream, i) =>
    Object.defineProperty(stream, "isTTY", { configurable: true, value: values[i] }),
  );
}

function put(name: string, value: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), typeof value === "string" ? value : JSON.stringify(value));
}

function state(name: string): unknown {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "navori-cache-"));
  dir = join(home, ".navori", "update-notice");
  vi.stubEnv("HOME", home);
  vi.stubEnv("CI", "");
  vi.stubEnv("NAVORI_NO_UPDATE_NOTIFIER", "");
  tty([true, true]);
  output = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  tty(originalTTY);
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("remote version cache (characterization)", () => {
  it("reserves a single token per day", () => {
    runUpdateNotice("0.1.0", ["status"]);
    const first = state("attempt.json") as { token: string };
    expect(first.token).toMatch(/^[0-9a-f-]{36}$/);
    runUpdateNotice("0.1.0", ["status"]);
    expect(state("attempt.json")).toEqual(first);
  });

  it("consumes the token before fetching", async () => {
    put("attempt.json", { at: Date.now(), token: TOKEN });
    let tokenAtFetch: unknown = "unset";
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      tokenAtFetch = (state("attempt.json") as { token: unknown }).token;
      return new Response(JSON.stringify({ version: "0.2.0" }));
    });
    await runUpdateNoticeWorker(TOKEN);
    expect(tokenAtFetch).toBeNull();
  });

  it("ignores state files over 16 KB and invalid JSON", () => {
    put("attempt.json", { at: Date.now(), token: null });
    put(
      "latest.json",
      JSON.stringify({ at: Date.now(), version: "0.2.0", pad: "x".repeat(17_000) }),
    );
    runUpdateNotice("0.1.0", ["status"]);
    put("latest.json", "{not json");
    runUpdateNotice("0.1.0", ["status"]);
    expect(output).not.toHaveBeenCalled();
  });

  it("rejects a future stamp", () => {
    put("attempt.json", { at: Date.now(), token: null });
    put("latest.json", { at: Date.now() + 60_000, version: "0.2.0" });
    runUpdateNotice("0.1.0", ["status"]);
    expect(output).not.toHaveBeenCalled();
  });

  it("discards a remote body over 16 KB", async () => {
    put("attempt.json", { at: Date.now(), token: TOKEN });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ version: "0.2.0", pad: "x".repeat(17_000) })),
    );
    await runUpdateNoticeWorker(TOKEN);
    expect(() => state("latest.json")).toThrow();
  });

  it("fails closed on a fresh lock", () => {
    put("latest.json", { at: Date.now(), version: "0.2.0" });
    mkdirSync(join(dir, "lock"));
    runUpdateNotice("0.1.0", ["status"]);
    expect(output).not.toHaveBeenCalled();
    expect(() => state("attempt.json")).toThrow();
  });
});

describe("remote-version-cache core", () => {
  it("recovers a stale lock on the next call and keeps a fresh or future one closed", () => {
    const lock = join(dir, "lock");
    mkdirSync(lock, { recursive: true });
    expect(locked(dir, () => 1)).toBeUndefined();
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(lock, old, old);
    expect(locked(dir, () => 1)).toBeUndefined();
    expect(locked(dir, () => 2)).toBe(2);
    mkdirSync(lock);
    const future = (Date.now() + 600_000) / 1000;
    utimesSync(lock, future, future);
    expect(locked(dir, () => 3)).toBeUndefined();
    expect(locked(dir, () => 3)).toBeUndefined();
  });

  it("takes the body limit as a parameter", async () => {
    const body = JSON.stringify({ pad: "x".repeat(20_000) });
    expect(await readBoundedJson(new Response(body), 16 * 1024)).toBeUndefined();
    expect(await readBoundedJson(new Response(body), 64 * 1024)).toMatchObject({
      pad: expect.any(String),
    });
    expect(await readBoundedJson(new Response("x", { status: 500 }), 1024)).toBeUndefined();
  });

  it("accepts only strict x.y.z", () => {
    expect(["1.2.3", "0.0.0"].every(stableVersion)).toBe(true);
    expect(["01.2.3", "1.2", "1.2.3-rc.1", "v1.2.3", 3].some(stableVersion)).toBe(false);
  });
});
