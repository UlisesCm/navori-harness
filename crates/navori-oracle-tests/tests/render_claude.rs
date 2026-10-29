//! `navori_core::render::claude::plan_claude_engine` (spec 0058 T14, A5): the whole Claude plan.
//!
//! - Against the `claude` snap of `golden-render-tree.test.ts`: the tree a fresh render writes
//!   with the golden config, normalized the same way, file by file and with the exec bit.
//! - Against the real `prepareClaudeEngine(...).finalize()` over repos rendered with another
//!   config and then edited: pending writes, removals and skips, in order.
//!
//! Every file is compared, the native wiring included: the golden runs without ported hooks, as
//! its TS test mocks `loadNativeHooks`, and the engine with the real `crates/ported.json`.

mod support;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::STAMP_VERSION;
use navori_core::config;
use navori_core::js_json::{self, JsValue};
use navori_core::manifest::{Hook, HookMode};
use navori_core::render::block_plan::PlanOptions;
use navori_core::render::claude::{ClaudeEnginePlan, plan_claude_engine};
use navori_core::render::claude_settings::claude_hook_command;
use navori_core::render::collect::DiskView;
use navori_core::render::command::{human_report, plan_render, render_json};
use navori_core::render::report::Clack;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use regex::Regex;
use serde_json::{Value, json};
use support::{Shared, cli_module, first_difference};

fn prelude() -> String {
    format!(
        "const e = await import({:?});\nconst m = await import({:?});\nconst c = await import({:?});\nconst path = await import('node:path');",
        cli_module("engines/claude/index.ts"),
        cli_module("lib/render/marker.ts"),
        cli_module("lib/config/config.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "m.setMarkerFloorVersion(request.floor ?? undefined);\n\
     try {\n\
       const root = request.root;\n\
       const config = c.readConfig(path.join(root, 'navori.config.json'));\n\
       const prepared = e.prepareClaudeEngine(root, config, { dryRun: true });\n\
       prepared.inventory.seal();\n\
       const fin = prepared.finalize();\n\
       return {\n\
         pending: fin.pending.map((p) => [p.relPath, p.content, p.status, p.chmodExec === true]),\n\
         removals: fin.removals.map((r) => [path.relative(root, r.path), r.recursive === true]),\n\
         skipped: fin.skipped.map((s) => [s.path, s.reason, s.status ?? null, s.resolution ? s.resolution.content : null]),\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }\n\
     finally { m.setMarkerFloorVersion(undefined); }",
);

static BASE: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-render-claude-{}", std::process::id()))
});

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, text);
}

fn plan(root: &Path, text: &str, floor: Option<&str>) -> Option<ClaudeEnginePlan> {
    plan_with(root, text, floor, None)
}

fn plan_with(
    root: &Path,
    text: &str,
    floor: Option<&str>,
    native_hooks: Option<BTreeMap<String, Hook>>,
) -> Option<ClaudeEnginePlan> {
    let read = config::read(text.as_bytes()).ok()?;
    let options = PlanOptions {
        ambient_floor: floor.map(str::to_owned),
        native_hooks,
        ..PlanOptions::default()
    };
    plan_claude_engine(&DiskView(root), &read.data, root, &options).ok()
}

// --- golden -------------------------------------------------------------------------------

/// `goldenConfig(["claude", "codex"])` of `golden-render-tree.test.ts`.
const GOLDEN_CONFIG: &str = r#"{
  "name": "golden-demo",
  "engines": ["claude", "codex"],
  "preset": "custom",
  "branchBase": "main",
  "commits": "conventional-es",
  "qualityGate": { "fast": "pnpm lint", "full": "pnpm test && pnpm lint" },
  "plugins": {
    "acli": { "enabled": true },
    "engram": { "enabled": true },
    "gh": { "enabled": true },
    "jscpd": { "enabled": true },
    "semgrep": { "enabled": true }
  },
  "project": { "libraries": ["zod-validation", "vitest"] }
}"#;

/// `NORMALIZERS` of the golden test, in order.
static NORMALIZERS: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
    [
        (
            r#"(navori:managed[^\n]*?)version="[^"]*""#,
            r#"${1}version="<VERSION>""#,
        ),
        (
            r#"(navori:managed[^\n]*?)hash="[^"]*""#,
            r#"${1}hash="<HASH>""#,
        ),
        (
            r#"("\$navori":\s*\{[^}]*?"version":\s*")[^"]*""#,
            r#"${1}<VERSION>""#,
        ),
    ]
    .into_iter()
    .filter_map(|(pattern, replacement)| Some((Regex::new(pattern).ok()?, replacement)))
    .collect()
});

