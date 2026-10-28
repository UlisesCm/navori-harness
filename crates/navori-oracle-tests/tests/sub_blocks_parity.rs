//! `navori_core::render::sub_blocks` and `agent_mcp_tools` against the real TS (spec 0058 T14):
//! the `injectInto` sub-blocks of enabled plugins with their `tools:` grant, the hook extensions
//! and the Codex cross-review advisory, on top of the harness files `prepareClaudeEngine` writes.
//! `guard-destructive` embeds the native owned-path inventory, compared with the TS's seal
//! (`owned_paths_parity` covers it on its own).

mod support;

use navori_core::render::block_plan::PlanOptions;
use navori_core::render::claude_md::plan_claude_md;
use navori_core::render::harness_plan::preset_hooks;
use navori_core::render::owned_paths::{ClaudeOwnedInput, claude_owned_paths};

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::STAMP_VERSION;
use navori_core::config;
use navori_core::js_json::JsValue;
use navori_core::markers::{InjectOptions, MarkerMeta, inject_managed_section};
use navori_core::render::agent_mcp_tools::{with_agent_mcp_tools, without_agent_mcp_tools};
use navori_core::render::claude_files::collect_claude_files;
use navori_core::render::collect::RepoView;
use navori_core::render::context::Lang;
use navori_core::render::harness_files::{collect_harness_files, filter_inventory};
use navori_core::render::harness_plan::resolve_harness_plan;
use navori_core::render::plugins::{
    RETIRED_PLUGIN_SUB_BLOCKS, load_disabled_plugins, load_enabled_plugins, load_plugin,
};
use navori_core::render::presets::load_preset;
use navori_core::render::sub_blocks::{CODEX_CROSS_REVIEW_ID, SubBlockCtx, apply_sub_blocks};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module, first_difference};

