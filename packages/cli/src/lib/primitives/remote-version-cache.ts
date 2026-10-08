import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Shared building blocks of the per-machine remote version caches (navori notice, tool notice). */
export const DAY = 86_400_000;
/** Hard cap when reading a state file; not configurable on purpose. */
export const STATE_MAX_BYTES = 16 * 1024;
/** A lock directory older than this is considered orphaned by a killed process. */
export const LOCK_STALE_MS = 60_000;

export type Stamp = { at: number };

/** Strict `x.y.z` release: no prerelease, no leading zeros, safe integers only. */
export function stableVersion(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    return false;
  return value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

/** A `{ at }` record whose timestamp is not in the future (a rewound clock fails closed). */
export function stamp(value: unknown, now: number): value is Stamp {
  return (
    typeof value === "object" &&
    value !== null &&
    "at" in value &&
    typeof value.at === "number" &&
    Number.isSafeInteger(value.at) &&
    value.at >= 0 &&
    value.at <= now
  );
}

/** Read a small JSON state file; anything oversized, missing or invalid is `undefined`. */
export function readState(path: string): unknown {
  try {
    const text = readFileSync(path, "utf8");
    return text.length <= STATE_MAX_BYTES ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run `action` under a `mkdir` lock in `dir`. A held lock yields `undefined`. A lock older than
 * `staleMs` is removed and also yields `undefined` this run, so the next run acquires it; a lock
 * mtime in the future (clock rewound) counts as fresh. Worst case of the unretried race is one
 * duplicate reservation: the state writes are atomic and the lock only avoids duplicate network.
 */
export function locked<T>(
  dir: string,
  action: () => T,
  { staleMs = LOCK_STALE_MS }: { staleMs?: number } = {},
): T | undefined {
  const lock = join(dir, "lock");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(lock);
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > staleMs) rmdirSync(lock);
    } catch {
      /* lock vanished or cannot be removed: stay closed */
    }
    return undefined;
  }
  try {
    return action();
  } finally {
    rmdirSync(lock);
  }
}

/** Opt-out and CI gate shared by every optional version check (no TTY or argv rules here). */
export function machineEligible(): boolean {
  if (process.env.NAVORI_NO_UPDATE_NOTIFIER === "1") return false;
  if (process.env.CI && !/^(0|false)$/i.test(process.env.CI)) return false;
  return true;
}

/** Read and parse a JSON response, giving up (`undefined`) once it exceeds `maxBytes`. */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!response.ok || !response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** Launch this same CLI as a detached private worker; the caller never waits for it. */
export function spawnPrivateWorker(flag: string, token: string): void {
  const child = spawn(process.execPath, [process.argv[1]!, flag, token], {
    detached: true,
    stdio: "ignore",
    shell: false,
  });
  child.on("error", () => {});
  child.unref();
}
