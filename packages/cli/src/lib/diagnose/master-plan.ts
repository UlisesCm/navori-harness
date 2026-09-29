/**
 * Advisory diagnostics for a master-plan registry. This deliberately does not
 * use the `harness.masterPlan` flag as a gate: closed stages retain raw context
 * after `close` turns that flag off.
 */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { NavoriConfig } from "../config/config.ts";
import { activeStage, indexJsonPath, masterDirPath, readMasterIndex } from "../master/stages.ts";

export type MasterPlanDiagnostic =
  | { kind: "invalid-index"; detail: string }
  | { kind: "missing-raw-gitignore"; path: string; repair: "init" | "checkout" }
  | { kind: "flag-registry-desync"; repair: "close" | "init" };

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
