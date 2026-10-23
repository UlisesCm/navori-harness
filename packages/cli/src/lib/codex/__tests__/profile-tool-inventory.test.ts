import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readProfileToolInventory,
  summarizeProfileRequestTools,
} from "../profile-tool-inventory.ts";

let root: string;
const secret = "PRIVATE_PROMPT_AND_UNKNOWN_TOOL_NAME";
beforeEach((): void => {
  root = mkdtempSync(join(tmpdir(), "navori-tools-inventory-"));
});
afterEach((): void => {
  rmSync(root, { recursive: true, force: true });
});

function trace(request: unknown, overrides: Record<string, unknown> = {}): string {
  const bundle = join(root, "bundle");
  mkdirSync(bundle, { recursive: true });
  writeFileSync(join(bundle, "request.json"), JSON.stringify(request));
  writeFileSync(
    join(bundle, "trace.jsonl"),
    JSON.stringify({
      payload: {
        type: "inference_started",
        thread_id: "parent",
        codex_turn_id: "turn",
        inference_call_id: "inference",
        request_payload: { kind: { type: "inference_request" }, path: "request.json" },
        ...overrides,
      },
    }) + "\n",
  );
  return bundle;
}

describe("private native request tool inventories", (): void => {
  // Covers: R12, R14, R16
  it("classifies tool failures and spawn argument shapes without retaining arguments or output", (): void => {
    const result = summarizeProfileRequestTools(
      {
        input: [
          {
            type: "function_call",
            name: "spawn_agent",
            arguments: JSON.stringify({
              task_name: secret,
              agent_type: secret,
              message: secret,
              fork_context: true,
            }),
          },
          {
            type: "function_call_output",
            output: `Error: fork_context is not supported in MultiAgentV2; ${secret}`,
          },
          {
            type: "function_call_output",
            output: [{ text: `Unknown model ${secret} for spawn_agent` }],
          },
          { type: "message", content: `Error: ${secret}` },
        ],
      },
      1,
    );
    expect(result.toolResults).toEqual(["unsupported-fork-context", "unsupported-spawn-model"]);
    expect(result.errorTerms).toContain("fork_context");
    expect(result.spawnInputs).toEqual([
      {
        forkTurns: "omitted",
        forkContext: true,
        role: true,
        taskName: true,
        model: false,
        effort: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  // Covers: R12, R14, R16
  it("distinguishes missing inventory from an explicitly empty inventory", (): void => {
    expect(summarizeProfileRequestTools({ input: secret }, 1)).toMatchObject({
      source: "missing",
      spawnAgent: "unverified",
    });
    expect(summarizeProfileRequestTools({ tools: [] }, 1)).toMatchObject({
      source: "direct",
      spawnAgent: "absent",
    });
  });
  // Covers: R12, R14, R16
  it("reads Responses Lite namespaces and combines them with direct tools without leaking text", (): void => {
    const result = summarizeProfileRequestTools(
      {
        response: {
          tools: [{ name: "exec" }, { name: secret }],
          input: [
            { text: secret },
            {
              type: "additional_tools",
              tools: [
                {
                  type: "namespace",
                  name: "collaboration",
                  tools: [
                    { name: "spawn_agent", description: secret, parameters: { private: secret } },
                    { name: "wait_agent" },
                  ],
                },
              ],
            },
          ],
        },
      },
      2,
    );
    expect(result).toEqual({
      turn: 2,
      source: "both",
      knownTools: ["collaboration.spawn_agent", "collaboration.wait_agent", "exec"],
      unknownTools: 1,
      spawnAgent: "present",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  // Covers: R12, R14, R16
  it("supports direct function wrappers and additional-only inventories", (): void => {
    expect(
      summarizeProfileRequestTools(
        { tools: [{ function: { name: "multi_agent_v1.spawn_agent" } }] },
        1,
      ).spawnAgent,
    ).toBe("present");
    expect(
      summarizeProfileRequestTools({ input: [{ type: "additional_tools", tools: [] }] }, 1),
    ).toMatchObject({ source: "additional", spawnAgent: "absent" });
  });
  // Covers: R14, R16, R18
  it.each([
    { tools: "not-an-array" },
    { tools: [null] },
    { tools: [{ type: "namespace", name: secret, tools: [{ name: "spawn_agent" }] }] },
    { tools: [], input: [{ type: "additional_tools", tools: null }] },
    { tools: [{ type: "unknown" }] },
  ])("keeps malformed or opaque inventories unverified: %j", (request: unknown): void => {
    const result = summarizeProfileRequestTools(request, 1);
    expect(result.spawnAgent).toBe("unverified");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  // Covers: R12, R14, R16
  it("joins the exact principal and observed turn, retaining only a redacted summary", (): void => {
    trace({
      input: [
        { text: secret },
        { type: "additional_tools", tools: [{ name: "collaboration.spawn_agent" }] },
      ],
    });
    expect(readProfileToolInventory(root, "parent", ["turn"])).toEqual({
      status: "captured",
      requests: [
        {
          turn: 1,
          source: "additional",
          knownTools: ["collaboration.spawn_agent"],
          unknownTools: 0,
          spawnAgent: "present",
        },
      ],
    });
    expect(readProfileToolInventory(root, "foreign", ["turn"])).toEqual({
      status: "unavailable",
      reason: "missing",
    });
    expect(readProfileToolInventory(root, "parent", ["foreign"])).toEqual({
      status: "unavailable",
      reason: "missing",
    });
  });
  // Covers: R12, R14, R16
  it("joins completed model output to its owned inference call and redacts spawn arguments", (): void => {
    const bundle = trace({ tools: [] });
    const start = JSON.stringify({
      payload: {
        type: "inference_started",
        thread_id: "parent",
        codex_turn_id: "turn",
        inference_call_id: "inference",
        request_payload: { kind: { type: "inference_request" }, path: "request.json" },
      },
    });
    const completed = JSON.stringify({
      payload: {
        type: "inference_completed",
        inference_call_id: "inference",
        response_payload: { kind: { type: "inference_response" }, path: "response.json" },
      },
    });
    writeFileSync(
      join(bundle, "response.json"),
      JSON.stringify({
        output_items: [
          {
            type: "function_call",
            name: "spawn_agent",
            arguments: JSON.stringify({ fork_turns: "all", message: secret, agent_type: secret }),
          },
        ],
      }),
    );
    writeFileSync(join(bundle, "trace.jsonl"), start + "\n" + completed + "\n");
    const result = readProfileToolInventory(root, "parent", ["turn"]);
    expect(result).toMatchObject({
      status: "captured",
      requests: [{ responseSpawnInputs: [{ forkTurns: "all", role: true, model: false }] }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  // Covers: R14, R16, R18
  it("rejects paths escaping the private trace root and symlink payloads", (): void => {
    const bundle = trace(
      {},
      { request_payload: { kind: { type: "inference_request" }, path: "../../outside" } },
    );
    expect(readProfileToolInventory(root, "parent", ["turn"])).toMatchObject({
      status: "unavailable",
      reason: "invalid",
    });
    writeFileSync(join(root, "outside.json"), "{}");
    trace({}, { request_payload: { kind: { type: "inference_request" }, path: "link.json" } });
    symlinkSync(join(root, "outside.json"), join(bundle, "link.json"));
    expect(readProfileToolInventory(root, "parent", ["turn"])).toMatchObject({
      status: "unavailable",
      reason: "invalid",
    });
  });
  // Covers: R14, R16, R18
  it("rejects oversized payloads and duplicate attempts without returning partial inventories", (): void => {
    const bundle = trace({ text: "x".repeat(2 * 1024 * 1024) });
    expect(readProfileToolInventory(root, "parent", ["turn"])).toMatchObject({
      status: "unavailable",
      reason: "budget-exceeded",
    });
    trace({ tools: [] });
    const event = JSON.stringify({
      payload: {
        type: "inference_started",
        thread_id: "parent",
        codex_turn_id: "turn",
        inference_call_id: "same",
        request_payload: { kind: { type: "inference_request" }, path: "request.json" },
      },
    });
    writeFileSync(join(bundle, "trace.jsonl"), event + "\n" + event + "\n");
    expect(readProfileToolInventory(root, "parent", ["turn"])).toMatchObject({
      status: "unavailable",
      reason: "invalid",
    });
  });
});
