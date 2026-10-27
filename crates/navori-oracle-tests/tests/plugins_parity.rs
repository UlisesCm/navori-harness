//! `navori_core::render::plugins` against the real TS (spec 0058 T14): the retired-plugin
//! registries, every bundled manifest and `loadEnabledPlugins`/`loadDisabledPlugins` over
//! generated configs.

mod support;

use navori_core::js_json;
use navori_core::render::plugins::{
    KNOWN_PLUGINS, LoadedPlugin, PluginLoadError, PluginsLoadResult, RETIRED_PLUGIN_BLOCKS,
    RETIRED_PLUGIN_SUB_BLOCKS, RETIRED_PLUGINS, bundled_plugin_ids, load_disabled_plugins,
    load_enabled_plugins, load_plugin, plugin_from_manifest, retired_plugin,
    retired_plugin_for_script, retired_script_basenames, with_native_hook,
};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const p = await import({:?});\nconst b = await import({:?});\nconst path = await import('node:path');\n\
         const fsMod = (await import('node:fs')).default;\nconst {{ syncBuiltinESMExports }} = await import('node:module');\n\
         const rel = (plugin, abs) => path.relative(plugin.packageRoot, abs).split(path.sep).join('/');\n\
         const ser = (plugin) => ({{\n\
           manifest: JSON.stringify(plugin.manifest),\n\
           nativeHookOmitted: plugin.nativeHookOmitted === true,\n\
           managed: plugin.managedAssets.map((a) => [a.id, rel(plugin, a.absPath)]),\n\
           scripts: plugin.scriptAssets.map((s) => [rel(plugin, s.src), s.dest, s.exec]),\n\
           hookExtensions: (plugin.hookExtensionAssets ?? []).map((h) => [h.id, h.target, rel(plugin, h.absPath)]),\n\
           skills: plugin.skillAssets.map((s) => [s.id, rel(plugin, s.absPath), s.recommendedAgent ?? null, s.injectInto ?? null, s.mcpTools ?? null]),\n\
         }});",
        cli_module("lib/config/plugins.ts"),
        cli_module("lib/render/bundled-assets.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "if (request.op === 'registry') return [\n\
       Object.entries(p.RETIRED_PLUGINS).map(([id, e]) => [id, e.removedIn, e.blockIds, e.assets, e.deleteForeign === true]),\n\
       Object.entries(p.RETIRED_PLUGIN_BLOCKS).map(([id, e]) => [id, e.retiredIn, e.blockIds]),\n\
       Object.entries(p.RETIRED_PLUGIN_SUB_BLOCKS).map(([id, e]) => [id, e.retiredIn, e.entries.map((x) => [x.id, x.targetPath])]),\n\
       Object.keys(p.KNOWN_PLUGINS),\n\
       [...p.retiredScriptBasenames()],\n\
       b.listBundledPluginIds().sort(),\n\
     ];\n\
     if (request.op === 'script') return request.names.map((n) => p.retiredPluginForScript(n)?.id ?? null);\n\
     if (request.op === 'retired') return request.ids.map((id) => p.isRetiredPlugin(id));\n\
     if (request.op === 'synthetic') {\n\
       // The real loadPlugin reads this text as acli's plugin.json: ESM fs imports follow the patch.\n\
       const target = b.bundledPluginManifestPath('acli');\n\
       const original = fsMod.readFileSync;\n\
       fsMod.readFileSync = function (file, ...rest) { return file === target ? request.text : original.call(this, file, ...rest); };\n\
       syncBuiltinESMExports();\n\
       try {\n\
         let plugin;\n\
         try { plugin = p.loadPlugin('acli'); }\n\
         catch (e) { if (e instanceof p.PluginManifestError) return { rejected: e.message.includes('outside the package root') ? 'escape' : 'schema' }; throw e; }\n\
         const set = p.loadEnabledPlugins({ acli: JSON.parse(request.settings) });\n\
         return { plugin: ser(plugin), native: ser(set.loaded[0]) };\n\
       } finally { fsMod.readFileSync = original; syncBuiltinESMExports(); }\n\
     }\n\
     if (request.op === 'load') {\n\
       try { return ser(p.loadPlugin(request.id)); }\n\
       catch (e) {\n\
         if (e instanceof p.PluginNotFoundError) return { notFound: true };\n\
         if (e instanceof p.PluginManifestError) return { delegate: true };\n\
         throw e;\n\
       }\n\
     }\n\
     const config = JSON.parse(request.plugins);\n\
     const r = request.enabled ? p.loadEnabledPlugins(config) : p.loadDisabledPlugins(config);\n\
     if (r.missing.some((m) => m.reason !== 'unknown plugin id')) return { delegate: true };\n\
     return { loaded: r.loaded.map(ser), missing: r.missing.map((m) => m.id), retired: r.retired };",
);

