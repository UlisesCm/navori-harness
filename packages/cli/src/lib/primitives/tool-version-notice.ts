import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { NavoriConfig } from "../config/config.ts";
import { loadPlugin, type LatestRelease } from "../config/plugins.ts";
import { readCliVersion } from "../render/bundled-assets.ts";
import { writeFileAtomic } from "./atomic.ts";
import { safeHomedir } from "./home.ts";
import {
  DAY,
  locked,
  machineEligible,
  readBoundedJson,
  readState,
  spawnPrivateWorker,
  stableVersion,
  stamp,
  type Stamp,
} from "./remote-version-cache.ts";
import { parseSemver } from "./semver.ts";
import { probeEnabledToolVersions, type ProbeOptions } from "./tool-version-probe.ts";

/**
 * Latest-release notices for opted-in plugin tools (#1244, stage 2 of #1210).
 *
 * Network lives ONLY in the detached worker. Everything the session sees is derived from a
 * validated per-machine cache: the worker's source comes from the bundled manifest by plugin id
 * (never argv or cache), and only `x.y.z` versions and plugin ids are ever echoed.
 */
export const TOOL_VERSION_WORKER_ARG = "--navori-private-tool-version-worker";
/** A cached "latest" older than this is not used to claim anything is current. */
export const LATEST_MAX_AGE_MS = 7 * DAY;
/** Global cap for the installed-version probes on the notice path. */
export const PROBE_BUDGET_MS = 1500;
/** Upper bound of notice lines per session start. */
export const MAX_NOTICES = 3;
const REQUEST_TIMEOUT_MS = 2_000;
const WORKER_SOFT_LIMIT_MS = 3_000;
/** GitHub's `releases/latest` carries release notes (engram: ~16.5 KB), npm's `/latest` does not. */
const BODY_LIMIT = { npm: 16 * 1024, github: 64 * 1024 } as const;
const TOKEN = /^[0-9a-f-]{36}$/;
const PLUGIN_ID = /^[a-z0-9][a-z0-9-]*$/;

/** `ok` carries a validated version; `unparseable` records that upstream's tag could not be read. */
export type LatestEntry = Stamp & { source: string; id: string } & (
    | { status: "ok"; version: string }
    | { status: "unparseable"; version: null }
  );
type Attempt = Stamp & { token: string | null };
type Notice = Stamp & { version: string };

function stateDir(): string {
  return join(safeHomedir(), ".navori", "tool-versions");
}

