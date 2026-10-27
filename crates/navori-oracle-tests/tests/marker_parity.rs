//! `navori_core::markers` against the real `marker.ts` (spec 0058 T11, T12): generated documents
//! must parse, inject, remove, reorder and split exactly as in the TS CLI.

mod support;

use navori_core::STAMP_VERSION;
use navori_core::integrity::marker_hash;
use navori_core::markers::{self, CommentStyle, InjectOptions, InjectResult, Kept, MarkerMeta};
use navori_core::render::context::Lang;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const m = await import({:?});",
        cli_module("lib/render/marker.ts")
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "switch (request.op) {\n\
       case 'inject':\n\
         m.setMarkerFloorVersion(request.ambient ?? undefined);\n\
         try { return m.injectManagedSection(request.existing, request.id, request.content, request.meta, request.style, request.force, request.restamp); }\n\
         finally { m.setMarkerFloorVersion(undefined); }\n\
       case 'remove': return m.removeManagedSectionGuarded(request.existing, request.id, request.style);\n\
       case 'locate': return m.locateManagedBlocks(request.content, request.style);\n\
       case 'prose': return m.proseLines(request.content, request.styles);\n\
       case 'reorder': return m.reorderManagedBlocks(request.content, request.order, request.style);\n\
       case 'split': return m.splitUserSection(request.content, request.style);\n\
       case 'emit': return m.emitUserSection(request.managed, request.body, request.lang);\n\
       default: throw new Error('unknown op ' + request.op);\n\
     }",
);

const IDS: [&str; 3] = ["a", "b", "c.d"];
const VERSIONS: [&str; 6] = [
    "0.11.0",
    "0.12.2",
    "0.13.0",
    "0.13.0-rust.1",
    "1.0",
    "0.12.10",
];

fn style_name(style: CommentStyle) -> &'static str {
    match style {
        CommentStyle::Html => "html",
        CommentStyle::Shell => "shell",
    }
}

/// JS string offset (UTF-16 units) of a Rust byte offset.
fn js_offset(text: &str, byte: usize) -> usize {
    text.get(..byte)
        .map_or(0, |prefix| prefix.encode_utf16().count())
}

fn prose_text() -> BoxedStrategy<String> {
    prop::sample::select(vec![
        "", "# Title", "prose é 😀", "trailing  ", "\u{feff}bom", "carriage\r", "a\u{2028}b",
        "~~~", "```", "  ```sh", "\u{a0}```", "\u{85}```", "<!-- navori:user-start -->",
        "<!-- navori:user-end -->", " <!-- navori:user-end --> ",
        "<!-- Escribe aquí el dominio y las convenciones específicas de tu repo. navori preserva intacto todo lo que esté entre estos marcadores en cada render. -->",
        "<!-- Zona de proyecto (no-managed) old hint -->", "\t", "body line", "x -->",
        "ends\u{feff}", "ends\u{85}",
    ])
    .prop_map(str::to_owned)
    .boxed()
}

fn body() -> BoxedStrategy<Vec<String>> {
    prop::collection::vec(
        prop_oneof![
            6 => prose_text(),
            1 => prop::sample::select(IDS.to_vec()).prop_map(|id| format!("<!-- /navori:managed id=\"{id}\" -->")),
            1 => prop::sample::select(IDS.to_vec()).prop_map(|id| format!("# navori:managed end id=\"{id}\"")),
        ],
        0..4,
    )
    .boxed()
}

#[derive(Debug, Clone)]
struct BlockSpec {
    style: CommentStyle,
    id: &'static str,
    hash: u8,
    version: Option<&'static str>,
    source: bool,
    fm_keys: bool,
    open_shape: u8,
    close: u8,
    body: Vec<String>,
}

