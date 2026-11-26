//! `navori_core::semver` against the real `semver.ts` (spec 0058 T7): generated version strings
//! must parse and order exactly as in the TS CLI.

mod support;

use std::cmp::Ordering;

use navori_core::semver::{compare, is_downgrade, parse};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const s = await import({:?});",
        cli_module("lib/primitives/semver.ts")
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "return { parsed: s.parseSemver(request.a) !== null, cmp: s.compareSemver(request.a, request.b), \
     down: s.isDowngrade(request.a, request.b) };",
);

/// Pieces that exercise every branch of `parseSemver`: JS and non-JS whitespace, long digit runs
/// (rounding and overflow to infinity), non-ASCII digits, separators and suffixes.
fn piece() -> impl Strategy<Value = String> {
    prop_oneof![
        4 => "[0-9]{1,3}",
        1 => "[0-9]{17,22}",
        1 => "[1-9][0-9]{310,312}",
        3 => Just(".".to_owned()),
        1 => prop_oneof![Just("-rc.1"), Just("+build"), Just("-"), Just("+")].prop_map(str::to_owned),
        1 => prop_oneof![
            Just(" "), Just("\t"), Just("\u{feff}"), Just("\u{3000}"), Just("\u{85}"), Just("\u{2028}")
        ].prop_map(str::to_owned),
        1 => prop_oneof![Just("v"), Just("x"), Just("١"), Just("..")].prop_map(str::to_owned),
    ]
}

fn version() -> impl Strategy<Value = String> {
    prop_oneof![
        3 => ("[0-9]{1,2}", "[0-9]{1,2}", "[0-9]{1,2}", prop::option::of("-[a-z]{1,4}\\.[0-9]"))
            .prop_map(|(a, b, c, pre)| format!("{a}.{b}.{c}{}", pre.unwrap_or_default())),
        2 => prop::collection::vec(piece(), 0..8).prop_map(|p| p.concat()),
    ]
}

fn ordering_json(ordering: Option<Ordering>) -> Value {
    match ordering {
        None => Value::Null,
        Some(Ordering::Less) => json!(-1),
        Some(Ordering::Equal) => json!(0),
        Some(Ordering::Greater) => json!(1),
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    // Covers: R37, R38
    #[test]
    fn semver_matches_semver_ts(a in version(), b in version()) {
        let reply = NODE
            .ask(&json!({ "a": a, "b": b }))
            .map_err(TestCaseError::fail)?;
        prop_assert_eq!(reply["parsed"].as_bool(), Some(parse(&a).is_some()), "parse {:?}", a);
        prop_assert_eq!(&reply["cmp"], &ordering_json(compare(Some(&a), Some(&b))), "{:?} vs {:?}", a, b);
        prop_assert_eq!(reply["down"].as_bool(), Some(is_downgrade(Some(&a), Some(&b))));
    }
}
