//! `navori_core::adopt::plan_adoption` against the real `planAdoption` (`commands/adopt.ts`,
//! spec 0058 T26): relative, absolute, `..` and `.`-laden targets, files, directories and missing
//! paths, and contents with and without a trailing newline, our marker, another tool's marker,
//! a marker quoted in a fence and non-ASCII text.

mod support;

use std::path::PathBuf;
use std::sync::LazyLock;

use navori_core::STAMP_VERSION;
use navori_core::adopt::{AdoptPlan, AdoptRefusal, plan_adoption};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const a = await import({:?});",
        cli_module("commands/adopt.ts")
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "return a.planAdoption(request.cwd, request.target);",
);

static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-adopt-parity-{}", std::process::id()))
});

fn reason(reason: AdoptRefusal) -> &'static str {
    match reason {
        AdoptRefusal::OutsideRepo => "outside-repo",
        AdoptRefusal::Missing => "missing",
        AdoptRefusal::NotAFile => "not-a-file",
        AdoptRefusal::NotAdoptablePath => "not-adoptable-path",
        AdoptRefusal::AlreadyManaged => "already-managed",
    }
}

fn as_json(plan: &AdoptPlan) -> Value {
    match plan {
        AdoptPlan::Refuse { reason: r, path } => {
            json!({ "kind": "refuse", "reason": reason(*r), "path": path })
        }
        AdoptPlan::Noop { path } => json!({ "kind": "noop", "path": path }),
        AdoptPlan::Adopt {
            path,
            rel_path,
            marker_id,
            content,
        } => json!({
            "kind": "adopt",
            "path": path.to_string_lossy(),
            "relPath": rel_path,
            "markerId": marker_id,
            "content": content,
        }),
    }
}

fn content() -> BoxedStrategy<String> {
    prop::sample::select(vec![
        "# Hecho a mano\n".to_owned(),
        "sin salto final".to_owned(),
        String::new(),
        "ñandú 🦤\r\nlínea\n".to_owned(),
        "<!-- navori:managed id=\"otra\" hash=\"00\" -->\nx\n<!-- /navori:managed id=\"otra\" -->\n"
            .to_owned(),
        "```\n<!-- navori:managed id=\"citado\" hash=\"00\" -->\n```\n".to_owned(),
        "<!-- navori:managed id=\"adopted-claude-agents-a\" hash=\"1\" -->\nmine\n".to_owned(),
        "# navori:managed start id=\"sh\" hash=\"00\"\necho\n# navori:managed end id=\"sh\"\n"
            .to_owned(),
        "mention of <!-- navori:managed --> without an id\n".to_owned(),
    ])
    .boxed()
}

fn target() -> BoxedStrategy<String> {
    prop::sample::select(vec![
        ".claude/agents/a.md",
        "./.claude/agents/../agents/a.md",
        ".claude/agents/A b.md",
        ".claude/agents",
        ".claude/agents/missing.md",
        ".claude/notes.txt",
        "README.md",
        "../outside.md",
        "..foo.md",
        "@ABS@/.claude/agents/a.md",
        "@ABS@/.claude/../.claude/agents/a.md",
        "/elsewhere/x.md",
        ".",
    ])
    .prop_map(str::to_owned)
    .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    // Covers: R14
    #[test]
    fn plan_matches_the_ts(body in content(), target in target()) {
        let root = ROOT.join("repo");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".claude/agents")).map_err(|e| TestCaseError::fail(e.to_string()))?;
        for rel in [".claude/agents/a.md", ".claude/agents/A b.md", ".claude/notes.txt", "README.md", "..foo.md"] {
            std::fs::write(root.join(rel), &body).map_err(|e| TestCaseError::fail(e.to_string()))?;
        }
        let cwd = root.to_string_lossy().into_owned();
        let target = target.replace("@ABS@", &cwd);
        let ts = NODE
            .ask(&json!({ "cwd": cwd, "target": target }))
            .map_err(TestCaseError::fail)?;
        let rust = plan_adoption(&cwd, &target, STAMP_VERSION)
            .map_err(|_| TestCaseError::fail("rust delegated"))?;
        prop_assert_eq!(ts, as_json(&rust), "{} {:?}", target, body);
    }
}
