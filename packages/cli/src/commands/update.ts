import { defineCommand, runCommand } from "citty";
import * as p from "@clack/prompts";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { refreshCommand } from "./refresh.ts";
import { fetchLatestVersion, installPlan } from "../lib/primitives/update-notice.ts";
import { compareSemver } from "../lib/primitives/semver.ts";
import { readCliVersion } from "../lib/render/bundled-assets.ts";
import { brand, dim } from "../lib/primitives/style.ts";
import { tc, resolveLang } from "../lib/i18n.ts";

/** Set on the re-executed binary so a freshly installed CLI never checks/installs again. */
export const UPDATE_REEXEC_ENV = "NAVORI_UPDATE_REEXEC";

interface UpdateArgs {
  cwd?: string;
  yes?: boolean;
  "dry-run"?: boolean;
  "config-only"?: boolean;
  "cli-only"?: boolean;
}

/** The `refresh` flags this `update` invocation forwards (in-process or to the new binary). */
function refreshArgv(args: UpdateArgs, cwd: string): string[] {
  // Always the absolute target: a re-exec may run from another directory (the manifest dir).
  const argv: string[] = ["--cwd", cwd];
  if (args.yes) argv.push("--yes");
  if (args["dry-run"]) argv.push("--dry-run");
  if (args["config-only"]) argv.push("--config-only");
  return argv;
}

/** Run an argv array (never a shell string) with inherited stdio; returns the exit code. */
function run(argv: string[], cwd?: string, env?: NodeJS.ProcessEnv): number {
  const [bin, ...rest] = argv;
  const result = spawnSync(bin!, rest, { stdio: "inherit", shell: false, cwd, env });
  return result.status ?? 1;
}

/**
 * Absolute path of the global `navori` bin, or `undefined` when it cannot be resolved for sure
 * (never fall back to a PATH lookup: `node_modules/.bin` may shadow it with a stale copy).
 */
function globalBin(): string | undefined {
  if (process.platform === "win32") return undefined;
  let prefix = process.env.npm_config_prefix;
  if (!prefix) {
    const r = spawnSync("npm", ["prefix", "-g"], { encoding: "utf8", shell: false });
    if (r.status === 0 && typeof r.stdout === "string") prefix = r.stdout.trim();
  }
  if (!prefix) return undefined;
  const bin = join(resolve(prefix), "bin", "navori");
  return existsSync(bin) ? bin : undefined;
}

/** Language of the target repo's config, `es` when it is missing or unreadable. */
function repoLang(cwd: string): ReturnType<typeof resolveLang> {
  try {
    const raw: unknown = JSON.parse(readFileSync(resolve(cwd, "navori.config.json"), "utf8"));
    return resolveLang(
      typeof raw === "object" && raw !== null && "language" in raw ? raw.language : undefined,
    );
  } catch {
    return resolveLang(undefined);
  }
}

/**
 * `navori update` — bring the CLI itself to the latest npm release, then run `navori refresh`
 * (with the new binary when one was installed). Offline or already current: say so in one line
 * and refresh anyway. Never installs without a confirmation or `--yes`, and never hangs on a
 * prompt without a TTY.
 */
export const updateCommand = defineCommand({
  meta: {
    name: "update",
    description: "Update the navori CLI to the latest release, then run 'navori refresh'",
  },
  args: {
    cwd: { type: "string", description: "Directory (default: cwd)" },
    yes: { type: "boolean", description: "Install and refresh without prompting" },
    "dry-run": {
      type: "boolean",
      description: "Forwarded to refresh: show changes, write nothing",
    },
    "config-only": { type: "boolean", description: "Forwarded to refresh: skip the sync step" },
    "cli-only": { type: "boolean", description: "Only update the CLI; do not run refresh" },
  },
  async run({ args }) {
    const cwd = resolve(args.cwd ?? process.cwd());
    const lang = existsSync(cwd) ? repoLang(cwd) : resolveLang(undefined);
    const t = tc(lang).cliUpdate;
    const forwarded = refreshArgv(args, cwd);
    const refresh = async (): Promise<void> => {
      await runCommand(refreshCommand, { rawArgs: forwarded });
    };

    // A re-executed (already updated) binary goes straight to refresh: no loops.
    if (process.env[UPDATE_REEXEC_ENV] === "1") {
      if (!args["cli-only"]) await refresh();
      return;
    }

    p.intro(brand("update"));
    const current = readCliVersion();
    const latest = await fetchLatestVersion();

    if (!latest) {
      p.log.info(t.offline);
    } else if (compareSemver(latest, current) !== 1) {
      p.log.info(t.upToDate(current));
    }
    if (!latest || compareSemver(latest, current) !== 1) {
      if (args["cli-only"]) {
        p.outro(t.cliOnlyDone);
        return;
      }
      await refresh();
      return;
    }

    const plan = installPlan();
    p.log.info(t.available(current, latest));

    if (!plan.install) {
      // npx always fetches the newest: nothing to install, just run refresh through it.
      if (args["cli-only"]) {
        p.outro(t.cliOnlyDone);
        return;
      }
      const argv = plan.exec(["refresh", ...forwarded]);
      const code = run(argv, undefined, { ...process.env, [UPDATE_REEXEC_ENV]: "1" });
      if (code !== 0) {
        p.log.error(t.reexecFailed);
        process.exitCode = code;
      }
      return;
    }

    const command = plan.install.join(" ");
    p.log.message(dim(t.willRun(command)));

    if (!args.yes) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        p.log.error(t.nonInteractive(command));
        process.exitCode = 1;
        return;
      }
      const ok = await p.confirm({ message: t.confirm(latest), initialValue: true });
      if (p.isCancel(ok) || !ok) {
        p.log.info(t.declined(command));
        return;
      }
    }

    if (run(plan.install, plan.cwd) !== 0) {
      p.log.error(t.installFailed(command));
      process.exitCode = 1;
      return;
    }
    if (args["cli-only"]) {
      p.outro(t.cliOnlyDone);
      return;
    }

    // The running process still holds the old code: refresh with the binary just installed.
    let argv = plan.exec(["refresh", ...forwarded]);
    if (plan.kind === "global") {
      const bin = globalBin();
      if (!bin) {
        p.log.info(t.manualRefresh(`navori refresh ${forwarded.join(" ")}`));
        return;
      }
      argv = [bin, "refresh", ...forwarded];
    }
    const code = run(argv, plan.cwd, {
      ...process.env,
      [UPDATE_REEXEC_ENV]: "1",
    });
    if (code !== 0) {
      p.log.error(t.reexecFailed);
      process.exitCode = code;
    }
  },
});
