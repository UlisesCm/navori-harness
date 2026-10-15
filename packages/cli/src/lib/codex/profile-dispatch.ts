import { randomUUID, createHash } from "node:crypto";
import { readFileSync, openSync, closeSync, writeSync, ftruncateSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { readConfig } from "../config/config.ts";
import { readNativeProfileView, type NativeProfileView } from "./host-observation.ts";
import {
  ensureStateDirectory,
  resolveStateRoot,
  stateArtifactPath,
  writeStateFileAtomic,
} from "../primitives/state-root.ts";

const inputSchema = z.strictObject({
  name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
  action: z.string().trim().min(1).max(256),
});
const preparationSchema = z.strictObject({
  id: z.uuid(),
  checkout: z.string(),
  tree: z.string(),
  configuration: z.string(),
  inventory: z.string(),
  name: inputSchema.shape.name,
  action: inputSchema.shape.action,
  model: z.string().min(1),
  effort: z.string().min(1),
  catalog: z.strictObject({
    connection: z.uuid(),
    context: z.uuid(),
    checkedAt: z.iso.datetime(),
    queries: z.array(z.string()).min(1),
    identity: z.string(),
  }),
  application: z.literal("pending"),
  reason: z.literal("native-context-closed; future-host-application-required"),
});

/** Metadata preparation has no permission, running-context mutation or agent launch semantics. */
export type ProfilePreparation = z.infer<typeof preparationSchema>;

/** Require an exact inventory row and supported pair; missing inheritance never implies observation. */
function requestedPair(view: NativeProfileView, name: string): { model: string; effort: string } {
  const rows = view.rows.filter((row) => row.nativeName === name);
  const row = rows.length === 1 ? rows[0] : undefined;
  const model = row?.model.wouldRender ?? (row?.origin === "local" ? row.rendered?.model : null);
  const effort = row?.effort.wouldRender ?? (row?.origin === "local" ? row.rendered?.effort : null);
  if (!row || !model || !effort || row.diagnostics.length !== 0)
    throw new Error("profile-missing-ambiguous-or-conflicting; human-decision-required");
  const advertised = view.catalog.models.find((candidate) => candidate.model === model);
  if (!advertised || !advertised.efforts.includes(effort))
    throw new Error("unsupported-model-or-effort; human-decision-required");
  return { model, effort };
}

/** Fresh native query on every preparation; persist only metadata for explicitly new work. */
export async function prepareCodexProfile(
  cwd: string,
  input: unknown,
): Promise<ProfilePreparation> {
  const selected = inputSchema.parse(input);
  const view = await readNativeProfileView(cwd);
  const pair = requestedPair(view, selected.name);
  const preparation: ProfilePreparation = {
    id: randomUUID(),
    checkout: view.checkout,
    tree: view.tree,
    configuration: view.configuration,
    inventory: view.inventory,
    ...selected,
    ...pair,
    catalog: {
      connection: view.catalog.connection,
      context: view.catalog.context,
      checkedAt: view.catalog.checkedAt,
      queries: [...view.catalog.queries],
      identity: createHash("sha256").update(JSON.stringify(view.catalog.models)).digest("hex"),
    },
    application: "pending",
    reason: "native-context-closed; future-host-application-required",
  };
  const root = resolveStateRoot({ cwd: view.checkout, feature: "codex-profile" });
  ensureStateDirectory(root);
  writeStateFileAtomic(root, `profile-${preparation.id}.json`, JSON.stringify(preparation));
  return preparation;
}

/** Refresh before exclusive metadata consumption; the winner still cannot dispatch or authorize. */
export async function claimCodexProfile(
  cwd: string,
  id: string,
  input: unknown,
): Promise<ProfilePreparation> {
  z.uuid().parse(id);
  const selected = inputSchema.parse(input);
  const root = resolveStateRoot({ cwd, feature: "codex-profile" });
  const preparation = preparationSchema.parse(
    JSON.parse(readFileSync(stateArtifactPath(root, `profile-${id}.json`), "utf8")) as unknown,
  );
  if (
    preparation.id !== id ||
    preparation.checkout !== root.cwd ||
    preparation.name !== selected.name ||
    preparation.action !== selected.action
  )
    throw new Error("profile-cross-checkout-role-or-action");
  const view = await readNativeProfileView(root.cwd);
  const pair = requestedPair(view, selected.name);
  const catalog = createHash("sha256").update(JSON.stringify(view.catalog.models)).digest("hex");
  if (
    preparation.tree !== view.tree ||
    preparation.configuration !== view.configuration ||
    preparation.inventory !== view.inventory ||
    preparation.catalog.identity !== catalog ||
    preparation.model !== pair.model ||
    preparation.effort !== pair.effort
  )
    throw new Error("profile-preparation-stale; prepare-again");
  const fd = openSync(stateArtifactPath(root, `profile-${id}.claim.json`), "wx", 0o600);
  try {
    writeSync(
      fd,
      JSON.stringify({
        preparation: id,
        name: selected.name,
        action: selected.action,
        currentCatalog: view.catalog,
      }),
    );
  } finally {
    closeSync(fd);
  }
  return preparation;
}

/** Native rewrite protocol only; an allow here is not a human approval or effective-selection proof. */
export type ProfileHookOutput =
  | Record<string, never>
  | {
      hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "allow" | "deny";
        permissionDecisionReason?: string;
        updatedInput?: Record<string, unknown>;
      };
    };

