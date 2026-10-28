//! `navori_core::render::claude::plan_claude_engine` (spec 0058 T14, A5): the whole Claude plan.
//!
//! - Against the `claude` snap of `golden-render-tree.test.ts`: the tree a fresh render writes
//!   with the golden config, normalized the same way, file by file and with the exec bit.
//! - Against the real `prepareClaudeEngine(...).finalize()` over repos rendered with another
//!   config and then edited: pending writes, removals and skips, in order.
//!
//! `settings.json`, `.mcp.json` and the native wiring of the hooks in `crates/ported.json` are
//! T15: they are left out of both comparisons until then.

mod support;

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::STAMP_VERSION;
use navori_core::config;
use navori_core::render::block_plan::PlanOptions;
use navori_core::render::claude::{ClaudeEnginePlan, plan_claude_engine};
use navori_core::render::collect::RepoView;
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
       const keep = (rel) => !request.excluded.includes(rel);\n\
       return {\n\
         pending: fin.pending.filter((p) => keep(p.relPath)).map((p) => [p.relPath, p.content, p.status, p.chmodExec === true]),\n\
         removals: fin.removals.map((r) => [path.relative(root, r.path), r.recursive === true]),\n\
         skipped: fin.skipped.filter((s) => keep(s.path)).map((s) => [s.path, s.reason, s.status ?? null, s.resolution ? s.resolution.content : null]),\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }\n\
     finally { m.setMarkerFloorVersion(undefined); }",
);

static BASE: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-render-claude-{}", std::process::id()))
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

/// T15 files: `settings.json`, `.mcp.json` and the hooks the native wiring rewrites.
static EXCLUDED: LazyLock<Vec<String>> = LazyLock::new(|| {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../ported.json");
    let ported: Value = std::fs::read_to_string(manifest)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or(Value::Null);
    let mut out: Vec<String> = ported["hooks"]
        .as_object()
        .map(|hooks| {
            hooks
                .keys()
                .map(|id| format!(".claude/hooks/{id}.sh"))
                .collect()
        })
        .unwrap_or_default();
    out.push(".claude/settings.json".to_owned());
    out.push(".mcp.json".to_owned());
    out
});

fn plan(root: &Path, text: &str, floor: Option<&str>) -> Option<ClaudeEnginePlan> {
    let read = config::read(text.as_bytes()).ok()?;
    let options = PlanOptions {
        ambient_floor: floor.map(str::to_owned),
        ..PlanOptions::default()
    };
    plan_claude_engine(&Disk(root), &read.data, root, &options).ok()
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
    let plan = plan(&root, GOLDEN_CONFIG, None).ok_or("plan_claude_engine delegated")?;
    let excluded = [".claude/settings.json", ".mcp.json"];
    let mut golden = golden_sections()?;
    golden.retain(|file, _| !excluded.contains(&file.as_str()));
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

fn report(plan: &ClaudeEnginePlan) -> Value {
    let keep = |rel: &str| !EXCLUDED.iter().any(|e| e == rel);
    json!({
        "pending": plan.pending.iter().filter(|w| keep(&w.rel_path)).map(|w| json!([w.rel_path, w.content, w.status.as_str(), w.chmod_exec])).collect::<Vec<_>>(),
        "removals": plan.removals.iter().map(|r| json!([r.rel_path, r.recursive])).collect::<Vec<_>>(),
        "skipped": plan.skipped.iter().filter(|s| keep(&s.rel_path)).map(|s| json!([s.rel_path, s.reason, s.status.as_str(), s.resolution])).collect::<Vec<_>>(),
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(80))]

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
            .ask(&json!({ "root": root.to_string_lossy(), "floor": floor, "excluded": *EXCLUDED }))
            .map_err(TestCaseError::fail)?;
        match plan(&root, &config, floor) {
            Some(rust) => {
                let rust = report(&rust);
                prop_assert!(ts == rust, "{}\n{}\n{:?}", first_difference(&ts, &rust), config, recipe);
            }
            None => prop_assert!(ts.get("threw").is_some(), "rust declined, ts: {} for {}", ts, config),
        }
    }
}
