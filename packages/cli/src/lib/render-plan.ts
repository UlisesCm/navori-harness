import { readFileSync } from "node:fs";
import { CORE_MANAGED_ASSETS, resolveAssetPath, type CoreManagedAsset } from "@navori/core";
import { injectManagedSection, removeManagedSection, resolveCondition, type InjectResult } from "./marker.ts";
import type { NavoriConfig } from "./config.ts";

export type AssetStatus =
  | InjectResult["status"]
  | "removed-condition-false";

export interface AssetPlanEntry {
  asset: CoreManagedAsset;
  status: AssetStatus;
  details?: InjectResult["details"];
  /** New content from the Core (or null when condition is falsy). */
  newContent: string | null;
}

export interface RenderPlan {
  existing: string;
  next: string;
  changed: boolean;
  entries: AssetPlanEntry[];
}

/**
 * Compute the next content of the target file by walking CORE_MANAGED_ASSETS.
 * Pure: does NOT touch disk for writing. Reads asset files from @navori/core.
 */
export function computeRenderPlan(existing: string, config: NavoriConfig): RenderPlan {
  let working = existing;
  const entries: AssetPlanEntry[] = [];
  const configRecord = config as unknown as Record<string, unknown>;

  for (const asset of CORE_MANAGED_ASSETS) {
    if (asset.condition) {
      const truthy = resolveCondition(configRecord, asset.condition);
      if (!truthy) {
        const before = working;
        working = removeManagedSection(working, asset.id);
        entries.push({
          asset,
          status: before === working ? "unchanged" : "removed-condition-false",
          newContent: null,
        });
        continue;
      }
    }

    const content = readFileSync(resolveAssetPath(asset), "utf-8");
    const result = injectManagedSection(working, asset.id, content);
    entries.push({
      asset,
      status: result.status,
      details: result.details,
      newContent: content,
    });
    working = result.output;
  }

  return {
    existing,
    next: working,
    changed: working !== existing,
    entries,
  };
}

/**
 * Re-apply the same plan but skipping ids marked "user-modified-skipped".
 * Used by sync after the user resolved conflicts (decides to keep theirs).
 */
export function applyPlanWithSkips(
  existing: string,
  config: NavoriConfig,
  skipIds: ReadonlySet<string>,
): string {
  const filteredAssets = CORE_MANAGED_ASSETS.filter((a) => !skipIds.has(a.id));
  let working = existing;
  const configRecord = config as unknown as Record<string, unknown>;

  for (const asset of filteredAssets) {
    if (asset.condition && !resolveCondition(configRecord, asset.condition)) {
      working = removeManagedSection(working, asset.id);
      continue;
    }
    const content = readFileSync(resolveAssetPath(asset), "utf-8");
    const result = injectManagedSection(working, asset.id, content);
    working = result.output;
  }
  return working;
}