impl BlockSpec {
    fn render(&self) -> String {
        let body = self.body.join("\n");
        let hash = match self.hash {
            0 | 3 => Some(marker_hash(&body)),
            1 => Some("deadbeef".to_owned()),
            _ => None,
        };
        let mut attrs = String::new();
        if self.hash == 3 {
            // An empty attribute never matches `name="([^"]+)"`; the next occurrence does.
            attrs.push_str(" hash=\"\" version=\"\"");
        }
        if let Some(hash) = hash {
            attrs.push_str(&format!(" hash=\"{hash}\""));
        }
        if let Some(version) = self.version {
            attrs.push_str(&format!(" version=\"{version}\""));
        }
        if self.source {
            attrs.push_str(" source=\"@navori/core\"");
        }
        if self.fm_keys {
            attrs.push_str(" fmkeys=\"name,model\"");
        }
        let id = self.id;
        let (open, close) = match self.style {
            CommentStyle::Html => {
                let open = match self.open_shape {
                    0 => format!("<!-- navori:managed id=\"{id}\"{attrs} -->"),
                    1 => format!("<!-- navori:managed\tid=\"{id}\"{attrs}-->"),
                    2 => format!("<!-- navori:managed id=\"{id}\"{attrs} ->"),
                    _ => format!("text <!-- navori:managed  id=\"{id}\"{attrs} --> more"),
                };
                (open, format!("<!-- /navori:managed id=\"{id}\" -->"))
            }
            CommentStyle::Shell => {
                let open = match self.open_shape {
                    0 | 2 => format!("# navori:managed start id=\"{id}\"{attrs}"),
                    1 => format!("# navori:managed start\u{feff}id=\"{id}\"{attrs}"),
                    _ => format!("  # navori:managed start id=\"{id}\"{attrs} trailing"),
                };
                (open, format!("# navori:managed end id=\"{id}\""))
            }
        };
        match self.close {
            // Collapsed empty block on one line.
            0 if body.is_empty() && self.style == CommentStyle::Html => format!("{open}{close}"),
            0..=2 => format!("{open}\n{body}\n{close}"),
            // Orphan open.
            3 => format!("{open}\n{body}"),
            // Orphan close only.
            _ => format!("{body}\n{close}"),
        }
    }
}

fn block(style: CommentStyle) -> BoxedStrategy<BlockSpec> {
    (
        prop::sample::select(IDS.to_vec()),
        0..4u8,
        prop::option::of(prop::sample::select(VERSIONS.to_vec())),
        any::<bool>(),
        any::<bool>(),
        prop_oneof![6 => Just(0u8), 1 => 1..4u8],
        prop_oneof![8 => Just(1u8), 1 => Just(0u8), 1 => 3..5u8],
        body(),
    )
        .prop_map(
            move |(id, hash, version, source, fm_keys, open_shape, close, body)| BlockSpec {
                style,
                id,
                hash,
                version,
                source,
                fm_keys,
                open_shape,
                close,
                body,
            },
        )
        .boxed()
}

fn document(style: CommentStyle) -> BoxedStrategy<String> {
    let piece = prop_oneof![
        3 => block(style).prop_map(|b| b.render()),
        2 => prose_text(),
        // A marker quoted inside a fence is documentation, not a block.
        1 => block(style).prop_map(|b| format!("```\n{}\n```", b.render())),
    ];
    (
        prop::collection::vec(piece, 0..6),
        prop::sample::select(vec!["", "\n", "\r\n", "\n\n\n"]),
    )
        .prop_map(|(pieces, end)| pieces.join("\n") + end)
        .boxed()
}

fn content() -> BoxedStrategy<String> {
    prop_oneof![
        3 => body().prop_map(|lines| lines.join("\n")),
        1 => Just(String::new()),
        1 => Just("new body\n\n  ".to_owned()),
    ]
    .boxed()
}

fn meta() -> BoxedStrategy<MarkerMeta> {
    (
        prop::option::of(prop::sample::select(vec!["@navori/core", ""])),
        prop::option::of(prop::sample::select(VERSIONS.to_vec())),
        prop::option::of(prop::sample::select(vec![vec![], vec!["name", "model"]])),
        prop::option::weighted(0.2, prop::sample::select(VERSIONS.to_vec())),
    )
        .prop_map(|(source, version, fm_keys, floor)| MarkerMeta {
            source: source.map(str::to_owned),
            version: version.map(str::to_owned),
            fm_keys: fm_keys.map(|keys| keys.into_iter().map(str::to_owned).collect()),
            floor_version: floor.map(str::to_owned),
        })
        .boxed()
}