fn normalize(content: &str) -> String {
    NORMALIZERS
        .iter()
        .fold(content.to_owned(), |text, (pattern, replacement)| {
            pattern.replace_all(&text, *replacement).into_owned()
        })
}

/// The snap's sections: path → (exec, normalized body).
fn golden_sections() -> Result<BTreeMap<String, (bool, String)>, String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/cli/src/engines/__tests__/__golden__/claude.snap");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut sections = BTreeMap::new();
    let mut current: Option<(String, bool, Vec<&str>)> = None;
    let mut flush = |current: Option<(String, bool, Vec<&str>)>| {
        if let Some((file, exec, mut lines)) = current {
            // Each section is `body` followed by one separator line.
            lines.pop();
            sections.insert(file, (exec, lines.join("\n")));
        }
    };
    for line in text.split('\n') {
        if let Some(rest) = line.strip_prefix("===== FILE: ")
            && let Some(header) = rest.strip_suffix(" =====")
        {
            flush(current.take());
            let (file, exec) = header
                .strip_suffix(" [exec]")
                .map_or((header, false), |file| (file, true));
            current = Some((file.to_owned(), exec, Vec::new()));
        } else if line.starts_with("===== END: ") {
            flush(current.take());
        } else if let Some((_, _, lines)) = current.as_mut() {
            lines.push(line);
        }
    }
    Ok(sections)
}

// Covers: R41
#[test]
fn claude_tree_matches_the_golden_snap() -> Result<(), String> {
    let root = BASE.join("golden");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::create_dir_all(&root);
    // The golden is the product render: no native wrapping (`loadNativeHooks: () => ({})`).
    let plan = plan_with(&root, GOLDEN_CONFIG, None, Some(BTreeMap::new()))
        .ok_or("plan_claude_engine delegated")?;
    let golden = golden_sections()?;
    let rendered: BTreeMap<String, (bool, String)> = plan
        .pending
        .iter()
        .map(|w| (w.rel_path.clone(), (w.chmod_exec, normalize(&w.content))))
        .collect();
    if golden.len() < 50 {
        return Err(format!("only {} golden sections parsed", golden.len()));
    }
    let missing: Vec<&String> = golden
        .keys()
        .filter(|f| !rendered.contains_key(*f))
        .collect();
    let extra: Vec<&String> = rendered
        .keys()
        .filter(|f| !golden.contains_key(*f))
        .collect();
    if !missing.is_empty() || !extra.is_empty() {
        return Err(format!("missing {missing:?}, extra {extra:?}"));
    }
    for (file, expected) in &golden {
        let actual = &rendered[file];
        if actual != expected {
            let at = expected
                .1
                .lines()
                .zip(actual.1.lines())
                .position(|(a, b)| a != b)
                .unwrap_or(0);
            return Err(format!(
                "{file}: exec {} vs {}, first differing line {at}:\n  golden {:?}\n  rust   {:?}",
                expected.0,
                actual.0,
                expected.1.lines().nth(at),
                actual.1.lines().nth(at),
            ));
        }
    }
    Ok(())
}

// --- parity with the real engine ------------------------------------------------------------

