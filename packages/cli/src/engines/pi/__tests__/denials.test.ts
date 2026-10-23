import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema } from "../../../lib/config/schema.ts";
import { classifyPiExtensionDenial } from "../denials.ts";
import { renderPiEngine } from "../index.ts";
import { load } from "./fixtures/load-extension.ts";

const dirs: string[] = [];
afterEach((): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Block {
  block: boolean;
  reason: string;
}
const content = (text: string): Array<{ type: string; text: string }> => [{ type: "text", text }];

describe("Pi native denial observations", () => {
  // Covers: R3 — render and classify the actual control output, not a duplicate reason table.
  it("shares the catalog with managed-lane, powershell and incompatible manifest decisions", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-pi-denials-"));
    dirs.push(cwd);
    renderPiEngine(
      cwd,
      NavoriConfigSchema.parse({ name: "denials", preset: "custom", engines: ["pi"] }),
    );
    const handler = load().get("tool_call")!;
    const context = { cwd, sessionManager: { getSessionId: (): string => "denials" } };
    const managed = (await handler(
      { toolName: "write", input: { path: ".pi/navori.json", content: "secret" } },
      context,
    )) as Block;
    expect(managed.block).toBe(true);
    expect(classifyPiExtensionDenial("write", true, content(managed.reason))).toBe("managed-lane");
    const powershell = (await handler({ toolName: "powershell", input: {} }, context)) as Block;
    expect(powershell.block).toBe(true);
    expect(classifyPiExtensionDenial("powershell", true, content(powershell.reason))).toBe(
      "powershell",
    );
    writeFileSync(join(cwd, ".pi/navori.json"), "{}");
    for (const toolName of ["bash", "write", "edit"]) {
      const manifest = (await handler({ toolName, input: {} }, context)) as Block;
      expect(manifest.block).toBe(true);
      expect(classifyPiExtensionDenial(toolName, true, content(manifest.reason))).toBe(
        "manifest-skew",
      );
    }
  });

  // Covers: R3 — the runtime block is observed without changing runtime admission.
  it("classifies the restricted runtime's actual output", async () => {
    const handler = load({ version: "0.0.0" }).get("tool_call")!;
    const result = (await handler({ toolName: "write", input: {} }, {})) as Block;
    expect(result.block).toBe(true);
    expect(classifyPiExtensionDenial("write", true, content(result.reason))).toBe(
      "runtime-restricted",
    );
  });

  // Covers: R3 — prose, shared hooks and malformed content never manufacture native denials.
  it.each([
    ["navori_subagent", false, content("Navori plan gate unavailable; subagent blocked")],
    ["bash", true, content("Navori plan gate unavailable; subagent blocked")],
    ["navori_subagent", true, content("quoted: Navori plan gate unavailable; subagent blocked")],
    [
      "navori_subagent",
      true,
      [
        ...content("ordinary failure"),
        ...content("Navori plan gate unavailable; subagent blocked"),
      ],
    ],
    ["bash", true, content("[navori] BLOCKED by guard-destructive: private diagnostic")],
    [
      "navori_subagent",
      true,
      [{ type: "image", text: "Navori plan gate unavailable; subagent blocked" }],
    ],
    ["navori_subagent", true, null],
  ] as const)(
    "ignores unrelated or malformed failure %#",
    (toolName: string, failed: boolean, value: unknown): void => {
      expect(classifyPiExtensionDenial(toolName, failed, value)).toBeUndefined();
    },
  );
});
