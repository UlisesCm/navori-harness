import { it } from "vitest";

const target = "./missing-module.ts";
await import(target);
// Covers: R27
it("never runs", () => {});