fn pick(options: &[&'static str]) -> BoxedStrategy<String> {
    prop::sample::select(options.to_vec())
        .prop_map(String::from)
        .boxed()
}

fn field(key: &'static str, value: BoxedStrategy<String>) -> BoxedStrategy<Option<String>> {
    prop::option::of(value.prop_map(move |v| format!("{}:{v}", json!(key)))).boxed()
}

fn config() -> BoxedStrategy<String> {
    let plugins = prop::collection::vec(0u8..3, 5).prop_map(|states| {
        let fields: Vec<String> = ["engram", "codegraph", "gh", "tgrep", "jscpd"]
            .iter()
            .zip(states)
            .filter(|(_, s)| *s > 0)
            .map(|(id, s)| format!(r#""{id}":{{"enabled":{}}}"#, s == 1))
            .collect();
        format!("{{{}}}", fields.join(","))
    });
    vec![
        Just(Some(r#""name":"demo""#.to_owned())).boxed(),
        pick(&[r#""custom""#, r#""astro""#])
            .prop_map(|p| Some(format!(r#""preset":{p}"#)))
            .boxed(),
        pick(&[r#"["claude"]"#, r#"["claude","codex"]"#])
            .prop_map(|e| Some(format!(r#""engines":{e}"#)))
            .boxed(),
        field("language", pick(&[r#""es""#, r#""en""#])),
        field(
            "harness",
            pick(&[
                r#"{"publisher":false}"#,
                r#"{"planTiers":true,"scout":false}"#,
            ]),
        ),
        field(
            "project",
            pick(&[
                r#"{"libraries":["zod-validation"]}"#,
                r#"{"posture":"production","libraries":["axios"]}"#,
            ]),
        ),
        field(
            "qualityGate",
            pick(&[r#"{"fast":"bun run check:fast","full":"bun run check"}"#]),
        ),
        field("plugins", plugins.boxed()),
    ]
    .prop_map(|fields| {
        format!(
            "{{{}}}",
            fields.into_iter().flatten().collect::<Vec<_>>().join(",")
        )
    })
    .boxed()
}

/// What the command reconciles beside the Claude engine: the root `.gitignore` mode and what
/// the user already has, prettier, the user's `.prettierignore` and a disabled engine's outputs.
#[derive(Debug, Clone)]
struct Extras {
    gitignore_mode: Option<&'static str>,
    user_gitignore: u8,
    prettier: bool,
    user_prettierignore: bool,
    orphans: bool,
}

fn extras() -> BoxedStrategy<Extras> {
    (
        prop::sample::select(vec![None, Some("off"), Some("minimal"), Some("full")]),
        0u8..3,
        prop::bool::ANY,
        prop::bool::ANY,
        prop::bool::ANY,
    )
        .prop_map(
            |(gitignore_mode, user_gitignore, prettier, user_prettierignore, orphans)| Extras {
                gitignore_mode,
                user_gitignore,
                prettier,
                user_prettierignore,
                orphans,
            },
        )
        .boxed()
}

impl Extras {
    /// Writes the extras into `root` and returns `config` with the `.gitignore` mode.
    fn apply(&self, root: &Path, config: &str) -> String {
        match self.user_gitignore {
            0 => {}
            1 => write(root, ".gitignore", "node_modules/\n.env\n"),
            // A harness block edited by hand, under a hash that no longer matches.
            _ => write(
                root,
                ".gitignore",
                &format!(
                    "# mine\n# navori:managed start id=\"gitignore-harness\" hash=\"00000000\" version=\"{STAMP_VERSION}\" source=\"@navori/core\"\nedited/\n# navori:managed end id=\"gitignore-harness\"\n"
                ),
            ),
        }
        if self.prettier {
            write(
                root,
                "package.json",
                r#"{"scripts":{"format":"prettier --write ."}}"#,
            );
        }
        if self.user_prettierignore {
            write(root, ".prettierignore", ".claude/\nCLAUDE.md\n");
        }
        if self.orphans {
            write(root, "AGENTS.md", "# mine\n");
            write(root, ".cursor/rules/mine.mdc", "mine\n");
        }
        match self.gitignore_mode {
            Some(mode) => config.replacen('{', &format!(r#"{{"gitignoreHarness":"{mode}","#), 1),
            None => config.to_owned(),
        }
    }
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
        prop::collection::vec((0u8..5, 0u8..80), 0..5),
    )
        .prop_map(|(baseline, restamp, edits)| Recipe {
            baseline,
            restamp,
            edits,
        })
        .boxed()
}

fn build_repo(root: &Path, recipe: &Recipe) {
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::create_dir_all(root);
    let Some(baseline) = recipe.baseline.as_deref() else {
        return;
    };
    let Some(rendered) = plan(root, baseline, None) else {
        return;
    };
    let mut files: Vec<(String, String)> = rendered
        .pending
        .into_iter()
        .map(|w| (w.rel_path, w.content))
        .collect();
    if let Some(version) = recipe.restamp {
        for (_, text) in &mut files {
            *text = text.replace(
                &format!("version=\"{STAMP_VERSION}\""),
                &format!("version=\"{version}\""),
            );
        }
    }
    let count = files.len().max(1);
    for (kind, index) in &recipe.edits {
        let Some((_, text)) = files.get_mut(usize::from(*index) % count) else {
            continue;
        };
        match kind {
            0 => {
                if let Some(at) = text.find("navori:managed")
                    && let Some(eol) = text[at..].find('\n')
                {
                    text.insert_str(at + eol + 1, "Hand edit.\n");
                }
            }
            1 => text.push_str("\nUser tail.\n"),
            2 => "mine\n".clone_into(text),
            3 => *text = text.replacen("tools: ", "tools: mcp__engram__*, ", 1),
            _ => text.clear(),
        }
    }
    for (rel, text) in &files {
        if !text.is_empty() {
            write(root, rel, text);
        }
    }
}

/// `settings.json` or `.mcp.json` exists and does not parse: the TS skips it with the V8 parser
/// message, which Rust does not reproduce, so the plan delegates.
fn unparseable_json(root: &Path) -> bool {
    [".claude/settings.json", ".mcp.json"].iter().any(|rel| {
        let path = root.join(rel);
        path.exists()
            && std::fs::read_to_string(path)
                .ok()
                .and_then(|text| js_json::parse(&text))
                .is_none()
    })
}

/// The native wiring's edge cases against the engine: a tgrep repo rendered with its own config
/// (both ported hooks signed), then one edit on a hook or the guard's dependency script.
// Covers: R42
#[test]
fn native_wiring_matches_the_engine_after_targeted_edits() -> Result<(), String> {
    const CONFIG: &str = r#"{"name":"demo","preset":"custom","engines":["claude"],"plugins":{"tgrep":{"enabled":true}}}"#;
    let targets = [
        ".claude/scripts/guard-search-routing.sh",
        ".claude/hooks/guard-destructive.sh",
        ".claude/hooks/subagent-no-background.sh",
    ];
    let root = BASE.join("native");
    for target in targets {
        for kind in 0..6 {
            let _ = std::fs::remove_dir_all(&root);
            let _ = std::fs::create_dir_all(&root);
            write(&root, "navori.config.json", CONFIG);
            let rendered = plan(&root, CONFIG, None).ok_or("baseline delegated")?;
            for w in &rendered.pending {
                let mut text = w.content.clone();
                if w.rel_path == target {
                    match kind {
                        0 => text = text.replacen("\nfi\n", "\nfi\n# hand edit\n", 1),
                        1 => text.push_str("\nUser tail.\n"),
                        2 => text = "mine\n".to_owned(),
                        3 => {
                            text = text.replacen(
                                &format!("version=\"{STAMP_VERSION}\""),
                                "version=\"0.1.0\"",
                                1,
                            )
                        }
                        4 => {
                            text = text.replacen(
                                &format!("version=\"{STAMP_VERSION}\""),
                                "version=\"999.0.0\"",
                                1,
                            )
                        }
                        _ => text = text.replace('\n', "\r\n"),
                    }
                }
                write(&root, &w.rel_path, &text);
            }
            compare_engine(&root, CONFIG, &format!("{target} kind {kind}"))?;
        }
    }
    // `settings.json` from a previous shell-only render (no ported hooks), then, combined: stamped
    // newer (1), made foreign with navori's coexist tracking (2), stamped older (4), and with a
    // hook entry and a tracked command duplicated (8).
    for kind in 0..16 {
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::create_dir_all(&root);
        write(&root, "navori.config.json", CONFIG);
        let shell =
            plan_with(&root, CONFIG, None, Some(BTreeMap::new())).ok_or("shell delegated")?;
        for w in &shell.pending {
            let mut text = w.content.clone();
            if w.rel_path == ".claude/settings.json" {
                if kind & 1 == 1 {
                    text = text.replacen(
                        &format!("\"version\": \"{STAMP_VERSION}\""),
                        "\"version\": \"999.0.0\"",
                        1,
                    );
                }
                if kind & 2 == 2 {
                    text = text.replacen("\"managed\": true", "\"managed\": false", 1);
                }
                if kind & 4 == 4 {
                    text = text.replacen(
                        &format!("\"version\": \"{STAMP_VERSION}\""),
                        "\"version\": \"0.1.0\"",
                        1,
                    );
                }
            }
            write(&root, &w.rel_path, &text);
        }
        if kind & 2 == 2 {
            // A coexist render first, so the file carries navori's tracking.
            let coexist =
                plan_with(&root, CONFIG, None, Some(BTreeMap::new())).ok_or("coexist delegated")?;
            for w in coexist
                .pending
                .iter()
                .filter(|w| w.rel_path == ".claude/settings.json")
            {
                write(&root, &w.rel_path, &w.content);
            }
        }
        if kind & 8 == 8 {
            let path = root.join(".claude/settings.json");
            let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
            write(&root, ".claude/settings.json", &duplicate_entries(&text));
        }
        compare_engine(&root, CONFIG, &format!("settings kind {kind}"))?;
    }
    Ok(())
}

/// Repeats the first entry of the first `PreToolUse` bucket under its native command variant
/// (untracked, so a coexist merge keeps it beside navori's shell entry), and the first tracked
/// command.
fn duplicate_entries(text: &str) -> String {
    let Some(JsValue::Object(mut settings)) = js_json::parse(text) else {
        return text.to_owned();
    };
    if let Some(JsValue::Object(hooks)) = settings.get_mut("hooks")
        && let Some(JsValue::Array(buckets)) = hooks.get_mut("PreToolUse")
        && let Some(JsValue::Object(bucket)) = buckets.first_mut()
        && let Some(JsValue::Array(entries)) = bucket.get_mut("hooks")
        && let Some(JsValue::Object(mut copy)) = entries.first().cloned()
    {
        let script = match copy.get("command") {
            Some(JsValue::String(command)) => command.to_rust().and_then(|c| {
                let rest = c.strip_prefix("f=\"$CLAUDE_PROJECT_DIR/")?.to_owned();
                Some(rest[..rest.find('"')?].to_owned())
            }),
            _ => None,
        };
        if let Some(script) = script {
            let variant = Hook {
                mode: HookMode::Shadow,
                gating: true,
                blocks: BTreeMap::new(),
                deps: BTreeMap::new(),
                r#impl: format!("sha256:{}", "0".repeat(64)),
                divergences: Vec::new(),
            };
            let native = claude_hook_command("PreToolUse", &script, None, Some(&variant));
            copy.insert("command", JsValue::string(&native));
            entries.push(JsValue::Object(copy));
        }
    }
    if let Some(JsValue::Object(ownership)) = settings.get_mut("$navori")
        && let Some(JsValue::Array(tracked)) = ownership.get_mut("managedHooks")
        && let Some(first) = tracked.first().cloned()
    {
        tracked.push(first);
    }
    JsValue::Object(settings)
        .stringify(Some(2))
        .map_or_else(|| text.to_owned(), |out| format!("{out}\n"))
}

fn compare_engine(root: &Path, config: &str, label: &str) -> Result<(), String> {
    let ts = NODE.ask(&json!({ "root": root.to_string_lossy(), "floor": null }))?;
    match plan(root, config, None).map(|p| report(&p)) {
        Some(rust) if rust == ts => Ok(()),
        Some(rust) => Err(format!("{label}: {}", first_difference(&ts, &rust))),
        None if ts.get("threw").is_some() || unparseable_json(root) => Ok(()),
        None => Err(format!("{label}: rust declined, ts {ts}")),
    }
}

fn report(plan: &ClaudeEnginePlan) -> Value {
    json!({
        "pending": plan.pending.iter().map(|w| json!([w.rel_path, w.content, w.status.as_str(), w.chmod_exec])).collect::<Vec<_>>(),
        "removals": plan.removals.iter().map(|r| json!([r.rel_path, r.recursive])).collect::<Vec<_>>(),
        "skipped": plan.skipped.iter().map(|s| json!([s.rel_path, s.reason, s.status.map(|st| st.as_str()), s.resolution])).collect::<Vec<_>>(),
    })
}

fn render_prelude() -> String {
    format!(
        "const r = await import({:?});",
        cli_module("commands/render.ts")
    )
}

/// `runRender(root, { dryRun: true })`: the engine result the report prints from.
static RENDER: Shared = Shared::new(
    render_prelude,
    "try {\n\
       const out = r.runRender(request.root, { dryRun: true });\n\
       if (!out.ok || !out.engineResult) return { failed: out.reasonCode ?? 'no-engine' };\n\
       const e = out.engineResult;\n\
       return {\n\
         written: e.written.map((w) => [w.path, w.status]),\n\
         skipped: e.skipped.map((s) => [s.path, s.reason, s.status ?? null]),\n\
         warnings: e.warnings,\n\
         inspected: e.inspected,\n\
         entries: out.entries.map((x) => [x.asset.id, x.status]),\n\
         fallbacks: out.languageFallbacks,\n\
         downgrades: out.downgrades.map((d) => [d.id, d.fromVersion]),\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }",
);

/// The engine notes random configs rarely reach: a missing preset, a local preset with a library
/// the registry dropped, unknown and retired libraries, and local skills (present, missing,
/// not a plain id).
// Covers: R41
#[test]
fn engine_result_warnings_match_run_render() -> Result<(), String> {
    let configs = [
        r#"{"name":"demo","preset":"nope","engines":["claude"]}"#,
        r#"{"name":"demo","preset":"mine","engines":["claude"],"language":"en"}"#,
        r#"{"name":"demo","preset":"custom","engines":["claude"],"project":{"libraries":["socketio","zzz","zod-validation"],"extraLibraries":["formik","zzz"]}}"#,
        r#"{"name":"demo","preset":"custom","engines":["claude"],"language":"en","project":{"libraries":["nativewind"],"localSkills":["present","missing","../x"," pad","zod-validation"]}}"#,
    ];
    let root = BASE.join("warnings");
    for config in configs {
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::create_dir_all(&root);
        write(&root, "navori.config.json", config);
        write(
            &root,
            ".claude/skills/present/SKILL.md",
            "---\nname: present\n---\nMine.\n",
        );
        write(
            &root,
            ".navori/presets/mine/mine.json",
            r#"{"id":"mine","displayName":"Mine","extends":"core","libraries":["zod-validation","zzz-lib"],"extras":{"managed":[],"agents":[],"skills":[],"hooks":[]}}"#,
        );
        let ts = RENDER.ask(&json!({ "root": root.to_string_lossy() }))?;
        let rust = plan(&root, config, None).map(|p| engine_result(&p));
        match rust {
            Some(rust) if rust == ts => {}
            Some(rust) => return Err(format!("{config}: {}", first_difference(&ts, &rust))),
            None => return Err(format!("{config}: rust declined, ts {ts}")),
        }
    }
    Ok(())
}

fn report_prelude() -> String {
    format!(
        "process.env.NO_COLOR = '1';\nprocess.env.TERM = 'xterm-256color';\nconst r = await import({:?});",
        cli_module("commands/render.ts")
    )
}

/// `navori render --cwd <root> [--json]` (preview), its stdout and stderr captured.
static REPORT: Shared = Shared::new(
    report_prelude,
    "const out = [];\n\
     const err = [];\n\
     const write = process.stdout.write;\n\
     const ewrite = process.stderr.write;\n\
     const exit = process.exit;\n\
     process.stdout.write = (chunk) => { out.push(String(chunk)); return true; };\n\
     process.stderr.write = (chunk) => { err.push(String(chunk)); return true; };\n\
     process.exit = (code) => { throw new Error('exit ' + code); };\n\
     try { await r.renderCommand.run({ args: { cwd: request.root, json: request.json === true, _: [] }, rawArgs: [], cmd: r.renderCommand }); }\n\
     catch (e) { return { threw: String(e && e.message || e) }; }\n\
     finally { process.stdout.write = write; process.stderr.write = ewrite; process.exit = exit; }\n\
     return { out: out.join(''), err: err.join('') };",
);

/// The TS side's provenance, which names the `core-assets` it read, as Rust prints it (Q11).
static PROVENANCE: LazyLock<Vec<(Regex, &str)>> = LazyLock::new(|| {
    [
        (
            r"(?m)^(\S+  )core: .+ \((?:dev sources|fuentes de dev|build copy|copia del build)\)$",
            "${1}core: (embedded)",
        ),
        (
            r#""coreRoot": "[^"]*",\n  "bundled": (?:true|false),"#,
            "\"coreRoot\": \"(embedded)\",\n  \"bundled\": true,",
        ),
    ]
    .into_iter()
    .filter_map(|(pattern, replacement)| Some((Regex::new(pattern).ok()?, replacement)))
    .collect()
});

fn mask_provenance(text: &str) -> String {
    PROVENANCE
        .iter()
        .fold(text.to_owned(), |text, (pattern, replacement)| {
            pattern.replace(&text, *replacement).into_owned()
        })
}

/// The native command's stdout and stderr on `root`; `None` when it delegates.
fn rust_command(root: &Path, config: &str, json: bool) -> Option<(String, String)> {
    let read = config::read(config.as_bytes()).ok()?;
    let plan = plan_render(&DiskView(root), &read, root, None).ok()?;
    let cwd = root.to_str()?;
    let stdout = if json {
        format!("{}\n", render_json(cwd, &plan).stringify(Some(2))?)
    } else {
        human_report(Clack { unicode: true }, cwd, &plan)
    };
    let stderr: String = std::iter::repeat_n(&read.warnings, 2)
        .flatten()
        .map(|w| format!("{w}\n"))
        .collect();
    Some((stdout, stderr))
}

/// The TS command and the native one print the same bytes, provenance aside; `Ok(false)` when
/// Rust delegates.
fn compare_command(root: &Path, config: &str, json: bool) -> Result<bool, String> {
    let ts = REPORT.ask(&json!({ "root": root.to_string_lossy(), "json": json }))?;
    let (Some(out), Some(err)) = (
        ts.get("out").and_then(Value::as_str),
        ts.get("err").and_then(Value::as_str),
    ) else {
        // Both refusing is agreement; the TS failing alone is not.
        return match rust_command(root, config, json) {
            None => Ok(true),
            Some(_) => Err(format!("ts failed: {ts}")),
        };
    };
    let Some((stdout, stderr)) = rust_command(root, config, json) else {
        return Ok(false);
    };
    let out = mask_provenance(out);
    if out != stdout {
        let at = out
            .bytes()
            .zip(stdout.bytes())
            .position(|(a, b)| a != b)
            .unwrap_or(out.len().min(stdout.len()));
        return Err(format!(
            "stdout (json: {json}) differs at byte {at}\n--- ts ---\n{out}\n--- rust ---\n{stdout}"
        ));
    }
    if err != stderr {
        return Err(format!(
            "stderr:\n--- ts ---\n{err}\n--- rust ---\n{stderr}"
        ));
    }
    Ok(true)
}

/// The wiring in both modes (D23: `guard-destructive` and `subagent-no-background` also in
/// `active`): every ported hook is signed so the runtime verifier accepts it, against its
/// dependency bytes and the manifest's `impl`, and `active` leaves no `--shadow` behind.
// Covers: R42
#[test]
fn native_wiring_verifies_in_shadow_and_active() -> Result<(), String> {
    const CONFIG: &str = r#"{"name":"demo","preset":"custom","engines":["claude"],"plugins":{"tgrep":{"enabled":true}}}"#;
    let root = BASE.join("modes");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::create_dir_all(&root);
    write(&root, "navori.config.json", CONFIG);
    for mode in [HookMode::Shadow, HookMode::Active] {
        let mut manifest = navori_core::render::native_hooks::embedded_native_hooks();
        if manifest.len() < 2 {
            return Err("ported.json lost a hook".to_owned());
        }
        for hook in manifest.values_mut() {
            hook.mode = mode;
        }
        let rendered =
            plan_with(&root, CONFIG, None, Some(manifest.clone())).ok_or("plan delegated")?;
        let content = |rel: &str| {
            rendered
                .pending
                .iter()
                .find(|w| w.rel_path == rel)
                .map(|w| w.content.clone())
        };
        for (id, hook) in &manifest {
            let script = content(&format!(".claude/hooks/{id}.sh"))
                .ok_or_else(|| format!("{id}: not planned"))?;
            let deps: Vec<String> = hook
                .deps
                .keys()
                .map(|dep| {
                    content(&format!(".claude/{dep}")).ok_or_else(|| format!("{dep}: not planned"))
                })
                .collect::<Result<_, _>>()?;
            let slices: Vec<&[u8]> = deps.iter().map(String::as_bytes).collect();
            if !navori_core::integrity::verify(script.as_bytes(), &slices, &hook.r#impl) {
                return Err(format!("{id} {mode:?}: signature does not verify"));
            }
            if script.contains("--shadow") != (mode == HookMode::Shadow) {
                return Err(format!("{id} {mode:?}: wrong runtime arm"));
            }
        }
        let settings = content(".claude/settings.json").ok_or("settings not planned")?;
        if !settings.contains("native-runtime start")
            || settings.contains("--shadow") != (mode == HookMode::Shadow)
        {
            return Err(format!("settings.json {mode:?}: wrong native commands"));
        }
    }
    Ok(())
}

/// Replaces the body of the first managed block of `text` and re-hashes its marker.
fn rewrite_first_block(text: &str, body: &str) -> String {
    let Some(open_end) = text.find(" -->\n").map(|at| at + " -->\n".len()) else {
        return text.to_owned();
    };
    let Some(close) = text[open_end..]
        .find("<!-- /navori:managed")
        .map(|at| at + open_end)
    else {
        return text.to_owned();
    };
    let open = &text[..open_end];
    let hash = navori_core::integrity::marker_hash(body);
    let open = match (open.find("hash=\""), open.find("hash=\"").map(|at| at + 14)) {
        (Some(start), Some(end)) => {
            format!("{}hash=\"{hash}\"{}", &open[..start], &open[end + 1..])
        }
        _ => open.to_owned(),
    };
    format!("{open}{body}\n{}", &text[close..])
}

/// The report over a repo a newer navori rendered, whose first `CLAUDE.md` block that render
/// wants to rewrite (a downgrade), and one an older navori rendered, in both languages.
// Covers: R41
#[test]
fn render_report_matches_after_restamps() -> Result<(), String> {
    let root = BASE.join("report-restamp");
    for language in ["es", "en"] {
        for version in ["999.0.0", "0.1.0"] {
            let config = format!(
                r#"{{"name":"demo","preset":"custom","engines":["claude"],"language":"{language}","plugins":{{"engram":{{"enabled":true}}}}}}"#
            );
            build_repo(
                &root,
                &Recipe {
                    baseline: Some(config.clone()),
                    restamp: Some(version),
                    edits: Vec::new(),
                },
            );
            write(&root, "navori.config.json", &config);
            // The first `CLAUDE.md` block becomes another navori's intact output: a body this
            // render would replace, under its own valid hash.
            let claude_md = root.join("CLAUDE.md");
            let text = std::fs::read_to_string(&claude_md).map_err(|e| e.to_string())?;
            write(
                &root,
                "CLAUDE.md",
                &rewrite_first_block(&text, "Older body."),
            );
            let (rust, _) = rust_command(&root, &config, false).ok_or("rust declined")?;
            if version == "999.0.0"
                && !(rust.contains("(up to 999.0.0)") || rust.contains("(hasta 999.0.0)"))
            {
                return Err(format!("{language}: no downgrade warning planned"));
            }
            for json in [false, true] {
                compare_command(&root, &config, json)
                    .map_err(|why| format!("{language} {version}: {why}"))?;
            }
        }
    }
    Ok(())
}

/// The Rust plan as the `ClaudeEngineResult` fields the report reads.
fn engine_result(plan: &ClaudeEnginePlan) -> Value {
    let written: Vec<Value> = plan
        .pending
        .iter()
        .map(|w| json!([w.rel_path, w.status.as_str()]))
        .chain(
            plan.removals
                .iter()
                .map(|r| json!([r.rel_path, "removed-condition-false"])),
        )
        .collect();
    json!({
        "written": written,
        "skipped": plan.skipped.iter().map(|s| json!([s.rel_path, s.reason, s.status.map(|st| st.as_str())])).collect::<Vec<_>>(),
        "warnings": plan.warnings,
        "inspected": plan.inspected,
        "entries": plan.claude_md_entries.iter().map(|(id, status)| json!([id, status.as_str()])).collect::<Vec<_>>(),
        "fallbacks": plan.language_fallbacks,
        "downgrades": plan.downgrades.iter().map(|d| json!([d.id, d.from_version])).collect::<Vec<_>>(),
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(40))]

    // Covers: R41
    #[test]
    fn render_report_matches_the_ts_output(
        config in config(),
        recipe in recipe(),
        same_config in prop::bool::weighted(0.4),
        extras in extras(),
    ) {
        prop_assume!(!config.contains("codex"));
        let root = BASE.join("report");
        let recipe = if same_config { Recipe { baseline: Some(config.clone()), ..recipe } } else { recipe };
        build_repo(&root, &recipe);
        let config = extras.apply(&root, &config);
        write(&root, "navori.config.json", &config);
        for json in [false, true] {
            match compare_command(&root, &config, json) {
                Ok(true) => {}
                Ok(false) => prop_assert!(unparseable_json(&root), "rust declined\n{config}\n{recipe:?}"),
                Err(why) => prop_assert!(false, "{why}\n{config}\n{recipe:?}\n{extras:?}"),
            }
        }
    }
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(80))]

    // Covers: R41
    #[test]
    fn engine_result_matches_run_render(
        config in config(),
        recipe in recipe(),
        same_config in prop::bool::weighted(0.4),
    ) {
        // `runRender` seals every engine's owned paths into the guard; the native subset is
        // Claude-only and re-delegates with another engine (Q8).
        prop_assume!(!config.contains("codex"));
        let root = BASE.join("result");
        let recipe = if same_config { Recipe { baseline: Some(config.clone()), ..recipe } } else { recipe };
        build_repo(&root, &recipe);
        write(&root, "navori.config.json", &config);
        let ts = RENDER
            .ask(&json!({ "root": root.to_string_lossy() }))
            .map_err(TestCaseError::fail)?;
        match plan(&root, &config, None) {
            Some(rust) => {
                let rust = engine_result(&rust);
                prop_assert!(ts == rust, "{}\n{}\n{:?}", first_difference(&ts, &rust), config, recipe);
            }
            None => prop_assert!(
                ts.get("threw").is_some() || ts.get("failed").is_some() || unparseable_json(&root),
                "rust declined, ts: {} for {}", ts, config
            ),
        }
    }

    // Covers: R41
    #[test]
    fn claude_plan_matches_the_engine(
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
            .ask(&json!({ "root": root.to_string_lossy(), "floor": floor }))
            .map_err(TestCaseError::fail)?;
        match plan(&root, &config, floor) {
            Some(rust) => {
                let rust = report(&rust);
                prop_assert!(ts == rust, "{}\n{}\n{:?}", first_difference(&ts, &rust), config, recipe);
            }
            None => prop_assert!(
                ts.get("threw").is_some() || unparseable_json(&root),
                "rust declined, ts: {} for {}", ts, config
            ),
        }
    }
}
