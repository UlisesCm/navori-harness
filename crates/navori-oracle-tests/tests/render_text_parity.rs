//! `navori_core::render::{frontmatter, hook_includes}` against the real TS modules (spec 0058 T14):
//! every bundled asset plus generated documents.

mod support;

use navori_core::assets::ASSETS;
use navori_core::render::frontmatter as fm;
use navori_core::render::hook_includes::expand_hook_includes;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const f = await import({:?});\nconst h = await import({:?});",
        cli_module("lib/render/frontmatter.ts"),
        cli_module("lib/render/hook-includes.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'include') {\n\
       try { return { ok: h.expandHookIncludes(request.text) }; } catch (e) { return { error: true }; }\n\
     }\n\
     const raw = request.text;\n\
     const split = f.splitFrontmatter(raw);\n\
     const keys = ['name', 'description', 'tools', 'metadata', 'model', 'disable-model-invocation', 'constructor'];\n\
     return {\n\
       split,\n\
       fields: Object.entries(f.parseFrontmatterFields(split.frontmatter)),\n\
       get: keys.map((k) => f.getFrontmatterField(split.frontmatter, k)),\n\
       map: ['type', 'maxWords'].map((k) => f.getFrontmatterMapField(split.frontmatter, 'metadata', k)),\n\
       removed: keys.map((k) => f.removeFrontmatterField(raw, k)),\n\
       strip: f.stripFrontmatter(raw),\n\
       format: f.formatFrontmatterField('k', raw),\n\
       tools: f.splitToolList(raw),\n\
     };",
);

const KEYS: [&str; 7] = [
    "name",
    "description",
    "tools",
    "metadata",
    "model",
    "disable-model-invocation",
    "constructor",
];

fn rust_frontmatter(raw: &str) -> Value {
    let split = fm::split_frontmatter(raw);
    let fields: Vec<Value> = fm::parse_frontmatter_fields(split.frontmatter)
        .entries()
        .iter()
        .map(|(k, v)| json!([k, v]))
        .collect();
    let get: Vec<Option<String>> = KEYS
        .iter()
        .map(|k| fm::get_frontmatter_field(split.frontmatter, k))
        .collect();
    let map: Vec<Option<String>> = ["type", "maxWords"]
        .iter()
        .map(|k| fm::get_frontmatter_map_field(split.frontmatter, "metadata", k))
        .collect();
    let removed: Vec<String> = KEYS
        .iter()
        .map(|k| fm::remove_frontmatter_field(raw, k))
        .collect();
    json!({
        "split": { "frontmatter": split.frontmatter, "body": split.body },
        "fields": fields,
        "get": get,
        "map": map,
        "removed": removed,
        "strip": fm::strip_frontmatter(raw),
        "format": fm::format_frontmatter_field("k", raw),
        "tools": fm::split_tool_list(raw),
    })
}

fn rust_include(text: &str) -> Value {
    match expand_hook_includes(text) {
        Ok(expanded) => json!({ "ok": expanded }),
        Err(_) => json!({ "error": true }),
    }
}

fn check_frontmatter(raw: &str) -> Result<(), TestCaseError> {
    let ts = NODE
        .ask(&json!({ "op": "frontmatter", "text": raw }))
        .map_err(TestCaseError::fail)?;
    prop_assert_eq!(ts, rust_frontmatter(raw), "{:?}", raw);
    Ok(())
}

fn check_include(text: &str) -> Result<(), TestCaseError> {
    let ts = NODE
        .ask(&json!({ "op": "include", "text": text }))
        .map_err(TestCaseError::fail)?;
    prop_assert_eq!(ts, rust_include(text), "{:?}", text);
    Ok(())
}

// Covers: R41
#[test]
fn every_bundled_text_asset_matches() -> Result<(), String> {
    let mut checked = 0;
    for (path, bytes) in ASSETS {
        let Ok(text) = std::str::from_utf8(bytes) else {
            continue;
        };
        if path.ends_with(".md") || path.ends_with(".md.tmpl") {
            check_frontmatter(text).map_err(|e| format!("{path}: {e}"))?;
            checked += 1;
        }
        if path.ends_with(".sh") {
            check_include(text).map_err(|e| format!("{path}: {e}"))?;
            checked += 1;
        }
    }
    if checked < 50 {
        return Err(format!("only {checked} bundled text assets checked"));
    }
    Ok(())
}

fn fm_line() -> BoxedStrategy<String> {
    prop::sample::select(vec![
        "---",
        "--- ",
        "---\t",
        "name: demo",
        "name: 'it''s'",
        "description: \"a\\nb\\\\c\\/d\\x\"",
        "tools: Read, Agent(scout, scribe), , Bash(git:*)",
        "metadata:",
        "  type: reference",
        "\tmaxWords: 120",
        "# comment",
        "",
        "disable-model-invocation: true",
        "model:",
        "x: a: b",
        "y: c #d",
        "z: e:",
        "w: [a, b]",
        "__proto__: p",
        "constructor: c",
        "key\u{2028}: v",
        "k: v\u{2028}w",
        "k:\u{2028}",
        "9bad: x",
        "a.b-c: ok",
        "  - item",
        "name: \u{feff}x\u{85}",
        "body text",
        "\r",
        "| block",
    ])
    .prop_map(str::to_owned)
    .boxed()
}

/// Half the documents are fenced like real frontmatter, so the field rules are actually reached.
fn fm_doc() -> BoxedStrategy<String> {
    (
        prop::collection::vec(fm_line(), 0..8),
        prop::collection::vec(fm_line(), 0..3),
        prop::sample::select(vec!["\n", "\r\n", "\u{2028}"]),
        any::<bool>(),
    )
        .prop_map(|(lines, body, sep, fenced)| {
            if fenced {
                let nl = if sep == "\r\n" { "\r\n" } else { "\n" };
                format!("---{nl}{}{nl}---{nl}{}", lines.join(sep), body.join("\n"))
            } else {
                lines.join(sep)
            }
        })
        .boxed()
}

fn include_doc() -> BoxedStrategy<String> {
    prop::collection::vec(
        prop::sample::select(vec![
            "# navori:include extract-cmd",
            "  #  navori:include extract-cmd  ",
            "# navori:include missing-partial",
            "#navori:includeextract-cmd",
            "x # navori:include extract-cmd",
            "# navori:include gate-ask\r",
            "\t# navori:include audit-log",
            "echo hi",
            "",
            "# navori:include",
            "# navori:include bad/name",
        ])
        .prop_map(str::to_owned),
        0..5,
    )
    .prop_map(|lines| lines.join("\n"))
    .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(2000))]

    // Covers: R41
    #[test]
    fn frontmatter_matches(raw in fm_doc()) {
        check_frontmatter(&raw)?;
    }

    // Covers: R41
    #[test]
    fn hook_includes_match(text in include_doc()) {
        check_include(&text)?;
    }
}