fn ser(plugin: &LoadedPlugin) -> Value {
    // Text, not `Value`: serde_json sorts object keys, and zod's key order is part of the port.
    json!({
        "manifest": plugin.manifest.stringify(None),
        "nativeHookOmitted": plugin.native_hook_omitted,
        "managed": plugin.managed_assets.iter().map(|a| json!([a.id, a.path])).collect::<Vec<_>>(),
        "scripts": plugin.script_assets.iter().map(|s| json!([s.src, s.dest, s.exec])).collect::<Vec<_>>(),
        "hookExtensions": plugin
            .hook_extension_assets
            .iter()
            .map(|h| json!([h.id, h.target, h.path]))
            .collect::<Vec<_>>(),
        "skills": plugin
            .skill_assets
            .iter()
            .map(|s| json!([s.id, s.path, s.recommended_agent, s.inject_into, s.mcp_tools]))
            .collect::<Vec<_>>(),
    })
}

fn rust_load(id: &str) -> Value {
    match load_plugin(id) {
        Ok(plugin) => ser(&plugin),
        Err(PluginLoadError::NotFound) => json!({ "notFound": true }),
        Err(PluginLoadError::Delegate) => json!({ "delegate": true }),
    }
}

fn rust_set(result: Result<PluginsLoadResult, PluginLoadError>) -> Value {
    match result {
        Err(_) => json!({ "delegate": true }),
        Ok(result) => json!({
            "loaded": result.loaded.iter().map(ser).collect::<Vec<_>>(),
            "missing": result.missing,
            "retired": result.retired,
        }),
    }
}

const ODD_IDS: &[&str] = &[
    "unknown-plugin",
    "",
    "Engram",
    "constructor",
    "toString",
    "__proto__",
    "hasOwnProperty",
];

// Covers: R41
#[test]
fn registries_match() -> Result<(), String> {
    let ts = NODE.ask(&json!({ "op": "registry" }))?;
    let retired: Vec<Value> = RETIRED_PLUGINS
        .iter()
        .map(|(id, e)| json!([id, e.removed_in, e.block_ids, e.assets, e.delete_foreign]))
        .collect();
    let sub_blocks: Vec<Value> = RETIRED_PLUGIN_SUB_BLOCKS
        .iter()
        .map(|(id, retired_in, entries)| json!([id, retired_in, entries]))
        .collect();
    let rust = json!([
        retired,
        RETIRED_PLUGIN_BLOCKS,
        sub_blocks,
        KNOWN_PLUGINS,
        retired_script_basenames(),
        bundled_plugin_ids(),
    ]);
    if ts != rust {
        return Err(format!(
            "plugin registries drifted; update render/plugins.rs\nts   {ts}\nrust {rust}"
        ));
    }

    let mut names: Vec<&str> = retired_script_basenames();
    names.extend(["check-other.sh", "", "scripts", ".claude"]);
    let ts = NODE.ask(&json!({ "op": "script", "names": names }))?;
    let rust: Vec<Option<&str>> = names
        .iter()
        .map(|name| retired_plugin_for_script(name).map(|(id, _)| id))
        .collect();
    if ts != json!(rust) {
        return Err(format!("retiredPluginForScript:\nts   {ts}\nrust {rust:?}"));
    }

    let mut ids: Vec<&str> = RETIRED_PLUGINS.iter().map(|(id, _)| *id).collect();
    ids.extend(KNOWN_PLUGINS);
    ids.extend(ODD_IDS);
    let ts = NODE.ask(&json!({ "op": "retired", "ids": ids }))?;
    let rust: Vec<bool> = ids.iter().map(|id| retired_plugin(id).is_some()).collect();
    if ts != json!(rust) {
        return Err(format!("isRetiredPlugin:\nts   {ts}\nrust {rust:?}"));
    }
    Ok(())
}

