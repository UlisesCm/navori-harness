import { NavoriConfigSchema } from "../../config/schema.ts";
import { conditionOrchestration } from "../../render/render-plan.ts";

/**
 * An asset's text as a repo renders it: `navori:if` markers resolved against a
 * minimal config whose harness flags take their defaults, except the ones given.
 * Content guards pin the rendered prose, not the raw markers (#1579).
 */
export function conditioned(text: string, harness: Record<string, boolean> = {}): string {
  const config = NavoriConfigSchema.parse({
    name: "conditioned-asset",
    engines: ["claude"],
    preset: "custom",
    harness,
  });
  return conditionOrchestration(text, config);
}
