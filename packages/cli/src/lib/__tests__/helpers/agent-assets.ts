import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { getCoreRoot } from "../../bundled-assets.ts";

/**
 * The core agent roster, read from disk so a new role joins by existing — the
 * same move `agents-assets.test.ts` made when a hand-kept list let `auditor`
 * ship outside the shape contract (#417).
 *
 * Shared because two suites need the SAME notion of "an agent the orchestrator
 * can actually launch": `handoff-contract` (#500) must not demand a closing
 * handoff from a playbook nobody invokes, and `mcp-capability-wiring` (#501)
 * must not count that playbook as proof a tool reached a subagent — `leader.md`
 * holding `mcp__engram__*` while forbidding its own invocation was exactly the
 * accounting error that let engram's prose ship to seven toolless agents.
 */
export const AGENTS_DIR = resolve(getCoreRoot(), "core-assets", "agents");

/** An agent asset: its id and its raw text, frontmatter included. */
export interface AgentAsset {
  readonly id: string;
  readonly content: string;
}

/** Every agent asset on disk, sorted by id. */
export function listAgentAssets(): AgentAsset[] {
  return readdirSync(AGENTS_DIR)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({
      id: name.slice(0, -".md".length),
      content: readFileSync(resolve(AGENTS_DIR, name), "utf-8"),
    }));
}

/**
 * The opt-out marker an agent uses to declare itself un-launchable. Matched on
 * the literal sentence `leader.md` puts first in its `description:`, so the
 * frontmatter stays the single source and no second list has to be maintained.
 */
export const NOT_INVOKABLE = "Do NOT invoke as a subagent";

/** True unless the asset declares itself un-launchable in its description. */
export function isInvokable(asset: AgentAsset): boolean {
  return !asset.content.includes(NOT_INVOKABLE);
}
