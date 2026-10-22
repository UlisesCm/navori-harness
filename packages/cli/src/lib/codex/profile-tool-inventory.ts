import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

type ObjectValue = Record<string, unknown>;
const asObject = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : undefined;

export interface ProfileRequestTools {
  readonly turn: number;
  readonly source: "direct" | "additional" | "both" | "missing";
  readonly knownTools: readonly string[];
  readonly unknownTools: number;
  readonly spawnAgent: "present" | "absent" | "unverified";
  readonly toolResults?: readonly string[];
  readonly errorTerms?: readonly string[];
  readonly responseSpawnInputs?: ProfileRequestTools["spawnInputs"];
  readonly spawnInputs?: readonly {
    forkTurns: "all" | "none" | "other" | "omitted";
    forkContext: boolean;
    role: boolean;
    taskName: boolean;
    model: boolean;
    effort: boolean;
  }[];
}

export type ProfileToolInventory =
  | { readonly status: "captured"; readonly requests: readonly ProfileRequestTools[] }
  | { readonly status: "unavailable"; readonly reason: "missing" | "invalid" | "budget-exceeded" };

const knownNames = new Set([
  "exec",
  "wait",
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
  "close_agent",
]);
const knownNamespaces = new Set(["", "functions", "collaboration", "multi_agent_v1"]);
const knownErrorTerms = new Set([
  "fork",
  "ephemeral",
  "rollout",
  "history",
  "unsupported",
  "override",
  "overrides",
  "model",
  "permission",
  "sandbox",
  "thread",
  "session",
  "encrypted",
  "ciphertext",
  "message",
  "decrypt",
  "encryption",
  "reasoning",
  "effort",
  "token",
  "agent",
  "type",
  "spawn",
  "config",
  "argument",
  "arguments",
  "fork_turns",
  "fork_context",
  "agent_type",
  "task_name",
  "reasoning_effort",
  "role",
  "invalid",
  "unknown",
  "disabled",
  "limit",
  "depth",
  "timeout",
  "requires",
  "required",
  "not",
  "cannot",
  "unavailable",
  "authentication",
  "credentials",
  "file",
  "read",
  "parse",
  "field",
]);

/** Only allowlisted names/counts leave a raw request; prompt, descriptions and arbitrary names never do. */
export function summarizeProfileRequestTools(value: unknown, turn: number): ProfileRequestTools {
  const root = asObject(value);
  const request = asObject(root?.response) ?? root;
  const direct = Array.isArray(request?.tools) ? request.tools : undefined;
  const additional = Array.isArray(request?.input)
    ? request.input.flatMap((entry: unknown): ObjectValue[] => {
        const item = asObject(entry);
        return item?.type === "additional_tools" ? [item] : [];
      })
    : [];
  let invalid = request?.tools != null && !direct;
  const tools: unknown[] = [...(direct ?? [])];
  for (const item of additional) {
    if (Array.isArray(item.tools)) tools.push(...item.tools);
    else invalid = true;
  }
  const names = new Set<string>();
  let unknownTools = 0;
  let visited = 0;
  const visit = (entries: readonly unknown[], namespace: string, depth: number): void => {
    if (depth > 8) {
      invalid = true;
      return;
    }
    for (const entry of entries) {
      if (++visited > 4096) {
        invalid = true;
        return;
      }
      const tool = asObject(entry);
      if (!tool) {
        invalid = true;
        continue;
      }
      if (tool.type === "namespace") {
        if (
          !namespace &&
          typeof tool.name === "string" &&
          knownNamespaces.has(tool.name) &&
          Array.isArray(tool.tools)
        )
          visit(tool.tools, tool.name, depth + 1);
        else {
          unknownTools++;
          invalid = true;
        }
        continue;
      }
      const fn = asObject(tool.function);
      const name = typeof tool.name === "string" ? tool.name : fn?.name;
      if (typeof name !== "string") {
        unknownTools++;
        invalid = true;
        continue;
      }
      const qualified = namespace ? `${namespace}.${name}` : name;
      const parts = qualified.split(".");
      const leaf = parts.pop()!;
      if (knownNames.has(leaf) && knownNamespaces.has(parts.join("."))) names.add(qualified);
      else unknownTools++;
    }
  };
  visit(tools, "", 0);
  const toolResults = new Set<string>();
  const errorTerms = new Set<string>();
  const spawnInputs: NonNullable<ProfileRequestTools["spawnInputs"]>[number][] = [];
  for (const raw of Array.isArray(request?.input) ? request.input : []) {
    const item = asObject(raw);
    if (
      item?.type === "function_call" &&
      ["spawn_agent", "collaboration.spawn_agent", "collaborationspawn_agent"].includes(
        String(item.name),
      )
    ) {
      try {
        const input = asObject(
          typeof item.arguments === "string"
            ? (JSON.parse(item.arguments) as unknown)
            : item.arguments,
        );
        if (input)
          spawnInputs.push({
            forkTurns:
              input.fork_turns === "all" || input.fork_turns === "none"
                ? input.fork_turns
                : input.fork_turns === undefined
                  ? "omitted"
                  : "other",
            forkContext: Object.hasOwn(input, "fork_context"),
            role: Object.hasOwn(input, "agent_type"),
            taskName: Object.hasOwn(input, "task_name"),
            model: Object.hasOwn(input, "model"),
            effort: Object.hasOwn(input, "reasoning_effort"),
          });
      } catch {
        toolResults.add("invalid-tool-arguments");
      }
    }
    if (item?.type !== "function_call_output" && item?.type !== "custom_tool_call_output") continue;
    const output: unknown = item.output;
    const texts: string[] =
      typeof output === "string"
        ? [output]
        : Array.isArray(output)
          ? output.flatMap((part: unknown): string[] => {
              const text = asObject(part)?.text;
              return typeof text === "string" ? [text] : [];
            })
          : [];
    for (const text of texts) {
      if (/error|fail|unsupported|not supported/i.test(text)) {
        for (const term of text.toLowerCase().match(/[a-z_]+/g) ?? [])
          if (knownErrorTerms.has(term)) errorTerms.add(term);
      }
      if (/fork_context is not supported in MultiAgentV2/.test(text))
        toolResults.add("unsupported-fork-context");
      else if (/fork_turns must be/.test(text)) toolResults.add("invalid-fork-mode");
      else if (/Unknown model .*for spawn_agent/.test(text))
        toolResults.add("unsupported-spawn-model");
      else if (/Reasoning effort .*is not supported for model/.test(text))
        toolResults.add("unsupported-spawn-effort");
      else if (/Full-history forked agents inherit/.test(text))
        toolResults.add("full-history-override");
      else if (/decrypt/i.test(text) && /error|fail/i.test(text))
        toolResults.add("message-decryption-error");
      else if (/profile-hook-/.test(text)) toolResults.add("profile-hook-denial");
      else if (/error/i.test(text)) toolResults.add("unclassified-tool-error");
    }
  }
  const source = direct
    ? additional.length
      ? "both"
      : "direct"
    : additional.length
      ? "additional"
      : "missing";
  return {
    turn,
    source,
    knownTools: [...names].sort(),
    unknownTools,
    ...(toolResults.size ? { toolResults: [...toolResults].sort() } : {}),
    ...(errorTerms.size ? { errorTerms: [...errorTerms].sort() } : {}),
    ...(spawnInputs.length ? { spawnInputs } : {}),
    spawnAgent: [...names].some((name: string): boolean => name.split(".").at(-1) === "spawn_agent")
      ? "present"
      : invalid || source === "missing"
        ? "unverified"
        : "absent",
  };
}