fn prelude() -> String {
    format!(
        "const e = await import({:?});\nconst m = await import({:?});\nconst c = await import({:?});\n\
         const t = await import({:?});\nconst b = await import({:?});\nconst path = await import('node:path');",
        cli_module("engines/claude/index.ts"),
        cli_module("lib/render/marker.ts"),
        cli_module("lib/config/config.ts"),
        cli_module("engines/claude/agent-mcp-tools.ts"),
        cli_module("lib/config/plugins.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'tools') {\n\
       const plugin = b.loadEnabledPlugins({ [request.plugin]: { enabled: true } }).loaded[0];\n\
       const mcp = request.mcpTools ?? undefined;\n\
       return [t.withAgentMcpTools(request.content, plugin, request.target, mcp),\n\
               t.withoutAgentMcpTools(request.content, plugin, request.target, mcp)];\n\
     }\n\
     m.setMarkerFloorVersion(request.floor ?? undefined);\n\
     try {\n\
       const root = request.root;\n\
       const config = c.readConfig(path.join(root, 'navori.config.json'));\n\
       const prepared = e.prepareClaudeEngine(root, config, { dryRun: true });\n\
       const sealed = prepared.inventory.seal();\n\
       const fin = prepared.finalize();\n\
       const result = prepared.commit();\n\
       const inScope = (rel) => /^\\.claude\\/(agents|skills|hooks)\\//.test(rel) && !request.excluded.includes(rel);\n\
       const ours = (u) => request.ids.includes(u.id);\n\
       const u = (x) => [x.id, x.source, x.fromVersion, x.toVersion];\n\
       return { owned: sealed.value, report: {\n\
         pending: fin.pending.filter((p) => inScope(p.relPath)).map((p) => [p.relPath, p.content, p.status, p.chmodExec === true]),\n\
         skipped: fin.skipped.filter((s) => inScope(s.path)).map((s) => [s.path, s.reason, s.status ?? null, s.resolution ? s.resolution.content : null]),\n\
         warnings: result.warnings.filter((w) => w.startsWith(\"skill '\") || w.includes(' \\u2014 retired block ')),\n\
         updates: result.updatesAvailable.filter(ours).map(u), downgrades: result.downgrades.filter(ours).map(u),\n\
       } };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }\n\
     finally { m.setMarkerFloorVersion(undefined); }",
);

static BASE: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-sub-blocks-{}", std::process::id()))
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

fn field(key: &'static str, value: BoxedStrategy<String>) -> BoxedStrategy<Option<String>> {
    prop::option::of(value.prop_map(move |v| format!("{}:{v}", json!(key)))).boxed()
}

fn object(fields: Vec<BoxedStrategy<Option<String>>>) -> BoxedStrategy<String> {
    fields
        .prop_map(|fields| {
            format!(
                "{{{}}}",
                fields.into_iter().flatten().collect::<Vec<_>>().join(",")
            )
        })
        .boxed()
}

const PLUGINS: [&str; 5] = ["engram", "codegraph", "gh", "acli", "tgrep"];

fn plugins() -> BoxedStrategy<String> {
    // Each plugin absent, enabled or disabled.
    prop::collection::vec(0u8..3, PLUGINS.len())
        .prop_map(|states| {
            let fields: Vec<String> = PLUGINS
                .iter()
                .zip(states)
                .filter(|(_, state)| *state > 0)
                .map(|(id, state)| format!("{}:{{\"enabled\":{}}}", json!(id), state == 1))
                .collect();
            format!("{{{}}}", fields.join(","))
        })
        .boxed()
}

fn config() -> BoxedStrategy<String> {
    let flag = || pick(&["true", "false"]);
    let harness = object(vec![
        field("implementer", flag()),
        field("reviewer", flag()),
        field("auditor", flag()),
        field("publisher", flag()),
    ]);
    object(vec![
        Just(Some(r#""name":"demo","preset":"custom""#.to_owned())).boxed(),
        pick(&[r#"["claude"]"#, r#"["claude","codex"]"#])
            .prop_map(|e| Some(format!(r#""engines":{e}"#)))
            .boxed(),
        field("language", pick(&[r#""es""#, r#""en""#])),
        field("prTarget", pick(&[r#""main""#, r#""develop""#])),
        field("harness", harness),
        field("plugins", plugins()),
    ])
}

#[derive(Debug, Clone)]
struct Recipe {
    baseline: Option<String>,
    restamp: Option<&'static str>,
    edits: Vec<(u8, u8)>,
}

fn recipe() -> BoxedStrategy<Recipe> {
    (
        prop::option::weighted(0.9, config()),
        prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
        prop::collection::vec((0u8..10, 0u8..40), 0..4),
    )
        .prop_map(|(baseline, restamp, edits)| Recipe {
            baseline,
            restamp,
            edits,
        })
        .boxed()
}

/// `subagent-no-background` is in `crates/ported.json`: the native wiring rewrites it later.
static EXCLUDED: LazyLock<Vec<String>> = LazyLock::new(|| {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ported.json");
    let ported: Value = std::fs::read_to_string(manifest)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    ported["hooks"]
        .as_object()
        .map(|hooks| {
            hooks
                .keys()
                .map(|id| format!(".claude/hooks/{id}.sh"))
                .collect()
        })
        .unwrap_or_default()
});

fn in_scope(rel: &str) -> bool {
    let prefixes = [".claude/agents/", ".claude/skills/", ".claude/hooks/"];
    prefixes.iter().any(|p| rel.starts_with(p)) && !EXCLUDED.iter().any(|e| e == rel)
}

/// Ids whose drift the sub-block steps report.
fn sub_block_ids() -> Vec<String> {
    let mut ids = vec![CODEX_CROSS_REVIEW_ID.to_owned()];
    for id in PLUGINS {
        if let Ok(plugin) = load_plugin(id) {
            ids.extend(plugin.skill_assets.iter().map(|s| s.id.clone()));
            ids.extend(plugin.hook_extension_assets.iter().map(|h| h.id.clone()));
        }
    }
    ids
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

fn rust_render(root: &Path, text: &str, floor: Option<&str>) -> Option<Value> {
    let read = config::read(text.as_bytes()).ok()?;
    let config = config::effective_config(&read.data);
    let preset = match string_at(&config, "preset").as_deref() {
        None | Some("" | "custom") => None,
        Some(id) => load_preset(id, root).ok()?,
    };
    let (plugins, disabled) = match &config {
        JsValue::Object(object) => (
            load_enabled_plugins(object.get("plugins")).ok()?,
            load_disabled_plugins(object.get("plugins")).ok()?,
        ),
        _ => return None,
    };
    let lang = Lang::resolve(string_at(&config, "language").as_deref());
    let view = Disk(root);
    let plan = filter_inventory(resolve_harness_plan(
        &config,
        preset.as_ref(),
        true,
        Some("claude"),
    ));
    let step1 = plan_claude_md(&view, &read.data, root, &PlanOptions::default()).ok()?;
    let hooks = preset_hooks(preset.as_ref(), &config);
    let owned = claude_owned_paths(
        &view,
        &ClaudeOwnedInput {
            claude_md: &step1.observed,
            plan: &plan,
            preset_hooks: &hooks,
            enabled: &plugins.loaded,
            disabled: &disabled.loaded,
        },
    )
    .ok()?;
    let harness = collect_harness_files(&view, &plan, &config, lang, floor, Some(&owned)).ok()?;
    let mut pending = harness.pending;
    let harness_skipped = harness.skipped;
    pending.extend(
        collect_claude_files(
            &view,
            &config,
            lang,
            preset.as_ref(),
            &plugins.loaded,
            floor,
        )
        .ok()?
        .pending,
    );
    let ctx = SubBlockCtx {
        view: &view,
        config: &config,
        lang,
        ambient_floor: floor,
    };
    let bare: serde_json::Map<String, Value> = pending
        .iter()
        .map(|w| (w.rel_path.clone(), json!(w.content)))
        .collect();
    let out = apply_sub_blocks(&ctx, &plugins.loaded, &disabled.loaded, &mut pending).ok()?;
    let u = |x: &navori_core::render::block_plan::UpdateAvailable| {
        json!([x.id, x.source, x.from_version, x.to_version])
    };
    Some(json!({
        "pending": pending.iter().filter(|w| in_scope(&w.rel_path)).map(|w| json!([w.rel_path, w.content, w.status.as_str(), w.chmod_exec])).collect::<Vec<_>>(),
        "skipped": harness_skipped.iter().chain(&out.skipped).filter(|s| in_scope(&s.rel_path)).map(|s| json!([s.rel_path, s.reason, s.status.map(|st| st.as_str()), s.resolution])).collect::<Vec<_>>(),
        "warnings": out.warnings.iter().chain(&out.retired_warnings).collect::<Vec<_>>(),
        "updates": out.updates_available.iter().map(u).collect::<Vec<_>>(),
        "downgrades": out.downgrades.iter().map(u).collect::<Vec<_>>(),
        "bare": bare,
        "owned": owned,
    }))
}

fn build_repo(root: &Path, recipe: &Recipe) {
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::create_dir_all(root);
    let Some(baseline) = recipe.baseline.as_deref() else {
        return;
    };
    let Some(rendered) = rust_render(root, baseline, None) else {
        return;
    };
    let (Value::Array(files), Value::Object(bare)) = (&rendered["pending"], &rendered["bare"])
    else {
        return;
    };
    let mut files: Vec<(String, String)> = files
        .iter()
        .filter_map(|f| Some((f[0].as_str()?.to_owned(), f[1].as_str()?.to_owned())))
        .collect();
    if let Some(version) = recipe.restamp {
        for (_, text) in &mut files {
            *text = text.replace(
                &format!("version=\"{STAMP_VERSION}\" source=\"@navori/plugin-"),
                &format!("version=\"{version}\" source=\"@navori/plugin-"),
            );
        }
    }
    for (kind, index) in &recipe.edits {
        // Each edit picks among the files it can affect.
        let fits = |rel: &str, text: &str| match kind {
            1 | 2 | 3 | 8 => rel.starts_with(".claude/agents/") && text.contains("tools:"),
            9 => sub_block_ids()
                .iter()
                .any(|id| text.contains(&format!("id=\"{id}\""))),
            5 => text.contains(CODEX_CROSS_REVIEW_ID),
            6 | 7 => RETIRED_PLUGIN_SUB_BLOCKS
                .iter()
                .any(|(_, _, entries)| entries.iter().any(|(_, target)| *target == rel)),
            _ => true,
        };
        let candidates: Vec<usize> = (0..files.len())
            .filter(|&i| fits(&files[i].0, &files[i].1))
            .collect();
        let Some(&chosen) = candidates.get(usize::from(*index) % candidates.len().max(1)) else {
            continue;
        };
        let Some((rel, text)) = files.get_mut(chosen) else {
            continue;
        };
        match kind {
            // A block a live plugin's manifest retired, pristine or edited.
            6 | 7 => {
                let retired = RETIRED_PLUGIN_SUB_BLOCKS
                    .iter()
                    .flat_map(|(_, _, entries)| entries.iter())
                    .find(|(_, target)| target == rel);
                if let Some((id, _)) = retired {
                    let meta = MarkerMeta {
                        source: Some("@navori/plugin-codegraph".to_owned()),
                        version: Some(recipe.restamp.unwrap_or(STAMP_VERSION).to_owned()),
                        fm_keys: None,
                        floor_version: None,
                    };
                    let body = if *kind == 6 {
                        "Old prose."
                    } else {
                        "Old prose.\nMine."
                    };
                    let mut injected = inject_managed_section(
                        text,
                        id,
                        "Old prose.",
                        &meta,
                        InjectOptions::default(),
                    )
                    .output;
                    if *kind == 7 {
                        injected = injected.replacen("Old prose.", body, 1);
                    }
                    *text = injected;
                }
            }
            // Inside a plugin sub-block (or the first block when there is none).
            0 => {
                let at = text
                    .find("source=\"@navori/plugin-")
                    .or_else(|| text.find("navori:managed"))
                    .and_then(|at| text[at..].find('\n').map(|eol| at + eol + 1));
                if let Some(at) = at {
                    text.insert_str(at, "Hand edit.\n");
                }
            }
            // The grant taken away, or never there.
            1 => *text = text.replacen(", mcp__engram__", ", mcp__other__", 1),
            2 => *text = text.replacen("tools: ", "tools: mcp__engram__*, ", 1),
            3 => *text = text.replacen("tools: ", "disallowed: ", 1),
            4 => text.clear(),
            // The tools line as the harness alone writes it: prose present, grant missing.
            8 => {
                let line = |t: &str| {
                    t.lines()
                        .find(|l| l.starts_with("tools:"))
                        .map(str::to_owned)
                };
                let old = bare
                    .get(rel.as_str())
                    .and_then(Value::as_str)
                    .and_then(line);
                if let (Some(old), Some(now)) = (old, line(text)) {
                    *text = text.replacen(&now, &old, 1);
                }
            }
            // A pristine sub-block an older (or newer) navori wrote with another body.
            9 => {
                let id = sub_block_ids()
                    .into_iter()
                    .find(|id| text.contains(&format!("id=\"{id}\"")));
                if let Some(id) = id {
                    let meta = MarkerMeta {
                        source: Some("@navori/plugin-x".to_owned()),
                        version: Some(recipe.restamp.unwrap_or("0.1.0").to_owned()),
                        fm_keys: None,
                        floor_version: None,
                    };
                    let options = InjectOptions {
                        shell: rel.ends_with(".sh"),
                        force_overwrite: true,
                        ..InjectOptions::default()
                    };
                    *text = inject_managed_section(text, &id, "Old prose.", &meta, options).output;
                }
            }
            _ => {
                let cross = format!("<!-- navori:managed id=\"{CODEX_CROSS_REVIEW_ID}\"");
                if let Some(at) = text.find(&cross) {
                    text.insert_str(at, "Mine.\n");
                }
            }
        }
    }
    for (rel, text) in &files {
        if !text.is_empty() {
            write(root, rel, text);
        }
    }
}

fn tool_content() -> BoxedStrategy<String> {
    let tools = pick(&[
        "tools: Read, Grep",
        "tools: Read, mcp__engram__*",
        "tools: mcp__engram__*, mcp__engram__mem_search, mcp__engram__mem_save",
        "tools: Agent(scout, scribe), mcp__engram__mem_search, mcp__engram__mem_save",
        "tools:",
        "tools: Read,, Grep  ",
        "tools: \"Read, Grep\"",
        "tools: Read\r",
        "  tools: nested",
        "tools: $&, Read",
    ]);
    (
        prop::bool::weighted(0.9),
        tools,
        pick(&["name: a\n", "", "description: x\n"]),
        pick(&[
            "Body.\n",
            "---\ntools: body copy\n---\n",
            "tools: in body\n",
        ]),
    )
        .prop_map(|(fenced, tools, other, body)| {
            if fenced {
                format!("---\n{other}{tools}\nmodel: sonnet\n---\n\n{body}")
            } else {
                format!("{tools}\n{body}")
            }
        })
        .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(600))]

    // Covers: R41
    #[test]
    fn agent_mcp_tools_match(
        content in tool_content(),
        plugin in pick(&["engram", "codegraph", "gh"]),
        target in pick(&[".claude/agents/reviewer.md", ".claude/skills/x/SKILL.md"]),
        mcp in prop::option::of(prop::sample::select(vec![
            vec![], vec!["mem_search"], vec!["mem_search", "mem_save"], vec!["mem_save", "mem_save"],
        ]).prop_map(|v| v.into_iter().map(String::from).collect::<Vec<_>>())),
    ) {
        let ts = NODE
            .ask(&json!({ "op": "tools", "content": content, "plugin": plugin, "target": target, "mcpTools": mcp }))
            .map_err(TestCaseError::fail)?;
        let loaded = load_plugin(&plugin).map_err(|e| TestCaseError::fail(format!("{e:?}")))?;
        let with = with_agent_mcp_tools(&content, &loaded, &target, mcp.as_deref());
        let without = without_agent_mcp_tools(&content, &loaded, &target, mcp.as_deref());
        if let (Some(with), Some(without)) = (with, without) {
            prop_assert_eq!(ts, json!([with, without]));
        } else {
            prop_assert!(content.contains('$'), "rust declined without a `$`: {}", content);
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(100))]

    // Covers: R41
    #[test]
    fn sub_blocks_match(
        config in config(),
        recipe in recipe(),
        floor in prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
        same_config in prop::bool::weighted(0.4),
    ) {
        let root = BASE.join("repo");
        let recipe = if same_config { Recipe { baseline: Some(config.clone()), ..recipe } } else { recipe };
        build_repo(&root, &recipe);
        write(&root, "navori.config.json", &config);
        let ts = NODE
            .ask(&json!({
                "op": "render", "root": root.to_string_lossy(), "floor": floor,
                "excluded": *EXCLUDED, "ids": sub_block_ids(),
            }))
            .map_err(TestCaseError::fail)?;
        let rust = rust_render(&root, &config, floor).map(|mut rust| {
            if let Some(object) = rust.as_object_mut() {
                object.remove("bare");
                let owned = object.remove("owned");
                if ts.get("owned").is_some() {
                    object.insert("sealed".to_owned(), owned.unwrap_or_default());
                }
            }
            rust
        });
        let ts = match ts.get("owned") {
            Some(owned) => {
                let mut report = ts["report"].clone();
                if let Some(object) = report.as_object_mut() {
                    object.insert("sealed".to_owned(), owned.clone());
                }
                json!({ "report": report })
            }
            None => ts,
        };
        match rust {
            Some(rust) => prop_assert!(ts["report"] == rust, "{}\n{}\n{:?}", first_difference(&ts["report"], &rust), config, recipe),
            None => prop_assert!(ts.get("threw").is_some(), "rust declined, ts: {} for {}", ts, config),
        }
    }
}
