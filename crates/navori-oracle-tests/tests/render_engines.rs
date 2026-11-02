//! `navori_core::render::prose` (spec 0059 T18, A5): the prose engines.
//!
//! - Against the `agents-md`, `cursor` and `copilot` snaps of `golden-render-tree.test.ts`: the
//!   file a fresh render writes with the golden config, normalized the same way.
//! - Against the real `renderAgentsMdEngine` / `renderCursorEngine` / `renderCopilotEngine` over
//!   files a previous render left and the user then edited: the written content and status, the
//!   skips with their resolution, and the parity warnings.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::config;
use navori_core::render::collect::DiskView;
use navori_core::render::prose::{
    AGENTS_MD, COPILOT, CURSOR, ProseOptions, ProsePlan, ProseSpec, plan_prose_file,
    summarize_trigger,
};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use regex::Regex;
use serde_json::{Value, json};
use support::{Shared, cli_module, first_difference};

fn prelude() -> String {
    format!(
        "const a = await import({:?});\nconst cu = await import({:?});\nconst co = await import({:?});\nconst m = await import({:?});\nconst c = await import({:?});\nconst s = await import({:?});\nconst fs = await import('node:fs');\nconst path = await import('node:path');\nconst engines = {{ 'agents-md': a.renderAgentsMdEngine, cursor: cu.renderCursorEngine, copilot: co.renderCopilotEngine }};",
        cli_module("engines/agents-md/index.ts"),
        cli_module("engines/cursor/index.ts"),
        cli_module("engines/copilot/index.ts"),
        cli_module("lib/render/marker.ts"),
        cli_module("lib/config/config.ts"),
        cli_module("lib/assets/skill-meta.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.trigger !== undefined) return s.summarizeTrigger(request.trigger);\n\
     m.setMarkerFloorVersion(request.floor ?? undefined);\n\
     try {\n\
       const root = request.root;\n\
       const config = c.readConfig(path.join(root, 'navori.config.json'));\n\
       const r = engines[request.engine](root, config, { dryRun: false });\n\
       const dest = path.join(root, request.dest);\n\
       return {\n\
         written: r.written.map((w) => [w.path, w.status]),\n\
         skipped: r.skipped.map((k) => [k.path, k.reason, k.status ?? null, k.resolution ? k.resolution.content : null]),\n\
         warnings: r.warnings,\n\
         content: fs.existsSync(dest) ? fs.readFileSync(dest, 'utf8') : null,\n\
       };\n\
     } catch (err) { return { threw: String(err && err.message || err) }; }\n\
     finally { m.setMarkerFloorVersion(undefined); }",
);

static BASE: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-render-engines-{}", std::process::id()))
});

fn write(root: &Path, rel: &str, text: &str) {
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, text);
}

fn plan(
    root: &Path,
    text: &str,
    spec: ProseSpec,
    floor: Option<&str>,
) -> Result<ProsePlan, String> {
    let read = config::read(text.as_bytes()).map_err(|_| "config rejected".to_owned())?;
    let options = ProseOptions {
        ambient_floor: floor,
        ..ProseOptions::default()
    };
    plan_prose_file(&DiskView(root), &read.data, root, spec, options, None)
        .map_err(|_| format!("{} delegated", spec.engine))
}

// --- golden -------------------------------------------------------------------------------

/// `goldenConfig([engine])` of `golden-render-tree.test.ts`.
fn golden_config(engine: &str) -> String {
    format!(
        r#"{{
  "name": "golden-demo",
  "engines": ["{engine}"],
  "preset": "custom",
  "branchBase": "main",
  "commits": "conventional-es",
  "qualityGate": {{ "fast": "pnpm lint", "full": "pnpm test && pnpm lint" }},
  "plugins": {{
    "acli": {{ "enabled": true }},
    "engram": {{ "enabled": true }},
    "gh": {{ "enabled": true }},
    "jscpd": {{ "enabled": true }},
    "semgrep": {{ "enabled": true }}
  }},
  "project": {{ "libraries": ["zod-validation", "vitest"] }}
}}"#
    )
}

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

