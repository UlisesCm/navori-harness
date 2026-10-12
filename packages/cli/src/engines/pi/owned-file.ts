import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as nodeModule from "node:module";

const OWNER_ID = "pi-runtime";

/** One shared hook script the extension bridge runs (spec 0048 D1); mirrors `PiHookBinding` plus its path. */
export interface PiManifestHook {
  script: string;
  path: string;
  on: "tool_call" | "tool_result" | "agent_before_settle" | "session_shutdown";
  tools?: readonly string[];
  scope: "parent" | "child" | "all";
  class: "enforced" | "advisory" | "lifecycle";
  interactive: boolean;
  timeoutMs: number;
}

interface PiManifestBase {
  agents: readonly string[];
  controls?: {
    planTiers: boolean;
    masterPlan: boolean;
    scribeOwnsMarkdown: boolean;
  };
}

/** Legacy manifest, still recognized so a render upgrades it; never written by this CLI. */
export interface PiManifestV1 extends PiManifestBase {
  schemaVersion: 1;
}

/**
 * Manifest v2 (spec 0048): a v1-only CLI sees it as foreign and refuses to write any Pi resource
 * (anti-downgrade); this CLI refuses to write over a schema newer than {@link PI_MANIFEST_SCHEMA}.
 */
export interface PiManifestV2 extends PiManifestBase {
  schemaVersion: 2;
  hooks: readonly PiManifestHook[];
  /** Whole-file destinations Navori owns, blocked for `edit`/`write` even before they exist. */
  ownedPaths: readonly string[];
  /** Shared shell permission rules (`Bash(...)` patterns) for `PI_PARITY` and `doctor`. */
  permissionRules: { ask: readonly string[]; deny: readonly string[] };
}

export type PiManifestPayload = PiManifestV1 | PiManifestV2;

/** The manifest schema this CLI writes. */
export const PI_MANIFEST_SCHEMA = 2;

/** A whole-file marker is deliberately outside the TypeScript payload. */
export function serializePiSource(source: string): string {
  const body = source.trim() + "\n";
  return `// navori:managed-file id="pi-extension" hash="${digest(body)}"\n${body}`;
}

