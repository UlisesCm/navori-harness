import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { runCommand } from "citty";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { masterCommand } from "../master.ts";
import * as delivery from "../../lib/master/delivery.ts";
import * as part from "../../lib/master/part.ts";
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

  describe("operator mutation adapters", () => {
    const quietStdout = (): MockInstance<typeof process.stdout.write> =>
      vi.spyOn(process.stdout, "write").mockReturnValue(true);

    it("passes delivery-revoke consent through and refuses it when omitted", async () => {
      const revoke = vi.spyOn(delivery, "revokeDeliveryQueue").mockReturnValue({ generation: 3 });
      const stdout = quietStdout();
      expect(
        (await invoke(tmpdir(), "delivery-revoke", "--approved-by", "user")).code,
      ).toBeUndefined();
      expect(revoke).toHaveBeenLastCalledWith(tmpdir(), "user");
      expect(stdout).toHaveBeenLastCalledWith('{"generation":3}\n');
      vi.restoreAllMocks();
      const refused = await invoke(tmpdir(), "delivery-revoke");
      expect(refused.code).toBe(1);
      expect(refused.output).toMatch(/requires --approved-by user/);
    });

    it("passes delivery-review artifacts and consent to the technical capture", async () => {
      const capture = vi
        .spyOn(part, "captureDeliveryReview")
        .mockReturnValue({ identity, unchanged: false });
      const stdout = quietStdout();
      const args = ["delivery-review", "--part", "P1", "--report", "r.txt", "--envelope", "e.json"];
      expect((await invoke(tmpdir(), ...args, "--approved-by", "user")).code).toBeUndefined();
      expect(capture).toHaveBeenLastCalledWith(tmpdir(), "P1", "r.txt", "e.json", "user");
      expect(stdout).toHaveBeenLastCalledWith(`{"identity":"${identity}","unchanged":false}\n`);
      vi.restoreAllMocks();
      const refused = await invoke(tmpdir(), ...args);
      expect(refused.code).toBe(1);
      expect(refused.output).toMatch(/requires --approved-by user/);
    });

    it("passes delivery-present the delivery id only", async () => {
      const present = vi
        .spyOn(delivery, "presentDelivery")
        .mockReturnValue({ identity, unchanged: false });
      const stdout = quietStdout();
      expect((await invoke(tmpdir(), "delivery-present", "--delivery", "E1")).code).toBeUndefined();
      expect(present).toHaveBeenLastCalledWith(tmpdir(), "E1");
      expect(stdout).toHaveBeenLastCalledWith(`{"identity":"${identity}","unchanged":false}\n`);
    });

    it("passes delivery-criterion approval only when the operator supplies it", async () => {
      const record = vi
        .spyOn(part, "recordDeliveryCriterion")
        .mockReturnValue({ unchanged: false });
      quietStdout();
      const args = ["delivery-criterion", "--part", "P1", "--criterion", "A1"];
      expect((await invoke(tmpdir(), ...args)).code).toBeUndefined();
      expect(record).toHaveBeenLastCalledWith(tmpdir(), "P1", "A1", undefined);
      expect((await invoke(tmpdir(), ...args, "--approved-by", "user")).code).toBeUndefined();
      expect(record).toHaveBeenLastCalledWith(tmpdir(), "P1", "A1", "user");
    });

    it("passes delivery-publication its attested reference and rejects a merge kind", async () => {
      const publish = vi.spyOn(delivery, "publishDelivery").mockReturnValue({ unchanged: false });
      const stdout = quietStdout();
      const args = ["delivery-publication", "--delivery", "E1", "--identity", identity];
      const approved = ["--reference", "v1.2.0", "--approved-by", "user"];
      expect(
        (await invoke(tmpdir(), ...args, "--kind", "deploy", ...approved)).code,
      ).toBeUndefined();
      expect(publish).toHaveBeenLastCalledWith(
        tmpdir(),
        "E1",
        identity,
        "deploy",
        "v1.2.0",
        "user",
      );
      expect(stdout).toHaveBeenLastCalledWith('{"unchanged":false}\n');
      publish.mockClear();
      const merge = await invoke(tmpdir(), ...args, "--kind", "merge", ...approved);
      expect(merge.code).toBe(1);
      expect(merge.output).toMatch(/publication kind must be release or deploy/);
      expect(publish).not.toHaveBeenCalled();
    });

    it("rejects an unknown delivery-queue transition before any authorization", async () => {
      const authorize = vi
        .spyOn(delivery, "authorizeDeliveryQueue")
        .mockReturnValue({ identity, unchanged: false });
      quietStdout();
      const args = [
        "delivery-queue",
        "--delivery",
        "E1",
        "--parts",
        "P1,P2",
        "--approved-by",
        "user",
      ];
      const invalid = await invoke(tmpdir(), ...args, "--transition", "swap");
      expect(invalid.code).toBe(1);
      expect(invalid.output).toMatch(/invalid authority transition/);
      expect(authorize).not.toHaveBeenCalled();
      expect(
        (await invoke(tmpdir(), ...args, "--transition", "continuation")).code,
      ).toBeUndefined();
      expect(authorize).toHaveBeenLastCalledWith(
        tmpdir(),
        "E1",
        ["P1", "P2"],
        "user",
        "continuation",
      );
    });
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
