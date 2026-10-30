//! `navori_core::render::mcp_file::plan_mcp_registration` against the real `planMcpRegistration`
//! (spec 0058 T15): synthetic plugins with and without `mcpServer` (`env`, `alwaysLoad`),
//! enabled and disabled, over no file, a file that does not parse or is not an object, the
//! user's own servers and keys, and a previous render restamped older or newer, with the floor
//! and `force`.

mod support;

use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use navori_core::STAMP_VERSION;
use navori_core::js_json;
use navori_core::render::collect::RepoView;
use navori_core::render::context::Lang;
use navori_core::render::mcp_file::plan_mcp_registration;
use navori_core::render::plugins::{LoadedPlugin, plugin_from_manifest};
use navori_core::render::settings_file::SettingsPlan;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const e = await import({:?});\nconst p = await import({:?});",
        cli_module("engines/claude/index.ts"),
        cli_module("lib/config/plugins.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "const load = (raw) => ({ manifest: p.PluginManifestSchema.parse(JSON.parse(raw)) });\n\
     const plan = e.planMcpRegistration(request.root, request.enabled.map(load), request.disabled.map(load),\n\
       { language: request.lang, harnessVersion: request.floor ?? undefined }, request.force);\n\
     if (plan.kind === 'noop') return ['noop'];\n\
     if (plan.kind === 'skip') return ['skip', plan.reason, plan.status ?? null];\n\
     return ['write', plan.content, plan.status];",
);

static ROOT: LazyLock<PathBuf> =
    LazyLock::new(|| std::env::temp_dir().join(format!("navori-mcp-file-{}", std::process::id())));

struct Disk<'a>(&'a Path);

impl RepoView for Disk<'_> {
    fn symlink(&self, rel: &str) -> Option<bool> {
        match std::fs::symlink_metadata(self.0.join(rel)) {
            Ok(meta) => Some(meta.file_type().is_symlink()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(false),
            Err(_) => None,
        }
    }

    fn read(&self, rel: &str) -> Option<String> {
        std::fs::read_to_string(self.0.join(rel)).ok()
    }

    fn read_regular(&self, rel: &str) -> Option<String> {
        self.read(rel)
    }

    fn exists(&self, rel: &str) -> bool {
        self.0.join(rel).exists()
    }

    fn lexists(&self, rel: &str) -> bool {
        std::fs::symlink_metadata(self.0.join(rel)).is_ok()
    }

    fn list_dir(&self, _rel: &str) -> Option<Vec<String>> {
        None
    }
}

