import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUpdateNotice, runUpdateNoticeWorker } from "../update-notice.ts";

// Characterization of the generic cache behaviour, observed through the only consumer today.
const TOKEN = "00000000-0000-4000-8000-000000000000";
const originalHome = process.env.HOME;
const originalOutTTY = process.stdout.isTTY;
const originalErrTTY = process.stderr.isTTY;
let home: string;
let dir: string;
let output: ReturnType<typeof vi.spyOn>;

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
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalOutTTY });
  Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: originalErrTTY });
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
