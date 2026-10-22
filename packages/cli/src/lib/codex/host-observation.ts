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
  readonly intent: NativeProfileIntent;
}

const selectionIntent = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("set"), value: z.string().min(1) }),
  z.strictObject({ kind: z.literal("inherit") }),
]);
/** Requested field intent preserves native inheritance without asserting an effective pair. */
export const nativeProfileIntent = z.strictObject({
  model: selectionIntent,
  effort: selectionIntent,
});
/** Per-field requested selection, kept distinct from native resolved values. */
export type NativeProfileIntent = z.infer<typeof nativeProfileIntent>;

/** Only explicit diagnostic-free inheritance can omit a field; unresolved/null values alone never suffice. */
export function profileSelectionIntent(row: CodexProfileProjection): NativeProfileIntent {
  if (row.diagnostics.length) throw new Error("ambiguous-profile-selection-intent");
  const field = (name: "model" | "effort"): z.infer<typeof selectionIntent> => {
    const value = row[name];
    if (value.wouldRender) return { kind: "set", value: value.wouldRender };
    if (
      value.origin === "inherited" &&
      value.configured === null &&
      value.wouldRender === null &&
      row.rendered?.[name] === null
    )
      return { kind: "inherit" };
    throw new Error("missing-or-ambiguous-profile-selection-intent");
  };
  return { model: field("model"), effort: field("effort") };
}

/** Fixed hook context is meaningful only inside a verified owned native hook completion. */
export const profileProbeHookContext = z.strictObject({
  probe: z.uuid(),
  checkout: z.string().min(1),
  session: z.string().min(1),
  call: z.string().min(1),
  role: z.string().min(1),
  model: selectionIntent,
  effort: selectionIntent,
  catalog: z.string().regex(/^[a-f0-9]{64}$/),
  configuration: z.string().regex(/^[a-f0-9]{64}$/),
  inventory: z.string().regex(/^[a-f0-9]{64}$/),
});

/** Source-checked candidates; a caller/imported event array is never an owned observation. */
export function nativeProfileHookCalls(
  messages: readonly unknown[],
  expected: {
    probe: string;
    checkout: string;
    sourcePath: string;
    principal: string;
    turn?: string;
  },
): z.infer<typeof profileProbeHookContext>[] {
  const completion = z.object({
    method: z.literal("hook/completed"),
    params: z.object({
      threadId: z.literal(expected.principal),
      ...(expected.turn ? { turnId: z.literal(expected.turn) } : {}),
      run: z.object({
        id: z.string().min(1),
        source: z.literal("project"),
        sourcePath: z.literal(expected.sourcePath),
        eventName: z.literal("preToolUse"),
        handlerType: z.literal("command"),
        executionMode: z.literal("sync"),
        status: z.literal("completed"),
        entries: z.array(z.object({ kind: z.string(), text: z.string() })),
      }),
    }),
  });
  const seen = new Set<string>();
  const result: z.infer<typeof profileProbeHookContext>[] = [];
  for (const message of messages) {
    const parsed = completion.safeParse(message);
    if (!parsed.success) continue;
    const run = parsed.data.params.run;
    for (const entry of run.entries) {
      if (entry.kind !== "context" || !entry.text.startsWith("navori-profile-probe:")) continue;
      try {
        const context = profileProbeHookContext.parse(
          JSON.parse(entry.text.slice("navori-profile-probe:".length)) as unknown,
        );
        if (
          context.probe !== expected.probe ||
          context.checkout !== expected.checkout ||
          context.session !== expected.principal
        )
          continue;
        // One native call has exactly one hook completion, including duplicate/conflicting runs.
        if (seen.has(run.id) || seen.has(`call:${context.call}`)) return [];
        seen.add(run.id);
        seen.add(`call:${context.call}`);
        result.push(context);
      } catch {
        // Other hook output cannot supply a profile identity.
      }
    }
  }
  return result;
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
  model: z.string().min(1).nullable().optional(),
  reasoningEffort: z.string().min(1).nullable().optional(),
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
  parentSelection?: {
    context: string;
    model: string;
    effort: string;
    unchanged: boolean;
    defaultsKnown: boolean;
    v2?: {
      turn: string;
      hooks: readonly z.infer<typeof profileProbeHookContext>[];
    };
  },
): NativeProfileCandidate[] {
  if (parentSelection?.v2) {
    const selected: NativeProfileCandidate[] = [];
    const seen = new Set<string>();
    for (const raw of messages) {
      const activity = z
        .object({
          method: z.literal("item/started"),
          params: z.object({
            threadId: z.literal(principal),
            turnId: z.literal(parentSelection.v2.turn),
            item: activityItem,
          }),
        })
        .safeParse(raw);
      if (!activity.success) continue;
      const item = activity.data.params.item;
      const hooks = parentSelection.v2.hooks.filter((hook) => hook.call === item.id);
      const hook = hooks.length === 1 ? hooks[0] : undefined;
      const targets = rows.filter(
        (row) => row.scope === "subagent" && row.nativeName === hook?.role,
      );
      const target = targets.length === 1 ? targets[0] : undefined;
      if (
        !hook ||
        !target ||
        target.diagnostics.length ||
        seen.has(item.id) ||
        seen.has(item.agentThreadId)
      )
        return [];
      let intent: NativeProfileIntent;
      try {
        intent = profileSelectionIntent(target);
      } catch {
        return [];
      }
      if (
        JSON.stringify(intent) !== JSON.stringify({ model: hook.model, effort: hook.effort }) ||
        parentSelection.context !== principal ||
        !parentSelection.unchanged ||
        !parentSelection.defaultsKnown ||
        item.model !== (intent.model.kind === "set" ? intent.model.value : parentSelection.model) ||
        item.reasoningEffort !==
          (intent.effort.kind === "set" ? intent.effort.value : parentSelection.effort) ||
        item.agentThreadId === principal ||
        seen.has(item.agentPath)
      )
        return [];
      seen.add(item.id);
      seen.add(item.agentThreadId);
      seen.add(item.agentPath);
      selected.push(
        Object.freeze({
          nativeName: target.nativeName,
          context: item.agentThreadId,
          parent: principal,
          call: item.id,
          activity: item.id,
          model: item.model,
          effort: item.reasoningEffort,
          agentPath: item.agentPath,
          intent,
        }),
      );
    }
    return selected;
  }
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
      let intent: NativeProfileIntent | undefined;
      try {
        if (target) intent = profileSelectionIntent(target);
      } catch {
        /* Invalid projection stays pending. */
      }
      const inherited = intent?.model.kind === "inherit" && intent.effort.kind === "inherit";
      const expectedModel =
        intent?.model.kind === "set" ? intent.model.value : parentSelection?.model;
      const expectedEffort =
        intent?.effort.kind === "set" ? intent.effort.value : parentSelection?.effort;
      if (
        !target ||
        target.diagnostics.length ||
        !call ||
        !activity ||
        !intent ||
        (inherited &&
          (!parentSelection?.unchanged ||
            !parentSelection.defaultsKnown ||
            parentSelection.context !== thread.parentThreadId)) ||
        (!inherited && (intent.model.kind === "inherit" || intent.effort.kind === "inherit")) ||
        conflicts.has(`call:${call.id}`) ||
        conflicts.has(`activity:${activity.id}`) ||
        (call.model != null && call.model !== expectedModel) ||
        (call.reasoningEffort != null && call.reasoningEffort !== expectedEffort) ||
        activity.model !== expectedModel ||
        activity.reasoningEffort !== expectedEffort
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
          intent,
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