/** The manifest's release source for a plugin, or `undefined` when it is not opted in. */
function watched(pluginId: string): LatestRelease | undefined {
  if (!PLUGIN_ID.test(pluginId)) return undefined;
  try {
    return loadPlugin(pluginId).manifest.externalTool?.latestRelease;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Enabled plugins of the repo that opted in to release notices, in config order. */
export function watchedPluginIds(config: NavoriConfig): string[] {
  return Object.entries(config.plugins ?? {})
    .filter(([id, settings]) => settings.enabled === true && watched(id))
    .map(([id]) => id);
}

function validAttempt(value: unknown, now: number): value is Attempt {
  return (
    stamp(value, now) &&
    "token" in value &&
    (value.token === null || (typeof value.token === "string" && TOKEN.test(value.token)))
  );
}

/** Validate one cache entry against the CURRENT manifest; anything else is ignored. */
function validEntry(
  pluginId: string,
  value: unknown,
  now: number,
  maxAge: number,
): LatestEntry | undefined {
  const release = watched(pluginId);
  if (!release || !stamp(value, now) || now - value.at >= maxAge) return undefined;
  const entry = value as Stamp & Record<string, unknown>;
  if (entry.source !== release.source || entry.id !== release.id) return undefined;
  if (entry.status === "ok" && stableVersion(entry.version))
    return {
      at: entry.at,
      source: release.source,
      id: release.id,
      status: "ok",
      version: entry.version,
    };
  if (entry.status === "unparseable" && entry.version === null)
    return {
      at: entry.at,
      source: release.source,
      id: release.id,
      status: "unparseable",
      version: null,
    };
  return undefined;
}

/** Fresh, manifest-consistent entries of `latest.json`. */
export function readLatest(now: number, maxAge = LATEST_MAX_AGE_MS): Map<string, LatestEntry> {
  const tools = record(record(readState(join(stateDir(), "latest.json"))).tools);
  const out = new Map<string, LatestEntry>();
  for (const [id, raw] of Object.entries(tools)) {
    const entry = validEntry(id, raw, now, maxAge);
    if (entry) out.set(id, entry);
  }
  return out;
}

/**
 * Reserve a refresh for every watched tool whose daily attempt is due, under one lock, and
 * return the shared one-use token (or `undefined` when nothing is due). A corrupt or
 * future-stamped file fails closed, like the navori notice.
 */
export function reserveRefresh(pluginIds: readonly string[], now: number): string | undefined {
  const dir = stateDir();
  return locked(dir, () => {
    const path = join(dir, "attempts.json");
    const previous = readState(path);
    if (existsSync(path) && typeof previous !== "object") return undefined;
    const attempts: Record<string, Attempt> = {};
    for (const [id, value] of Object.entries(record(previous)))
      if (watched(id) && validAttempt(value, now)) attempts[id] = value;
    const token = randomUUID();
    let reserved = false;
    for (const id of pluginIds) {
      const prior = record(previous)[id];
      if (prior !== undefined && !validAttempt(prior, now)) continue; // future stamp: fail closed
      if (prior !== undefined && now - (prior as Attempt).at < DAY) continue;
      attempts[id] = { at: now, token };
      reserved = true;
    }
    if (!reserved) return undefined;
    writeFileAtomic(path, JSON.stringify(attempts));
    return token;
  });
}

function endpoint(release: LatestRelease): string {
  return release.source === "npm"
    ? `https://registry.npmjs.org/${release.id.replace("/", "%2F")}/latest`
    : `https://api.github.com/repos/${release.id}/releases/latest`;
}

/**
 * Turn a remote body into a cache entry. Raw tags are never stored: either a validated
 * `x.y.z` or `unparseable`. A body that is not an object at all is a transport problem and
 * yields `undefined` (keep the previous cache).
 */
export function entryFromBody(
  release: LatestRelease,
  raw: unknown,
  now: number,
): LatestEntry | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const base = { at: now, source: release.source, id: release.id };
  const body = raw as Record<string, unknown>;
  let version: unknown;
  if (release.source === "npm") version = body.version;
  else if (body.prerelease === false && body.draft === false && typeof body.tag_name === "string")
    version = /^v?(\d+\.\d+\.\d+)$/.exec(body.tag_name)?.[1];
  return stableVersion(version)
    ? { ...base, status: "ok", version }
    : { ...base, status: "unparseable", version: null };
}

/** Worker body: claim this token's tools, then fetch each one (sequential, 2 s per request). */
export async function runToolVersionWorker(token: string | undefined): Promise<void> {
  if (!token || !TOKEN.test(token) || !machineEligible()) return;
  try {
    const dir = stateDir();
    const claimed = locked(dir, (): string[] => {
      const path = join(dir, "attempts.json");
      const now = Date.now();
      const attempts = record(readState(path));
      const mine: string[] = [];
      let touched = false;
      for (const [id, value] of Object.entries(attempts)) {
        if (!validAttempt(value, now) || value.token !== token || now - value.at >= DAY) continue;
        touched = true;
        if (watched(id)) {
          mine.push(id);
          attempts[id] = { at: value.at, token: null };
        } else delete attempts[id];
      }
      if (touched) writeFileAtomic(path, JSON.stringify(attempts));
      return mine;
    });
    if (!claimed || claimed.length === 0) return;
    const fetched: [string, LatestEntry][] = [];
    const started = Date.now();
    for (const id of claimed) {
      if (Date.now() - started > WORKER_SOFT_LIMIT_MS) break; // keeps the whole run under ~5 s
      const release = watched(id);
      if (!release) continue;
      try {
        const response = await fetch(endpoint(release), {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            "user-agent": `navori/${readCliVersion()}`,
            accept:
              release.source === "github" ? "application/vnd.github+json" : "application/json",
          },
        });
        const entry = entryFromBody(
          release,
          await readBoundedJson(response, BODY_LIMIT[release.source]),
          Date.now(),
        );
        if (entry) fetched.push([id, entry]);
      } catch {
        /* offline, 403/429 or a stalled body: keep the previous cache for this tool */
      }
    }
    if (fetched.length === 0) return;
    locked(dir, () => {
      const path = join(dir, "latest.json");
      const now = Date.now();
      const tools: Record<string, LatestEntry> = {};
      // Rewrite from validated entries only: this prunes tools that lost their manifest opt-in.
      for (const [id, entry] of readLatest(now, Infinity)) tools[id] = entry;
      for (const [id, entry] of fetched) tools[id] = entry;
      writeFileAtomic(path, JSON.stringify({ tools }));
    });
  } catch {
    /* optional notice must not affect anything */
  }
}

