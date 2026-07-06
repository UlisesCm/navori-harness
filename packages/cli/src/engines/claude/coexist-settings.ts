/**
 * Coexist settings merge — inject navori's defensive layers into a settings.json
 * that navori does NOT own (hand-written, no `$navori.managed`), WITHOUT taking
 * ownership. This is the JSON analogue of the managed-block model used for
 * CLAUDE.md: navori manages only its own entries and leaves every user key
 * untouched.
 *
 * Without this, coexist repos (a `.claude/settings.json` already exists) had the
 * guard-destructive hook written to disk but never registered — so the hard
 * backstop silently did nothing.
 *
 * What gets injected (the defensive layers, not the convenience `allow` list):
 *   - hooks:  the guard-destructive + quality-gate PreToolUse hooks (plus any
 *             plugin hooks), identified for idempotent removal by their exact
 *             command string.
 *   - permissions.deny / permissions.ask: the catastrophic / destructive-but-
 *             legit rules.
 *
 * Idempotency: navori records what it injected under
 * `$navori.{managedHooks,managedDeny,managedAsk}`. On every re-render those prior
 * entries are stripped first, then the current desired set is injected — so a
 * changed hook path or a now-disabled gate is updated/removed instead of piling
 * up. `$navori.managed` is deliberately NOT set: the file stays hybrid so the
 * user keeps ownership of everything else.
 */

const OWNERSHIP_KEY = "$navori";

type Json = Record<string, unknown>;

interface Tracking {
  managedHooks: string[];
  managedDeny: string[];
  managedAsk: string[];
}

interface DesiredHook {
  event: string;
  matcher: string | undefined;
  hook: Json;
}

export function isPlainObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Merge navori's defensive layers from `navoriSettings` (a full
 * buildClaudeSettings result) into the user-owned `existing` settings. Pure:
 * returns a new object, does not mutate `existing`.
 */
export function mergeCoexistSettings(existing: Json, navoriSettings: Json): Json {
  const result = structuredClone(existing);
  const prior = readTracking(result);

  // 1. Remove what navori injected on a previous render (idempotent + prunes
  //    stale entries) before re-injecting the current desired set.
  stripTrackedHooks(result, prior.managedHooks);
  stripFromPermissionList(result, "deny", prior.managedDeny);
  stripFromPermissionList(result, "ask", prior.managedAsk);

  // 2. Collect navori's current desired defensive entries.
  const desiredHooks = collectHooks(navoriSettings);
  const desiredDeny = permissionList(navoriSettings, "deny");
  const desiredAsk = permissionList(navoriSettings, "ask");

  // 3. Inject, preserving every user entry.
  injectHooks(result, desiredHooks);
  injectPermissionList(result, "deny", desiredDeny);
  injectPermissionList(result, "ask", desiredAsk);
  pruneEmptyHooks(result);

  // 4. Record tracking (never sets managed:true — the file stays hybrid).
  writeTracking(result, {
    managedHooks: desiredHooks.map((d) => String(d.hook.command)),
    managedDeny: desiredDeny,
    managedAsk: desiredAsk,
  });

  return result;
}

function readTracking(obj: Json): Tracking {
  const nav = obj[OWNERSHIP_KEY];
  const t: Json = isPlainObject(nav) ? nav : {};
  return {
    managedHooks: asStringArray(t.managedHooks),
    managedDeny: asStringArray(t.managedDeny),
    managedAsk: asStringArray(t.managedAsk),
  };
}

function writeTracking(obj: Json, t: Tracking): void {
  const nav: Json = isPlainObject(obj[OWNERSHIP_KEY]) ? (obj[OWNERSHIP_KEY] as Json) : {};
  nav.managedHooks = t.managedHooks;
  nav.managedDeny = t.managedDeny;
  nav.managedAsk = t.managedAsk;
  nav.note =
    "Bloques 'managed*' inyectados por navori (coexist). El resto es tuyo. Se re-sincronizan en cada 'navori render'.";
  obj[OWNERSHIP_KEY] = nav;
}

