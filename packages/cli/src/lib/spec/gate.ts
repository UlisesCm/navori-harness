/**
 * Disk-reading front of {@link decideGate} (spec 0044 D5): resolves config,
 * spec directory and `tasks.md`, and turns every failure into a `full`
 * decision with reason `tasks-unreadable`, so the gate can only over-run.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readConfig } from "../config/config.ts";
import {
  DEFAULT_DELIVERIES,
  resolveDeliveryThresholds,
  type DeliveryThresholds,
} from "../config/schema.ts";
import { classifySpec, decideGate, type GateDecision } from "./classify.ts";
import { locateSpecDir } from "./locate.ts";
import { parseTasks } from "./tasks.ts";

/** Decision for `spec`/`milestone` as the branch's `tasks.md` bytes read today. */
export function decideGateFromDisk(cwd: string, spec: string, milestone: string): GateDecision {
  try {
    const root = resolve(cwd);
    const configPath = join(root, "navori.config.json");
    let specsDir = "specs";
    let thresholds: DeliveryThresholds = { ...DEFAULT_DELIVERIES };
    if (existsSync(configPath)) {
      const config = readConfig(configPath);
      specsDir = config.sdd?.specsDir ?? specsDir;
      thresholds = resolveDeliveryThresholds(config);
    }
    const location = locateSpecDir(root, specsDir, spec);
    if (!location.ok) throw new Error(location.why);
    const parsed = parseTasks(readFileSync(join(location.dir, "tasks.md"), "utf8"));
    return decideGate(parsed, classifySpec(parsed, thresholds), milestone);
  } catch {
    return { gateKind: "full", reason: "tasks-unreadable", unit: null, closingMilestone: null };
  }
}