// Covers: R41
#[test]
fn every_bundled_plugin_loads_alike() -> Result<(), String> {
    let bundled = bundled_plugin_ids();
    if bundled.len() < 5 {
        return Err(format!("only {} bundled plugins", bundled.len()));
    }
    let retired = RETIRED_PLUGINS.iter().map(|(id, _)| *id);
    for id in bundled
        .iter()
        .map(String::as_str)
        .chain(retired)
        .chain(ODD_IDS.iter().copied())
    {
        let ts = NODE.ask(&json!({ "op": "load", "id": id }))?;
        let rust = rust_load(id);
        if ts != rust {
            return Err(format!("{id}:\nts   {ts}\nrust {rust}"));
        }
    }
    Ok(())
}

fn plugins_config() -> BoxedStrategy<String> {
    let mut ids: Vec<String> = bundled_plugin_ids();
    ids.extend(
        [
            "cognitive",
            "jscpd",
            "unknown-plugin",
            "constructor",
            "7",
            "3",
        ]
        .map(String::from),
    );
    let entry = (
        prop::option::weighted(0.9, any::<bool>()),
        prop::option::of(any::<bool>()),
    );
    prop::sample::subsequence(ids.clone(), 0..=ids.len())
        .prop_shuffle()
        .prop_flat_map(move |chosen| {
            let n = chosen.len();
            (Just(chosen), prop::collection::vec(entry.clone(), n))
        })
        .prop_map(|(chosen, entries)| {
            let fields: Vec<String> = chosen
                .iter()
                .zip(entries)
                .map(|(id, (enabled, native))| {
                    let mut settings = serde_json::Map::new();
                    if let Some(enabled) = enabled {
                        settings.insert("enabled".into(), json!(enabled));
                    }
                    if let Some(native) = native {
                        settings.insert("nativeHook".into(), json!(native));
                    }
                    format!("{}:{}", json!(id), Value::Object(settings))
                })
                .collect();
            format!("{{{}}}", fields.join(","))
        })
        .boxed()
}

const FILES: &[&str] = &[
    "managed/m.md",
    "./m.md",
    "a/../m.md",
    "a//b.md",
    "../m.md",
    "a/../../m.md",
    "/etc/m.md",
    ".",
];

