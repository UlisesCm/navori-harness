//! `navori_core::render::owned_paths` against the real `prepareClaudeEngine` (spec 0058 T14): the
//! sealed inventory `guard-destructive` embeds, over destinations that are missing, navori's
//! (current, edited, newer, another block's), foreign, symlinked, dangling or directories, with
//! `settings.json` and `.mcp.json` in every ownership shape, plugins and a local preset.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::config;
use navori_core::js_json::JsValue;
use navori_core::markers::{InjectOptions, MarkerMeta, inject_managed_section};
use navori_core::render::block_plan::PlanOptions;
use navori_core::render::claude_md::plan_claude_md;
use navori_core::render::collect::RepoView;
use navori_core::render::harness_files::filter_inventory;
use navori_core::render::harness_plan::{preset_hooks, resolve_harness_plan};
use navori_core::render::owned_paths::{ClaudeOwnedInput, claude_owned_paths};
use navori_core::render::plugins::{load_disabled_plugins, load_enabled_plugins};
use navori_core::render::presets::load_preset;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::json;
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const e = await import({:?});\nconst c = await import({:?});\nconst path = await import('node:path');",
        cli_module("engines/claude/index.ts"),
        cli_module("lib/config/config.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "try {\n\
       const config = c.readConfig(path.join(request.root, 'navori.config.json'));\n\
       const prepared = e.prepareClaudeEngine(request.root, config, { dryRun: true });\n\
       return { owned: prepared.inventory.seal().value };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }",
);

static BASE: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-owned-paths-{}", std::process::id()))
});

struct Disk<'a>(&'a Path);

impl RepoView for Disk<'_> {
    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.0.join(rel)).ok()
    }

    fn read_regular(&self, rel: &str) -> Option<String> {
        let path = self.0.join(rel);
        if !std::fs::symlink_metadata(&path).ok()?.is_file() {
            return None;
        }
        std::fs::read_to_string(path).ok()
    }

    fn exists(&self, rel: &str) -> bool {
        self.0.join(rel).exists()
    }

    fn lexists(&self, rel: &str) -> bool {
        std::fs::symlink_metadata(self.0.join(rel)).is_ok()
    }

    fn list_dir(&self, rel: &str) -> Option<Vec<String>> {
        let entries = std::fs::read_dir(self.0.join(rel)).ok()?;
        Some(
            entries
                .filter_map(|e| e.ok()?.file_name().into_string().ok())
                .collect(),
        )
    }
}

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, text);
}

