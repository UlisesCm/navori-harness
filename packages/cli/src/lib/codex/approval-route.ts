/** Non-authorizing PR-create requests: local claims mediate, never grant permission. */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, realpathSync, writeSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { contentIdentity } from "../primitives/content-identity.ts";
import {
  ensureStateDirectory,
  stateArtifactPath,
  writeStateFileAtomic,
  type StateRoot,
} from "../primitives/state-root.ts";

const LIMIT = 64 * 1024;
const TIMEOUT = 5_000;
const text = z
  .string()
  .min(1)
  .max(512)
  .refine((value) =>
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
const branch = text.regex(/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/).refine((value) => !value.includes(".."));
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const actionSchema = z.strictObject({
  repo: text.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/),
  base: branch,
  head: branch,
  title: text,
  bodyFile: text.refine((value) => !isAbsolute(value) && !value.split(/[\\/]/).includes("..")),
  draft: z.boolean(),
});
const requestSchema = z.strictObject({
  version: z.literal(1),
  id: z.uuid(),
  action: z.literal("github.pr.create"),
  checkout: text,
  createdAt: z.number().int().positive(),
  fields: actionSchema,
  commandDigest: digest,
  bodyDigest: digest,
  head: text,
  base: text.nullable(),
  fingerprint: digest,
  origin: z.strictObject({
    session: text.optional(),
    tool: text.optional(),
    child: text.optional(),
  }),
  source: z.literal("unavailable"),
  hostVersion: z.literal("unknown"),
  surface: z.literal("command-hooks; authenticated consent unverified"),
});
const inputSchema = z
  .object({
    cwd: text,
    tool_name: z.enum(["Bash", "exec_command", "functions.exec_command"]),
    tool_input: z.strictObject({ command: z.string().min(1).max(LIMIT) }),
    session_id: text.optional(),
    tool_use_id: text.optional(),
    agent_id: text.optional(),
    subagent_id: text.optional(),
  })
  .refine(
    (value) =>
      !["approved", "human", "consent", "authorization", "source"].some((key) => key in value),
  );
type Action = z.infer<typeof actionSchema>;
type Request = z.infer<typeof requestSchema>;

/** Pending output has no allowed/verified state and cannot execute external effects. */
export interface ApprovalPending {
  status: "pending";
  reason: string;
  requestId?: string;
  mediation?: "claimed" | "already-claimed";
  fields?: Action;
  reviewCommand?: string;
  fingerprint?: string;
  remoteState?: "unverified";
}
const pending = (reason: string): ApprovalPending => ({ status: "pending", reason });
const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** Builds display-only shell text; no code path evaluates it. */
function reviewCommand(fields: Action): string {
  return `gh pr create --repo ${quote(fields.repo)} --base ${quote(fields.base)} --head ${quote(fields.head)} --title ${quote(fields.title)} --body-file ${quote(fields.bodyFile)}${fields.draft ? " --draft" : ""}`;
}

