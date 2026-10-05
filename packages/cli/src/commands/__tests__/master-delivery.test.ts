import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runCommand } from "citty";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { masterCommand } from "../master.ts";
import * as delivery from "../../lib/master/delivery.ts";
import { DeliveryStateSchema } from "../../lib/master/delivery-schema.ts";

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

describe("delivery CLI", () => {
  const identity = "a".repeat(64);
  const decisionSchema = DeliveryStateSchema.shape.decisions.unwrap().element;

  /** Adapter-only fixture: validates persisted schema, not human/reviewer attestation. */
  function mockDecisionPersistence(): MockInstance<typeof delivery.decideDelivery> {
    let previous = "";
    return vi
      .spyOn(delivery, "decideDelivery")
      .mockImplementation(
        (_cwd, deliveryId, reviewedIdentity, decision, approvedBy, reason, reference) => {
          const record = decisionSchema.parse({
            kind: "operator-attestation",
            deliveryId,
            reviewedIdentity,
            decision,
            approvedBy,
            ...(reason !== undefined ? { reason } : {}),
            ...(reference !== undefined ? { reference } : {}),
            recordedAt: "2026-10-04T00:00:00.000Z",
          });
          const current = JSON.stringify(record);
          const unchanged = previous === current;
          previous = current;
          return { unchanged };
        },
      );
  }

  it.each(
    (["accepted", "declined", "deferred", "discarded"] as const).flatMap((decision) =>
      [undefined, "client-record-42"].map((reference) => ({ decision, reference })),
    ),
  )(
    "preserves reference $reference for $decision and fixture replay",
    async ({ decision, reference }) => {
      const persistence = mockDecisionPersistence();
      const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      const args = [
        "delivery-decision",
        "--delivery",
        "E1",
        "--identity",
        identity,
        "--decision",
        decision,
        "--approved-by",
        "user",
        ...(reference === undefined ? [] : ["--reference", reference]),
        ...(decision === "accepted" ? [] : ["--reason", "Client fixture reason"]),
      ];
      expect((await invoke(tmpdir(), ...args)).code).toBeUndefined();
      expect(persistence).toHaveBeenLastCalledWith(
        tmpdir(),
        "E1",
        identity,
        decision,
        "user",
        decision === "accepted" ? undefined : "Client fixture reason",
        reference,
      );
      expect(stdout).toHaveBeenLastCalledWith('{"unchanged":false}\n');
      expect((await invoke(tmpdir(), ...args)).code).toBeUndefined();
      expect(stdout).toHaveBeenLastCalledWith('{"unchanged":true}\n');
    },
  );

  it("keeps explicit empty references invalid under the real strict schema", async () => {
    mockDecisionPersistence();
    const result = await invoke(
      tmpdir(),
      "delivery-decision",
      "--delivery",
      "E1",
      "--identity",
      identity,
      "--decision",
      "accepted",
      "--approved-by",
      "user",
      "--reference",
      "",
    );
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/reference/);
  });

  it("does not infer operator consent when approved-by is omitted", async () => {
    const result = await invoke(
      tmpdir(),
      "delivery-decision",
      "--delivery",
      "E1",
      "--identity",
      identity,
      "--decision",
      "accepted",
    );
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/requires --approved-by user/);
  });

  it("does not turn a general implementation request into baseline or queue authority", async () => {
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
    expect((await invoke(cwd, "delivery-baseline")).code).toBe(1);
    expect((await invoke(cwd, "delivery-queue", "--delivery", "E1", "--parts", "P1")).code).toBe(1);
    expect((await invoke(cwd, "delivery-check")).output).toMatch(/no active deliveries stage/);
  });
});
