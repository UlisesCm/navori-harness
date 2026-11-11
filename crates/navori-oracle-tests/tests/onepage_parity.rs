//! `navori_core::spec::onepage` against the real `checkOnePageSpec` (`lib/spec/onepage.ts`,
//! #1483): generated one-page specs must give the same words and findings, and the heading fold
//! must agree with `normalize` wherever it can decide a match.

mod support;

use navori_core::spec::check::Finding;
use navori_core::spec::onepage::{check_one_page, fold_heading};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module, first_difference};

fn prelude() -> String {
    format!(
        "const o = await import({:?});",
        cli_module("lib/spec/onepage.ts")
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'fold') { \
       const fold = (c) => c.normalize('NFD').replace(/\\p{M}/gu, '').toLowerCase(); \
       const ascii = []; const marks = []; \
       for (let cp = 0x80; cp <= 0x10ffff; cp++) { \
         if (cp >= 0xd800 && cp <= 0xdfff) continue; \
         const f = fold(String.fromCodePoint(cp)); \
         if (f === '') marks.push(cp); \
         else if (/^[\\x00-\\x7f]+$/.test(f)) ascii.push([cp, f]); \
       } \
       return { ascii, marks }; } \
     return o.checkOnePageSpec(request.text);",
);

/// Combining blocks assigned in full long before any Unicode version Node or `regex` may carry.
const STABLE_MARKS: [(u32, u32); 4] = [
    (0x0300, 0x036F),
    (0x1DC0, 0x1DFF),
    (0x20D0, 0x20F0),
    (0xFE20, 0xFE2F),
];

fn finding_value(f: &Finding) -> Value {
    let mut value = json!({
        "rule": f.rule,
        "severity": f.severity.as_str(),
        "where": f.where_,
        "message": f.message,
    });
    if let Some(line) = f.line {
        value["line"] = json!(line);
    }
    value
}

fn titles() -> BoxedStrategy<String> {
    let base = prop::sample::select(vec![
        "Outcome",
        "RESULTADO",
        "Acceptance script",
        "Guion de aceptación",
        "Guio\u{301}n de ACEPTACIO\u{301}N",
        "guion de aceptacion",
        "Applicable rules",
        "Reglas aplicables",
        "States",
        "Estados",
        "Environment and data",
        "Entorno y datos",
        "Out of scope",
        "Fuera de alcance",
        "Tasks",
        "Tareas",
        "Táreas",
        "Ŧasks",
        "ſtates",
        "\u{212a}",
        "Notes",
        "",
    ]);
    let suffix = prop::sample::select(vec![
        "", " ", " (v2)", "(v2)", ":", "x", "\u{a0}", "\u{feff}", " \r", "\r", "\u{2028}",
        "\u{301}",
    ]);
    let prefix = prop::sample::select(vec!["## ", "##  ", "##   ", "### ", "##\t", "##"]);
    (prefix, base, suffix)
        .prop_map(|(p, b, s)| format!("{p}{b}{s}"))
        .boxed()
}

fn body_line() -> BoxedStrategy<String> {
    prop::sample::select(vec![
        "",
        "   ",
        "\r",
        "\u{feff}",
        "Some prose.",
        "1. Open the app.",
        "10. Close it.",
        "1.Open",
        " 1. indented",
        "- a task",
        "- [ ] a task",
        "- [x] done",
        "- [X] done",
        "- [y] odd",
        "* star",
        "-no space",
        "```",
        "  ~~~",
        "```md",
        "## ",
        "##  ",
        "Empty",
        "VACÍO",
        "vacio",
        "VACIO",
        "ERROR",
        "Offline",
        "Sin Conexión",
        "SIN CONEXIÓN",
        "permiso",
        "PERMISSION",
        "permiſſion",
        "- bump to 1.2.3",
        "- v1.2.3",
        "- 1.2.3a",
        "- a@1",
        "- see src/a.ts",
        "- see a/b",
        "- call run(x)",
        "- a (b)",
        "- f(x\ty)",
        "2. edit lib/x.rs\u{a0}now",
    ])
    .prop_map(str::to_owned)
    .boxed()
}

fn document() -> BoxedStrategy<String> {
    let block = prop_oneof![titles(), body_line()];
    (
        prop::collection::vec(block, 0..40),
        prop::sample::select(vec![0_usize, 1195, 1200, 1201]),
    )
        .prop_map(|(lines, filler)| {
            let mut text = lines.join("\n");
            if filler > 0 {
                text.push('\n');
                text.push_str(&vec!["w"; filler].join(" \u{3000}"));
            }
            text
        })
        .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(3000))]

    #[test]
    fn check_one_page_matches_the_ts(text in document()) {
        let ts = NODE.ask(&json!({ "op": "check", "text": text })).map_err(TestCaseError::fail)?;
        let result = check_one_page(&text).ok_or_else(|| TestCaseError::fail("mark regex"))?;
        let rust = json!({
            "ok": result.ok,
            "words": result.words,
            "findings": result.findings.iter().map(finding_value).collect::<Vec<_>>(),
        });
        prop_assert!(ts == rust, "{:?}: {}", text, first_difference(&ts, &rust));
    }
}

/// Every code point that folds to ASCII folds to the same character, and the long-assigned
/// combining marks fold to nothing, as in Node.
#[test]
fn heading_fold_matches_normalize_ts() -> Result<(), String> {
    let node = NODE.ask(&json!({ "op": "fold" }))?;
    let mut expected: Vec<(u32, String)> = node["ascii"]
        .as_array()
        .ok_or("no ascii list")?
        .iter()
        .filter_map(|pair| {
            Some((
                u32::try_from(pair[0].as_u64()?).ok()?,
                pair[1].as_str()?.to_owned(),
            ))
        })
        .collect();
    expected.sort();
    let mut actual = Vec::new();
    for cp in 0x80..=0x0010_FFFF_u32 {
        let Some(ch) = char::from_u32(cp) else {
            continue;
        };
        let folded = fold_heading(&ch.to_string()).ok_or("mark regex")?;
        if !folded.is_empty() && folded.is_ascii() {
            actual.push((cp, folded));
        }
    }
    if actual != expected {
        return Err(format!(
            "ascii fold differs: {} rust vs {} ts",
            actual.len(),
            expected.len()
        ));
    }
    let marks: Vec<u64> = node["marks"]
        .as_array()
        .ok_or("no marks")?
        .iter()
        .filter_map(Value::as_u64)
        .collect();
    for (lo, hi) in STABLE_MARKS {
        for cp in lo..=hi {
            let ch = char::from_u32(cp).ok_or("bad code point")?;
            let rust_mark = fold_heading(&ch.to_string())
                .ok_or("mark regex")?
                .is_empty();
            if rust_mark != marks.contains(&u64::from(cp)) {
                return Err(format!("U+{cp:04X}: rust strips {rust_mark}"));
            }
        }
    }
    Ok(())
}
