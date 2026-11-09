import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "citty";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { masterCommand } from "../master.ts";
import * as delivery from "../../lib/master/delivery.ts";
import * as part from "../../lib/master/part.ts";
import * as slice from "../../lib/master/slice.ts";

/**
 * Spec 0063 T6: the v1 delivery flow is read-only. Every delivery-* writer is refused before it
 * reaches the library, and `delivery-check` keeps reading.
 */

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function invoke(
  cwd: string,
  ...args: string[]
): Promise<{ code: number | undefined; output: string }> {
  const oldCode = process.exitCode;
  const oldErr = process.stderr.write;
  let output = "";
  process.exitCode = undefined;
  process.stderr.write = ((chunk: string) => {
    output += chunk;
    return true;
  }) as typeof process.stderr.write;
  try {
    await runCommand(masterCommand, { rawArgs: [...args, "--cwd", cwd] });
    return { code: process.exitCode, output };
  } finally {
    process.exitCode = oldCode;
    process.stderr.write = oldErr;
  }
}

describe("delivery CLI is read-only", () => {
  const identity = "a".repeat(64);

  it.each([
    ["delivery-slice", "--part", "P1", "--refresh", "--approved-by", "user"],
    ["delivery-baseline", "--approved-by", "user"],
    ["delivery-queue", "--delivery", "E1", "--parts", "P1", "--approved-by", "user"],
    ["delivery-revoke", "--approved-by", "user"],
    ["delivery-criterion", "--part", "P1", "--criterion", "A1", "--approved-by", "user"],
    ["delivery-review", "--part", "P1", "--report", "r.txt", "--envelope", "e.json"],
    ["delivery-present", "--delivery", "E1"],
    ["delivery-decision", "--delivery", "E1", "--identity", identity, "--decision", "accepted"],
    ["delivery-publication", "--delivery", "E1", "--identity", identity, "--kind", "release"],
  ])("refuses %s before it reaches the library", async (...args: string[]) => {
    const spies = [
      vi.spyOn(delivery, "approveDeliveryBaseline"),
      vi.spyOn(delivery, "authorizeDeliveryQueue"),
      vi.spyOn(delivery, "revokeDeliveryQueue"),
      vi.spyOn(delivery, "presentDelivery"),
      vi.spyOn(delivery, "decideDelivery"),
      vi.spyOn(delivery, "publishDelivery"),
      vi.spyOn(part, "recordDeliveryCriterion"),
      vi.spyOn(part, "captureDeliveryReview"),
      vi.spyOn(slice, "prepareDeliverySlice"),
    ];
    const result = await invoke(tmpdir(), ...args);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`navori master ${args[0]}`);
    expect(result.output).toContain("navori master migrate");
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("keeps delivery-check read-only and working", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "navori-d2-cli-"));
    dirs.push(cwd);
    writeFileSync(
      join(cwd, "navori.config.json"),
      JSON.stringify({
        name: "demo",
        engines: ["claude"],
        preset: "custom",
        sdd: { enabled: true },
      }),
    );
    expect((await invoke(cwd, "delivery-check")).output).toMatch(/no active deliveries stage/);
  });
});
