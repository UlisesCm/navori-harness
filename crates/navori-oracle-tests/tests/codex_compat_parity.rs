//! `navori_core::render::codex_compat` against the real `compat.ts` (spec 0059 T19): generated
//! prose with every citation shape and vocabulary term must adapt exactly as in the TS CLI.

mod support;

use navori_core::render::codex_compat::adapt_harness_text_for_codex;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::json;
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const c = await import({:?});",
        cli_module("engines/codex/compat.ts")
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "return c.adaptHarnessTextForCodex(request.text, {});",
);

fn piece() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => "[a-z ]{0,6}",
        3 => prop_oneof![
            Just(".claude/"), Just(".claude/agents/"), Just(".claude/skills/"), Just(".claude/hooks/x.sh"),
            Just(".claude/scripts/a.sh"), Just(".claude/progress"), Just(".claude/agents/orchestrator.md"),
            Just(".claude/agents/scout.md"), Just(".claude/skills/plan-simple/SKILL.md"),
            Just(".claude/skills/x.md"), Just(".claude/skills/<id>/SKILL.md"), Just(".claude/agents.md"),
            Just(".claude/constructor"), Just("CLAUDE.md"), Just("Never commit `.claude/` or `CLAUDE.md`"),
        ].prop_map(str::to_owned),
        2 => prop_oneof![
            Just("`Agent(subagent_type: orchestrator)`"), Just("`Agent`"), Just("Claude serializes by default"),
            Just("/spec-bootstrap"), Just("`SendMessage`"), Just("/master-plan"), Just("`"), Just("é"),
            Just("\u{0}"), Just("navori:never-commit"),
        ].prop_map(str::to_owned),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(1500))]

    // Covers: R62
    #[test]
    fn codex_compat_matches_compat_ts(text in prop::collection::vec(piece(), 0..10).prop_map(|p| p.concat())) {
        let reply = NODE.ask(&json!({ "text": text })).map_err(TestCaseError::fail)?;
        prop_assert_eq!(reply, json!(adapt_harness_text_for_codex(&text)), "{:?}", text);
    }
}
