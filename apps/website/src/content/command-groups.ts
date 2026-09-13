/**
 * Lifecycle grouping for the landing's command section.
 *
 * Lives in its own module for two reasons: an `.astro` component frontmatter
 * can't `export` bindings, and `landing-inventory.test.ts` needs to import this
 * to assert it covers `commandOrder` exactly — no command missing, none
 * invented, none listed twice.
 *
 * Adding a subcommand means adding it to a group here. That is the guard: a
 * command the landing forgets is a test failure, not a silent omission.
 */

export interface CommandGroup {
  id: string;
  /** Key into the i18n dictionary for the group's visible label. */
  labelKey: string;
  /** CSS custom property used as the group's accent colour. */
  accent: string;
  /** Subcommand ids, in display order. Must exist in `commandOrder`. */
  commands: readonly string[];
}

export const COMMAND_GROUPS: readonly CommandGroup[] = [
  {
    id: "start",
    labelKey: "commands.group.start",
    accent: "var(--color-sky-500)",
    commands: ["init", "adopt", "add", "remove", "preset", "configure"],
  },
  {
    id: "render",
    labelKey: "commands.group.render",
    accent: "var(--color-violet-500)",
    commands: ["render", "sync", "update", "migrations", "backup"],
  },
  {
    id: "operate",
    labelKey: "commands.group.operate",
    accent: "var(--color-sky-600)",
    commands: ["doctor", "status", "scan", "registry", "bench"],
  },
  {
    id: "observe",
    labelKey: "commands.group.observe",
    accent: "var(--color-violet-600)",
    commands: ["audit"],
  },
  {
    id: "scale",
    labelKey: "commands.group.scale",
    accent: "var(--color-violet-400)",
    commands: ["global", "workspace", "dominio", "ticket"],
  },
] as const;

/** Flat list of every command the landing presents, in display order. */
export const GROUPED_COMMANDS: readonly string[] = COMMAND_GROUPS.flatMap((g) => g.commands);
