//! `navori_core::render::claude_files` against the real `prepareClaudeEngine` (spec 0058 T14): the
//! one-shot `progress/` files, the hooks of a local preset and the plugin scripts under
//! `.claude/scripts/`, with configured progress paths, stale and newer versions, hand edits,
//! markerless scripts (pristine pre-#637, foreign, mentioning a marker), symlinks and
//! destinations that are directories.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::STAMP_VERSION;
use navori_core::config;
use navori_core::js_json::JsValue;
use navori_core::render::claude_files::collect_claude_files;
use navori_core::render::collect::RepoView;
use navori_core::render::context::Lang;
use navori_core::render::plugin_scripts::{
    LEGACY_FINGERPRINTS, ScriptEngine, legacy_script_content, masked_sha256,
    matches_legacy_fingerprint, plugin_script_placements,
};
use navori_core::render::plugins::{load_enabled_plugins, load_plugin};
use navori_core::render::presets::load_preset;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module, first_difference};

fn prelude() -> String {
    format!(
        "const e = await import({:?});\nconst m = await import({:?});\nconst c = await import({:?});\n\
         const f = await import({:?});\nconst s = await import({:?});\nconst b = await import({:?});\n\
         const crypto = await import('node:crypto');\nconst path = await import('node:path');",
        cli_module("engines/claude/index.ts"),
        cli_module("lib/render/marker.ts"),
        cli_module("lib/config/config.ts"),
        cli_module("engines/shared/legacy-plugin-script-fingerprints.ts"),
        cli_module("engines/shared/plugin-scripts.ts"),
        cli_module("lib/config/plugins.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'table') return f.legacyFingerprintTable();\n\
     if (request.op === 'fingerprint') {\n\
       const lines = request.content.split('\\n');\n\
       for (const i of request.masked) if (i < lines.length) lines[i] = '';\n\
       return [crypto.createHash('sha256').update(lines.join('\\n')).digest('hex'),\n\
               f.matchesLegacyFingerprint(request.name, request.content)];\n\
     }\n\
     if (request.op === 'placements') {\n\
       const plugin = b.loadEnabledPlugins({ [request.id]: { enabled: true } }).loaded[0];\n\
       return ['claude', 'codex', 'pi'].flatMap((engine) => s.pluginScriptPlacements(plugin, engine)\n\
         .map((p) => [p.destRelPath, p.managedId, p.meta.source, p.exec]));\n\
     }\n\
     m.setMarkerFloorVersion(request.floor ?? undefined);\n\
     try {\n\
       const root = request.root;\n\
       const config = c.readConfig(path.join(root, 'navori.config.json'));\n\
       const prepared = e.prepareClaudeEngine(root, config, { dryRun: true });\n\
       prepared.inventory.seal();\n\
       const fin = prepared.finalize();\n\
       const inScope = (rel) => /^(\\.claude\\/scripts|progress|notes|docs|tools)\\//.test(rel);\n\
       return {\n\
         pending: fin.pending.filter((p) => inScope(p.relPath)).map((p) => [p.relPath, p.content, p.status, p.chmodExec === true]),\n\
         skipped: fin.skipped.filter((x) => inScope(x.path)).map((x) => [x.path, x.reason, x.status ?? null,\n\
           x.resolution ? x.resolution.content : null, x.markerlessResolution ? x.markerlessResolution.content : null]),\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }\n\
     finally { m.setMarkerFloorVersion(undefined); }",
);

static BASE: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-claude-files-{}", std::process::id()))
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

fn field(key: &'static str, value: BoxedStrategy<String>) -> BoxedStrategy<Option<String>> {
    prop::option::of(value.prop_map(move |v| format!("{}:{v}", json!(key)))).boxed()
}

fn config() -> BoxedStrategy<String> {
    vec![
        Just(Some(r#""name":"demo","engines":["claude"]"#.to_owned())).boxed(),
        field(
            "preset",
            pick(&[r#""custom""#, r#""mine""#, r#""astro""#, r#""loose""#]),
        ),
        field("language", pick(&[r#""es""#, r#""en""#])),
        field("projectName", pick(&[r#""demo""#, r#""other""#])),
        field(
            "progress",
            pick(&[
                r#"{"dir":"notes"}"#,
                r#"{"dir":"./docs//state","currentFile":"now.md"}"#,
                r#"{"currentFile":"log.md","historyFile":"log.md"}"#,
                r#"{"historyFile":"archive/old.md"}"#,
            ]),
        ),
        field(
            "sdd",
            pick(&[r#"{"enabled":false}"#, r#"{"enabled":true}"#]),
        ),
        field(
            "plugins",
            pick(&[
                r#"{"tgrep":{"enabled":true}}"#,
                r#"{"tgrep":{"enabled":false}}"#,
                r#"{"tgrep":{"enabled":true,"nativeHook":true}}"#,
            ]),
        ),
    ]
    .prop_map(|fields| {
        format!(
            "{{{}}}",
            fields.into_iter().flatten().collect::<Vec<_>>().join(",")
        )
    })
    .boxed()
}

fn local_preset(root: &Path) {
    write(
        root,
        ".navori/presets/mine/mine.json",
        r#"{"id":"mine","displayName":"Mine",
            "extras":{"hooks":[{"id":"lint-hook","relPath":"hooks//lint.sh","destRelPath":"tools/lint.sh"},
                               {"id":"doc-hook","relPath":"./hooks/doc.md","destRelPath":"tools/doc.md","condition":"sdd.enabled"}]}}"#,
    );
    // An unnormalized destination: the owned-path inventory throws on it.
    write(
        root,
        ".navori/presets/loose/loose.json",
        r#"{"id":"loose","displayName":"Loose",
            "extras":{"hooks":[{"id":"lint-hook","relPath":"lint.sh","destRelPath":"tools/./lint.sh"}]}}"#,
    );
    write(
        root,
        ".navori/presets/loose/lint.sh",
        "#!/usr/bin/env bash\necho loose\n",
    );
    write(
        root,
        ".navori/presets/mine/hooks/lint.sh",
        "#!/usr/bin/env bash\n# Lint for {{projectName}}.\n# navori:include extract-cmd\necho lint\n# navori:user-section\n# local tweaks\n",
    );
    write(
        root,
        ".navori/presets/mine/hooks/doc.md",
        "---\nname: doc\n---\n\nDocs for {{projectName}}.\n",
    );
}

const SCRIPT: &str = ".claude/scripts/guard-search-routing.sh";
const HOOK: &str = "tools/lint.sh";
const DOC: &str = "tools/doc.md";

/// What one destination holds before the render.
#[derive(Debug, Clone, Copy)]
enum State {
    Absent,
    Rendered,
    HandEdited,
    Restamped(&'static str),
    Pristine,
    Foreign,
    MentionsMarker,
    ForeignSymlink,
    Directory,
}

fn state() -> BoxedStrategy<State> {
    prop::sample::select(vec![
        State::Absent,
        State::Rendered,
        State::HandEdited,
        State::Restamped("0.1.0"),
        State::Restamped("999.0.0"),
        State::Pristine,
        State::Foreign,
        State::MentionsMarker,
        State::ForeignSymlink,
        State::Directory,
    ])
    .boxed()
}

#[derive(Debug, Clone)]
struct Recipe {
    baseline: String,
    script: State,
    hook: State,
    doc: State,
    progress: u8,
}

fn recipe() -> BoxedStrategy<Recipe> {
    (config(), state(), state(), state(), 0u8..4)
        .prop_map(|(baseline, script, hook, doc, progress)| Recipe {
            baseline,
            script,
            hook,
            doc,
            progress,
        })
        .boxed()
}

fn effective(text: &str) -> Option<JsValue> {
    Some(config::effective_config(
        &config::read(text.as_bytes()).ok()?.data,
    ))
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

fn rust_files(root: &Path, text: &str, floor: Option<&str>) -> Option<Value> {
    let config = effective(text)?;
    let preset = match string_at(&config, "preset").as_deref() {
        None | Some("" | "custom") => None,
        Some(id) => load_preset(id, root).ok()?,
    };
    let plugins = match &config {
        JsValue::Object(object) => load_enabled_plugins(object.get("plugins")).ok()?,
        _ => return None,
    };
    let language = string_at(&config, "language");
    let files = collect_claude_files(
        &Disk(root),
        &config,
        Lang::resolve(language.as_deref()),
        preset.as_ref(),
        &plugins.loaded,
        floor,
    )
    .ok()?;
    Some(json!({
        "pending": files.pending.iter().map(|w| json!([w.rel_path, w.content, w.status.as_str(), w.chmod_exec])).collect::<Vec<_>>(),
        "skipped": files.skipped.iter().map(|s| json!([s.rel_path, s.reason, s.status.as_str(), s.resolution, s.markerless_resolution])).collect::<Vec<_>>(),
    }))
}

/// The script exactly as navori wrote it before #637, for the baseline config.
fn pristine_script(baseline: &str) -> Option<String> {
    let config = effective(baseline)?;
    let plugin = load_plugin("tgrep").ok()?;
    let placement = plugin_script_placements(&plugin, ScriptEngine::Claude)
        .into_iter()
        .next()?;
    legacy_script_content(placement.template()?, &config)
}

fn place(root: &Path, rel: &str, state: State, rendered: Option<&str>, pristine: Option<&str>) {
    let shebang = "#!/usr/bin/env bash\n";
    let text = match state {
        State::Absent => return,
        State::Directory => {
            let _ = std::fs::create_dir_all(root.join(rel));
            return;
        }
        State::Rendered => rendered.map(str::to_owned),
        // A line added right after the start marker, inside the block.
        State::HandEdited => rendered.and_then(|t| {
            let start = t.find("navori:managed start")?;
            let eol = start + t[start..].find('\n')? + 1;
            Some(format!("{}# hand edit\n{}", &t[..eol], &t[eol..]))
        }),
        State::Restamped(version) => rendered.map(|t| {
            t.replace(
                &format!("version=\"{STAMP_VERSION}\""),
                &format!("version=\"{version}\""),
            )
        }),
        State::Pristine => pristine.map(str::to_owned),
        State::Foreign => Some(format!("{shebang}echo mine\n")),
        State::MentionsMarker => Some(format!("{shebang}# copied from a navori:managed file\n")),
        State::ForeignSymlink => {
            write(
                root,
                &format!("{rel}.real"),
                &format!("{shebang}echo linked\n"),
            );
            if let Some(name) = Path::new(rel).file_name() {
                let _ = std::os::unix::fs::symlink(
                    format!("{}.real", name.to_string_lossy()),
                    root.join(rel),
                );
            }
            return;
        }
    };
    if let Some(text) = text {
        write(root, rel, &text);
    }
}

fn build_repo(root: &Path, recipe: &Recipe) {
    let _ = std::fs::remove_dir_all(root);
    local_preset(root);
    let rendered: Vec<(String, String)> = rust_files(root, &recipe.baseline, None)
        .and_then(|v| v["pending"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|f| Some((f[0].as_str()?.to_owned(), f[1].as_str()?.to_owned())))
        .collect();
    let content = |rel: &str| {
        rendered
            .iter()
            .find(|(path, _)| path == rel)
            .map(|(_, text)| text.as_str())
    };
    let pristine = pristine_script(&recipe.baseline);
    place(
        root,
        SCRIPT,
        recipe.script,
        content(SCRIPT),
        pristine.as_deref(),
    );
    place(root, HOOK, recipe.hook, content(HOOK), None);
    place(root, DOC, recipe.doc, content(DOC), None);
    let progress: Vec<&(String, String)> = rendered
        .iter()
        .filter(|(path, _)| !path.starts_with(".claude/") && !path.starts_with("tools/"))
        .collect();
    for (index, (rel, text)) in progress.iter().enumerate() {
        match recipe.progress {
            1 if index == 0 => write(root, rel, "# Mine\n"),
            2 => write(root, rel, text),
            3 if index == 0 => {
                let _ = std::fs::create_dir_all(root.join(rel));
            }
            _ => {}
        }
    }
}

// Covers: R41
#[test]
fn fingerprint_table_matches() -> Result<(), String> {
    let ts = NODE.ask(&json!({ "op": "table" }))?;
    let rust: serde_json::Map<String, Value> = LEGACY_FINGERPRINTS
        .iter()
        .map(|(name, entries)| ((*name).to_owned(), json!(entries)))
        .collect();
    if ts != Value::Object(rust.clone()) {
        return Err(first_difference(&ts, &Value::Object(rust)));
    }
    Ok(())
}

// Covers: R41
#[test]
fn placements_match() -> Result<(), String> {
    let ts = NODE.ask(&json!({ "op": "placements", "id": "tgrep" }))?;
    let plugin = load_plugin("tgrep").map_err(|e| format!("{e:?}"))?;
    let rust: Vec<Value> = [ScriptEngine::Claude, ScriptEngine::Codex, ScriptEngine::Pi]
        .into_iter()
        .flat_map(|engine| plugin_script_placements(&plugin, engine))
        .map(|p| json!([p.dest_rel_path, p.managed_id, p.source, p.script.exec]))
        .collect();
    if ts != json!(rust) {
        return Err(first_difference(&ts, &json!(rust)));
    }
    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(60))]

    // Covers: R41
    #[test]
    fn masked_fingerprints_match(
        lines in prop::collection::vec(pick(&["", "a", "base=main", "  x  ", "é"]), 0..8),
        masked in prop::collection::vec(0usize..10, 0..4),
        name in pick(&["check-jscpd.sh", "check-semgrep.sh", "guard-search-routing.sh"]),
    ) {
        let content = lines.join("\n");
        let ts = NODE
            .ask(&json!({ "op": "fingerprint", "content": content, "masked": masked, "name": name }))
            .map_err(TestCaseError::fail)?;
        let rust = json!([masked_sha256(&content, &masked), matches_legacy_fingerprint(&name, &content)]);
        prop_assert_eq!(ts, rust);
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(200))]

    // Covers: R41
    #[test]
    fn claude_files_match(
        config in config(),
        recipe in recipe(),
        floor in prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
        same_config in prop::bool::weighted(0.4),
    ) {
        let root = BASE.join("repo");
        let recipe = if same_config { Recipe { baseline: config.clone(), ..recipe } } else { recipe };
        build_repo(&root, &recipe);
        write(&root, "navori.config.json", &config);
        let ts = NODE
            .ask(&json!({ "op": "files", "root": root.to_string_lossy(), "floor": floor }))
            .map_err(TestCaseError::fail)?;
        match rust_files(&root, &config, floor) {
            Some(rust) => prop_assert!(ts == rust, "{}\n{}\n{:?}", first_difference(&ts, &rust), config, recipe),
            None => prop_assert!(ts.get("threw").is_some(), "rust declined, ts: {} for {}", ts, config),
        }
    }
}
