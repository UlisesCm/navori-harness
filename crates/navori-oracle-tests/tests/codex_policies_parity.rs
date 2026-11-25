//! `navori_core::render::codex_policies` against the real `role-policy.ts` and
//! `engram-grant-policy.ts` (spec 0059 T19): the `case` bodies `role-guard` and
//! `engram-write-guard` interpolate must match, the role policy for any `sdd.specsDir`.

mod support;

use navori_core::js_json;
use navori_core::render::codex_policies::{build_engram_policy_shell, build_role_policy_shell};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::json;
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const r = await import({:?}); const g = await import({:?});",
        cli_module("engines/shared/role-policy.ts"),
        cli_module("engines/shared/engram-grant-policy.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "return request.engram ? g.buildEngramPolicyShell() : r.buildRolePolicyShell(request.config);",
);

fn specs_dir() -> impl Strategy<Value = Option<String>> {
    let piece = prop_oneof![
        3 => "[a-z]{1,4}",
        2 => prop::sample::select(vec!["./", "/", ".", "'", "{{sdd.specsDir}}", " ", "é"])
            .prop_map(str::to_owned),
    ];
    prop::option::of(prop::collection::vec(piece, 0..5).prop_map(|p| p.concat()))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(800))]

    // Covers: R62
    #[test]
    fn role_policy_matches_ts(dir in specs_dir()) {
        let config = dir.as_ref().map_or_else(|| json!({}), |d| json!({ "sdd": { "specsDir": d } }));
        let js = js_json::parse(&config.to_string()).ok_or_else(|| TestCaseError::fail("json"))?;
        let reply = NODE.ask(&json!({ "config": config })).map_err(TestCaseError::fail)?;
        prop_assert_eq!(reply, json!(build_role_policy_shell(&js)), "{:?}", dir);
    }
}

// Covers: R62
#[test]
fn engram_policy_matches_ts() {
    let reply = NODE.ask(&json!({ "engram": true }));
    assert_eq!(reply, Ok(json!(build_engram_policy_shell())));
}
