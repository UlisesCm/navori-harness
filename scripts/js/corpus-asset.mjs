import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildEngramPolicyShell } from "../../packages/cli/src/engines/shared/engram-grant-policy.ts";
import { buildRolePolicyShell } from "../../packages/cli/src/engines/shared/role-policy.ts";
import { expandHookIncludes } from "../../packages/cli/src/lib/render/hook-includes.ts";

/**
 * Spec 0060 T13 — the bytes the hook verdict corpus records and replays for a core hook asset:
 * its partials expanded, and the two policies that are a function BODY rendered as `navori
 * render` writes them for the default roster (`{{rolePolicy}}` of role-guard, `{{engramPolicy}}`
 * of engram-write-guard). Left literal, such a placeholder is a command that does not exist, so
 * the recorded verdict would be the script failing, not the policy deciding. Every other
 * placeholder stays literal, as before (a test stands in for it with a stub of that name).
 *
 * @param {string} hooksDir `packages/core/core-assets/hooks`
 * @param {string} name asset file name, `<hook>.sh`
 * @returns {string}
 */
export function corpusAsset(hooksDir, name) {
  const expanded = expandHookIncludes(readFileSync(join(hooksDir, name), "utf8"));
  if (name === "role-guard.sh") return expanded.replace("{{rolePolicy}}", () => buildRolePolicyShell({}));
  if (name === "engram-write-guard.sh") return expanded.replace("{{engramPolicy}}", () => buildEngramPolicyShell());
  return expanded;
}