fn meta_json(meta: &MarkerMeta) -> Value {
    let mut object = serde_json::Map::new();
    if let Some(source) = &meta.source {
        object.insert("source".into(), json!(source));
    }
    if let Some(version) = &meta.version {
        object.insert("version".into(), json!(version));
    }
    if let Some(keys) = &meta.fm_keys {
        object.insert("fmKeys".into(), json!(keys));
    }
    if let Some(floor) = &meta.floor_version {
        object.insert("floorVersion".into(), json!(floor));
    }
    Value::Object(object)
}

fn inject_json(result: &InjectResult) -> Value {
    let d = &result.details;
    let mut details = json!({
        "existingHash": d.existing_hash,
        "actualHash": d.actual_hash,
        "newHash": d.new_hash,
        "existingVersion": d.existing_version,
        "existingSource": d.existing_source,
    });
    if let (Some(drift), Some(downgrade), Some(object)) =
        (d.version_drift, d.downgrade, details.as_object_mut())
    {
        object.insert("versionDrift".into(), json!(drift));
        object.insert("downgrade".into(), json!(downgrade));
    }
    json!({ "output": result.output, "status": result.status.as_str(), "details": details })
}

fn ask(request: &Value) -> Result<Value, TestCaseError> {
    NODE.ask(request).map_err(TestCaseError::fail)
}

#[derive(Debug, Clone)]
struct InjectCase {
    style: CommentStyle,
    existing: String,
    id: &'static str,
    content: String,
    meta: MarkerMeta,
    force: bool,
    restamp: bool,
    ambient: Option<&'static str>,
}

/// Half of the cases plant a well-formed block with the injected id, and half of those inject its
/// own body again (optionally with trailing whitespace), so `unchanged`, metadata-only updates and
/// the downgrade branches are reached as often as `created`.
fn inject_case() -> impl Strategy<Value = InjectCase> {
    prop_oneof![Just(CommentStyle::Html), Just(CommentStyle::Shell)].prop_flat_map(|style| {
        (
            (
                document(style),
                document(style),
                block(style),
                any::<bool>(),
                0..3u8,
            ),
            content(),
            meta(),
            prop::bool::weighted(0.2),
            prop::bool::weighted(0.2),
            prop::option::weighted(0.3, prop::sample::select(VERSIONS.to_vec())),
        )
            .prop_map(
                move |(
                    (before, after, mut target, plant, reuse),
                    content,
                    meta,
                    force,
                    restamp,
                    ambient,
                )| {
                    target.open_shape = 0;
                    target.close = 1;
                    let id = target.id;
                    let (existing, content) = if plant {
                        let existing = format!("{before}\n{}\n{after}", target.render());
                        let body = target.body.join("\n");
                        let content = match reuse {
                            0 => body,
                            1 => format!("{body}\r\n \t"),
                            _ => content,
                        };
                        (existing, content)
                    } else {
                        (before, content)
                    };
                    InjectCase {
                        style,
                        existing,
                        id,
                        content,
                        meta,
                        force,
                        restamp,
                        ambient,
                    }
                },
            )
    })
}