fn pick(options: &[&'static str]) -> BoxedStrategy<String> {
    prop::sample::select(options.to_vec())
        .prop_map(String::from)
        .boxed()
}

/// What a destination holds.
#[derive(Debug, Clone, Copy)]
enum State {
    Missing,
    Ours,
    OtherBlock,
    Edited,
    Newer,
    Foreign,
    Symlink,
    Dangling,
    Directory,
}

fn state() -> BoxedStrategy<State> {
    prop::sample::select(vec![
        State::Missing,
        State::Missing,
        State::Ours,
        State::OtherBlock,
        State::Edited,
        State::Newer,
        State::Foreign,
        State::Symlink,
        State::Dangling,
        State::Directory,
    ])
    .boxed()
}

/// Destinations and the marker id each is observed with.
const MARKED: [(&str, &str); 12] = [
    (".claude/hooks/guard-destructive.sh", "tgrep-search-lane"),
    ("CLAUDE.md", "contexto-proyecto"),
    (".claude/context/10-orquestacion.md", "orquestacion"),
    (".claude/agents/orchestrator.md", "codex-cross-review"),
    (".claude/agents/publisher.md", "publisher-base"),
    (
        ".claude/agents/implementer.md",
        "codegraph-access-v2-implementer",
    ),
    (".claude/agents/explorer.md", "codegraph-explorer-extension"),
    (".claude/skills/review-diff/SKILL.md", "review-diff-base"),
    (
        ".claude/skills/structural-search/SKILL.md",
        "codegraph-search-extension",
    ),
    (".claude/hooks/plan-gate.sh", "plan-gate-base"),
    (
        ".claude/scripts/guard-search-routing.sh",
        "tgrep-script-guard-search-routing",
    ),
    ("tools/lint.sh", "lint-hook"),
];

fn block(id: &str, shell: bool, version: &str) -> String {
    let meta = MarkerMeta {
        source: Some("@navori/core".to_owned()),
        version: Some(version.to_owned()),
        fm_keys: None,
        floor_version: None,
    };
    let options = InjectOptions {
        shell,
        ..InjectOptions::default()
    };
    inject_managed_section("", id, "Body.", &meta, options).output
}

fn place(root: &Path, rel: &str, id: &str, state: State) {
    let shell = rel.ends_with(".sh");
    match state {
        State::Missing => {}
        State::Ours => write(root, rel, &block(id, shell, "0.1.0")),
        State::OtherBlock => write(root, rel, &block("someone-else", shell, "0.1.0")),
        State::Edited => write(
            root,
            rel,
            &block(id, shell, "0.1.0").replacen("Body.", "Edited.", 1),
        ),
        State::Newer => write(root, rel, &block(id, shell, "999.0.0")),
        State::Foreign => write(root, rel, "mine\n"),
        State::Symlink | State::Dangling => {
            let target = format!("{rel}.real");
            if matches!(state, State::Symlink) {
                write(root, &target, &block(id, shell, "0.1.0"));
            } else if let Some(parent) = root.join(rel).parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Some(name) = Path::new(&target).file_name() {
                let _ = std::os::unix::fs::symlink(name, root.join(rel));
            }
        }
        State::Directory => {
            let _ = std::fs::create_dir_all(root.join(rel));
        }
    }
}

const JSON_SHAPES: [Option<&str>; 7] = [
    None,
    Some(r#"{"$navori":{"managed":true,"version":"0.1.0"}}"#),
    Some(r#"{"$navori":{"managed":false}}"#),
    Some(r#"{"$navori":1}"#),
    Some(r#"{"permissions":{}}"#),
    Some("[1]"),
    Some("{broken"),
];

fn config() -> BoxedStrategy<String> {
    (
        pick(&[r#""custom""#, r#""mine""#]),
        prop::collection::vec(0u8..3, 4),
        pick(&[r#"["claude"]"#, r#"["claude","codex"]"#]),
        prop::option::of(pick(&[r#"{"publisher":false}"#, r#"{"planTiers":true}"#])),
        pick(&[r#""es""#, r#""en""#]),
        pick(&["", r#","project":{"posture":"production"}"#]),
    )
        .prop_map(|(preset, states, engines, harness, lang, project)| {
            let plugins: Vec<String> = ["engram", "codegraph", "gh", "tgrep"]
                .iter()
                .zip(states)
                .filter(|(_, s)| *s > 0)
                .map(|(id, s)| format!(r#""{id}":{{"enabled":{}}}"#, s == 1))
                .collect();
            let harness = harness.map_or_else(String::new, |h| format!(r#","harness":{h}"#));
            format!(
                r#"{{"name":"demo","preset":{preset},"engines":{engines},"language":{lang}{harness}{project},"plugins":{{{}}}}}"#,
                plugins.join(",")
            )
        })
        .boxed()
}

fn local_preset(root: &Path) {
    write(
        root,
        ".navori/presets/mine/mine.json",
        r#"{"id":"mine","displayName":"Mine","extras":{"hooks":[{"id":"lint-hook","relPath":"lint.sh","destRelPath":"tools/lint.sh"}]}}"#,
    );
    write(
        root,
        ".navori/presets/mine/lint.sh",
        "#!/usr/bin/env bash\necho lint\n",
    );
}

fn string_at(config: &JsValue, key: &str) -> Option<String> {
    match config {
        JsValue::Object(object) => match object.get(key) {
            Some(JsValue::String(text)) => text.to_rust(),
            _ => None,
        },
        _ => None,
    }
}

fn rust_owned(root: &Path, text: &str) -> Option<String> {
    let read = config::read(text.as_bytes()).ok()?;
    let config = config::effective_config(&read.data);
    let view = Disk(root);
    let step1 = plan_claude_md(&view, &read.data, root, &PlanOptions::default()).ok()?;
    let preset = match string_at(&config, "preset").as_deref() {
        None | Some("" | "custom") => None,
        Some(id) => load_preset(id, root).ok()?,
    };
    let (enabled, disabled) = match &config {
        JsValue::Object(object) => (
            load_enabled_plugins(object.get("plugins")).ok()?,
            load_disabled_plugins(object.get("plugins")).ok()?,
        ),
        _ => return None,
    };
    let plan = filter_inventory(resolve_harness_plan(
        &config,
        preset.as_ref(),
        true,
        Some("claude"),
    ));
    let hooks = preset_hooks(preset.as_ref(), &config);
    claude_owned_paths(
        &view,
        &ClaudeOwnedInput {
            claude_md: &step1.observed,
            plan: &plan,
            preset_hooks: &hooks,
            enabled: &enabled.loaded,
            disabled: &disabled.loaded,
        },
    )
    .ok()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    // Covers: R41
    #[test]
    fn owned_paths_match(
        config in config(),
        states in prop::collection::vec(state(), MARKED.len()),
        settings in prop::sample::select(JSON_SHAPES.to_vec()),
        mcp in prop::sample::select(JSON_SHAPES.to_vec()),
    ) {
        let root = BASE.join("repo");
        let _ = std::fs::remove_dir_all(&root);
        local_preset(&root);
        for ((rel, id), state) in MARKED.iter().zip(&states) {
            place(&root, rel, id, *state);
        }
        if let Some(text) = settings {
            write(&root, ".claude/settings.json", text);
        }
        if let Some(text) = mcp {
            write(&root, ".mcp.json", text);
        }
        write(&root, "navori.config.json", &config);
        let ts = NODE
            .ask(&json!({ "root": root.to_string_lossy() }))
            .map_err(TestCaseError::fail)?;
        let rust = rust_owned(&root, &config);
        match (ts.get("owned").and_then(|v| v.as_str()), rust) {
            (Some(ts), Some(rust)) => prop_assert_eq!(ts, rust.as_str(), "{} {:?}", config, states),
            (None, _) => {} // The TS threw before sealing (an unreadable destination).
            (Some(ts), None) => prop_assert!(false, "rust declined, ts sealed {:?} for {} {:?}", ts, config, states),
        }
    }
}
