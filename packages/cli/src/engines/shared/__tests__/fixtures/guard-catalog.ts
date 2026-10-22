/** K4 distinguishes script parity from host settings and extension-only policy. */
export type Layer = "script" | "claude-settings" | "pi-extension";
/** Observed decision at the layer named by a catalog row. */
export type GuardDecision = "allow" | "block" | "ask" | "n/a";
/** One deterministic guard stimulus; tokens in braces are resolved by the runner. */
export interface CatalogRow {
  readonly id: string;
  readonly input:
    | { readonly command: string }
    | { readonly tool: "edit" | "write"; readonly path: string };
  readonly actor: "parent" | "implementer" | "reviewer";
  readonly layer: Layer;
  readonly expect: { readonly claude: GuardDecision; readonly pi: GuardDecision };
  readonly route?: string;
  readonly engineSpecific?: string;
}

/** Script cases exercise the same installed target union in both engines. */
export const GUARD_CATALOG: readonly CatalogRow[] = [
  ...[
    "rm -rf /",
    "rm -rf --no-preserve-root /",
    "git commit --no-verify -m x",
    "git push --force origin main",
    "echo x > CLAUDE.md",
  ].map((command, index): CatalogRow => ({
    id: `destructive-${index}`,
    input: { command },
    actor: "parent",
    layer: "script",
    expect: { claude: "block", pi: "block" },
  })),
  ...[
    "cp x CLAUDE.md",
    "cp x CLAUDE.md 2>&1",
    "cp x CLAUDE.md &",
    "cp x ./CLAUDE.md # c",
    "/bin/cp x CLAUDE.md",
    'cp x "$CLAUDE_PROJECT_DIR"/CLAUDE.md',
    "cp x {root}/CLAUDE.md",
    "cp x {physicalRoot}/CLAUDE.md",
    "mv x .claude/agents/implementer.md",
    "git mv x .claude/agents/implementer.md",
    "mv CLAUDE.md /tmp/x",
    "install -m 644 x .pi/agents/implementer.md",
    "cp implementer.md -t .claude/agents",
    "ln -sf x .claude/hooks/guard-destructive.sh",
    "mv .claude/agents /tmp/agents",
    "git mv .agents/skills /tmp/skills",
    "cp -r template .claude/agents",
    "env -i /bin/cp x CLAUDE.md",
    "command cp x AGENTS.md",
  ].map((command, index): CatalogRow => ({
    id: `owned-copy-${index}`,
    input: { command },
    actor: "parent",
    layer: "script",
    expect: { claude: "block", pi: "block" },
    route: "navori render --apply",
  })),
  ...[
    "git status",
    "ls -la",
    "cp CLAUDE.md /tmp/x",
    "cp x ../wt/CLAUDE.md",
    "cp x /tmp/CLAUDE.md",
    "cp x docs/CLAUDE.md",
    "cp x {root}-other/CLAUDE.md",
    "cp -r tmpl .claude/skills/mia",
    "mv draft .claude/skills/mia/",
    "cp x .pi/agents/mine.md",
  ].map((command, index): CatalogRow => ({
    id: `allowed-${index}`,
    input: { command },
    actor: "parent",
    layer: "script",
    expect: { claude: "allow", pi: "allow" },
  })),
  ...["echo x > notes.md", "tee README.md", "cp a.md b.md", "echo x > .claude/agents/x.md"].map(
    (command, index): CatalogRow => ({
      id: `markdown-${index}`,
      input: { command },
      actor: "implementer",
      layer: "script",
      expect: { claude: "block", pi: "block" },
      route: "markdownRequests",
    }),
  ),
  {
    id: "markdown-read",
    input: { command: "cat README.md" },
    actor: "implementer",
    layer: "script",
    expect: { claude: "allow", pi: "allow" },
  },
  {
    id: "doctrine-write",
    input: { tool: "write", path: ".claude/agents/x.md" },
    actor: "implementer",
    layer: "script",
    expect: { claude: "allow", pi: "allow" },
  },
  {
    id: "markdown-edit",
    input: { tool: "edit", path: "notes.md" },
    actor: "implementer",
    layer: "script",
    expect: { claude: "block", pi: "block" },
    route: "markdownRequests",
  },
  {
    id: "reviewer-markdown",
    input: { command: "echo x > notes.md" },
    actor: "reviewer",
    layer: "script",
    expect: { claude: "allow", pi: "allow" },
  },
  {
    id: "pi-control-copy-out",
    input: { command: "cp .pi/navori/hooks/guard-destructive.sh /tmp/x" },
    actor: "parent",
    layer: "script",
    expect: { claude: "allow", pi: "block" },
    engineSpecific:
      "Pi forbids copying its control plane out (rule 6c); Claude permits copying an owned source.",
  },
  ...["rg TODO src", "grep -R TODO src"].map((command, index): CatalogRow => ({
    id: `search-routing-${index}`,
    input: { command },
    actor: "parent",
    layer: "script",
    expect: { claude: "block", pi: "block" },
    route: "tgrep search -n -- PATTERN ROOT",
  })),
  ...[
    "grep -n TODO src/file.ts",
    "printf x | grep x",
    "tgrep search -n --no-index -- TODO src",
  ].map((command, index): CatalogRow => ({
    id: `search-extraction-${index}`,
    input: { command },
    actor: "parent",
    layer: "script",
    expect: { claude: "allow", pi: "allow" },
  })),
  {
    id: "pi-disable-extension",
    input: { command: "pi --no-extensions" },
    actor: "parent",
    layer: "script",
    expect: { claude: "allow", pi: "block" },
    engineSpecific: "Only Pi owns extension admission.",
  },
  {
    id: "recursive-remove-ask",
    input: { command: "rm -r build" },
    actor: "parent",
    layer: "claude-settings",
    expect: { claude: "ask", pi: "ask" },
  },
  {
    id: "approved-by-question",
    input: { command: "navori master close --approved-by user" },
    actor: "parent",
    layer: "pi-extension",
    expect: { claude: "n/a", pi: "ask" },
  },
  {
    id: "pi-managed-write",
    input: { tool: "write", path: ".pi/navori.json" },
    actor: "parent",
    layer: "pi-extension",
    expect: { claude: "n/a", pi: "block" },
  },
];
