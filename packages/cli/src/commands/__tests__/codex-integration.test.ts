import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { startCodexIntegration } from "../codex-integration.ts";
import { findUnknownConfigKeys } from "../../lib/config/config.ts";
import { runNativeIntegration } from "../../lib/codex/native-integration.ts";

vi.mock(import("../../lib/codex/native-integration.ts"), () => ({ runNativeIntegration: vi.fn() }));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** Minimal real project config; tests never start a browser or native engine. */
function fixture(optIn = false): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-integration-cli-"));
  dirs.push(cwd);
  writeFileSync(
    join(cwd, "navori.config.json"),
    JSON.stringify({
      name: "fixture",
      preset: "custom",
      engines: ["codex"],
      harness: { codexIntegration: optIn },
    }),
  );
  return cwd;
}

/** Simulate only host availability; these fields cannot prove human invocation. */
function hostAvailability(tty: boolean): () => void {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const input = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  if (!platform) throw new Error("missing-platform-descriptor");
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: tty });
  return () => {
    Object.defineProperty(process, "platform", platform);
    if (input) Object.defineProperty(process.stdin, "isTTY", input);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  };
}

describe("Codex integration start", () => {
  // Covers: R6, R7, R16
  it("keeps the registered CLI pending despite caller approval and environment assertions", () => {
    const result = spawnSync(
      "bun",
      [
        resolve("src/index.ts"),
        "codex",
        "integration",
        "start",
        "--cwd",
        fixture(true),
        "--request",
        "b771998e-155d-4213-af16-c3ae36ebc49e",
        "--approved",
        "--source-isolation",
      ],
      {
        encoding: "utf8",
        timeout: 15_000,
        input: JSON.stringify({ approved: true, sourceIsolation: true, actor: "human" }),
        env: { ...process.env, NAVORI_CODEX_APPROVED: "true", NAVORI_ACTOR_ROLE: "human" },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      status: "pending",
      reason: "human-source-isolation-unverified",
      connection: "unstarted",
      events: [],
    });
  });
  // Covers: R6, R7, R16
  it.each([true, false])(
    "keeps unverified source isolation pending with TTY %s",
    async (tty: boolean) => {
      const restore = hostAvailability(tty);
      vi.mocked(runNativeIntegration).mockResolvedValue({
        status: "pending",
        reason: "native-called-without-verified-source",
        connection: "fixture",
        events: [],
      });
      try {
        expect(
          (await startCodexIntegration(fixture(true), "b771998e-155d-4213-af16-c3ae36ebc49e"))
            .reason,
        ).toBe("human-source-isolation-unverified");
        expect(runNativeIntegration).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    },
  );
  // Covers: R6, R16
  it("refuses absent project opt-in without creating a native context", async () => {
    expect(
      (await startCodexIntegration(fixture(), "b771998e-155d-4213-af16-c3ae36ebc49e")).reason,
    ).toBe("project-opt-in-required");
    expect(runNativeIntegration).not.toHaveBeenCalled();
  });
  // Covers: R6, R7
  it("refuses headless callers and forged request IDs even with opt-in", async () => {
    const cwd = fixture(true);
    expect((await startCodexIntegration(cwd, "approved:true")).reason).toBe(
      "invalid-pending-request",
    );
    expect((await startCodexIntegration(cwd, "b771998e-155d-4213-af16-c3ae36ebc49e")).reason).toBe(
      "human-source-isolation-unverified",
    );
    expect(runNativeIntegration).not.toHaveBeenCalled();
  });
  // Covers: R16
  it("recognizes the opt-in flag without a typo diagnostic", () => {
    expect(findUnknownConfigKeys({ harness: { codexIntegration: true } })).toEqual([]);
  });
});
