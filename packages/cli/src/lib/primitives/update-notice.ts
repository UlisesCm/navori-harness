import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { safeHomedir } from "./home.ts";
import { writeFileAtomic } from "./atomic.ts";
import { compareSemver } from "./semver.ts";
import { updateNoticeText, resolveLang, type Lang } from "../i18n.ts";

export const UPDATE_NOTICE_WORKER_ARG = "--navori-private-update-worker";
const DAY = 86_400_000;
const MAX_BYTES = 16 * 1024;
const REGISTRY = "https://registry.npmjs.org/navori/latest";
type Stamp = { at: number };
type Attempt = Stamp & { token: string | null };
type Latest = Stamp & { version: string };

function stableVersion(value: unknown): value is string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value))
    return false;
  return value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

function stamp(value: unknown, now: number): value is Stamp {
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

function readState(path: string): unknown {
  try {
    const text = readFileSync(path, "utf8");
    return text.length <= MAX_BYTES ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

function validAttempt(value: unknown, now: number): value is Attempt {
  return (
    stamp(value, now) &&
    "token" in value &&
    (value.token === null ||
      (typeof value.token === "string" && /^[0-9a-f-]{36}$/.test(value.token)))
  );
}

function validLatest(value: unknown, now: number): value is Latest {
  return stamp(value, now) && "version" in value && stableVersion(value.version);
}

function stateDir(): string {
  return join(safeHomedir(), ".navori", "update-notice");
}

function locked<T>(dir: string, action: () => T): T | undefined {
  const lock = join(dir, "lock");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(lock);
  } catch {
    return undefined;
  }
  try {
    return action();
  } finally {
    rmdirSync(lock);
  }
}

function eligible(argv: readonly string[]): boolean {
  if (process.env.NAVORI_NO_UPDATE_NOTIFIER === "1") return false;
  if (process.env.CI && !/^(0|false)$/i.test(process.env.CI)) return false;
  if (!process.stdout.isTTY || !process.stderr.isTTY) return false;
  if (argv.some((arg) => arg === "--json" || arg.startsWith("--json="))) return false;
  if (argv.length === 0 || argv.some((arg) => ["--help", "-h", "--version", "-v"].includes(arg)))
    return false;
  return true;
}

function language(argv: readonly string[]): Lang {
  const index = argv.findIndex((arg) => arg === "--cwd");
  const cwd = index >= 0 ? argv[index + 1] : argv.find((arg) => arg.startsWith("--cwd="))?.slice(6);
  const root = cwd && !cwd.startsWith("-") ? resolve(cwd) : process.cwd();
  try {
    const raw: unknown = JSON.parse(readFileSync(join(root, "navori.config.json"), "utf8"));
    return resolveLang(
      typeof raw === "object" && raw !== null && "language" in raw ? raw.language : undefined,
    );
  } catch {
    return "es";
  }
}

function installer(): string {
  if (process.env.npm_command === "exec" || process.env.npm_command === "npx")
    return "npx navori@latest <command>";
  const prefix = process.env.npm_config_prefix;
  if (
    prefix &&
    resolve(process.argv[1] ?? "").startsWith(
      join(resolve(prefix), "lib", "node_modules", "navori"),
    )
  )
    return "npm i -g navori@latest";
  let dir = process.cwd();
  for (;;) {
    try {
      const raw: unknown = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
      if (typeof raw === "object" && raw !== null) {
        const npm =
          "packageManager" in raw
            ? typeof raw.packageManager === "string" && raw.packageManager.startsWith("npm@")
            : existsSync(join(dir, "package-lock.json"));
        if (!npm) break;
        if (
          "devDependencies" in raw &&
          typeof raw.devDependencies === "object" &&
          raw.devDependencies !== null &&
          "navori" in raw.devDependencies
        )
          return "npm install --save-dev navori@latest";
        if (
          "dependencies" in raw &&
          typeof raw.dependencies === "object" &&
          raw.dependencies !== null &&
          "navori" in raw.dependencies
        )
          return "npm install navori@latest";
      }
    } catch {
      /* keep searching for the nearest manifest */
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "npx navori@latest <command>";
}

/** Reserve optional daily work synchronously; the CLI never waits for registry I/O. */
export function runUpdateNotice(installed: string, argv: readonly string[]): void {
  if (!eligible(argv) || !stableVersion(installed)) return;
  try {
    const dir = stateDir();
    const now = Date.now();
    const result = locked(dir, (): { version?: string; token?: string } => {
      const noticePath = join(dir, "notice.json");
      const attemptPath = join(dir, "attempt.json");
      const latest = readState(join(dir, "latest.json"));
      const previousNotice = readState(noticePath);
      const previousAttempt = readState(attemptPath);
      const outcome: { version?: string; token?: string } = {};
      const canNotice =
        !existsSync(noticePath) || (stamp(previousNotice, now) && now - previousNotice.at >= DAY);
      const canAttempt =
        !existsSync(attemptPath) ||
        (validAttempt(previousAttempt, now) && now - previousAttempt.at >= DAY);
      if (
        validLatest(latest, now) &&
        now - latest.at < DAY &&
        compareSemver(latest.version, installed) === 1 &&
        canNotice
      ) {
        writeFileAtomic(noticePath, JSON.stringify({ at: now }));
        outcome.version = latest.version;
      }
      if (canAttempt) {
        outcome.token = randomUUID();
        writeFileAtomic(attemptPath, JSON.stringify({ at: now, token: outcome.token }));
      }
      return outcome;
    });
    if (!result) return;
    if (result.version)
      process.stderr.write(
        updateNoticeText(language(argv), installed, result.version, installer()),
      );
    if (result.token) {
      const child = spawn(
        process.execPath,
        [process.argv[1]!, UPDATE_NOTICE_WORKER_ARG, result.token],
        {
          detached: true,
          stdio: "ignore",
          shell: false,
        },
      );
      child.on("error", () => {});
      child.unref();
    }
  } catch {
    /* optional notice must not affect commands */
  }
}

/** Consume a one-use reservation before touching the registry. */
export async function runUpdateNoticeWorker(token: string | undefined): Promise<void> {
  if (!token || !/^[0-9a-f-]{36}$/.test(token)) return;
  try {
    const dir = stateDir();
    const claimed = locked(dir, (): boolean => {
      const path = join(dir, "attempt.json");
      const value = readState(path);
      if (!validAttempt(value, Date.now()) || value.token !== token || Date.now() - value.at >= DAY)
        return false;
      writeFileAtomic(path, JSON.stringify({ at: value.at, token: null }));
      return true;
    });
    if (!claimed) return;
    const response = await fetch(REGISTRY, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) {
        await reader.cancel();
        return;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      typeof raw !== "object" ||
      raw === null ||
      !("version" in raw) ||
      !stableVersion(raw.version)
    )
      return;
    writeFileAtomic(
      join(dir, "latest.json"),
      JSON.stringify({ at: Date.now(), version: raw.version }),
    );
  } catch {
    /* offline and cache failures are silent */
  }
}