/** Refuse to replace a source file changed since the last render. */
export function ownsPiSource(content: string): boolean {
  const match = /^\/\/ navori:managed-file id="pi-extension" hash="([a-f0-9]{64})"\n/.exec(content);
  if (match === null || match[1] !== digest(content.slice(match[0].length))) return false;
  try {
    if (typeof nodeModule.stripTypeScriptTypes === "function") {
      nodeModule.stripTypeScriptTypes(content);
      return true;
    }
    // Bun lacks this Node API. Parse in Node without importing or executing the payload.
    if (Buffer.byteLength(content, "utf8") > 1_048_576) return false;
    const result = spawnSync(
      "node",
      [
        "--input-type=commonjs",
        "--eval",
        'require("node:module").stripTypeScriptTypes(require("node:fs").readFileSync(0, "utf8"));',
      ],
      { input: content, timeout: 5_000, maxBuffer: 1_048_576, windowsHide: true },
    );
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}

/** Serialize one agent with a YAML-comment ownership marker. */
export function serializePiAgent(input: {
  name: string;
  description: string;
  model?: string;
  tools: readonly string[];
  instructions: string;
}): string {
  const fields = [
    `name: ${JSON.stringify(input.name)}`,
    `description: ${JSON.stringify(input.description)}`,
    ...(input.model ? [`model: ${JSON.stringify(input.model)}`] : []),
    `tools: ${JSON.stringify([...input.tools])}`,
  ];
  const body = `${fields.join("\n")}\n---\n${input.instructions.trim()}\n`;
  return `---\n# navori:managed-file id="pi-agent-${input.name}" hash="${digest(body)}"\n${body}`;
}

/** Validate agent syntax and ownership without accepting a hand-edited file. */
export function ownsPiAgent(content: string, name: string): boolean {
  const match = /^---\n# navori:managed-file id="pi-agent-([a-z-]+)" hash="([a-f0-9]{64})"\n/.exec(
    content,
  );
  if (!match || match[1] !== name || match[2] !== digest(content.slice(match[0].length)))
    return false;
  const body = content.slice(match[0].length);
  const separator = body.indexOf("\n---\n");
  if (separator < 0) return false;
  const fields = new Map<string, unknown>();
  try {
    for (const line of body.slice(0, separator).split("\n")) {
      const field = /^(name|description|model|tools): (.+)$/.exec(line);
      if (!field || fields.has(field[1]!)) return false;
      fields.set(field[1]!, JSON.parse(field[2]!));
    }
    const parsedName = fields.get("name");
    const description = fields.get("description");
    const model = fields.get("model");
    const tools = fields.get("tools");
    if (
      parsedName !== name ||
      typeof description !== "string" ||
      (model !== undefined && typeof model !== "string") ||
      !Array.isArray(tools) ||
      !tools.every((tool: unknown) => typeof tool === "string")
    )
      return false;
    const instructions = body.slice(separator + "\n---\n".length);
    return (
      content ===
      serializePiAgent({
        name,
        description,
        ...(model === undefined ? {} : { model }),
        tools,
        instructions,
      })
    );
  } catch {
    return false;
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalPayload(payload: PiManifestPayload): string {
  return JSON.stringify({
    schemaVersion: payload.schemaVersion,
    agents: [...payload.agents].sort(),
    ...(payload.controls ? { controls: payload.controls } : {}),
    ...(payload.schemaVersion === 2
      ? {
          hooks: payload.hooks.map((hook) => ({
            script: hook.script,
            path: hook.path,
            on: hook.on,
            ...(hook.tools ? { tools: [...hook.tools] } : {}),
            scope: hook.scope,
            class: hook.class,
            interactive: hook.interactive,
            timeoutMs: hook.timeoutMs,
          })),
          ownedPaths: [...payload.ownedPaths].sort(),
          permissionRules: {
            ask: [...payload.permissionRules.ask],
            deny: [...payload.permissionRules.deny],
          },
        }
      : {}),
  });
}

/** Serialize the Navori-only Pi manifest as strict JSON with a payload digest. */
export function serializePiManifest(payload: PiManifestPayload): string {
  const canonical = canonicalPayload(payload);
  const parsed: unknown = JSON.parse(canonical);
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid Pi manifest payload");
  return (
    JSON.stringify({ _navori: { id: OWNER_ID, hash: digest(canonical) }, ...parsed }, null, 2) +
    "\n"
  );
}

const HOOK_EVENTS = ["tool_call", "tool_result", "agent_before_settle", "session_shutdown"];
const HOOK_SCOPES = ["parent", "child", "all"];
const HOOK_CLASSES = ["enforced", "advisory", "lifecycle"];
const HOOK_KEYS = "class,interactive,on,path,scope,script,timeoutMs";

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

/** A shared hook copy, or a plugin script under `.pi/navori/scripts` (spec 0048 D13); never a path that climbs out. */
function isPiHookPath(script: string, path: unknown): path is string {
  if (path === `.pi/navori/hooks/${script}.sh`) return true;
  return (
    typeof path === "string" &&
    /^\.pi\/navori\/scripts\/[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(path) &&
    !path.includes("..")
  );
}

/** Strict shape check of one `hooks[]` entry: a script id, a Navori-owned relative path and closed enums. */
function parseManifestHook(raw: unknown): PiManifestHook | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const hook = raw as Record<string, unknown>;
  const keys = Object.keys(hook).sort().join(",");
  if (keys !== HOOK_KEYS && keys !== `${HOOK_KEYS},tools`) return null;
  if (
    typeof hook.script !== "string" ||
    !/^[a-z0-9][a-z0-9-]*$/.test(hook.script) ||
    !isPiHookPath(hook.script, hook.path) ||
    typeof hook.on !== "string" ||
    !HOOK_EVENTS.includes(hook.on) ||
    typeof hook.scope !== "string" ||
    !HOOK_SCOPES.includes(hook.scope) ||
    typeof hook.class !== "string" ||
    !HOOK_CLASSES.includes(hook.class) ||
    typeof hook.interactive !== "boolean" ||
    typeof hook.timeoutMs !== "number" ||
    !Number.isSafeInteger(hook.timeoutMs) ||
    hook.timeoutMs <= 0 ||
    (hook.tools !== undefined && !isStringArray(hook.tools))
  )
    return null;
  return {
    script: hook.script,
    path: hook.path,
    on: hook.on as PiManifestHook["on"],
    ...(hook.tools ? { tools: hook.tools as string[] } : {}),
    scope: hook.scope as PiManifestHook["scope"],
    class: hook.class as PiManifestHook["class"],
    interactive: hook.interactive,
    timeoutMs: hook.timeoutMs,
  };
}

/** Schema version of a manifest that carries Navori's own owner id, or null when it is not one. */
export function piManifestSchemaVersion(content: string): number | null {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const meta = record._navori;
    if (
      typeof meta !== "object" ||
      meta === null ||
      (meta as Record<string, unknown>).id !== OWNER_ID
    )
      return null;
    return typeof record.schemaVersion === "number" ? record.schemaVersion : null;
  } catch {
    return null;
  }
}

/** Validate syntax, exact schema (v1 or v2), ownership id and digest before replacement. */
export function ownsPiManifest(content: string): boolean {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const meta = record._navori;
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return false;
    const owner = meta as Record<string, unknown>;
    if (owner.id !== OWNER_ID || typeof owner.hash !== "string") return false;
    const version = record.schemaVersion;
    if ((version !== 1 && version !== 2) || !isStringArray(record.agents)) return false;
    const keys = Object.keys(record).sort().join(",");
    const base =
      version === 1
        ? ["_navori", "agents"]
        : ["_navori", "agents", "hooks", "ownedPaths", "permissionRules"];
    const allowed = [
      [...base, "schemaVersion"].sort().join(","),
      [...base, "controls", "schemaVersion"].sort().join(","),
    ];
    if (!allowed.includes(keys)) return false;
    let controls: PiManifestPayload["controls"];
    if (record.controls !== undefined) {
      if (
        typeof record.controls !== "object" ||
        record.controls === null ||
        Array.isArray(record.controls)
      )
        return false;
      const raw = record.controls as Record<string, unknown>;
      if (
        Object.keys(raw).sort().join(",") !== "masterPlan,planTiers,scribeOwnsMarkdown" ||
        typeof raw.planTiers !== "boolean" ||
        typeof raw.masterPlan !== "boolean" ||
        typeof raw.scribeOwnsMarkdown !== "boolean"
      )
        return false;
      controls = {
        planTiers: raw.planTiers,
        masterPlan: raw.masterPlan,
        scribeOwnsMarkdown: raw.scribeOwnsMarkdown,
      };
    }
    const common = { agents: record.agents, ...(controls ? { controls } : {}) };
    let payload: PiManifestPayload;
    if (version === 1) {
      payload = { schemaVersion: 1, ...common };
    } else {
      const rules = record.permissionRules;
      if (
        !Array.isArray(record.hooks) ||
        !isStringArray(record.ownedPaths) ||
        typeof rules !== "object" ||
        rules === null ||
        Array.isArray(rules) ||
        Object.keys(rules).sort().join(",") !== "ask,deny" ||
        !isStringArray((rules as Record<string, unknown>).ask) ||
        !isStringArray((rules as Record<string, unknown>).deny)
      )
        return false;
      const hooks = record.hooks.map(parseManifestHook);
      if (hooks.some((hook) => hook === null)) return false;
      payload = {
        schemaVersion: 2,
        ...common,
        hooks: hooks as PiManifestHook[],
        ownedPaths: record.ownedPaths,
        permissionRules: {
          ask: (rules as { ask: string[] }).ask,
          deny: (rules as { deny: string[] }).deny,
        },
      };
    }
    return (
      owner.hash === digest(canonicalPayload(payload)) && content === serializePiManifest(payload)
    );
  } catch {
    return false;
  }
}