export interface ToolUpdate {
  pluginId: string;
  binary: string;
  installedVersion: string;
  latestVersion: string;
}

export interface ScanOptions extends ProbeOptions {
  now?: number;
  /** Suppress what `ackToolNotices` already delivered within 24 h (the hook path; doctor shows all). */
  dedupe?: boolean;
}

/** `notify` threshold: is `latest` ahead of `installed` by at least the manifest's level? */
export function meetsNotifyLevel(
  installed: string,
  latest: string,
  notify: LatestRelease["notify"],
): boolean {
  const a = parseSemver(installed);
  const b = parseSemver(latest);
  if (!a || !b) return false;
  if (b.major !== a.major) return b.major > a.major;
  if (notify === "major") return false;
  if (b.minor !== a.minor) return b.minor > a.minor;
  return notify === "patch" && b.patch > a.patch;
}

/**
 * Cache-only relevance scan: no network, no writes. Probes the installed version only of tools
 * with a fresh cached `latest`, so a quiet machine spawns nothing. Opt-out and CI win over any cache.
 */
export function scanToolUpdates(
  config: NavoriConfig,
  { now = Date.now(), dedupe = false, ...probe }: ScanOptions = {},
): { updates: ToolUpdate[]; unparseable: { pluginId: string; source: string; id: string }[] } {
  const empty = { updates: [], unparseable: [] };
  if (!machineEligible()) return empty;
  const latest = readLatest(now);
  const unparseable = [...latest]
    .filter(([id, e]) => e.status === "unparseable" && config.plugins?.[id]?.enabled === true)
    .map(([pluginId, e]) => ({ pluginId, source: e.source, id: e.id }));
  const delivered = dedupe ? record(readState(join(stateDir(), "notice.json"))) : {};
  const updates = probeEnabledToolVersions(
    config,
    (_tool, id) => latest.get(id)?.status === "ok",
    probe,
  ).flatMap((v): ToolUpdate[] => {
    const entry = latest.get(v.pluginId);
    const release = watched(v.pluginId);
    if (!entry || entry.version === null || !release) return [];
    if (!meetsNotifyLevel(v.installedVersion, entry.version, release.notify)) return [];
    const prior = delivered[v.pluginId];
    if (dedupe && prior !== undefined) {
      // An invalid stamp (future or corrupt) suppresses: fail closed, never nag.
      if (!stamp(prior, now)) return [];
      if ((prior as Notice).version === entry.version && now - prior.at < DAY) return [];
    }
    return [
      {
        pluginId: v.pluginId,
        binary: v.binary,
        installedVersion: v.installedVersion,
        latestVersion: entry.version,
      },
    ];
  });
  return { updates, unparseable };
}

/**
 * Hook entry point: reserve due refreshes (spawning the detached worker if any), then return
 * the cache-only notices to deliver. Never throws and never waits for the network.
 */
export function prepareToolNotices(config: NavoriConfig, options: ScanOptions = {}): ToolUpdate[] {
  try {
    if (!machineEligible()) return [];
    const ids = watchedPluginIds(config);
    if (ids.length === 0) return [];
    const token = reserveRefresh(ids, options.now ?? Date.now());
    if (token) spawnPrivateWorker(TOOL_VERSION_WORKER_ARG, token);
    return scanToolUpdates(config, {
      budgetMs: PROBE_BUDGET_MS,
      ...options,
      dedupe: true,
    }).updates.slice(0, MAX_NOTICES);
  } catch {
    return [];
  }
}

/**
 * Stamp delivery of `pluginId@x.y.z` pairs. Every pair is re-validated against the bundled
 * manifest (opted in) and `stableVersion`; invalid pairs are ignored silently. Prunes entries
 * of tools that lost their opt-in.
 */
export function ackToolNotices(pairs: readonly string[], now = Date.now()): void {
  try {
    const dir = stateDir();
    locked(dir, () => {
      const path = join(dir, "notice.json");
      const notices: Record<string, Notice> = {};
      for (const [id, value] of Object.entries(record(readState(path))))
        if (watched(id) && stamp(value, now) && stableVersion((value as Notice).version))
          notices[id] = value as Notice;
      let changed = false;
      for (const pair of pairs) {
        const [id, version, ...rest] = pair.split("@");
        if (rest.length > 0 || !id || !watched(id) || !stableVersion(version)) continue;
        notices[id] = { at: now, version };
        changed = true;
      }
      if (changed) writeFileAtomic(path, JSON.stringify(notices));
    });
  } catch {
    /* ack is best effort: the notice just reappears */
  }
}
