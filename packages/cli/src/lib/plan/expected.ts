/** Structured predicates are whole-string forms; ordinary prose retains its legacy meaning. */
export type ExpectedSpec =
  | { kind: "free" }
  | { kind: "exit"; code: number }
  | { kind: "contains"; text: string }
  | { kind: "matches"; source: string; flags: string }
  | { kind: "invalid"; reason: string };

export interface ExpectedObservation {
  exit?: number;
  expected?: string;
  outcome?: "pass" | "fail" | "unevaluated";
}

/** Compile regex syntax only. Acceptance validation never reads or executes tool output. */
export function parseExpected(text: string): ExpectedSpec {
  const exit = /^exit (0|[1-9]\d{0,2})$/.exec(text);
  if (exit && exit[0] === text && Number(exit[1]) <= 255)
    return { kind: "exit", code: Number(exit[1]) };
  if (/^exit [-+]?\d+$/.test(text))
    return {
      kind: "invalid",
      reason: "exit code must be an integer from 0 to 255 without leading zeros",
    };
  const contains = /^contains: (.+)$/.exec(text);
  if (contains && contains[0] === text) return { kind: "contains", text: contains[1]! };
  if (text.startsWith("contains:"))
    return { kind: "invalid", reason: "contains: requires one nonempty literal line" };
  if (text.startsWith("matches:")) {
    const match = /^matches: \/(.+)\/([imsu]*)$/.exec(text);
    if (match && match[0] === text) {
      try {
        new RegExp(match[1]!, match[2]!); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- syntax check only on an author-owned workplan; never run against input
        return { kind: "matches", source: match[1]!, flags: match[2]! };
      } catch {
        /* Invalid syntax and repeated flags are never downgraded to prose. */
      }
    }
    return {
      kind: "invalid",
      reason: "matches: requires a valid /pattern/ with only i, m, s and u flags",
    };
  }
  return { kind: "free" };
}

/** A missing legacy exit means success: all historical evidence lanes recorded only host-confirmed exit 0. */
export function expectedEvidenceProblem(
  expected: string,
  observation: ExpectedObservation,
): string | undefined {
  const spec = parseExpected(expected);
  if (spec.kind === "invalid") return "invalid structured expected: " + spec.reason;
  const legacy =
    observation.exit === undefined &&
    observation.expected === undefined &&
    observation.outcome === undefined;
  if (legacy) {
    if (spec.kind === "free" || (spec.kind === "exit" && spec.code === 0)) return undefined;
    return "comparison not recorded for the current expected value";
  }
  if (observation.outcome === "unevaluated")
    return "output not comparable (too large, truncated, interrupted or invalid comparison)";
  if (observation.outcome === "fail") return "expected not met";
  if (observation.expected !== undefined && observation.expected !== expected)
    return "comparison not recorded for the current expected value";
  if (spec.kind === "free") {
    return observation.exit === 0 ? undefined : "successful exit not recorded";
  }
  if (observation.expected !== expected)
    return "comparison not recorded for the current expected value";
  if (observation.outcome !== "pass" || observation.exit === undefined)
    return "comparison not recorded for the current expected value";
  const code = spec.kind === "exit" ? spec.code : 0;
  return observation.exit === code ? undefined : "expected not met";
}