/** Literal tokens only: reject shell operators, expansions and ambiguous quoting. */
function parseAction(command: string): Action {
  if (/[\r\n$`;&|<>\\]/.test(command)) throw new Error("unsupported-shape");
  const tokens = command.match(/'[^']*'|"[^"]*"|[^\s'"]+/g) ?? [];
  if (tokens.join(" ") !== command.trim().replace(/\s+/g, " "))
    throw new Error("unsupported-shape");
  const words = tokens.map((token) => (/^["']/.test(token) ? token.slice(1, -1) : token));
  if (words.slice(0, 3).join(" ") !== "gh pr create") throw new Error("unsupported-shape");
  const fields: Record<string, unknown> = { draft: false };
  const flags: Record<string, string> = {
    "--repo": "repo",
    "--base": "base",
    "--head": "head",
    "--title": "title",
    "--body-file": "bodyFile",
  };
  const seen = new Set<string>();
  for (let i = 3; i < words.length; i++) {
    const flag = words[i]!;
    if (seen.has(flag)) throw new Error("unsupported-shape");
    seen.add(flag);
    if (flag === "--draft") fields.draft = true;
    else {
      const key = flags[flag];
      const value = words[++i];
      if (!key || !value || value.startsWith("--")) throw new Error("unsupported-shape");
      fields[key] = value;
    }
  }
  const parsed = actionSchema.safeParse(fields);
  if (!parsed.success) throw new Error("unsupported-shape");
  return parsed.data;
}

/** Metadata Git calls share the operation deadline and disable project hooks/fsmonitor. */
function git(cwd: string, args: string[], deadline: number): string {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("timeout");
  const result = spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: remaining,
      maxBuffer: LIMIT,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    },
  );
  if (result.error || result.status !== 0) throw new Error("metadata-unavailable");
  return result.stdout.trim();
}

/** Reject lexical symlinks before using checkout-contained state primitives. */
function physical(path: string): string {
  const absolute = resolve(path);
  let current: string = sep;
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("unsafe-path");
  }
  return realpathSync(absolute);
}

/** Bounded checkout resolution avoids the legacy resolver's unbounded synchronous Git. */
function stateRoot(cwd: string, deadline: number): StateRoot {
  const requested = physical(cwd);
  const checkout = physical(git(requested, ["rev-parse", "--show-toplevel"], deadline));
  const rel = relative(checkout, requested);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("unsafe-path");
  const root: StateRoot = {
    cwd: checkout,
    dir: ".navori/state/handoffs",
    path: resolve(checkout, ".navori/state/handoffs"),
    kind: "neutral",
  };
  stateArtifactPath(root, "approval-check.json");
  return root;
}

/** Only bounded regular files inside the physical checkout are read. */
function boundedFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > LIMIT) throw new Error("unsafe-or-large-file");
  const bytes = readFileSync(path);
  if (bytes.length > LIMIT) throw new Error("unsafe-or-large-file");
  return bytes;
}

/** Revalidates the body, selected head, local content and locally known base; not remote state. */
function binding(
  root: StateRoot,
  fields: Action,
  deadline: number,
): Pick<Request, "head" | "base" | "fingerprint" | "bodyDigest"> {
  if (git(root.cwd, ["branch", "--show-current"], deadline) !== fields.head)
    throw new Error("head-mismatch");
  const body = physical(resolve(root.cwd, fields.bodyFile));
  const rel = relative(root.cwd, body);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("unsafe-path");
  const bodyDigest = hash(boundedFile(body));
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("timeout");
  const identity = contentIdentity(root.cwd, { target: fields.base, timeoutMs: remaining });
  if (!identity.ok) throw new Error(identity.reason);
  if (Date.now() >= deadline) throw new Error("timeout");
  return {
    head: identity.head,
    base: identity.base,
    fingerprint: identity.fingerprint,
    bodyDigest,
  };
}

/** Creates a concrete pending request, never a grant. Input provenance is caller supplied. */
export function requestApproval(raw: string): ApprovalPending {
  const deadline = Date.now() + TIMEOUT;
  try {
    if (Buffer.byteLength(raw) > LIMIT) return pending("oversized-input");
    const input = inputSchema.parse(JSON.parse(raw) as unknown);
    // Check raw keys before Zod strips ordinary host metadata; assertions are not consent.
    const original = JSON.parse(raw) as Record<string, unknown>;
    if (["approved", "human", "consent", "authorization", "source"].some((key) => key in original))
      return pending("untrusted-assertion");
    const fields = parseAction(input.tool_input.command);
    const root = stateRoot(input.cwd, deadline);
    const request: Request = {
      version: 1,
      id: randomUUID(),
      action: "github.pr.create",
      checkout: root.cwd,
      createdAt: Date.now(),
      fields,
      commandDigest: hash(reviewCommand(fields)),
      ...binding(root, fields, deadline),
      origin: {
        session: input.session_id,
        tool: input.tool_use_id,
        child: input.agent_id ?? input.subagent_id,
      },
      source: "unavailable",
      hostVersion: "unknown",
      surface: "command-hooks; authenticated consent unverified",
    };
    writeStateFileAtomic(root, `approval_${request.id}.json`, JSON.stringify(request));
    return { ...pending("source-unavailable"), requestId: request.id };
  } catch {
    return pending("unsupported-or-unavailable");
  }
}

/** Returns a usable read-only summary even to claim losers; exclusivity is mediation only. */
export function relayApproval(id: string, cwd: string): ApprovalPending {
  const deadline = Date.now() + TIMEOUT;
  try {
    if (!z.uuid().safeParse(id).success) return pending("invalid-request-id");
    const root = stateRoot(cwd, deadline);
    const path = stateArtifactPath(root, `approval_${id}.json`);
    const bytes = boundedFile(path);
    const request = requestSchema.parse(JSON.parse(bytes.toString("utf8")) as unknown);
    if (
      request.id !== id ||
      request.checkout !== root.cwd ||
      request.createdAt > Date.now() ||
      Date.now() - request.createdAt > 15 * 60_000
    )
      return pending("stale-request");
    if (request.commandDigest !== hash(reviewCommand(request.fields)))
      return pending("stale-request");
    const current = binding(root, request.fields, deadline);
    if (Object.entries(current).some(([key, value]) => value !== request[key as keyof Request]))
      return pending("stale-request");
    ensureStateDirectory(root);
    const claim = stateArtifactPath(root, `approval_${id}.claim`);
    let mediation: "claimed" | "already-claimed" = "claimed";
    try {
      const fd = openSync(claim, "wx", 0o600);
      try {
        writeSync(fd, hash(bytes));
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      mediation = "already-claimed";
    }
    // Cooperating claims never authorize; recheck bytes and content after ownership.
    if (
      !boundedFile(path).equals(bytes) ||
      JSON.stringify(binding(root, request.fields, deadline)) !== JSON.stringify(current)
    )
      return pending("stale-request");
    return {
      ...pending("source-unavailable"),
      requestId: id,
      mediation,
      fields: request.fields,
      reviewCommand: reviewCommand(request.fields),
      fingerprint: request.fingerprint,
      remoteState: "unverified",
    };
  } catch {
    return pending("malformed-stale-or-unavailable");
  }
}

/** Valid PreToolUse denial for all pending outcomes, including unsupported inputs. */
export function approvalDeny(result: ApprovalPending): object {
  const route = result.requestId
    ? ` Pending request ${result.requestId}; relay with navori codex approval relay ${result.requestId} --cwd <checkout>.`
    : " Prepare a fresh canonical request for review; do not retry the denied effect.";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `[navori] PR create remains pending (${result.reason}). No authenticated consent source is available in the inspected command-hook surface.${route} The principal must show the reviewed fields and ask the human to run the command; local claims are not authorization.`,
    },
  };
}