/// The one section of a prose engine's snap: (path, body).
fn golden_section(engine: &str) -> Result<(String, String), String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../packages/cli/src/engines/__tests__/__golden__/{engine}.snap"
    ));
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut file: Option<String> = None;
    let mut lines: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        if let Some(rest) = line.strip_prefix("===== FILE: ")
            && let Some(header) = rest.strip_suffix(" =====")
        {
            if file.is_some() {
                return Err(format!("{engine}: more than one file in the snap"));
            }
            file = Some(header.to_owned());
        } else if line.starts_with("===== END: ") {
            // Each section is `body` followed by one separator line.
            lines.pop();
            break;
        } else if file.is_some() {
            lines.push(line);
        }
    }
    Ok((
        file.ok_or(format!("{engine}: no file in the snap"))?,
        lines.join("\n"),
    ))
}

// Covers: R62, R64
#[test]
fn agents_md_cursor_and_copilot_match_their_golden_render_tree_snaps() -> Result<(), String> {
    for spec in [AGENTS_MD, CURSOR, COPILOT] {
        let root = BASE.join(format!("golden-{}", spec.engine));
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::create_dir_all(&root);
        let plan = plan(&root, &golden_config(spec.engine), spec, None)?;
        let write = plan
            .write
            .ok_or(format!("{}: nothing to write", spec.engine))?;
        let (file, expected) = golden_section(spec.engine)?;
        if write.rel_path != file {
            return Err(format!(
                "{}: wrote {} not {file}",
                spec.engine, write.rel_path
            ));
        }
        let actual = normalize(&write.content);
        if actual != expected {
            let at = expected
                .lines()
                .zip(actual.lines())
                .position(|(a, b)| a != b)
                .unwrap_or(0);
            return Err(format!(
                "{file}: first differing line {at}:\n  golden {:?}\n  rust   {:?}",
                expected.lines().nth(at),
                actual.lines().nth(at),
            ));
        }
    }
    Ok(())
}

// --- parity with the real engines -----------------------------------------------------------

