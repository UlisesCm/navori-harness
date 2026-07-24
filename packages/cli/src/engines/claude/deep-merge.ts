/**
 * Deep-merge two plain objects with the rules navori needs for
 * `.claude/settings.json` assembly:
 *   - Nested objects are merged recursively.
 *   - Arrays are concatenated AND deduplicated by structural equality
 *     (JSON-serialized). This lets multiple plugins each contribute
 *     entries to `hooks.PreToolUse[]` without colliding or duplicating.
 *   - Primitives in the override always win.
 *
 * Inputs are not mutated.
 */
export function deepMerge<T extends Record<string, unknown>>(base: T, override: Partial<T>): T {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(override)) {
    const baseVal = result[key];
    const overrideVal = (override as Record<string, unknown>)[key];
    if (Array.isArray(baseVal) && Array.isArray(overrideVal)) {
      result[key] = dedupeArray([...baseVal, ...overrideVal]);
    } else if (isPlainObject(baseVal) && isPlainObject(overrideVal)) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else {
      result[key] = overrideVal;
    }
  }
  return result as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function dedupeArray(arr: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of arr) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
