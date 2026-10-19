import { format } from "node:util";
import { runMain } from "citty";
import { main } from "../../cli.ts";

/** What a CLI run produced; the same shape the spawned runner of `cli.e2e.test.ts` returns. */
export interface CliInProcessResult {
  status: number;
  stdout: string;
  stderr: string;
  combined: string;
}

/** Options of {@link runCliInProcess}. */
export interface CliInProcessOptions {
  /** Working directory for the run; restored afterwards. Defaults to the current one. */
  cwd?: string;
  /** Overrides applied on top of `process.env` for the run; the whole environment is restored afterwards. */
  env?: Record<string, string>;
}

/** Thrown by the intercepted `process.exit` so the code after it does not run, like the real one. */
class CliExit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const CONSOLE_STDOUT = ["log", "info", "debug"] as const;
const CONSOLE_STDERR = ["error", "warn", "trace"] as const;

/**
 * Runs the real CLI (`src/cli.ts`, lazy subcommands included) inside this process (spec 0055 R17):
 * for cases that verify flag parsing, dispatch, `--json` and config errors, not the packaged binary.
 * Same entry as `dist/index.js` minus the update-notice side effects: citty's `runMain` with the
 * given `rawArgs`, so help, version and error paths print and exit like the real one.
 *
 * `process.stdout`/`stderr` and `console` are captured, `process.exit` is intercepted (the first
 * code wins and later output is dropped, as if the process had ended) and `process.exitCode` is
 * folded into `status`. `cwd` and `env` are restored in a `finally`; a run never leaves an exit
 * code behind. Runs must not overlap: they share the process.
 *
 * @param args CLI arguments, without the binary name
 * @param options working directory and environment overrides
 * @returns exit status plus captured output
 */
export async function runCliInProcess(
  args: readonly string[],
  options: CliInProcessOptions = {},
): Promise<CliInProcessResult> {
  const savedCwd = process.cwd();
  const savedEnv = { ...process.env };
  const savedExitCode = process.exitCode;
  const savedExit = process.exit;
  const savedStdoutWrite = process.stdout.write;
  const savedStderrWrite = process.stderr.write;
  const savedConsole = new Map<string, unknown>();
  let stdout = "";
  let stderr = "";
  let exited: number | undefined;

  const sink = (stream: "out" | "err") => (chunk: unknown) => {
    if (exited !== undefined) return true;
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString();
    if (stream === "out") stdout += text;
    else stderr += text;
    return true;
  };
  const consoleSink =
    (stream: "out" | "err") =>
    (...parts: unknown[]): void => {
      sink(stream)(`${format(...parts)}\n`);
    };

  try {
    if (options.cwd !== undefined) process.chdir(options.cwd);
    Object.assign(process.env, { NO_COLOR: "1", ...options.env });
    process.exitCode = undefined;
    process.exit = ((code?: number | string | null) => {
      const status = Number(code ?? process.exitCode ?? 0);
      exited ??= status;
      throw new CliExit(status);
    }) as typeof process.exit;
    process.stdout.write = sink("out") as typeof process.stdout.write;
    process.stderr.write = sink("err") as typeof process.stderr.write;
    for (const name of CONSOLE_STDOUT) {
      savedConsole.set(name, console[name]);
      console[name] = consoleSink("out");
    }
    for (const name of CONSOLE_STDERR) {
      savedConsole.set(name, console[name]);
      console[name] = consoleSink("err");
    }

    try {
      await runMain(main, { rawArgs: [...args] });
    } catch (error) {
      if (!(error instanceof CliExit)) throw error;
    }
    const status = exited ?? Number(process.exitCode ?? 0);
    return { status, stdout, stderr, combined: stdout + stderr };
  } finally {
    for (const [name, original] of savedConsole) {
      (console as unknown as Record<string, unknown>)[name] = original;
    }
    process.stdout.write = savedStdoutWrite;
    process.stderr.write = savedStderrWrite;
    process.exit = savedExit;
    process.exitCode = savedExitCode;
    process.chdir(savedCwd);
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, savedEnv);
  }
}
