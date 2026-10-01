import { createHash } from "node:crypto";
import * as nodeModule from "node:module";

const OWNER_ID = "pi-runtime";

export interface PiManifestPayload {
  schemaVersion: 1;
  agents: readonly string[];
  controls?: {
    planTiers: boolean;
    masterPlan: boolean;
    scribeOwnsMarkdown: boolean;
  };
}

/** A whole-file marker is deliberately outside the TypeScript payload. */
export function serializePiSource(source: string): string {
  const body = source.trim() + "\n";
  return `// navori:managed-file id="pi-extension" hash="${digest(body)}"\n${body}`;
}

/** Refuse to replace a source file changed since the last render. */
export function ownsPiSource(content: string): boolean {
  const match = /^\/\/ navori:managed-file id="pi-extension" hash="([a-f0-9]{64})"\n/.exec(content);
  if (match === null || match[1] !== digest(content.slice(match[0].length))) return false;
  // Pi requires Node 22.19+, while other engines still support older Node.
  if (typeof nodeModule.stripTypeScriptTypes !== "function") return false;
  try {
    nodeModule.stripTypeScriptTypes(content);
    return true;
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

/** Validate syntax, exact schema, ownership id and digest before replacement. */
export function ownsPiManifest(content: string): boolean {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const meta = record._navori;
    if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return false;
    const owner = meta as Record<string, unknown>;
    if (owner.id !== OWNER_ID || typeof owner.hash !== "string") return false;
    if (record.schemaVersion !== 1 || !Array.isArray(record.agents)) return false;
    if (!record.agents.every((agent: unknown) => typeof agent === "string")) return false;
    const keys = Object.keys(record).sort().join(",");
    if (keys !== "_navori,agents,schemaVersion" && keys !== "_navori,agents,controls,schemaVersion")
      return false;
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
    const payload: PiManifestPayload = {
      schemaVersion: 1,
      agents: record.agents as string[],
      ...(controls ? { controls } : {}),
    };
    return (
      owner.hash === digest(canonicalPayload(payload)) && content === serializePiManifest(payload)
    );
  } catch {
    return false;
  }
}
