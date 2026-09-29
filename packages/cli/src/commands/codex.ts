import { defineCommand } from "citty";
import * as p from "@clack/prompts";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { readConfig, ConfigError, type NavoriConfig } from "../lib/config/config.ts";
import { tc, resolveLang } from "../lib/i18n.ts";
import { resolveCodexHooks } from "../engines/codex/hook-registrations.ts";
import { loadEnabledPlugins } from "../lib/config/plugins.ts";
import {
  defaultCodexHomeConfigPath,
  isValidToml,
  planTrustEdit,
  projectCodexHooksMatch,
  readCodexTrustState,
  type CodexTrustState,
} from "../lib/codex/trust.ts";
import {
  enabledMonorepoWorkspaces,
  effectiveConfigForWorkspace,
} from "../lib/workspace/monorepo.ts";
import { backupRoot } from "../lib/render/backup.ts";
import { hasBinary } from "../lib/primitives/which.ts";
import { brand, dim, color, sym } from "../lib/primitives/style.ts";

/** One render target (root, or a monorepo workspace) with `codex` enabled. */
interface TrustTarget {
  readonly label: string;
  readonly cwd: string;
  readonly config: NavoriConfig;
  readonly wsSubpath: string;
}

/** Root + every enabled monorepo workspace whose effective config still
 *  carries the `codex` engine (spec 0035 D9: each has its own
 *  `.codex/config.toml`, activated only when a session starts inside it). */
function collectTargets(repoCwd: string, rootConfig: NavoriConfig): TrustTarget[] {
  const targets: TrustTarget[] = [];
  if (rootConfig.engines.includes("codex")) {
    targets.push({ label: ".", cwd: repoCwd, config: rootConfig, wsSubpath: "" });
  }
  for (const ws of enabledMonorepoWorkspaces(rootConfig)) {
    const wsConfig = effectiveConfigForWorkspace(rootConfig, ws);
    if (!wsConfig.engines.includes("codex")) continue;
    targets.push({
      label: ws.path,
      cwd: resolve(repoCwd, ws.path),
      config: wsConfig,
      wsSubpath: ws.path.split(sep).join("/"),
    });
  }
  return targets;
}

/** Codex keys trust at the git root (worktrees inherit it) — spec 0035 D9. */
function gitRootOf(cwd: string): string {
  try {
    const out = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return resolve(cwd);
  }
}

