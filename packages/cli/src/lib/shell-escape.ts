/**
 * Shell-escaping for config values that land INSIDE a generated `.sh` file.
 *
 * `navori.config.json` is checked-in and editable via PR, so it is NOT a
 * trusted source: a hostile `branchBase` / `qualityGate.fast` must never be
 * able to break out of its string context in a rendered hook and inject a
 * command that then runs on every Bash the agent issues (guard-destructive.sh
 * runs in PreToolUse). See issue #197.
 */

/**
 * Wrap an arbitrary string as a single POSIX shell token, safe to inline into
 * a generated shell script. Uses single-quote quoting: everything between the
 * quotes is literal (no expansion, no word-splitting, no command substitution),
 * and an embedded `'` is emitted as `'\''` — close the quote, an escaped literal
 * quote, reopen the quote.
 *
 * A hostile value such as `x'; touch /tmp/pwned; :'` renders as
 * `'x'\''; touch /tmp/pwned; :'\'''` — the shell reads it as ONE literal string
 * and never executes the injected command. The result always includes its own
 * surrounding quotes, so templates must NOT wrap the placeholder themselves
 * (write `base={{shq:branchBase}}`, not `base="{{shq:branchBase}}"`).
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
