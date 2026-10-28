//! `navori_core::render::claude_settings::build_claude_settings` against the real
//! `buildClaudeSettings` (spec 0058 T15): the base, every conditional registration (scribe,
//! plan tiers, master plan, publisher, scout, audit, verify-on-stop, quality gate), effort,
//! the hooks the filtered plan drops, plugin fragments and hooks (bundled and synthetic, with
//! `nativeHook`), the derived permission rules over generated gate commands, and coalescing.

mod support;

use navori_core::config;
use navori_core::js_json::JsValue;
use navori_core::render::claude_settings::build_claude_settings;
use navori_core::render::harness_files::filter_inventory;
use navori_core::render::harness_plan::resolve_harness_plan;
use navori_core::render::plugins::{LoadedPlugin, load_enabled_plugins, plugin_from_manifest};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module, first_difference};

fn prelude() -> String {
    format!(
        "const s = await import({:?});\nconst c = await import({:?});\nconst p = await import({:?});\n\
         const h = await import({:?});\nconst n = await import({:?});\nconst b = await import({:?});\nconst path = await import('node:path');",
        cli_module("engines/claude/build-settings.ts"),
        cli_module("lib/config/config.ts"),
        cli_module("lib/config/plugins.ts"),
        cli_module("engines/shared/harness-plan.ts"),
        cli_module("engines/shared/native-overlap.ts"),
        cli_module("lib/render/bundled-assets.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "const file = path.join(request.dir, 'navori.config.json');\n\
     (await import('node:fs')).writeFileSync(file, request.config);\n\
     let read;\n\
     try { read = c.readConfig(file); } catch { return { invalid: true }; }\n\
     const config = c.effectiveConfig(read);\n\
     const plugins = p.loadEnabledPlugins(config.plugins).loaded;\n\
     for (const raw of request.synthetic) plugins.push({ manifest: p.PluginManifestSchema.parse(JSON.parse(raw)) });\n\
     const plan = h.resolveHarnessPlan(config, path.join(b.getCoreRoot(), 'core-assets'), null, { includeOrchestrator: true, engine: 'claude' });\n\
     const inventory = n.filterInventory({ plan, plugins }, 'claude');\n\
     try { return { json: JSON.stringify(s.buildClaudeSettings(config, inventory), null, 2) }; }\n\
     catch (err) { return { threw: String(err && err.message || err) }; }",
);

static DIR: std::sync::LazyLock<std::path::PathBuf> = std::sync::LazyLock::new(|| {
    let dir = std::env::temp_dir().join(format!("navori-claude-settings-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir
});

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

/// Gate commands: package managers, `cd`, chains, unsafe characters and whitespace.
fn gate() -> BoxedStrategy<String> {
    let step = pick(&[
        "pnpm lint",
        "npm test",
        "yarn build",
        "bun run check:fast",
        "cd packages/cli",
        "cd  apps/web",
        "cargo test",
        "make check",
        "pnpm test -- --run",
        "echo $HOME",
        "pnpm run $X",
        "cdx dir",
        "cdfoo",
        "cd a b",
        "",
        "  pnpm   lint  ",
    ]);
    let sep = pick(&[" && ", "&&", " || ", "; ", ";"]);
    (step.clone(), prop::collection::vec((sep, step), 0..3))
        .prop_map(|(first, rest)| {
            let mut out = first;
            for (sep, step) in rest {
                out.push_str(&sep);
                out.push_str(&step);
            }
            json!(out).to_string()
        })
        .boxed()
}

fn config() -> BoxedStrategy<String> {
    let flag = || pick(&["true", "false"]);
    let plugins = prop::collection::vec(0u8..4, 5).prop_map(|states| {
        let fields: Vec<String> = ["engram", "codegraph", "gh", "tgrep", "acli"]
            .iter()
            .zip(states)
            .filter(|(_, s)| *s > 0)
            .map(|(id, s)| match s {
                1 => format!(r#""{id}":{{"enabled":true}}"#),
                2 => format!(r#""{id}":{{"enabled":true,"nativeHook":true}}"#),
                _ => format!(r#""{id}":{{"enabled":false}}"#),
            })
            .collect();
        format!("{{{}}}", fields.join(","))
    });
    object(vec![
        Just(Some(
            r#""name":"demo","preset":"custom","engines":["claude"]"#.to_owned(),
        ))
        .boxed(),
        field("language", pick(&[r#""es""#, r#""en""#])),
        field(
            "harness",
            object(vec![
                field("scribeOwnsMarkdown", flag()),
                field("planTiers", flag()),
                field("masterPlan", flag()),
                field("publisher", flag()),
                field("scout", flag()),
            ]),
        ),
        field(
            "effort",
            pick(&[
                r#"{"orchestrator":"high"}"#,
                r#"{"orchestrator":"max"}"#,
                r#"{"orchestrator":"low"}"#,
            ]),
        ),
        field(
            "audit",
            pick(&[r#"{"mode":"always"}"#, r#"{"mode":"opt-in"}"#]),
        ),
        field(
            "hooks",
            pick(&[r#"{"verifyOnStop":true}"#, r#"{"verifyOnStop":false}"#]),
        ),
        field(
            "packageManager",
            pick(&[r#""pnpm""#, r#""bun""#, r#""npm""#]),
        ),
        (gate(), gate(), prop::option::of(gate()))
            .prop_map(|(fast, full, scoped)| {
                let scoped = scoped.map_or_else(String::new, |s| format!(r#","scoped":{s}"#));
                Some(format!(
                    r#""qualityGate":{{"fast":{fast},"full":{full}{scoped}}}"#
                ))
            })
            .boxed(),
        field("plugins", plugins.boxed()),
    ])
}

/// Synthetic plugins with hooks: plain commands with and without args, a foreign command,
/// shared and absent matchers, a duplicate, and a fragment that adds settings.
fn synthetic() -> BoxedStrategy<Vec<String>> {
    let entry = pick(&[
        r#"{"event":"PreToolUse","matcher":"Bash","command":"bash \"$CLAUDE_PROJECT_DIR/.claude/scripts/check-x.sh\"","timeout":30}"#,
        r#"{"event":"PreToolUse","matcher":"Bash","command":"bash \"$CLAUDE_PROJECT_DIR/.claude/scripts/check-x.sh\" --fast","statusMessage":"x"}"#,
        r#"{"event":"PostToolUse","command":"node tool.js"}"#,
        r#"{"event":"PostToolUse","command":"bash \"$CLAUDE_PROJECT_DIR/.claude/scripts/t.sh\" "}"#,
        r#"{"event":"Stop","command":"bash \"$CLAUDE_PROJECT_DIR/.claude/hooks/guard-destructive.sh\""}"#,
        r#"{"event":"SessionStart","matcher":"startup|resume|clear|compact|fork","command":"bash \"$CLAUDE_PROJECT_DIR/.claude/scripts/s.sh\""}"#,
    ]);
    let fragment = pick(&[
        "",
        r#","settingsFragment":{"permissions":{"allow":["Bash(x:*)","Bash(git status*)"]},"env":{"A":"1"}}"#,
        r#","settingsFragment":{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"y"}]}],"Custom":"x"}}"#,
        r#","settingsFragment":{"hooks":{"Stop":["raw",{"matcher":"x"},{"hooks":[{"type":"command","command":"z"}]}]}}"#,
    ]);
    prop::collection::vec((prop::collection::vec(entry, 0..4), fragment), 0..2)
        .prop_map(|plugins| {
            plugins
                .into_iter()
                .enumerate()
                .map(|(i, (hooks, fragment))| {
                    format!(
                        r#"{{"id":"synth{i}","name":"S","description":"S","version":"0.0.1","hooks":[{}]{fragment}}}"#,
                        hooks.join(",")
                    )
                })
                .collect()
        })
        .boxed()
}

fn rust_settings(text: &str, synthetic: &[String]) -> Option<String> {
    let config = config::effective_config(&config::read(text.as_bytes()).ok()?.data);
    let mut plugins: Vec<LoadedPlugin> = match &config {
        JsValue::Object(object) => load_enabled_plugins(object.get("plugins")).ok()?.loaded,
        _ => return None,
    };
    for (i, raw) in synthetic.iter().enumerate() {
        plugins.push(plugin_from_manifest(&format!("synth{i}"), raw).ok()?);
    }
    let plan = filter_inventory(resolve_harness_plan(&config, None, true, Some("claude")));
    build_claude_settings(&config, &plan, &plugins)
        .ok()?
        .stringify(Some(2))
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    // Covers: R42
    #[test]
    fn settings_match(config in config(), synthetic in synthetic()) {
        let ts = NODE
            .ask(&json!({ "config": config, "synthetic": synthetic, "dir": DIR.to_string_lossy() }))
            .map_err(TestCaseError::fail)?;
        if ts.get("invalid").is_some() {
            return Ok(());
        }
        let rust = rust_settings(&config, &synthetic);
        match (ts.get("json").and_then(Value::as_str), rust) {
            (Some(ts), Some(rust)) => {
                let (a, b): (Value, Value) = (
                    serde_json::from_str(ts).unwrap_or(Value::Null),
                    serde_json::from_str(&rust).unwrap_or(Value::Null),
                );
                prop_assert!(ts == rust, "{}\n{}", first_difference(&a, &b), config);
            }
            (None, None) => {}
            (ts, rust) => prop_assert!(false, "ts {:?} rust {:?} for {}", ts, rust.is_some(), config),
        }
    }
}