/** Flatten `settings.hooks` into a list of individual hook objects with context. */
function collectHooks(settings: Json): DesiredHook[] {
  const out: DesiredHook[] = [];
  const hooks = settings.hooks;
  if (!isPlainObject(hooks)) return out;
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isPlainObject(entry) || !Array.isArray(entry.hooks)) continue;
      const matcher = typeof entry.matcher === "string" ? entry.matcher : undefined;
      for (const hook of entry.hooks) {
        if (isPlainObject(hook) && typeof hook.command === "string") {
          out.push({ event, matcher, hook });
        }
      }
    }
  }
  return out;
}

function permissionList(settings: Json, key: "deny" | "ask"): string[] {
  const perms = settings.permissions;
  if (!isPlainObject(perms)) return [];
  return asStringArray(perms[key]);
}

/**
 * Remove hook objects whose command is in `commands` and prune emptied matcher
 * groups. Keeps the `hooks` key and its event arrays in place (even if emptied)
 * so a later re-inject fills the SAME position — insertion order must stay
 * stable for the serialized output to be idempotent. Genuinely-empty leftovers
 * are pruned by `pruneEmptyHooks` after injection.
 */
function stripTrackedHooks(obj: Json, commands: string[]): void {
  if (commands.length === 0) return;
  const hooks = obj.hooks;
  if (!isPlainObject(hooks)) return;
  const set = new Set(commands);
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    const kept: unknown[] = [];
    for (const entry of entries) {
      if (isPlainObject(entry) && Array.isArray(entry.hooks)) {
        entry.hooks = entry.hooks.filter(
          (h) => !(isPlainObject(h) && typeof h.command === "string" && set.has(h.command)),
        );
        if (entry.hooks.length > 0) kept.push(entry);
      } else {
        kept.push(entry);
      }
    }
    hooks[event] = kept;
  }
}

/** Drop event arrays left empty after strip+inject, and the `hooks` key if all
 *  events emptied. Order-stable: only ever removes genuinely-empty leftovers. */
function pruneEmptyHooks(obj: Json): void {
  const hooks = obj.hooks;
  if (!isPlainObject(hooks)) return;
  for (const [event, entries] of Object.entries(hooks)) {
    if (Array.isArray(entries) && entries.length === 0) delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete obj.hooks;
}

function stripFromPermissionList(obj: Json, key: "deny" | "ask", values: string[]): void {
  if (values.length === 0) return;
  const perms = obj.permissions;
  if (!isPlainObject(perms)) return;
  const list = perms[key];
  if (!Array.isArray(list)) return;
  const set = new Set(values);
  const filtered = list.filter((v) => !(typeof v === "string" && set.has(v)));
  if (filtered.length > 0) perms[key] = filtered;
  else delete perms[key];
}

function injectHooks(obj: Json, desired: DesiredHook[]): void {
  if (desired.length === 0) return;
  const hooks: Json = isPlainObject(obj.hooks) ? (obj.hooks as Json) : {};
  obj.hooks = hooks;
  for (const { event, matcher, hook } of desired) {
    const arr: unknown[] = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    hooks[event] = arr;
    let group = arr.find(
      (e): e is Json => isPlainObject(e) && e.matcher === matcher && Array.isArray(e.hooks),
    );
    if (!group) {
      group = matcher !== undefined ? { matcher, hooks: [] } : { hooks: [] };
      arr.push(group);
    }
    const groupHooks = group.hooks as unknown[];
    const cmd = hook.command;
    if (!groupHooks.some((h) => isPlainObject(h) && h.command === cmd)) {
      groupHooks.push(hook);
    }
  }
}

function injectPermissionList(obj: Json, key: "deny" | "ask", values: string[]): void {
  if (values.length === 0) return;
  const perms: Json = isPlainObject(obj.permissions) ? (obj.permissions as Json) : {};
  obj.permissions = perms;
  const list: unknown[] = Array.isArray(perms[key]) ? (perms[key] as unknown[]) : [];
  perms[key] = list;
  for (const v of values) {
    if (!list.includes(v)) list.push(v);
  }
}