fn pick(options: &[&'static str]) -> BoxedStrategy<String> {
    prop::sample::select(options.to_vec())
        .prop_map(String::from)
        .boxed()
}

fn field(key: &'static str, value: BoxedStrategy<String>) -> BoxedStrategy<Option<String>> {
    prop::option::of(value.prop_map(move |v| format!("{}:{v}", json!(key)))).boxed()
}

fn config(engine: &'static str) -> BoxedStrategy<String> {
    let plugins = prop::collection::vec(0u8..3, 4).prop_map(|states| {
        let fields: Vec<String> = ["engram", "gh", "tgrep", "jscpd"]
            .iter()
            .zip(states)
            .filter(|(_, s)| *s > 0)
            .map(|(id, s)| format!(r#""{id}":{{"enabled":{}}}"#, s == 1))
            .collect();
        format!("{{{}}}", fields.join(","))
    });
    vec![
        Just(Some(format!(r#""name":"demo","engines":["{engine}"]"#))).boxed(),
        pick(&[
            r#""custom""#,
            r#""astro""#,
            r#""nextjs""#,
            r#""fastapi-python""#,
        ])
        .prop_map(|p| Some(format!(r#""preset":{p}"#)))
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
                r#"{"posture":"production","libraries":["axios"],"extraLibraries":["vitest"]}"#,
            ]),
        ),
        field("sdd", pick(&[r#"{"enabled":false}"#])),
        field("models", pick(&[r#"{"implementer":"sonnet"}"#])),
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

/// What the file looks like before the render under test.
#[derive(Debug, Clone, Copy)]
enum Before {
    /// No file.
    Absent,
    /// A previous render with another config, untouched.
    Rendered,
    /// That render with user prose around the block.
    UserProse,
    /// That render with the managed body edited by hand.
    EditedBlock,
    /// That render stamped by a newer navori.
    Newer,
    /// A file of the user's with no marker.
    Foreign,
}

fn before() -> BoxedStrategy<Before> {
    prop::sample::select(vec![
        Before::Absent,
        Before::Rendered,
        Before::UserProse,
        Before::EditedBlock,
        Before::Newer,
        Before::Foreign,
    ])
    .boxed()
}

fn ask(request: &Value) -> Result<Value, TestCaseError> {
    let reply = NODE.ask(request).map_err(TestCaseError::fail)?;
    if let Some(threw) = reply.get("threw") {
        return Err(TestCaseError::reject(format!("TS threw: {threw}")));
    }
    Ok(reply)
}

/// Brings `root` to `before`, starting from a TS render with `seed`.
fn prepare(
    root: &Path,
    spec: ProseSpec,
    seed: &str,
    before: Before,
) -> Result<Option<String>, TestCaseError> {
    let _ = std::fs::remove_dir_all(root);
    let _ = std::fs::create_dir_all(root);
    let rendered = match before {
        Before::Absent => return Ok(None),
        Before::Foreign => return Ok(Some("# Mine\n\nNotes the user keeps.\n".to_owned())),
        _ => {
            write(root, "navori.config.json", seed);
            let reply = ask(
                &json!({ "root": root.to_string_lossy(), "engine": spec.engine, "dest": spec.dest }),
            )?;
            reply["content"]
                .as_str()
                .ok_or_else(|| TestCaseError::fail("seed render wrote nothing"))?
                .to_owned()
        }
    };
    let close = format!("<!-- /navori:managed id=\"{}\" -->", spec.managed_id);
    Ok(Some(match before {
        Before::UserProse => format!("Intro the user wrote.\n\n{rendered}\nMore rules.\n"),
        Before::EditedBlock => rendered.replacen(&close, &format!("Hand edit.\n{close}"), 1),
        Before::Newer => {
            let re = Regex::new(r#"(navori:managed id="[^"]*" hash="[^"]*" )version="[^"]*""#)
                .map_err(|e| TestCaseError::fail(e.to_string()))?;
            re.replace(&rendered, r#"${1}version="99.0.0""#)
                .into_owned()
        }
        _ => rendered,
    }))
}

fn rust_reply(plan: &ProsePlan, before: Option<&str>) -> Value {
    let content = plan
        .write
        .as_ref()
        .map(|w| w.content.clone())
        .or_else(|| before.map(str::to_owned));
    json!({
        "written": plan.write.iter().map(|w| json!([w.rel_path, w.status.as_str()])).collect::<Vec<_>>(),
        "skipped": plan.skipped.iter().map(|s| json!([
            s.rel_path,
            s.reason,
            s.status.map(|status| status.as_str()),
            s.resolution,
        ])).collect::<Vec<_>>(),
        "warnings": plan.warnings,
        "content": content,
    })
}

fn check(
    spec: ProseSpec,
    seed: &str,
    text: &str,
    before: Before,
    floor: Option<&str>,
) -> Result<(), TestCaseError> {
    let ts_root = BASE.join(format!("ts-{}", spec.engine));
    let rust_root = BASE.join(format!("rust-{}", spec.engine));
    let initial = prepare(&ts_root, spec, seed, before)?;
    let _ = std::fs::remove_dir_all(&rust_root);
    let _ = std::fs::create_dir_all(&rust_root);
    for root in [&ts_root, &rust_root] {
        write(root, "navori.config.json", text);
        if let Some(initial) = &initial {
            write(root, spec.dest, initial);
        }
    }
    let ts = ask(&json!({
        "root": ts_root.to_string_lossy(),
        "engine": spec.engine,
        "dest": spec.dest,
        "floor": floor,
    }))?;
    let rust = rust_reply(
        &plan(&rust_root, text, spec, floor).map_err(TestCaseError::fail)?,
        initial.as_deref(),
    );
    prop_assert!(ts == rust, "{}", first_difference(&ts, &rust));
    Ok(())
}

fn spec() -> BoxedStrategy<ProseSpec> {
    prop::sample::select(vec![AGENTS_MD, CURSOR, COPILOT]).boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(60))]

    // Covers: R62, R64
    #[test]
    fn prose_engines_match_the_ts_render(
        (spec, seed, text) in spec().prop_flat_map(|spec| (Just(spec), config(spec.engine), config(spec.engine))),
        before in before(),
        floor in prop::option::of(pick(&["0.1.0", "99.0.0"])),
    ) {
        check(spec, &seed, &text, before, floor.as_deref())?;
    }
}

// --- summarizeTrigger -----------------------------------------------------------------------

fn description() -> BoxedStrategy<String> {
    let piece = prop::sample::select(vec![
        "Use when",
        " ",
        "  ",
        "\t",
        "\n",
        " — ",
        " – ",
        ". ",
        "; ",
        ",",
        ".",
        ";",
        "a durable fact",
        "or need",
        "x",
        "😀",
        "é",
        "\u{a0}",
        "\u{feff}",
        "\u{2028}",
        "word ",
    ]);
    prop::collection::vec(piece, 0..60)
        .prop_map(|parts| parts.concat())
        .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    // Covers: R64
    #[test]
    fn summarize_trigger_matches_node(text in description()) {
        let ts = NODE.ask(&json!({ "trigger": text })).map_err(TestCaseError::fail)?;
        let rust = summarize_trigger(Some(&text));
        prop_assert_eq!(ts.as_str().map(str::to_owned), rust);
    }
}

/// Every section of an engine's snap, as `(header, body)`: the header is the path with its
/// ` [exec]` mark, the body the normalized bytes (each section ends with one separator line).
fn golden_sections(engine: &str) -> Result<Vec<(String, String)>, String> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
        "../../packages/cli/src/engines/__tests__/__golden__/{engine}.snap"
    ));
    let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut sections: Vec<(String, Vec<&str>)> = Vec::new();
    for line in text.split('\n') {
        if let Some(header) = line
            .strip_prefix("===== FILE: ")
            .and_then(|rest| rest.strip_suffix(" ====="))
        {
            sections.push((header.to_owned(), Vec::new()));
        } else if line.starts_with("===== END: ") {
            break;
        } else if let Some((_, lines)) = sections.last_mut() {
            lines.push(line);
        }
    }
    Ok(sections
        .into_iter()
        .map(|(header, mut lines)| {
            lines.pop();
            (header, lines.join("\n"))
        })
        .collect())
}

// Covers: R62, R64, R66
#[test]
fn codex_tree_matches_the_codex_snap_of_golden_render_tree() -> Result<(), String> {
    use navori_core::render::codex_engine::{
        CodexEngineInput, codex_observed, plan_codex_engine, seal_observed,
    };
    let root = BASE.join("golden-codex");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::create_dir_all(&root);
    // `goldenConfig(["claude", "codex"])`, rendered by `renderCodexEngine` alone.
    let text = golden_config("claude\", \"codex");
    let read = config::read(text.as_bytes()).map_err(|_| "config rejected".to_owned())?;
    // The golden test runs outside the migration opt-in: `loadNativeHooks()` is empty there.
    let manifest = std::collections::BTreeMap::new();
    let input = CodexEngineInput {
        config: &read.data,
        repo_root: &root,
        ambient_floor: None,
        native_manifest: &manifest,
        catalog: None,
    };
    let view = DiskView(&root);
    let observed = codex_observed(&view, &input).map_err(|_| "codex delegated".to_owned())?;
    let seal = seal_observed(&view, &observed).map_err(|_| "seal delegated".to_owned())?;
    let plan = plan_codex_engine(&view, &input, &seal).map_err(|_| "codex delegated".to_owned())?;
    let mut rust: Vec<(String, String)> = plan
        .pending
        .iter()
        .map(|w| {
            let exec = if w.chmod_exec { " [exec]" } else { "" };
            (format!("{}{exec}", w.rel_path), normalize(&w.content))
        })
        .collect();
    rust.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let golden = golden_sections("codex")?;
    let names = |list: &[(String, String)]| list.iter().map(|(h, _)| h.clone()).collect::<Vec<_>>();
    if names(&rust) != names(&golden) {
        return Err(format!(
            "file lists differ:\n  golden {:?}\n  rust   {:?}",
            names(&golden),
            names(&rust)
        ));
    }
    for ((file, expected), (_, actual)) in golden.iter().zip(&rust) {
        if expected != actual {
            let at = expected
                .split('\n')
                .zip(actual.split('\n'))
                .position(|(a, b)| a != b)
                .unwrap_or(0);
            return Err(format!(
                "{file}: first differing line {at}:\n  golden {:?}\n  rust   {:?}",
                expected.split('\n').nth(at),
                actual.split('\n').nth(at)
            ));
        }
    }
    Ok(())
}

// Covers: R62, R67, R68
#[test]
fn pi_tree_matches_the_pi_snap_of_golden_render_tree() -> Result<(), String> {
    use navori_core::render::pi_engine::{PiEngineInput, pi_observed, pi_seal, plan_pi_engine};

    let root = BASE.join("golden-pi");
    let _ = std::fs::remove_dir_all(&root);
    let _ = std::fs::create_dir_all(&root);
    let text = golden_config("pi");
    let read = config::read(text.as_bytes()).map_err(|_| "config rejected".to_owned())?;
    // The golden test runs outside the migration opt-in: `loadNativeHooks()` is empty there.
    let manifest = std::collections::BTreeMap::new();
    let input = PiEngineInput {
        config: &read.data,
        repo_root: &root,
        ambient_floor: None,
        native_manifest: &manifest,
    };
    let view = DiskView(&root);
    let (observed, excluded) = pi_observed(&view, &input).map_err(|_| "pi delegated".to_owned())?;
    let seal = pi_seal(&observed, &excluded).map_err(|_| "seal delegated".to_owned())?;
    let plan = plan_pi_engine(&view, &input, &seal).map_err(|_| "pi delegated".to_owned())?;
    let mut rust: Vec<(String, String)> = plan
        .pending
        .iter()
        .chain(plan.context.iter().flat_map(|c| c.write.iter()))
        .map(|w| {
            let exec = if w.chmod_exec { " [exec]" } else { "" };
            (format!("{}{exec}", w.rel_path), normalize(&w.content))
        })
        .collect();
    rust.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let mut golden = golden_sections("pi")?;
    // The extension comes from `dist` (D29): its serialized functions are the bundler's, not the
    // sources' the golden test renders, so the oracle's Pi cases compare it against `dist`; here it
    // only has to be a valid owned file at the same path.
    let ext = ".pi/extensions/navori.ts";
    let extension = plan.pending.iter().find(|w| w.rel_path == ext);
    if !extension.is_some_and(|w| navori_core::render::pi_owned::owns_pi_source(&w.content)) {
        return Err("the Pi extension is missing or not a valid owned file".to_owned());
    }
    rust.retain(|(h, _)| h != ext);
    golden.retain(|(h, _)| h != ext);
    let names = |list: &[(String, String)]| list.iter().map(|(h, _)| h.clone()).collect::<Vec<_>>();
    if names(&rust) != names(&golden) {
        return Err(format!(
            "file lists differ:\n  golden {:?}\n  rust   {:?}",
            names(&golden),
            names(&rust)
        ));
    }
    for ((file, expected), (_, actual)) in golden.iter().zip(&rust) {
        if expected != actual {
            let at = expected
                .split('\n')
                .zip(actual.split('\n'))
                .position(|(a, b)| a != b)
                .unwrap_or(0);
            return Err(format!(
                "{file}: first differing line {at}:\n  golden {:?}\n  rust   {:?}",
                expected.split('\n').nth(at),
                actual.split('\n').nth(at)
            ));
        }
    }
    Ok(())
}
