//! `navori_core::config::read` against the real `readConfig` (spec 0058 T8): generated configs
//! must be accepted or rejected alike, produce the same `JSON.stringify(data, null, 2)` and the
//! same stderr warnings.

mod support;

use std::fmt::Write as _;

use navori_core::config;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::json;
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const cfg = await import({:?});\n\
         const fs = await import('node:fs');\n\
         const os = await import('node:os');\n\
         const path = await import('node:path');\n\
         const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'navori-config-parity-'));\n\
         const file = path.join(dir, 'navori.config.json');",
        cli_module("lib/config/config.ts")
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "fs.writeFileSync(file, request.text);\n\
     const writes = [];\n\
     const original = process.stderr.write;\n\
     process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };\n\
     try {\n\
       const data = cfg.readConfig(file);\n\
       return { valid: true, data: JSON.stringify(data, null, 2), stderr: writes.join('') };\n\
     } catch (error) {\n\
       if (error instanceof cfg.ConfigError) return { valid: false };\n\
       throw error;\n\
     } finally { process.stderr.write = original; }",
);

/// A JSON document with explicit key order (duplicates allowed), so the generator controls the
/// insertion order `JSON.parse` sees.
#[derive(Debug, Clone)]
enum Doc {
    Null,
    Bool(bool),
    Num(f64),
    /// A number literal written as is, to exercise `JSON.parse` rounding.
    RawNum(&'static str),
    Str(String),
    Arr(Vec<Doc>),
    Obj(Vec<(String, Doc)>),
}

impl Doc {
    fn write(&self, out: &mut String) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Self::Num(n) => {
                let _ = write!(out, "{n}");
            }
            Self::RawNum(text) => out.push_str(text),
            Self::Str(s) => out.push_str(&serde_json::to_string(s).unwrap_or_default()),
            Self::Arr(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Self::Obj(entries) => {
                out.push('{');
                for (i, (key, value)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(key).unwrap_or_default());
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

fn s(text: &str) -> Doc {
    Doc::Str(text.to_owned())
}

/// Strings that hit the schema's checks: enums, kebab-case, paths, gate chains, whitespace.
fn interesting_string() -> BoxedStrategy<String> {
    prop_oneof![
        prop::sample::select(vec![
            "",
            " ",
            "claude",
            "codex",
            "pi",
            "cursor",
            "agents-md",
            "copilot",
            "fr",
            "es",
            "en",
            "conventional",
            "conventional-es",
            "free",
            "opt-in",
            "always",
            "off",
            "local",
            "full",
            "minimal",
            "root",
            "pnpm",
            "npm",
            "bun",
            "yarn",
            "turbo",
            "opus",
            "sonnet",
            "haiku",
            "low",
            "max",
            "xhigh",
            "my-repo",
            "My Repo",
            "-repo",
            "1.2.3",
            "0.13.0-rust.1",
            "pnpm test",
            "pnpm lint && pnpm test",
            "cd packages/cli && bun run check",
            "cd a b",
            "pnpm $(curl x)",
            "make test",
            "pnpm test;",
            "pnpm a || npm b",
            "progress",
            "../escape",
            "/abs",
            "a\\..\\b",
            "docs/x.md",
            " sol ",
            "\u{feff}",
            "ws<1>",
            "line\nbreak",
            "@scope/pkg",
            "profile_1",
            "_bad",
            "\u{e9}t\u{e9}",
        ])
        .prop_map(str::to_owned),
        "[a-zA-Z_ -]{0,10}",
    ]
    .boxed()
}

fn scalar() -> BoxedStrategy<Doc> {
    prop_oneof![
        Just(Doc::Null),
        any::<bool>().prop_map(Doc::Bool),
        prop::sample::select(vec![
            0.0,
            -1.0,
            1.0,
            2.0,
            1.5,
            175_000.0,
            9_007_199_254_740_992.0
        ])
        .prop_map(Doc::Num),
        interesting_string().prop_map(Doc::Str),
        prop::sample::select(vec![
            "123456789012345678901234",
            "0.1000000000000000055511151231257827",
            "1e-7",
            "-0",
            "2.5E+3",
            "9007199254740993",
            "1.7976931348623157e308",
        ])
        .prop_map(Doc::RawNum),
    ]
    .boxed()
}

fn any_doc() -> BoxedStrategy<Doc> {
    scalar()
        .prop_recursive(3, 16, 4, |inner| {
            prop_oneof![
                prop::collection::vec(inner.clone(), 0..4).prop_map(Doc::Arr),
                prop::collection::vec((interesting_string(), inner), 0..4).prop_map(Doc::Obj),
            ]
        })
        .boxed()
}

/// An object whose entries come from `catalog`, each present with probability `p`, shuffled,
/// sometimes with a duplicated key. A key ending in `!` is a required field (present 95% of the
/// time); one ending in `?` is rare (3%).
fn object_of(catalog: Vec<(&'static str, BoxedStrategy<Doc>)>, p: f64) -> BoxedStrategy<Doc> {
    let entries: Vec<BoxedStrategy<Option<(String, Doc)>>> = catalog
        .into_iter()
        .map(|(key, strategy)| {
            let (key, p) = match (key.strip_suffix('!'), key.strip_suffix('?')) {
                (Some(required), _) => (required, 0.95),
                (_, Some(rare)) => (rare, 0.03),
                _ => (key, p),
            };
            prop::option::weighted(p, strategy.prop_map(move |doc| (key.to_owned(), doc))).boxed()
        })
        .collect();
    (entries, any::<bool>())
        .prop_map(|(entries, duplicate)| {
            let mut present: Vec<(String, Doc)> = entries.into_iter().flatten().collect();
            if duplicate && let Some(first) = present.first().cloned() {
                present.push(first);
            }
            present
        })
        .prop_shuffle()
        .prop_map(Doc::Obj)
        .boxed()
}

fn either(good: BoxedStrategy<Doc>) -> BoxedStrategy<Doc> {
    prop_oneof![30 => good, 1 => any_doc()].boxed()
}

fn string_list() -> BoxedStrategy<Doc> {
    prop::collection::vec(interesting_string().prop_map(Doc::Str), 0..4)
        .prop_map(Doc::Arr)
        .boxed()
}

fn one_of(values: &'static [&'static str]) -> BoxedStrategy<Doc> {
    prop::sample::select(values).prop_map(s).boxed()
}

fn boolean() -> BoxedStrategy<Doc> {
    any::<bool>().prop_map(Doc::Bool).boxed()
}

/// Gate chains built from safe and unsafe steps, joined by every sequencer `isSafeGateChain`
/// splits on, with stray whitespace.
fn gate_chain() -> BoxedStrategy<Doc> {
    let step = prop::sample::select(vec![
        "pnpm test",
        "bun run check:fast",
        "npm",
        "yarn x=1 @a/b:c",
        "cd packages/cli",
        "cd a b",
        "cd",
        "cd  dir",
        "cd\tdir",
        "make",
        "pnpm $(x)",
        "pnpm 'q'",
        "",
        " ",
        "pnpm\u{a0}test",
    ]);
    let sequencer = prop::sample::select(vec!["&&", " && ", "||", ";", " ; ", "|", "&", "&&&"]);
    (step.clone(), prop::collection::vec((sequencer, step), 0..3))
        .prop_map(|(first, rest)| {
            let mut chain = first.to_owned();
            for (sequencer, step) in rest {
                chain.push_str(sequencer);
                chain.push_str(step);
            }
            Doc::Str(chain)
        })
        .boxed()
}

fn quality_gate() -> BoxedStrategy<Doc> {
    object_of(
        vec![
            ("fast!", either(Just(s("pnpm lint")).boxed())),
            ("full!", either(Just(s("pnpm test")).boxed())),
            (
                "scoped",
                either(interesting_string().prop_map(Doc::Str).boxed()),
            ),
            ("affected", either(gate_chain())),
            ("docs", either(gate_chain())),
            ("nativeHooks", either(boolean())),
            ("fsat", scalar()),
        ],
        0.6,
    )
}

fn roles(
    value: BoxedStrategy<Doc>,
    extra: Vec<(&'static str, BoxedStrategy<Doc>)>,
) -> BoxedStrategy<Doc> {
    let mut catalog: Vec<(&'static str, BoxedStrategy<Doc>)> = [
        "orchestrator",
        "implementer",
        "reviewer",
        "scout",
        "auditor",
        "publisher",
        "scribe",
        "architect?",
        "leader?",
        "Reviewer",
        "scuot",
    ]
    .into_iter()
    .map(|key| (key, value.clone()))
    .collect();
    catalog.extend(extra);
    object_of(catalog, 0.25)
}

fn models() -> BoxedStrategy<Doc> {
    let profile = object_of(
        vec![
            (
                "model",
                either(interesting_string().prop_map(Doc::Str).boxed()),
            ),
            ("effort", either(one_of(&["low", "high", "max"]))),
            ("extra", scalar()),
        ],
        0.4,
    );
    let profiles = prop::collection::vec((interesting_string(), profile), 0..3)
        .prop_map(Doc::Obj)
        .boxed();
    let codex_map = object_of(
        vec![
            ("opus", either(Just(s("sol")).boxed())),
            ("sonnet", either(Just(s("luna")).boxed())),
            ("haiku", scalar()),
            ("gpt", scalar()),
        ],
        0.5,
    );
    roles(
        either(one_of(&["opus", "sonnet", "haiku"])),
        vec![
            ("codexProfiles", either(profiles)),
            ("codexMap", either(codex_map)),
        ],
    )
}

fn project() -> BoxedStrategy<Doc> {
    let migration = object_of(
        vec![
            ("legacy!", either(Just(s("a")).boxed())),
            ("preferred!", either(Just(s("b")).boxed())),
            ("domain!", either(Just(s("c")).boxed())),
            ("note", scalar()),
        ],
        0.85,
    );
    object_of(
        vec![
            ("legacyPaths", either(string_list())),
            ("criticalAreas", either(string_list())),
            ("criticalPaths", either(string_list())),
            ("testRunner", either(Just(s("vitest")).boxed())),
            ("posture", scalar()),
            ("testsExclude", either(string_list())),
            ("localSkills", either(string_list())),
            (
                "foreignHarness",
                either(object_of(
                    vec![("acknowledged", either(string_list())), ("other", scalar())],
                    0.6,
                )),
            ),
            ("libraries", either(string_list())),
            ("extraLibraries", either(string_list())),
            (
                "libraryMigrations",
                either(
                    prop::collection::vec(migration, 0..3)
                        .prop_map(Doc::Arr)
                        .boxed(),
                ),
            ),
            ("codeLanguage", either(one_of(&["ts", "rust", "python"]))),
            ("customPrompt", any_doc()),
            ("2", scalar()),
        ],
        0.3,
    )
}

fn monorepo() -> BoxedStrategy<Doc> {
    let workspace = object_of(
        vec![
            ("name!", prop_oneof![4 => one_of(&["web", "@scope/api"]), 1 => interesting_string().prop_map(Doc::Str).boxed()].boxed()),
            ("path!", prop_oneof![4 => one_of(&["apps/web", "pkg"]), 1 => one_of(&["../x", "/abs", ""])].boxed()),
            ("preset", scalar()),
            ("qualityGate", quality_gate()),
            ("libraries", either(string_list())),
            ("pth", scalar()),
        ],
        0.75,
    );
    object_of(
        vec![
            ("enabled!", either(boolean())),
            ("tool", either(one_of(&["pnpm", "turbo", "bazel"]))),
            (
                "workspaces",
                either(
                    prop::collection::vec(workspace, 0..3)
                        .prop_map(Doc::Arr)
                        .boxed(),
                ),
            ),
            (
                "workspaceHarness",
                either(one_of(&["minimal", "full", "root", "half"])),
            ),
        ],
        0.7,
    )
}

fn config_doc() -> BoxedStrategy<Doc> {
    let numbers = prop::sample::select(vec![
        0.0,
        1.0,
        2.0,
        3.0,
        1.5,
        -1.0,
        9_007_199_254_740_991.0,
        9_007_199_254_740_992.0,
    ])
    .prop_map(Doc::Num)
    .boxed();
    let sdd = object_of(
        vec![
            (
                "deliveries",
                either(object_of(
                    vec![
                        ("splitMinTasks", either(numbers.clone())),
                        ("splitMinLoc", either(numbers.clone())),
                        ("maxPrsPerSpec", either(numbers)),
                    ],
                    0.5,
                )),
            ),
            ("enabled", either(boolean())),
            ("specsDir", scalar()),
            ("applyWhen", either(string_list())),
        ],
        0.4,
    );
    let progress = object_of(
        vec![
            (
                "dir",
                either(interesting_string().prop_map(Doc::Str).boxed()),
            ),
            ("currentFile", either(Just(s("now.md")).boxed())),
            ("historyFile", scalar()),
            ("checkpointsDir", scalar()),
            ("archiveAfterDays", scalar()),
        ],
        0.35,
    );
    let plugin = object_of(
        vec![
            ("enabled!", either(boolean())),
            ("nativeHook", either(boolean())),
            ("enabeld", scalar()),
        ],
        0.8,
    );
    let plugins = prop::collection::vec((interesting_string(), plugin), 0..3)
        .prop_map(Doc::Obj)
        .boxed();
    let engines = (
        prop::collection::vec(
            prop_oneof![
                4 => one_of(&["claude", "codex", "pi", "cursor"]),
                1 => one_of(&["fr", "windsurf"]),
                1 => scalar(),
            ],
            1..4,
        ),
        prop::bool::weighted(0.1),
    )
        .prop_map(|(engines, empty)| Doc::Arr(if empty { Vec::new() } else { engines }))
        .boxed();
    let harness_extra = vec![
        ("planTiers", either(boolean())),
        ("masterPlan", either(boolean())),
        (
            "compactAdviceTokens",
            either(
                prop::sample::select(vec![0.0, 175_000.0, -5.0, 1.5, 9_007_199_254_740_992.0])
                    .prop_map(Doc::Num)
                    .boxed(),
            ),
        ),
    ];
    let catalog: Vec<(&'static str, BoxedStrategy<Doc>)> = vec![
        (
            "$schema",
            either(Just(s("https://x/navori.config.v1.json")).boxed()),
        ),
        (
            "name",
            prop_oneof![8 => Just(s("my-repo")), 1 => scalar()].boxed(),
        ),
        ("version", either(Just(s("2.0.0")).boxed())),
        (
            "harnessVersion",
            either(one_of(&["0.12.2", "0.13.0-rust.1"])),
        ),
        ("workspace", either(one_of(&["team", "../../evil"]))),
        ("engines", prop_oneof![8 => engines, 1 => scalar()].boxed()),
        (
            "preset",
            prop_oneof![8 => Just(s("node")), 1 => scalar()].boxed(),
        ),
        (
            "language",
            prop_oneof![one_of(&["es", "en", "fr"]), scalar()].boxed(),
        ),
        ("branchBase", either(Just(s("dev")).boxed())),
        (
            "gitignoreHarness",
            either(one_of(&["off", "local", "full", "all"])),
        ),
        ("prTarget", scalar()),
        (
            "commits",
            prop_oneof![one_of(&["conventional", "free", "gitmoji"]), scalar()].boxed(),
        ),
        ("qualityGate", either(quality_gate())),
        (
            "hooks",
            either(object_of(
                vec![("verifyOnStop", either(boolean())), ("onStop", scalar())],
                0.5,
            )),
        ),
        (
            "audit",
            either(object_of(
                vec![("mode", either(one_of(&["opt-in", "always", "never"])))],
                0.7,
            )),
        ),
        ("packageManager", either(one_of(&["pnpm", "bun", "deno"]))),
        ("sdd", either(sdd)),
        ("harness", either(roles(either(boolean()), harness_extra))),
        ("models", either(models())),
        (
            "effort",
            either(roles(
                either(one_of(&["low", "high", "max", "ultra"])),
                vec![],
            )),
        ),
        ("plugins", either(plugins)),
        (
            "blocks",
            either(object_of(vec![("exclude", either(string_list()))], 0.7)),
        ),
        ("progress", either(progress)),
        ("project", either(project())),
        ("monorepo", either(monorepo())),
        ("nmae", scalar()),
        ("customTool", any_doc()),
        ("10", scalar()),
    ];
    object_of(catalog, 0.15)
}

/// Required keys are present most of the time so most documents reach the deeper checks.
fn config_text() -> impl Strategy<Value = String> {
    (config_doc(), any::<u8>()).prop_map(|(doc, knob)| {
        let mut doc = doc;
        if let Doc::Obj(entries) = &mut doc
            && knob % 8 != 0
        {
            for (key, value) in [
                ("name", s("my-repo")),
                ("engines", Doc::Arr(vec![s("claude")])),
                ("preset", s("node")),
            ] {
                if !entries.iter().any(|(k, _)| k == key) {
                    entries.insert(0, (key.to_owned(), value));
                }
            }
        }
        let mut text = String::new();
        if knob % 13 == 0 {
            text.push('\u{feff}');
        }
        doc.write(&mut text);
        if knob % 17 == 0 {
            text.push_str(" ,");
        }
        text
    })
}

fn check(text: &str) -> Result<(), TestCaseError> {
    let reply = NODE
        .ask(&json!({ "text": text }))
        .map_err(TestCaseError::fail)?;
    let rust = config::read(text.as_bytes());
    let ts_valid = reply["valid"].as_bool() == Some(true);
    prop_assert_eq!(
        ts_valid,
        rust.is_ok(),
        "acceptance differs for {}: rust {:?}",
        text,
        rust.as_ref().err()
    );
    if let Ok(config) = rust {
        let data = config.data.stringify(Some(2));
        prop_assert_eq!(
            reply["data"].as_str(),
            data.as_deref(),
            "data differs for {}",
            text
        );
        let stderr: String = config
            .warnings
            .iter()
            .map(|line| format!("{line}\n"))
            .collect();
        prop_assert_eq!(
            reply["stderr"].as_str(),
            Some(stderr.as_str()),
            "warnings differ for {}",
            text
        );
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(6000))]

    // Covers: R32, R33
    #[test]
    fn read_matches_read_config(text in config_text()) {
        check(&text)?;
    }
}

// Covers: R32
#[test]
fn the_repository_config_matches() -> Result<(), String> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../navori.config.json");
    let text = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    check(&text).map_err(|e| e.to_string())
}
