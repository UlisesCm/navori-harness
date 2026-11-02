//! `navori_core::render::codex_trust` against the real `readCodexTrustState` (spec 0059 T19,
//! D37): over generated configs and machine-global `config.toml` files (absent, broken, project
//! trusted or not, each hook's stored hash right, wrong, non-string or missing), the trust state
//! must match, keys and expected hashes included.

mod support;

use std::path::PathBuf;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicUsize, Ordering};

use navori_core::js_json;
use navori_core::render::codex_hooks::{codex_hook_command, codex_hook_hash, resolve_codex_hooks};
use navori_core::render::codex_trust::read_codex_trust_state;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const t = await import({:?}); const h = await import({:?});",
        cli_module("lib/codex/trust.ts"),
        cli_module("engines/codex/hook-registrations.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "const hooks = h.resolveCodexHooks(request.config, []);\n\
     const s = t.readCodexTrustState(request.root, request.toml, hooks, { codexHomeConfigPath: request.home, wsSubpath: request.ws });\n\
     return { projectTrusted: s.projectTrusted, hooks: s.hooks.map((x) => [x.script, x.event, x.matcher ?? null, x.key, x.expectedHash, x.status]) };",
);

static ROOT: LazyLock<PathBuf> = LazyLock::new(|| {
    std::env::temp_dir().join(format!("navori-codex-trust-{}", std::process::id()))
});
static CASE: AtomicUsize = AtomicUsize::new(0);

fn flag() -> impl Strategy<Value = Option<bool>> {
    prop::option::of(any::<bool>())
}

fn config() -> impl Strategy<Value = Value> {
    (flag(), flag(), flag(), flag()).prop_map(|(fast, tiers, master, codex)| {
        let mut harness = serde_json::Map::new();
        for (key, value) in [
            ("planTiers", tiers),
            ("masterPlan", master),
            ("codexIntegration", codex),
        ] {
            if let Some(value) = value {
                harness.insert(key.to_owned(), json!(value));
            }
        }
        let mut config = json!({ "harness": harness });
        if fast == Some(true) {
            config["qualityGate"] = json!({ "fast": "bun run check:fast" });
        }
        config
    })
}

/// What the home config stores for one hook.
#[derive(Debug, Clone, Copy)]
enum Stored {
    Missing,
    Right,
    Wrong,
    Number,
}

fn stored() -> impl Strategy<Value = Stored> {
    prop::sample::select(vec![
        Stored::Missing,
        Stored::Right,
        Stored::Wrong,
        Stored::Number,
    ])
}

/// Escapes a string as a TOML basic string.
fn quoted(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    // Covers: R66
    #[test]
    fn trust_state_matches_read_codex_trust_state(
        config in config(),
        ws in prop::sample::select(vec!["", "apps/web", "a \"b\""]),
        home_kind in prop::sample::select(vec!["absent", "broken", "file"]),
        trusted in prop::option::of(prop::sample::select(vec!["trusted", "untrusted"])),
        stores in prop::collection::vec(stored(), 32),
    ) {
        let dir = ROOT.join(CASE.fetch_add(1, Ordering::Relaxed).to_string());
        std::fs::create_dir_all(&dir).map_err(|e| TestCaseError::fail(e.to_string()))?;
        let root = dir.join("repo").display().to_string();
        let toml_path = dir.join("repo/.codex/config.toml").display().to_string();
        let home = dir.join("config.toml");
        let js = js_json::parse(&config.to_string()).ok_or_else(|| TestCaseError::fail("json"))?;
        let hooks = resolve_codex_hooks(&js, &[]).ok_or_else(|| TestCaseError::fail("hooks"))?;
        match home_kind {
            "broken" => std::fs::write(&home, "= broken").map_err(|e| TestCaseError::fail(e.to_string()))?,
            "file" => {
                let mut text = String::new();
                if let Some(level) = trusted {
                    text.push_str(&format!("[projects.{}]\ntrust_level = \"{level}\"\n\n", quoted(&root)));
                }
                let mut groups: Vec<(String, usize)> = Vec::new();
                for (hook, store) in hooks.iter().zip(stores.iter().cycle()) {
                    let group = match groups.iter_mut().find(|(e, _)| *e == hook.event) {
                        Some((_, n)) => { *n += 1; *n - 1 }
                        None => { groups.push((hook.event.clone(), 1)); 0 }
                    };
                    let snake = hook.event.chars().fold(String::new(), |mut out, ch| {
                        if ch.is_ascii_uppercase() && !out.is_empty() { out.push('_'); }
                        out.push(ch.to_ascii_lowercase());
                        out
                    });
                    let key = format!("{toml_path}:{snake}:{group}:0");
                    let hash = codex_hook_hash(hook, &codex_hook_command(hook, ws)).unwrap_or_default();
                    let value = match store {
                        Stored::Missing => continue,
                        Stored::Right => quoted(&hash),
                        Stored::Wrong => quoted("sha256:0"),
                        Stored::Number => "1".to_owned(),
                    };
                    text.push_str(&format!("[hooks.state.{}]\ntrusted_hash = {value}\n\n", quoted(&key)));
                }
                std::fs::write(&home, text).map_err(|e| TestCaseError::fail(e.to_string()))?;
            }
            _ => {}
        }
        let rust = read_codex_trust_state(&root, &toml_path, &hooks, &home, ws)
            .ok_or_else(|| TestCaseError::fail("unexpected delegate"))?;
        let reply = NODE.ask(&json!({
            "config": config, "root": root, "toml": toml_path, "home": home, "ws": ws,
        })).map_err(TestCaseError::fail)?;
        prop_assert_eq!(reply, json!({
            "projectTrusted": rust.project_trusted,
            "hooks": rust.hooks.iter().map(|x| json!([
                x.script, x.event, x.matcher, x.key, x.expected_hash, x.status.as_str(),
            ])).collect::<Vec<_>>(),
        }));
    }
}
