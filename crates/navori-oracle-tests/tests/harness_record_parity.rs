//! `navori_core::config::record_harness_version` against the real `recordHarnessVersion`
//! (`lib/config/config.ts`, spec 0058 M8, R47): canonical and hand-formatted files, absent, older,
//! equal, newer, unparseable and non-string versions, the `version`/`name` anchors, numeric keys
//! and CLI versions that do not parse. The TS writes the file, so it runs on a scratch copy.

mod support;

use std::path::PathBuf;
use std::sync::LazyLock;

use navori_core::config::{HarnessRecord, record_harness_version};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::json;
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const c = await import({:?});\nconst fs = await import('node:fs');",
        cli_module("lib/config/config.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "fs.writeFileSync(request.path, request.text);\n\
     const outcome = c.recordHarnessVersion(request.path, request.cli);\n\
     return [outcome, fs.readFileSync(request.path, 'utf8')];",
);

static SCRATCH: LazyLock<PathBuf> = LazyLock::new(|| {
    let dir = std::env::temp_dir().join(format!("navori-harness-record-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("navori.config.json")
});

fn pick(options: &[&'static str]) -> BoxedStrategy<String> {
    prop::sample::select(options.to_vec())
        .prop_map(str::to_owned)
        .boxed()
}

fn config_text() -> BoxedStrategy<String> {
    let field = |key: &'static str, values: &[&'static str]| {
        prop::option::of(pick(values).prop_map(move |v| format!("\"{key}\": {v}"))).boxed()
    };
    (
        prop::collection::vec(
            prop::option::of(pick(&[
                r#""1": true"#,
                r#""name": "demo""#,
                r#""version": "1.0.0""#,
                r#""engines": ["claude"]"#,
                r#""project": {}"#,
            ])),
            0..5,
        ),
        field(
            "harnessVersion",
            &[
                r#""0.1.0""#,
                r#""0.12.3""#,
                r#""999.0.0""#,
                r#""dev""#,
                "7",
                "null",
            ],
        ),
        0u8..4,
    )
        .prop_map(|(fields, harness, format)| {
            let mut entries: Vec<String> = fields.into_iter().flatten().collect();
            entries.dedup();
            if let Some(h) = harness {
                entries.insert(entries.len() / 2, h);
            }
            match format {
                // Canonical, as `JSON.stringify(raw, null, 2) + "\n"` writes it.
                0 | 1 => match serde_json::from_str::<serde_json::Value>(&format!(
                    "{{{}}}",
                    entries.join(",")
                )) {
                    Ok(value) => format!(
                        "{}\n",
                        serde_json::to_string_pretty(&value).unwrap_or_default()
                    ),
                    Err(_) => String::new(),
                },
                2 => format!("{{{}}}", entries.join(",")),
                _ => "[1, 2]\n".to_owned(),
            }
        })
        .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    // Covers: R47
    #[test]
    fn record_matches_the_ts(
        text in config_text(),
        cli in pick(&["0.12.3", "0.1.0", "1000.0.0", "0.13.0-rust.1", "dev"]),
    ) {
        let ts = NODE
            .ask(&json!({ "path": SCRATCH.to_string_lossy(), "text": text, "cli": cli }))
            .map_err(TestCaseError::fail)?;
        let rust = record_harness_version(&text, &cli);
        let after = match &rust {
            HarnessRecord::Recorded(next) => next.clone(),
            _ => text.clone(),
        };
        prop_assert_eq!(ts, json!([rust.as_str(), after]), "{}", text);
    }
}