function trustStateFor(
  gitRoot: string,
  target: TrustTarget,
  codexHomeConfigPath: string,
): CodexTrustState {
  const configTomlPath = join(target.cwd, ".codex", "config.toml");
  const hooks = resolveCodexHooks(target.config, loadEnabledPlugins(target.config.plugins).loaded);
  return readCodexTrustState(gitRoot, configTomlPath, hooks, {
    codexHomeConfigPath,
    wsSubpath: target.wsSubpath,
  });
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`
  );
}

/** One hook Codex's `hooks/list` reports back, matched by its trust key. */
export interface CodexTrustVerifyEntry {
  readonly key: string;
  readonly trusted: boolean;
}

/** Best-effort JSON-RPC probe: `codex app-server` → initialize → initialized
 *  → `hooks/list`. Returns `null` when the binary is missing, the call fails
 *  or times out — NEVER throws, NEVER blocks the command (spec 0035 D9's
 *  post-write verification is optional by design). The response schema is
 *  read defensively (any object with a string `key`), since it's read-only
 *  probing of an external, evolving tool. */
export type CodexTrustVerifier = (
  cwd: string,
  timeoutMs?: number,
) => Promise<CodexTrustVerifyEntry[] | null>;

function isJsonRpcResponse(value: unknown, id: number): value is { id: number; result?: unknown } {
  return typeof value === "object" && value !== null && (value as { id?: unknown }).id === id;
}

function extractVerifyEntries(result: unknown): CodexTrustVerifyEntry[] {
  const entries: CodexTrustVerifyEntry[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      if (typeof obj.key === "string") {
        entries.push({ key: obj.key, trusted: obj.status === "Trusted" || obj.trusted === true });
      }
      for (const v of Object.values(obj)) visit(v);
    }
  };
  visit(result);
  return entries;
}

export const defaultVerify: CodexTrustVerifier = (cwd, timeoutMs = 5000) => {
  if (!hasBinary("codex")) return Promise.resolve(null);
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value: CodexTrustVerifyEntry[] | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // already dead
      }
      resolvePromise(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      clearTimeout(timer);
      resolvePromise(null);
      return;
    }
    let buffer = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      let idx: number;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (isJsonRpcResponse(msg, 2)) {
          finish(extractVerifyEntries(msg.result));
          return;
        }
      }
    });
    child.on("error", () => finish(null));
    child.on("exit", () => finish(null));
    const send = (obj: unknown): void => {
      child.stdin?.write(`${JSON.stringify(obj)}\n`);
    };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    send({ jsonrpc: "2.0", method: "initialized", params: {} });
    send({ jsonrpc: "2.0", id: 2, method: "hooks/list", params: { cwds: [cwd] } });
  });
};

/** Everything `trust`'s `run()` needs beyond its own args — injectable so
 *  tests never spawn a real `codex` process. */
export interface RunCodexTrustOptions {
  readonly yes?: boolean;
  readonly verify?: CodexTrustVerifier;
}

/**
 * Core logic of `navori codex trust` (spec 0035 T9), separated from citty's
 * `run()` so it's directly callable/testable. Approves the current project's
 * (root + every codex workspace's) Codex hooks in `~/.codex/config.toml`
 * after an explicit confirmation. Exits the process (never throws) on every
 * abort path, matching the rest of the CLI's command convention.
 */
export async function runCodexTrust(
  cwd: string,
  options: RunCodexTrustOptions = {},
): Promise<void> {
  const configPath = join(cwd, "navori.config.json");
  if (!existsSync(configPath)) {
    p.cancel(`No navori.config.json at ${configPath}`);
    process.exit(1);
  }
  let rootConfig: NavoriConfig;
  try {
    rootConfig = readConfig(configPath);
  } catch (err) {
    p.cancel(err instanceof ConfigError ? err.message : String(err));
    process.exit(1);
  }
  const lang = resolveLang(rootConfig.language);
  const tx = tc(lang).codex;
  const targets = collectTargets(cwd, rootConfig);
  if (targets.length === 0) {
    p.cancel(tx.noCodexEngine);
    process.exit(1);
  }

  const gitRoot = gitRootOf(cwd);
  const codexHomeConfigPath = defaultCodexHomeConfigPath();
  for (const target of targets) {
    const configPath = join(target.cwd, ".codex", "config.toml");
    const hooks = resolveCodexHooks(
      target.config,
      loadEnabledPlugins(target.config.plugins).loaded,
    );
    if (!projectCodexHooksMatch(configPath, hooks, target.wsSubpath)) {
      p.cancel(
        `Los hooks de ${configPath} difieren del render propuesto; ejecuta navori render antes de aprobar trust.`,
      );
      process.exit(1);
    }
  }
  const states = targets.map((target) => ({
    target,
    state: trustStateFor(gitRoot, target, codexHomeConfigPath),
  }));
  // Snapshot taken at the moment the table/confirmation is shown to the user
  // — re-read right before writing and compared against THIS, so a change
  // that lands during the confirmation (a concurrent `/hooks` approval,
  // another `navori codex trust` run) aborts the write (spec 0035 D9).
  const shownText = existsSync(codexHomeConfigPath)
    ? readFileSync(codexHomeConfigPath, "utf-8")
    : "";

  p.intro(brand("codex trust"));

  const rows: string[] = [];
  let approved = 0;
  let total = 0;
  for (const { target, state } of states) {
    rows.push(`  ${dim(target.label)}${state.projectTrusted ? "" : dim(" (project not trusted)")}`);
    for (const hook of state.hooks) {
      total += 1;
      if (hook.status === "Trusted") approved += 1;
      const marker = hook.status === "Trusted" ? color.green(sym.ok) : color.yellow(sym.update);
      const matcher = hook.matcher ? ` (${hook.matcher})` : "";
      rows.push(`    ${marker} ${hook.event}${matcher} — ${hook.script} [${hook.status}]`);
    }
  }
  p.note(rows.join("\n"), tx.tableTitle(gitRoot));
  p.log.info(tx.alreadyApproved(approved, total));

  const allTrusted = states.every(
    ({ state }) => state.projectTrusted && state.hooks.every((h) => h.status === "Trusted"),
  );
  if (allTrusted) {
    p.outro(tx.nothingToDo);
    return;
  }

  if (!options.yes) {
    if (process.stdin.isTTY !== true) {
      p.cancel(tx.nonInteractive);
      process.exit(1);
    }
    const ok = await p.confirm({ message: tx.confirmPrompt });
    if (p.isCancel(ok) || !ok) {
      p.cancel(tx.aborted);
      process.exit(1);
    }
  }

  const current = existsSync(codexHomeConfigPath) ? readFileSync(codexHomeConfigPath, "utf-8") : "";
  if (current !== shownText) {
    p.cancel(tx.changedMeanwhile);
    process.exit(1);
  }
  for (const { target } of states) {
    const configPath = join(target.cwd, ".codex", "config.toml");
    const hooks = resolveCodexHooks(
      target.config,
      loadEnabledPlugins(target.config.plugins).loaded,
    );
    if (!projectCodexHooksMatch(configPath, hooks, target.wsSubpath)) {
      p.cancel(
        `Los hooks de ${configPath} cambiaron durante la confirmación; ejecuta navori render antes de aprobar trust.`,
      );
      process.exit(1);
    }
  }

  let text = current;
  for (const { state } of states) {
    text = planTrustEdit(text, state).text;
  }
  if (!isValidToml(text)) {
    p.cancel(tx.invalidResult);
    process.exit(1);
  }

  mkdirSync(backupRoot(), { recursive: true });
  const backupPath = join(backupRoot(), `codex-config-${timestamp()}.toml`);
  if (existsSync(codexHomeConfigPath)) copyFileSync(codexHomeConfigPath, backupPath);

  const mode = existsSync(codexHomeConfigPath) ? statSync(codexHomeConfigPath).mode & 0o777 : 0o600;
  mkdirSync(dirname(codexHomeConfigPath), { recursive: true });
  const tmpPath = `${codexHomeConfigPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, text, { mode });
  renameSync(tmpPath, codexHomeConfigPath);

  p.log.success(tx.written(backupPath));

  const verify = options.verify ?? defaultVerify;
  const verified = await verify(cwd);
  if (verified === null) {
    p.log.info(tx.verificationSkipped);
  } else {
    const ourKeys = new Set(states.flatMap(({ state }) => state.hooks.map((h) => h.key)));
    const stillUntrusted = verified.filter((e) => ourKeys.has(e.key) && !e.trusted);
    if (stillUntrusted.length > 0) {
      p.log.warn(tx.verificationFoundUntrusted(stillUntrusted.length));
    } else {
      p.log.success(tx.verificationOk);
    }
  }

  p.outro(tx.done);
}

const trustSubCommand = defineCommand({
  meta: {
    name: "trust",
    description: "Approve this project's Codex hooks in ~/.codex/config.toml",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
    yes: { type: "boolean", description: "Skip the confirmation (non-interactive)" },
  },
  async run({ args }) {
    const cwd = resolve((args.cwd as string | undefined) ?? process.cwd());
    await runCodexTrust(cwd, { yes: Boolean(args.yes) });
  },
});

export const codexCommand = defineCommand({
  meta: {
    name: "codex",
    description: "Codex-specific commands",
  },
  subCommands: {
    trust: trustSubCommand,
  },
});
