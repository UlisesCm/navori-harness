//! `navori_core::render::doc_budget` against `lib/assets/doc-budgets.ts` and
//! `lib/diagnose/health.ts` (spec 0058 M8): the ceiling tables are the TS's, and
//! `measureDocBudget` agrees on documents of budgeted, computed and unknown blocks, nested
//! blocks, list rows and Unicode whitespace.

mod support;

use navori_core::render::doc_budget::{CEILINGS, COMPUTED, measure_doc_budget};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const b = await import({:?});\nconst h = await import({:?});",
        cli_module("lib/assets/doc-budgets.ts"),
        cli_module("lib/diagnose/health.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'tables') return { ceilings: b.managedBlockCeilings(), computed: b.COMPUTED_BLOCK_FORMULAS };\n\
     const m = h.measureDocBudget(request.content);\n\
     return [m.managedWords, m.unbudgetedWords, m.ceiling, m.overBy];",
);

/// The Rust tables equal `managedBlockCeilings()` and `COMPUTED_BLOCK_FORMULAS`.
#[test]
fn ceiling_tables_match_the_ts() -> Result<(), String> {
    let ts = NODE.ask(&json!({ "op": "tables" }))?;
    let ceilings: serde_json::Map<String, Value> = CEILINGS
        .iter()
        .map(|(id, c)| ((*id).to_owned(), json!(c)))
        .collect();
    let computed: serde_json::Map<String, Value> = COMPUTED
        .iter()
        .map(|(id, base, per_row)| ((*id).to_owned(), json!({ "base": base, "perRow": per_row })))
        .collect();
    if ts["ceilings"] != Value::Object(ceilings) {
        return Err(format!(
            "CEILINGS drifted; managedBlockCeilings() is {}",
            ts["ceilings"]
        ));
    }
    if ts["computed"] != Value::Object(computed) {
        return Err(format!(
            "COMPUTED drifted; COMPUTED_BLOCK_FORMULAS is {}",
            ts["computed"]
        ));
    }
    Ok(())
}

fn word() -> BoxedStrategy<String> {
    prop::sample::select(vec![
        "palabra", "- item", "x", "\u{a0}", "\u{feff}", "\u{2028}", "\t", "", "ñandú", "\n",
    ])
    .prop_map(str::to_owned)
    .boxed()
}

fn body() -> BoxedStrategy<String> {
    prop::collection::vec(word(), 0..30)
        .prop_map(|words| words.join(" "))
        .boxed()
}

fn block(id: String, inner: String) -> String {
    format!(
        "<!-- navori:managed id=\"{id}\" hash=\"00000000\" version=\"0.1.0\" source=\"@navori/core\" -->\n{inner}\n<!-- /navori:managed id=\"{id}\" -->\n"
    )
}

fn document() -> BoxedStrategy<String> {
    let id = prop::sample::select(vec![
        "orquestacion",
        "tipado-fuerte",
        "contexto-proyecto",
        "agentes-disponibles",
        "desconocido",
        "navori-agents",
    ]);
    let piece =
        (id, body(), prop::option::of(body()), body()).prop_map(|(id, inner, nested, after)| {
            let inner = match nested {
                Some(text) => format!("{inner}\n{}", block("tipado-fuerte".to_owned(), text)),
                None => inner,
            };
            format!("{}{after}\n", block(id.to_owned(), inner))
        });
    (body(), prop::collection::vec(piece, 0..5))
        .prop_map(|(head, pieces)| format!("{head}\n{}", pieces.concat()))
        .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    #[test]
    fn measure_matches_the_ts(content in document()) {
        let ts = NODE.ask(&json!({ "content": content })).map_err(TestCaseError::fail)?;
        let rust = measure_doc_budget(&content);
        prop_assert_eq!(
            ts,
            json!([rust.managed_words, rust.unbudgeted_words, rust.ceiling, rust.over_by]),
            "{}",
            content
        );
    }
}
