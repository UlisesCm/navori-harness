import { describe, expect, it } from "vitest";
import { DeliveryPartsSchema, DeliveryStateSchema } from "../delivery-schema.ts";

describe("deliveries v2 strict contracts", () => {
  it("rejects unknown state and parts fields without falling back to v1", () => {
    expect(DeliveryPartsSchema.safeParse({ version: 1, workflow: "deliveries" }).success).toBe(
      false,
    );
    expect(
      DeliveryStateSchema.safeParse({ version: 2, workflow: "unknown", phase: "context" }).success,
    ).toBe(false);
    expect(
      DeliveryStateSchema.safeParse({
        version: 2,
        workflow: "deliveries",
        phase: "execution",
        mode: null,
        signal: {},
        history: [],
        accepted: true,
      }).success,
    ).toBe(false);
  });
});