fn pick(options: &[&'static str]) -> BoxedStrategy<String> {
    prop::sample::select(options.to_vec())
        .prop_map(String::from)
        .boxed()
}

/// A synthetic manifest `p<i>`, with or without `mcpServer`.
fn plugin(i: usize) -> BoxedStrategy<String> {
    let server = prop::option::weighted(
        0.8,
        (
            pick(&["", r#","args":["mcp","--x"]"#]),
            pick(&["", r#","env":{}"#, r#","env":{"K":"v","A":"b"}"#]),
            pick(&["", r#","alwaysLoad":true"#, r#","alwaysLoad":false"#]),
        )
            .prop_map(|(args, env, always)| {
                format!(r#","mcpServer":{{"command":"srv"{args}{env}{always}}}"#)
            }),
    );
    server
        .prop_map(move |server| {
            format!(
                r#"{{"id":"p{i}","name":"P","description":"P","version":"0.0.1"{}}}"#,
                server.unwrap_or_default()
            )
        })
        .boxed()
}

fn server_key() -> BoxedStrategy<String> {
    pick(&["p0", "p1", "p2", "mine", "0"])
}

/// `.mcp.json` before the render, `None` when absent.
fn existing() -> BoxedStrategy<Option<String>> {
    let servers = prop_oneof![
        6 => prop::collection::vec(
            (
                server_key(),
                // Navori's keys (set, stale or absent), a host's own switches (#1448), in
                // different orders, and entries that are not objects.
                pick(&[
                    r#"{"command":"old"}"#,
                    r#"{"command":"srv","args":[]}"#,
                    r#"{"command":"srv","directTools":true}"#,
                    r#"{"directTools":true,"args":["old"],"command":"old","env":{"Z":"1"}}"#,
                    r#"{"alwaysLoad":true,"host":{"a":1},"command":"srv"}"#,
                    r#"{"2":1,"command":"srv","1":2,"directTools":false}"#,
                    r#""broken""#,
                    r#"null"#,
                    r#"[1]"#,
                ]),
            ),
            0..4,
        )
        .prop_map(|entries| {
            let body: Vec<String> = entries
                .into_iter()
                .map(|(k, v)| format!("{}:{v}", json!(k)))
                .collect();
            format!("{{{}}}", body.join(","))
        }),
        1 => pick(&[r#""str""#, "[]"]),
    ];
    let stamp = pick(&[
        r#"{"managed":true,"version":"0.1.0"}"#,
        r#"{"managed":true,"version":"999.0.0"}"#,
        r#""x""#,
    ]);
    let object = (
        prop::option::of(stamp),
        prop::option::weighted(0.8, servers),
        prop::option::of(pick(&[r#""other":1"#, r#""1":true"#])),
    )
        .prop_map(|(stamp, servers, extra)| {
            let mut fields = Vec::new();
            if let Some(s) = stamp {
                fields.push(format!(r#""$navori":{s}"#));
            }
            if let Some(s) = servers {
                fields.push(format!(r#""mcpServers":{s}"#));
            }
            fields.extend(extra);
            let text = format!("{{{}}}", fields.join(","));
            js_json::parse(&text)
                .and_then(|v| v.stringify(Some(2)))
                .map_or(text, |pretty| format!("{pretty}\n"))
        });
    prop_oneof![
        2 => Just(None),
        6 => object.prop_map(Some),
        1 => pick(&["{oops", "[1]\n", "\"s\"\n"]).prop_map(Some),
    ]
    .boxed()
}

/// Every server navori wants, stamped with `version`: a previous render over the same plugins.
fn previous(enabled: &[LoadedPlugin], version: &str) -> Option<String> {
    let empty = ROOT.join("empty");
    let _ = std::fs::create_dir_all(&empty);
    match plan_mcp_registration(&Disk(&empty), enabled, &[], None, false, Lang::En) {
        Ok(SettingsPlan::Write { content, .. }) => Some(content.replace(
            &format!("\"version\": \"{STAMP_VERSION}\""),
            &format!("\"version\": \"{version}\""),
        )),
        _ => None,
    }
}

fn load(raws: &[String]) -> Option<Vec<LoadedPlugin>> {
    raws.iter()
        .enumerate()
        .map(|(i, raw)| plugin_from_manifest(&format!("p{i}"), raw).ok())
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(500))]

    // Covers: R41
    #[test]
    fn mcp_registration_matches(
        plugins in (plugin(0), plugin(1), plugin(2)),
        enabled_mask in prop::collection::vec(prop::option::of(any::<bool>()), 3),
        existing in existing(),
        restamp in prop::sample::select(vec![None, Some("0.1.0"), Some(STAMP_VERSION), Some("999.0.0")]),
        floor in prop::sample::select(vec![None, Some("0.1.0"), Some("999.0.0")]),
        force in prop::bool::weighted(0.2),
        lang in prop::sample::select(vec!["es", "en"]),
    ) {
        let plugins = [plugins.0, plugins.1, plugins.2];
        let (mut enabled, mut disabled) = (Vec::new(), Vec::new());
        for (raw, state) in plugins.iter().zip(&enabled_mask) {
            match state {
                Some(true) => enabled.push(raw.clone()),
                Some(false) => disabled.push(raw.clone()),
                None => {}
            }
        }
        let (Some(enabled_rust), Some(disabled_rust)) = (load(&enabled), load(&disabled)) else {
            return Err(TestCaseError::fail("synthetic manifest rejected"));
        };
        let existing = match restamp {
            Some(version) => previous(&enabled_rust, version).or(existing),
            None => existing,
        };
        let root = ROOT.join("repo");
        let _ = std::fs::remove_dir_all(&root);
        let _ = std::fs::create_dir_all(&root);
        if let Some(text) = &existing {
            let _ = std::fs::write(root.join(".mcp.json"), text);
        }
        let ts = NODE
            .ask(&json!({
                "root": root.to_string_lossy(),
                "enabled": enabled,
                "disabled": disabled,
                "lang": lang,
                "floor": floor,
                "force": force,
            }))
            .map_err(TestCaseError::fail)?;
        let lang = Lang::resolve(Some(lang));
        let rust = match plan_mcp_registration(&Disk(&root), &enabled_rust, &disabled_rust, floor, force, lang) {
            Ok(SettingsPlan::Noop) => json!(["noop"]),
            Ok(SettingsPlan::Skip { reason, status }) => json!(["skip", reason, status.map(|s| s.as_str())]),
            Ok(SettingsPlan::Write { content, status }) => json!(["write", content, status.as_str()]),
            Err(_) => {
                // Only an unparseable file delegates without `force`.
                let unparseable = existing.as_deref().is_some_and(|t| js_json::parse(t).is_none());
                prop_assert!(unparseable && !force && ts[0] == "skip", "rust declined, ts {ts}");
                return Ok(());
            }
        };
        prop_assert!(ts == rust, "ts {ts}\nrust {rust}\nexisting {existing:?}\nenabled {enabled:?}\ndisabled {disabled:?}");
    }
}

#[test]
fn ts_bridge_answers() -> Result<(), String> {
    let ts: Value = NODE.ask(&json!({
        "root": ROOT.join("none").to_string_lossy(),
        "enabled": [],
        "disabled": [],
        "lang": "en",
        "floor": null,
        "force": false,
    }))?;
    if ts == json!(["noop"]) {
        Ok(())
    } else {
        Err(ts.to_string())
    }
}