/** Recoverable failures use the native denial wire without exposing payloads or configuration. */
export function denyProfileHook(reason: string): ProfileHookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

/** Canonicalize JSON data only: preserve arrays and opaque fields while ignoring object key order. */
function canonicalAction(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (typeof entry === "object" && entry !== null)
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, sort(item)]),
      );
    if (entry === null || ["string", "boolean", "number"].includes(typeof entry)) return entry;
    throw new Error("invalid-hook-json");
  };
  return createHash("sha256")
    .update(JSON.stringify(sort(value)))
    .digest("hex");
}

/** Burn one native call before validation/query; all later failures remain consumed and uncertain. */
export async function consumeCodexProfileHook(
  payload: unknown,
  deadline = Date.now() + 8_000,
): Promise<ProfileHookOutput> {
  deadline = Math.min(deadline, Date.now() + 8_000);
  let fd: number | undefined;
  try {
    const envelope = z
      .object({
        cwd: z.string().min(1),
        session_id: z.string().min(1),
        tool_use_id: z.string().min(1),
        tool_name: z.string(),
        tool_input: z.unknown(),
      })
      .parse(payload);
    const root = resolveStateRoot({ cwd: envelope.cwd, feature: "codex-profile" });
    const config = readConfig(join(root.cwd, "navori.config.json"));
    if (!config.engines.includes("codex") || config.harness?.codexIntegration !== true) return {};
    if (Date.now() >= deadline) throw new Error("profile-hook-deadline");
    ensureStateDirectory(root);
    const key = createHash("sha256")
      .update(JSON.stringify([root.cwd, envelope.session_id, envelope.tool_use_id]))
      .digest("hex");
    fd = openSync(stateArtifactPath(root, `profile-hook-${key}.json`), "wx", 0o600);
    const action = canonicalAction(envelope.tool_input);
    const burn = { key, action, application: "pending", status: "consumed-uncertain" };
    writeSync(fd, JSON.stringify(burn));
    fsyncSync(fd);
    if (!["Agent", "spawn_agent"].includes(envelope.tool_name))
      throw new Error("unsupported-native-agent-tool");
    const input = z.record(z.string(), z.unknown()).parse(envelope.tool_input);
    const role = inputSchema.shape.name.parse(input.agent_type);
    const before = await readNativeProfileView(root.cwd, undefined, deadline);
    const target = before.rows.find((row) => row.nativeName === role);
    if (target?.scope !== "subagent") throw new Error("profile-child-role-required");
    const pair = requestedPair(before, role);
    const current = await readNativeProfileView(root.cwd, undefined, deadline);
    const next = requestedPair(current, role);
    const catalog = canonicalAction(before.catalog.models);
    if (
      Date.now() >= deadline ||
      before.tree !== current.tree ||
      before.configuration !== current.configuration ||
      before.inventory !== current.inventory ||
      catalog !== canonicalAction(current.catalog.models) ||
      pair.model !== next.model ||
      pair.effort !== next.effort
    )
      throw new Error("profile-hook-current-inputs-changed-or-deadline");
    const record = JSON.stringify({
      ...burn,
      role,
      tree: current.tree,
      configuration: current.configuration,
      inventory: current.inventory,
      catalog,
      queries: current.catalog.queries,
      catalogContext: current.catalog.context,
      checkedAt: current.catalog.checkedAt,
      ...pair,
      status: "candidate-rewrite; effective-selection-pending",
    });
    ftruncateSync(fd, 0);
    writeSync(fd, record, 0, "utf8");
    fsyncSync(fd);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...input, model: pair.model, reasoning_effort: pair.effort },
      },
    };
  } catch {
    return denyProfileHook(
      "profile-hook-unavailable-stale-invalid-or-consumed; effective-selection-pending",
    );
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
