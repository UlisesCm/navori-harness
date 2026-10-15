import { createHash, randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../config/config.ts";
import { projectCodexProfiles, type CodexProfileProjection } from "../assets/model-profile.ts";
import { fingerprintTree } from "../plan/evidence.ts";
import {
  resolveStateRoot,
  ensureStateDirectory,
  stateArtifactPath,
  writeStateFileAtomic,
} from "../primitives/state-root.ts";
import { queryNativeCatalog, isOwnedNativeCatalog } from "./native-integration.ts";
import { z } from "zod";

/** Closed connection query provenance is a point-in-time candidate, never runtime execution. */
export interface NativeCatalogSnapshot {
  readonly source: "codex-app-server";
  readonly checkout: string;
  readonly version: string;
  readonly connection: string;
  readonly context: string;
  readonly checkedAt: string;
  readonly queries: readonly string[];
  readonly models: readonly {
    readonly id: string;
    readonly model: string;
    readonly efforts: readonly string[];
  }[];
  readonly lifecycle: "open" | "closed";
}

/** Recomputed checkout/config/render/catalog inputs; observed profiles remain explicitly pending. */
export interface NativeProfileView {
  readonly checkout: string;
  readonly tree: string;
  readonly configuration: string;
  readonly inventory: string;
  readonly catalog: NativeCatalogSnapshot;
  readonly rows: readonly CodexProfileProjection[];
}

/** Parsed joins are candidates only; the owned transport separately attests received messages. */
export interface NativeProfileCandidate {
  readonly nativeName: string;
  readonly context: string;
  readonly parent: string;
  readonly call: string;
  readonly activity: string;
  readonly model: string;
  readonly effort: string;
  readonly agentPath: string;
}

const nativeItem = z.object({
  threadId: z.string().min(1),
  item: z.record(z.string(), z.unknown()),
});
const childThread = z.object({
  thread: z.object({
    id: z.string().min(1),
    parentThreadId: z.string().min(1),
    agentRole: z.string().min(1),
  }),
});
const spawnItem = z.object({
  type: z.literal("collabAgentToolCall"),
  id: z.string().min(1),
  tool: z.literal("spawnAgent"),
  senderThreadId: z.string().min(1),
  receiverThreadIds: z.array(z.string().min(1)).min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
  status: z.literal("completed"),
});
const activityItem = z.object({
  type: z.literal("subAgentActivity"),
  id: z.string().min(1),
  kind: z.literal("started"),
  agentThreadId: z.string().min(1),
  agentPath: z.string().min(1),
  model: z.string().min(1),
  reasoningEffort: z.string().min(1),
});

/** Join native receiver/call, resolved creation pair and authentic role/parent; never infer a role from prompts. */
export function nativeProfileCandidates(
  rows: readonly CodexProfileProjection[],
  principal: string,
  messages: readonly unknown[],
): NativeProfileCandidate[] {
  const threads: z.infer<typeof childThread>["thread"][] = [];
  const calls: z.infer<typeof spawnItem>[] = [];
  const activities: { parent: string; item: z.infer<typeof activityItem> }[] = [];
  const invalid = new Set<string>();
  const identities = new Map<string, string>();
  const conflicts = new Set<string>();
  const remember = (kind: string, id: string, value: unknown): void => {
    const key = `${kind}:${id}`;
    const previous = identities.get(key);
    const encoded = JSON.stringify(value);
    if (previous !== undefined && previous !== encoded) conflicts.add(key);
    identities.set(key, encoded);
  };
  for (const raw of messages) {
    const message = z.object({ method: z.string(), params: z.unknown() }).safeParse(raw);
    if (!message.success) continue;
    if (message.data.method === "thread/started") {
      const thread = childThread.safeParse(message.data.params);
      if (thread.success) {
        remember("thread", thread.data.thread.id, thread.data.thread);
        threads.push(thread.data.thread);
      }
    }
    if (!["item/started", "item/completed"].includes(message.data.method)) continue;
    const params = nativeItem.safeParse(message.data.params);
    if (!params.success) continue;
    const call = spawnItem.safeParse(params.data.item);
    const activity = activityItem.safeParse(params.data.item);
    if (call.success) {
      remember("call", call.data.id, { parent: params.data.threadId, item: call.data });
      if (call.data.senderThreadId === params.data.threadId) calls.push(call.data);
    }
    if (activity.success) {
      const entry = { parent: params.data.threadId, item: activity.data };
      remember("activity", activity.data.id, entry);
      activities.push(entry);
    }
    if (
      params.data.item.type === "subAgentActivity" &&
      params.data.item.kind !== "started" &&
      typeof params.data.item.agentThreadId === "string" &&
      (params.data.item.model != null || params.data.item.reasoningEffort != null)
    )
      invalid.add(params.data.item.agentThreadId);
  }
  const result: NativeProfileCandidate[] = [];
  const known = new Set([principal]);
  for (let pass = 0; pass < threads.length; pass++) {
    for (const thread of threads) {
      if (
        known.has(thread.id) ||
        !known.has(thread.parentThreadId) ||
        invalid.has(thread.id) ||
        conflicts.has(`thread:${thread.id}`)
      )
        continue;
      const row = rows.filter(
        (entry) => entry.scope === "subagent" && entry.nativeName === thread.agentRole,
      );
      const matchingCalls = calls.filter(
        (entry) =>
          entry.senderThreadId === thread.parentThreadId &&
          entry.receiverThreadIds.includes(thread.id),
      );
      const matchingActivities = activities.filter(
        (entry) => entry.parent === thread.parentThreadId && entry.item.agentThreadId === thread.id,
      );
      const uniqueCalls = [...new Map(matchingCalls.map((entry) => [entry.id, entry])).values()];
      const uniqueActivities = [
        ...new Map(matchingActivities.map((entry) => [entry.item.id, entry.item])).values(),
      ];
      const target = row.length === 1 ? row[0] : undefined;
      const call = uniqueCalls.length === 1 ? uniqueCalls[0] : undefined;
      const activity = uniqueActivities.length === 1 ? uniqueActivities[0] : undefined;
      if (
        !target ||
        target.diagnostics.length ||
        !call ||
        !activity ||
        activity.id !== call.id ||
        conflicts.has(`call:${call.id}`) ||
        conflicts.has(`activity:${activity.id}`) ||
        call.model !==
          (target.model.wouldRender ??
            (target.origin === "local" ? target.rendered?.model : null)) ||
        call.reasoningEffort !==
          (target.effort.wouldRender ??
            (target.origin === "local" ? target.rendered?.effort : null)) ||
        activity.model !== call.model ||
        activity.reasoningEffort !== call.reasoningEffort
      )
        continue;
      result.push(
        Object.freeze({
          nativeName: target.nativeName,
          context: thread.id,
          parent: thread.parentThreadId,
          call: call.id,
          activity: activity.id,
          model: activity.model,
          effort: activity.reasoningEffort,
          agentPath: activity.agentPath,
        }),
      );
      known.add(thread.id);
    }
  }
  return result;
}

/** Query from the private transport and reuse the delivered full inventory/resolver read-only. */
export async function readNativeProfileView(
  cwd: string,
  currentCatalog?: NativeCatalogSnapshot,
  deadline?: number,
): Promise<NativeProfileView> {
  const root = resolveStateRoot({ cwd, feature: "codex-profile" });
  const configPath = join(root.cwd, "navori.config.json");
  const configuration = createHash("sha256").update(readFileSync(configPath)).digest("hex");
  const config = readConfig(configPath);
  if (!config.engines.includes("codex") || config.harness?.codexIntegration !== true)
    throw new Error("project-opt-in-required");
  const before = fingerprintTree(root.cwd, undefined, { readOnly: true, deadline });
  if (!before.ok) throw new Error(before.reason);
  const catalog = currentCatalog ?? (await queryNativeCatalog(root.cwd, deadline));
  if (!isOwnedNativeCatalog(catalog) || catalog.checkout !== root.cwd)
    throw new Error("native-catalog-source-unverified");
  ensureStateDirectory(root);
  const name = `catalog-${randomUUID()}.json`;
  const path = stateArtifactPath(root, name);
  writeStateFileAtomic(
    root,
    name,
    JSON.stringify({ models: catalog.models.map((row) => ({ slug: row.model })) }),
  );
  let rows: CodexProfileProjection[];
  try {
    rows = projectCodexProfiles(root.cwd, config, { catalogPath: path });
  } finally {
    unlinkSync(path);
  }
  const after = fingerprintTree(root.cwd, undefined, { readOnly: true, deadline });
  if (!after.ok || after.tree !== before.tree) throw new Error("native-profile-inputs-changed");
  return {
    checkout: root.cwd,
    tree: after.tree,
    configuration,
    inventory: createHash("sha256").update(JSON.stringify(rows)).digest("hex"),
    catalog,
    rows,
  };
}
