import { ENGINE_CAPABILITIES } from "../shared/engine-capabilities.ts";

export const MIN_PI_VERSION = "0.87.1";
export const MIN_NODE_VERSION = "22.19.0";

type Version = readonly [major: number, minor: number, patch: number];
type RuntimeCheck = (piVersion: string, nodeVersion?: string) => void;
type AdmissionVersion = { capability: string; verifiedFrom: string };
interface RuntimeChecks {
  assert: RuntimeCheck;
  /** Admitted capabilities the given Pi version has not been verified for (empty = all verified). */
  unverified: (piVersion: string) => string[];
}

/** Admitted Pi runtime capabilities (spec 0047 D1): the single table the extension is gated on. */
const ADMITTED: readonly AdmissionVersion[] = (ENGINE_CAPABILITIES.pi.runtimeAdmissions ?? [])
  .filter((row) => row.decision === "admitted")
  .map(({ capability, verifiedFrom }) => ({ capability, verifiedFrom }));

/** Keep serialized code closure-free so bundled function names remain valid. */
function createRuntimeCheck(
  minPiVersion: string,
  minNodeVersion: string,
  admissions: readonly AdmissionVersion[],
): RuntimeChecks {
  function parseStableVersion(value: string): Version | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[\w.-]+)?$/.exec(value.trim());
    if (!match) return null;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isSafeInteger)) return null;
    return [major, minor, patch];
  }

  function isAtLeast(actual: Version, minimum: Version): boolean {
    if (actual[0] !== minimum[0]) return actual[0] > minimum[0];
    if (actual[1] !== minimum[1]) return actual[1] > minimum[1];
    return actual[2] >= minimum[2];
  }

  const assert = (piVersion: string, nodeVersion: string = process.versions.node): void => {
    const node = parseStableVersion(nodeVersion);
    const minimumNode = parseStableVersion(minNodeVersion);
    if (!node || !minimumNode || !isAtLeast(node, minimumNode)) {
      throw new Error(
        `Navori's Pi engine requires Node.js ${minNodeVersion} or later; found ${nodeVersion}.`,
      );
    }

    const pi = parseStableVersion(piVersion);
    const minimumPi = parseStableVersion(minPiVersion);
    if (!pi || !minimumPi || !isAtLeast(pi, minimumPi)) {
      throw new Error(
        `Navori's Pi engine requires @earendil-works/pi-coding-agent ${minPiVersion} or later; found ${piVersion}. Run pi --version and upgrade Pi.`,
      );
    }
  };

  const unverified = (piVersion: string): string[] => {
    const pi = parseStableVersion(piVersion);
    return admissions
      .filter((row) => {
        const verified = parseStableVersion(row.verifiedFrom);
        return !pi || !verified || !isAtLeast(pi, verified);
      })
      .map((row) => row.capability + " (verified from Pi " + row.verifiedFrom + ")");
  };

  return { assert, unverified };
}

/**
 * Reproducible runtime probe: the admitted child flags a Pi help text does not list.
 * A flag the runtime does not advertise is never counted as an enforced capability.
 */
export function missingPiChildFlags(helpText: string): string[] {
  const tokens = new Set(helpText.split(/[\s,]+/));
  return (ENGINE_CAPABILITIES.pi.runtimeAdmissions ?? [])
    .filter((row) => row.decision === "admitted" && row.flag !== undefined)
    .map((row) => row.flag as string)
    .filter((flag) => !tokens.has(flag));
}

/**
 * Serialize a function as an anonymous function expression. Bundler minifiers
 * assign the identifier, which changes with unrelated code and would drift the
 * rendered output; arrow/async forms are rejected rather than mis-serialized.
 */
export function serializeAnonymousFunction(fn: (...args: never[]) => unknown): string {
  const source = fn.toString();
  const anonymous = source.replace(/^function\s*[\w$]*\s*\(/, "function(");
  if (!anonymous.startsWith("function(")) {
    throw new Error("Expected a plain function declaration to serialize");
  }
  return anonymous;
}

/** Embed a stable binding to the same self-contained check after bundling. */
export function renderPiRuntimeVersionSource(): string {
  return (
    `const piRuntimeChecks = (${serializeAnonymousFunction(createRuntimeCheck)})` +
    `(${JSON.stringify(MIN_PI_VERSION)}, ${JSON.stringify(MIN_NODE_VERSION)}, ${JSON.stringify(ADMITTED)});\n` +
    "const assertSupportedPiRuntime = piRuntimeChecks.assert;\n" +
    "const unverifiedPiCapabilities = piRuntimeChecks.unverified;\n"
  );
}

/** Reject incompatible Pi/Node versions before loading Navori's Pi extension. */
const checks = createRuntimeCheck(MIN_PI_VERSION, MIN_NODE_VERSION, ADMITTED);
export const assertSupportedPiRuntime: RuntimeCheck = checks.assert;

/** Admitted capabilities this Pi version has not been verified for; dispatch refuses a non-empty list. */
export const unverifiedPiCapabilities: RuntimeChecks["unverified"] = checks.unverified;
