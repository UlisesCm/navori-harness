/**
 * Shared `--help` / `-h` handling for the scripts that write or compile.
 *
 * Several scripts ignore unknown flags, so `--help` used to run the whole script (a build, a
 * `render --apply`, a file rewrite). Call {@link exitOnHelp} as the first thing the script does,
 * before any side effect, from its entry-point guard (never from `main()` or an argv parser: tests
 * import those).
 */

/**
 * When `argv` holds `--help` or `-h`, prints `usage` to stdout and exits 0; otherwise returns.
 *
 * @param {readonly string[]} argv arguments after the script path (`process.argv.slice(2)`).
 * @param {string} usage the usage text to print, without a trailing newline.
 * @returns {void}
 */
export function exitOnHelp(argv, usage) {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
}