fn styled_document() -> impl Strategy<Value = (CommentStyle, String)> {
    prop_oneof![Just(CommentStyle::Html), Just(CommentStyle::Shell)]
        .prop_flat_map(|style| document(style).prop_map(move |doc| (style, doc)))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(3000))]

    // Covers: R35, R37
    #[test]
    fn inject_matches_inject_managed_section(case in inject_case()) {
        let ts = ask(&json!({
            "op": "inject", "existing": case.existing, "id": case.id, "content": case.content,
            "meta": meta_json(&case.meta), "style": style_name(case.style), "force": case.force,
            "restamp": case.restamp, "ambient": case.ambient,
        }))?;
        let rust = markers::inject_managed_section(
            &case.existing,
            case.id,
            &case.content,
            &case.meta,
            InjectOptions {
                shell: case.style == CommentStyle::Shell,
                force_overwrite: case.force,
                restamp: case.restamp,
                ambient_floor: case.ambient,
            },
        );
        prop_assert_eq!(ts, inject_json(&rust), "{:?}", case);
    }

    // Covers: R36, R37
    #[test]
    fn guarded_remove_matches_remove_managed_section_guarded(
        (style, existing) in styled_document(),
        id in prop::sample::select(IDS.to_vec()),
    ) {
        let ts = ask(&json!({ "op": "remove", "existing": existing, "id": id, "style": style_name(style) }))?;
        let rust = match markers::remove_managed_section_guarded(&existing, id, style, STAMP_VERSION) {
            Ok(content) => json!({ "content": content }),
            Err(Kept::Newer) => json!({ "kept": "newer" }),
            Err(Kept::Modified) => json!({ "kept": "modified" }),
        };
        prop_assert_eq!(ts, rust, "{:?}", existing);
    }

    // Covers: R35
    #[test]
    fn locate_and_prose_lines_match((style, content) in styled_document()) {
        let ts = ask(&json!({ "op": "locate", "content": content, "style": style_name(style) }))?;
        let rust: Vec<Value> = markers::locate_managed_blocks(&content, style)
            .iter()
            .map(|b| json!({
                "id": b.id,
                "openStart": js_offset(&content, b.open_start),
                "closeEnd": js_offset(&content, b.close_end),
            }))
            .collect();
        prop_assert_eq!(&ts, &Value::Array(rust), "{:?}", content);

        let ts = ask(&json!({ "op": "prose", "content": content, "styles": ["html", "shell"] }))?;
        let rust: Vec<Value> = markers::prose_lines(&content, &[CommentStyle::Html, CommentStyle::Shell])
            .iter()
            .map(|l| json!({ "text": l.text, "index": l.index, "offset": js_offset(&content, l.offset) }))
            .collect();
        prop_assert_eq!(&ts, &Value::Array(rust), "{:?}", content);
    }

    // Covers: R35
    #[test]
    fn reorder_split_and_emit_match(
        (style, content) in styled_document(),
        order in prop::sample::subsequence(vec!["c.d", "b", "a", "z"], 0..4).prop_shuffle(),
        lang in prop_oneof![Just(Lang::Es), Just(Lang::En)],
    ) {
        let ts = ask(&json!({ "op": "reorder", "content": content, "order": order, "style": style_name(style) }))?;
        let rust = markers::reorder_managed_blocks(&content, &order, style);
        prop_assert_eq!(ts, json!({
            "output": rust.output,
            "reordered": rust.reordered,
            "blockedByInterleaving": rust.blocked_by_interleaving,
        }), "{:?}", content);

        let ts = ask(&json!({ "op": "split", "content": content, "style": style_name(style) }))?;
        let rust = markers::split_user_section(&content, style);
        prop_assert_eq!(ts, json!({
            "managed": rust.managed,
            "userBody": rust.user_body,
            "hadMarkers": rust.had_markers,
        }), "{:?}", content);

        let lang_name = if lang == Lang::En { "en" } else { "es" };
        let ts = ask(&json!({ "op": "emit", "managed": rust.managed, "body": rust.user_body, "lang": lang_name }))?;
        let emitted = markers::emit_user_section(&rust.managed, rust.user_body.as_deref(), lang);
        prop_assert_eq!(ts, json!(emitted));

        // Arbitrary managed text and body, trailing JS-only whitespace included.
        let ts = ask(&json!({ "op": "emit", "managed": content, "body": content, "lang": lang_name }))?;
        let emitted = markers::emit_user_section(&content, Some(&content), lang);
        prop_assert_eq!(ts, json!(emitted), "{:?}", content);
    }
}
