import * as p from "@clack/prompts";
import { parseArgs, type ArgsDef, type ParsedArgs } from "citty";
import { NavoriError } from "./errors.ts";

/**
 * Strict non-negative integer parse for numeric CLI flags (`--depth`, `--limit`).
 * Throws NavoriError (code "invalid-flag") on NaN / negative / non-integer input.
 *
 * Without this, `Number("abc")` yields NaN and slips through downstream: `??`
 * only catches null/undefined so `NaN ?? 4 === NaN` (→ `depth >= NaN` is always
 * false → unlimited scan), and `slice(0, NaN)` treats NaN as 0 (→ silently empty
 * list). See #283.
 */
export function parsePositiveInt(raw: string, flag: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new NavoriError("invalid-flag", `--${flag} must be a non-negative integer, got '${raw}'`);
  }
  return n;
}

/**
 * Command-boundary wrapper for an optional numeric flag. Returns `fallback` when
 * the flag is absent; on invalid input prints a clean cancel and exits 1 (the
 * pattern commands already use for user errors), instead of letting citty dump a
 * raw stack trace or letting NaN through silently.
 */
export function intFlagOrExit(raw: unknown, flag: string, fallback?: number): number | undefined {
  if (raw === undefined || raw === null || raw === "") return fallback;
  try {
    return parsePositiveInt(String(raw), flag);
  } catch (err) {
    if (err instanceof NavoriError) {
      p.cancel(err.message);
      process.exit(1);
    }
    throw err;
  }
}

/**
 * True when `key` is the camelCase alias citty (>= 0.2) adds to the parsed
 * `args` for a declared kebab-case arg (`byEngine` beside `by-engine`). Citty
 * adds aliases only for declared names, so a key that is neither declared nor
 * such an alias is a genuinely unknown flag.
 */
export function isCittyCamelAlias(key: string, declared: Iterable<string>): boolean {
  for (const name of declared) {
    if (name !== key && name.replace(/-+([a-z0-9])/g, (_, c: string) => c.toUpperCase()) === key)
      return true;
  }
  return false;
}

/**
 * citty >= 0.2 keeps only the LAST value of a repeated flag (`--start a --start b`
 * yields `"b"`), where 0.1 returned an array. Commands that reject repeated
 * identity flags need the array back: rebuild it from `rawArgs` for every declared
 * `string`/`boolean` arg seen more than once (before any `--`), under both the
 * kebab-case name and its camelCase alias. Other keys pass through untouched.
 */
export function restoreRepeatedFlags<T extends object>(
  args: T,
  rawArgs: readonly string[],
  defs: Readonly<Record<string, { readonly type?: string }>>,
): T {
  const out = { ...args } as Record<string, unknown>;
  const end = rawArgs.indexOf("--");
  const tokens = end === -1 ? rawArgs : rawArgs.slice(0, end);
  for (const [name, def] of Object.entries(defs)) {
    const isString = def.type === "string";
    if (!isString && def.type !== "boolean") continue;
    const camel = name.replace(/-+([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    const values: unknown[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i] ?? "";
      if (token === `--${name}` || token === `--${camel}`) {
        values.push(isString ? (tokens[i + 1] ?? "") : true);
        if (isString) i++;
      } else if (token.startsWith(`--${name}=`) || token.startsWith(`--${camel}=`)) {
        values.push(token.slice(token.indexOf("=") + 1));
      }
    }
    if (values.length > 1) {
      out[name] = values;
      out[camel] = values;
    }
  }
  // Typed like citty types `args` (single values); repeats surface as arrays at runtime, as in 0.1.
  return out as T;
}

/**
 * citty >= 0.2 lets a string flag with an OPTIONAL value swallow the next flag
 * (`--diff --cwd x` yields `diff: "--cwd"` and drops `--cwd`), where 0.1 gave
 * `diff: ""`. Rewrite each bare occurrence (end of input or followed by another
 * flag) to `--name=` and re-parse with citty so the rest keeps its meaning.
 * Returns `args` untouched when nothing needed rewriting.
 */
export function reparseBareValueFlags<D extends ArgsDef>(
  args: ParsedArgs<D>,
  rawArgs: readonly string[],
  defs: D,
  optionalValue: readonly string[],
): ParsedArgs<D> {
  const fixed = rawArgs.map((token, i) => {
    const next = rawArgs[i + 1];
    const bare = optionalValue.some((name) => token === `--${name}`);
    return bare && (next === undefined || next.startsWith("-")) ? `${token}=` : token;
  });
  if (fixed.every((token, i) => token === rawArgs[i])) return args;
  return parseArgs<D>(fixed, defs);
}