/** Read only this process's private trace and exact principal/turns, before its owner deletes raw data. */
export function readProfileToolInventory(
  directory: string,
  principal: string,
  turns: readonly string[],
): ProfileToolInventory {
  let remaining = 2 * 1024 * 1024;
  let frames = 0;
  const requests: ProfileRequestTools[] = [];
  const calls = new Map<string, number>();
  try {
    const root = realpathSync(directory);
    const read = (path: string): string => {
      const rel = relative(root, realpathSync(path));
      if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error("invalid");
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new Error("invalid");
        if (stat.size > remaining) throw new Error("budget-exceeded");
        const content = readFileSync(fd);
        remaining -= content.length;
        if (remaining < 0) throw new Error("budget-exceeded");
        return content.toString("utf8");
      } finally {
        closeSync(fd);
      }
    };
    const bundles = readdirSync(root, { withFileTypes: true });
    if (bundles.length > 64) throw new Error("budget-exceeded");
    for (const bundle of bundles) {
      if (!bundle.isDirectory()) continue;
      const folder = join(root, bundle.name);
      for (const line of read(join(folder, "trace.jsonl")).split("\n")) {
        if (!line.trim()) continue;
        if (++frames > 2048) throw new Error("budget-exceeded");
        const event = asObject(JSON.parse(line) as unknown);
        const payload = asObject(event?.payload);
        if (
          payload?.type === "inference_completed" &&
          typeof payload.inference_call_id === "string"
        ) {
          const index = calls.get(payload.inference_call_id);
          if (index !== undefined) {
            const ref = asObject(payload.response_payload);
            if (asObject(ref?.kind)?.type !== "inference_response" || typeof ref?.path !== "string")
              throw new Error("invalid");
            const response = asObject(JSON.parse(read(resolve(folder, ref.path))) as unknown);
            const inputs = summarizeProfileRequestTools(
              { input: response?.output_items },
              requests[index]!.turn,
            ).spawnInputs;
            if (inputs) requests[index] = { ...requests[index]!, responseSpawnInputs: inputs };
          }
          continue;
        }
        if (payload?.type !== "inference_started" || payload.thread_id !== principal) continue;
        const turn = turns.indexOf(String(payload.codex_turn_id));
        if (turn < 0) continue;
        const ref = asObject(payload.request_payload);
        if (
          asObject(ref?.kind)?.type !== "inference_request" ||
          typeof ref?.path !== "string" ||
          typeof payload.inference_call_id !== "string" ||
          calls.has(payload.inference_call_id)
        )
          throw new Error("invalid");
        calls.set(payload.inference_call_id, requests.length);
        if (requests.length >= 64) throw new Error("budget-exceeded");
        const request: unknown = JSON.parse(read(resolve(folder, ref.path)));
        requests.push(summarizeProfileRequestTools(request, turn + 1));
      }
    }
    return requests.length
      ? { status: "captured", requests }
      : { status: "unavailable", reason: "missing" };
  } catch (error: unknown) {
    return {
      status: "unavailable",
      reason:
        error instanceof Error && error.message === "budget-exceeded"
          ? "budget-exceeded"
          : "invalid",
    };
  }
}
