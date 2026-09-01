import * as p from "@clack/prompts";
import { GLOBAL_SAFE_BLOCK_IDS } from "../lib/render-plan.ts";
import { PERMISSION_KINDS, type PermissionBag } from "../lib/global-config.ts";
import { tc, type Lang } from "../lib/i18n.ts";

/**
 * The interactive half of `navori global init` (#545).
 *
 * Kept out of `commands/global.ts` so the pickers can be unit-tested with a
 * mocked `@clack/prompts` — that mock is file-scoped, and the command module
 * also owns the write path, which must never run inside the suite.
 *
 * Every picker returns `null` when the user aborts (Ctrl-C). The caller treats
 * that as "write nothing": `init` prompts BEFORE it plans, so a cancel can
 * always be honoured with zero bytes on disk.
 */

/**
 * Split a comma-separated answer into permission rules: trimmed, de-duped, no
 * empties. Order is the user's, so re-running `init` shows back what they typed.
 *
 * TODO(ux): a rule containing a literal comma cannot be entered here; add it by
 * hand to `~/.navori/global.json`. Revisit if Claude Code's rule syntax ever
 * grows one (today's `Tool(arg:*)` shapes have none).
 */
export function parseRuleList(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
}

/**
 * Ask which core blocks compose the global baseline. Options come from
 * `GLOBAL_SAFE_BLOCK_IDS` — the assets that DECLARE `globalSafe` — so the picker
 * can only ever offer what `composeBaseline` accepts.
 *
 * `current` pre-selects: on a re-`init` that is the previous selection, which is
 * how a second run stops resetting the user's choice back to the defaults.
 * Anything in `current` that is not global-safe is dropped rather than offered;
 * it could not have rendered anyway.
 */
export async function pickGlobalBlocks(
  current: readonly string[],
  lang: Lang,
): Promise<string[] | null> {
  const g = tc(lang).global;
  const offered = new Set(GLOBAL_SAFE_BLOCK_IDS);
  const selected = await p.multiselect<string>({
    message: g.blocksPrompt,
    options: GLOBAL_SAFE_BLOCK_IDS.map((id) => ({ value: id, label: id, hint: g.blockHints[id] })),
    initialValues: current.filter((id) => offered.has(id)),
    required: true,
  });
  if (p.isCancel(selected)) return null;
  // Re-sorted into asset order: `blocks.include` IS the baseline's emission
  // order, and a multiselect hands back values in toggle order.
  const chosen = new Set(selected);
  return GLOBAL_SAFE_BLOCK_IDS.filter((id) => chosen.has(id));
}

/**
 * Ask for the personal permissions merged into `~/.claude/settings.json` — the
 * only UI path `permissions` has ever had (#545).
 *
 * Declining the opt-in returns `current` UNCHANGED, never an empty bag: on a
 * re-`init` an empty answer would silently drop rules the user declared
 * earlier, and `permissions` is what feeds the ownership record uninstall reads
 * (#544). Each bucket is pre-filled with what is already declared, so nothing
 * is ever written that the user did not see in the prompt.
 */
export async function pickGlobalPermissions(
  current: PermissionBag,
  lang: Lang,
): Promise<PermissionBag | null> {
  const g = tc(lang).global;
  const declared = PERMISSION_KINDS.some((kind) => current[kind].length > 0);
  const wanted = await p.confirm({ message: g.permsPrompt, initialValue: declared });
  if (p.isCancel(wanted)) return null;
  if (!wanted) return current;

  const next: PermissionBag = { allow: [], deny: [], ask: [] };
  for (const kind of PERMISSION_KINDS) {
    const answer = await p.text({
      message: g.permsRules(kind),
      placeholder: g.permsPlaceholder,
      initialValue: current[kind].join(", "),
      defaultValue: "",
    });
    if (p.isCancel(answer)) return null;
    next[kind] = parseRuleList(answer);
  }
  return next;
}
