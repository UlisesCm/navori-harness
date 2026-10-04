/**
 * Advisory diagnostics for a master-plan registry. This deliberately does not
 * use the `harness.masterPlan` flag as a gate: closed stages retain raw context
 * after `close` turns that flag off.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { NavoriConfig } from "../config/config.ts";
import { activeStage, indexJsonPath, masterDirPath, readMasterIndex } from "../master/stages.ts";
import { DeliveryStateSchema } from "../master/delivery-schema.ts";
import { checkDeliveryPreparation, containedFile } from "../master/delivery-checks.ts";
import { MasterStateSchema } from "../master/schema.ts";

export type MasterPlanDiagnostic =
  | { kind: "invalid-index"; detail: string }
  | { kind: "missing-raw-gitignore"; path: string; repair: "init" | "checkout" }
  | { kind: "flag-registry-desync"; repair: "close" | "init" }
  | { kind: "invalid-state"; detail: string }
  | { kind: "deliveries-pending"; detail: string };

/**
 * Finds recoverable master-plan inconsistencies without affecting doctor's
 * health verdict. `init` and `close` are the only repairs this scanner names
 * for registry/config desynchronization; a closed stage is read-only, so its
 * missing ignore file must be restored from git instead.
 */
export function scanMasterPlan(cwd: string, config: NavoriConfig): MasterPlanDiagnostic[] {
  const specsDir = config.sdd?.specsDir ?? "specs";
  if (!existsSync(indexJsonPath(cwd, specsDir))) return [];

  let index;
  try {
    index = readMasterIndex(cwd, specsDir);
  } catch (cause) {
    return [
      { kind: "invalid-index", detail: cause instanceof Error ? cause.message : String(cause) },
    ];
  }
  if (!index) return [];

  const issues: MasterPlanDiagnostic[] = [];
  const active = activeStage(index);
  if (active) {
    const statePath = join(masterDirPath(cwd, specsDir), active.dir, "state.json");
    if (!existsSync(statePath))
      issues.push({
        kind: "invalid-state",
        detail: `${active.dir}: state.json missing; run master init to resume`,
      });
    else {
      try {
        const raw: unknown = JSON.parse(readFileSync(statePath, "utf8"));
        if (active.workflow === "deliveries") DeliveryStateSchema.parse(raw);
        else MasterStateSchema.parse(raw);
      } catch (cause) {
        issues.push({
          kind: "invalid-state",
          detail: `${active.dir}: ${cause instanceof Error ? cause.message : String(cause)}`,
        });
      }
    }
    if (active.workflow === "deliveries") {
      const partsPath = join(masterDirPath(cwd, specsDir), active.dir, "parts.json");
      if (!existsSync(partsPath))
        issues.push({
          kind: "deliveries-pending",
          detail: `${active.dir}: preparation pending; not ready for delivery`,
        });
      else {
        try {
          const safeParts = containedFile(cwd, partsPath);
          if (!safeParts) throw new Error("parts.json outside repository");
          const checked = checkDeliveryPreparation(
            cwd,
            JSON.parse(readFileSync(safeParts, "utf8")) as unknown,
          );
          issues.push(
            checked.parts
              ? {
                  kind: "deliveries-pending",
                  detail: `${active.dir}: ${checked.blockers.length ? checked.blockers.join("; ") : "preparation ready"}; execution not ready for delivery`,
                }
              : {
                  kind: "invalid-state",
                  detail: `${active.dir}: invalid parts.json: ${checked.blockers.join("; ")}`,
                },
          );
        } catch (cause) {
          issues.push({
            kind: "invalid-state",
            detail: `${active.dir}: invalid parts.json: ${cause instanceof Error ? cause.message : String(cause)}`,
          });
        }
      }
    }
  }
  for (const stage of index.stages) {
    const path = join(masterDirPath(cwd, specsDir), stage.dir, "context", "raw", ".gitignore");
    if (!existsSync(path)) {
      issues.push({
        kind: "missing-raw-gitignore",
        path: relative(cwd, path),
        repair: stage.state === "activa" ? "init" : "checkout",
      });
    }
  }

  const enabled = config.harness?.masterPlan ?? false;
  if (enabled && !active) issues.push({ kind: "flag-registry-desync", repair: "close" });
  if (!enabled && active) issues.push({ kind: "flag-registry-desync", repair: "init" });
  return issues;
}