fn pick(options: &[&'static str]) -> BoxedStrategy<String> {
    prop::sample::select(options.to_vec())
        .prop_map(String::from)
        .boxed()
}

/// `"key":value` when present; values are JSON text so nested key order survives.
fn field(key: &'static str, value: BoxedStrategy<String>) -> BoxedStrategy<Option<String>> {
    prop::option::of(value.prop_map(move |v| format!("{}:{v}", json!(key)))).boxed()
}

/// A required `"key":value`: absent required keys only feed the no-claim schema bucket.
fn need(key: &'static str, value: BoxedStrategy<String>) -> BoxedStrategy<Option<String>> {
    value
        .prop_map(move |v| Some(format!("{}:{v}", json!(key))))
        .boxed()
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

fn list(item: BoxedStrategy<String>) -> BoxedStrategy<String> {
    prop::collection::vec(item, 0..3)
        .prop_map(|items| format!("[{}]", items.join(",")))
        .boxed()
}

/// `managed[].file` is only `min(1)`: escapes reach the containment check.
fn file_text() -> BoxedStrategy<String> {
    pick(FILES).prop_map(|f| json!(f).to_string()).boxed()
}

/// `safeRelPath` fields: what the schema accepts, so the asset paths are compared.
fn safe_file_text() -> BoxedStrategy<String> {
    pick(&["managed/m.md", "./m.md", "a//b.md", "."])
        .prop_map(|f| json!(f).to_string())
        .boxed()
}

fn synthetic_manifest() -> BoxedStrategy<String> {
    let text = |v: &'static str| Just(json!(v).to_string()).boxed();
    let raw = |v: &'static str| Just(v.to_owned()).boxed();
    let managed = list(object(vec![
        field("recommendedAgent", text("reviewer")),
        need("file", file_text()),
        field("zzz", raw("1")),
        need("id", text("m")),
    ]));
    let scripts = list(object(vec![
        field("exec", any::<bool>().prop_map(|b| b.to_string()).boxed()),
        need("dest", text("x.sh")),
        need("src", safe_file_text()),
    ]));
    let hook_extensions = list(object(vec![
        need("file", safe_file_text()),
        need("target", text(".claude/hooks/a.sh")),
        need("id", text("h")),
    ]));
    let skills = list(object(vec![
        field("mcpTools", raw(r#"["b","a"]"#)),
        field("injectInto", text(".claude/agents/reviewer.md")),
        field("recommendedAgent", text("implementer")),
        need("file", safe_file_text()),
        need("id", text("s")),
    ]));
    let hooks = list(object(vec![
        field("matcher", text("Bash")),
        need("command", text("x")),
        need("event", text("PreToolUse")),
    ]));
    let mcp = object(vec![
        field("env", raw(r#"{"Z":"1","A":"2"}"#)),
        field("args", raw(r#"["--x"]"#)),
        need("command", text("c")),
    ]);
    let tool = object(vec![
        field(
            "latestRelease",
            object(vec![
                field("notify", text("patch")),
                need("id", text("pkg")),
                need("source", text("npm")),
            ]),
        ),
        field("checkBinary", text("t")),
        need("name", text("t")),
    ]);
    let prompts = list(object(vec![
        field("optional", raw("true")),
        field(
            "options",
            raw(r#"[{"label":{"en":"L","x":1,"es":"E"},"value":"v"}]"#),
        ),
        need("type", text("string")),
        need("question", raw(r#"{"x":0,"en":"q","es":"p"}"#)),
        need("key", text("a.b")),
    ]));
    let fields = vec![
        need("id", text("acli")),
        need("name", text("A")),
        need("description", text("d")),
        need("version", text("1.0.0")),
        field("managed", managed),
        field("externalTool", tool),
        field("mcpServer", mcp),
        field(
            "settingsFragment",
            Just(r#"{"b":1,"a":{"c":2},"10":3}"#.to_owned()).boxed(),
        ),
        field("hooks", hooks),
        field("scripts", scripts),
        field("hookExtensions", hook_extensions),
        field("skills", skills),
        field("prompts", prompts),
        field("invariants", Just(r#"["keep"]"#.to_owned()).boxed()),
        field("zzz", Just("1".to_owned()).boxed()),
    ];
    fields
        .prop_map(|fields| fields.into_iter().flatten().collect::<Vec<_>>())
        .prop_shuffle()
        .prop_map(|fields| format!("{{{}}}", fields.join(",")))
        .boxed()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    // Covers: R41
    #[test]
    fn synthetic_manifests_load_alike(
        text in synthetic_manifest(),
        native in prop::option::of(any::<bool>()),
    ) {
        let settings = match native {
            Some(native) => format!(r#"{{"enabled":true,"nativeHook":{native}}}"#),
            None => r#"{"enabled":true}"#.to_owned(),
        };
        let ts = NODE
            .ask(&json!({ "op": "synthetic", "text": text, "settings": settings }))
            .map_err(TestCaseError::fail)?;
        let rust = plugin_from_manifest("acli", &text);
        match ts.get("rejected").and_then(Value::as_str) {
            // Leaf validation is the build-time oracle's job: no claim on a schema rejection.
            Some("schema") => {}
            Some(_) => prop_assert_eq!(rust, Err(PluginLoadError::Delegate), "{}", text),
            None => {
                let plugin = rust.map_err(|e| TestCaseError::fail(format!("{e:?}: {text}")))?;
                let Some(js_json::JsValue::Object(settings)) = js_json::parse(&settings) else {
                    return Err(TestCaseError::fail("settings"));
                };
                let native = with_native_hook(plugin.clone(), &settings);
                prop_assert_eq!(&ts["plugin"], &ser(&plugin), "{}", text);
                prop_assert_eq!(&ts["native"], &ser(&native), "{}", text);
            }
        }
    }

    // Covers: R41
    #[test]
    fn enabled_and_disabled_sets_match(text in plugins_config(), enabled in any::<bool>()) {
        let ts = NODE
            .ask(&json!({ "op": "set", "plugins": text, "enabled": enabled }))
            .map_err(TestCaseError::fail)?;
        let config = js_json::parse(&text);
        let rust = rust_set(if enabled {
            load_enabled_plugins(config.as_ref())
        } else {
            load_disabled_plugins(config.as_ref())
        });
        prop_assert_eq!(ts, rust, "{}", text);
    }
}
