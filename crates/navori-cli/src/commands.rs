//! Root command table mirroring citty's `subCommands` (name, description), in registration order.
//! Each ported command adds its own row to the parser table (D2); the `--help` case of the oracle
//! validates it against `cli-surface.golden.json`.

/// `(name, description)` of every root subcommand of the TS CLI.
pub const ROOT_COMMANDS: &[(&str, &str)] = &[
    (
        "init",
        "Adopt navori in the current repo (auto-detects stack, presets, quality gate)",
    ),
    (
        "add",
        "Register a plugin in navori.config.json and optionally install its external tool",
    ),
    (
        "remove",
        "Disable a plugin and clean up its managed blocks, sub-blocks and scripts",
    ),
    (
        "adopt",
        "Take a hand-made .claude/ file under navori's management (preview by default)",
    ),
    ("configure", "Modify navori.config.json sections after init"),
    (
        "update",
        "Update the navori CLI to the latest release, then run 'navori refresh'",
    ),
    (
        "refresh",
        "Re-detect the repo, refresh config and run sync (one shot 'bring me up to date')",
    ),
    (
        "render",
        "Render every configured engine from navori.config.json",
    ),
    (
        "sync",
        "Sync every configured engine from the bundle, prompting on conflicts",
    ),
    (
        "scan",
        "Re-detect workspaces in a monorepo and add new ones to navori.config.json",
    ),
    (
        "registry",
        "Global registry of every navori repo on this machine (for 'render --all')",
    ),
    (
        "doctor",
        "Inspect navori.config.json and report resolved state + managed blocks",
    ),
    (
        "status",
        "Quick snapshot: config, plugins, drift, and suggested next steps",
    ),
    (
        "bench",
        "Benchmark render over N runs and report p50/p95 (spots local regressions)",
    ),
    (
        "workspace",
        "Manage navori workspaces (cross-repo config + tickets)",
    ),
    ("ticket", "Manage tickets-as-files inside a workspace"),
    ("backup", "List and restore navori backups"),
    (
        "migrations",
        "List and restore init replace-mode migrations",
    ),
    ("preset", "Manage local presets under .navori/presets/"),
    ("codex", "Codex-specific commands"),
    (
        "dominio",
        "Manage the workspace knowledge base (canonical cross-repo facts)",
    ),
    ("audit", "Report harness tokens and adherence gaps"),
    ("receipt", "Sign or check the reviewed content receipt"),
    (
        "plan",
        "Classify, render, update and check a level-1/2 workplan",
    ),
    ("spec", "Classify and validate a spec's tasks.md"),
    (
        "handoff",
        "Validate the implementer's handoff before dispatch",
    ),
    ("master", "Master-plan project flow (spec 0034)"),
    ("tools", "Machine commands about external tools"),
    (
        "gate",
        "Run qualityGate.<fast|full>, or `foreign` for a registered destination repo (hooks only); full output goes to a log, stdout gets a verdict",
    ),
];
