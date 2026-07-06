import * as p from "@clack/prompts";
import { readConfig, ConfigError, type NavoriConfig } from "./config.ts";
import { NavoriError } from "./errors.ts";

/**
 * `readConfig` for command entry points. On a domain error (invalid or missing
 * config) it prints a clean, actionable message — the same shape `doctor` and
 * `status` already show — and exits 1, instead of letting citty's `runMain`
 * dump a raw stack trace. `render`/`sync`/`update`/`configure` called the bare
 * `readConfig` and so surfaced cryptic stacks for the exact same broken config
 * that `doctor` reported legibly. Issue #70.
 */
export function readConfigOrExit(path: string): NavoriConfig {
  try {
    return readConfig(path);
  } catch (err) {
    if (err instanceof ConfigError) {
      p.cancel(err.message);
      for (const issue of err.issues ?? []) {
        console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
      }
      process.exit(1);
    }
    if (err instanceof NavoriError) {
      p.cancel(err.message);
      process.exit(1);
    }
    throw err;
  }
}
