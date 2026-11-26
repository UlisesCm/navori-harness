//! `navori_core::render::{pi_roles, pi_extension, pi_owned}` against the real `knowledge-tools.ts`,
//! `extension-source.ts` and `owned-file.ts` (spec 0059 T20, D29, D38): knowledge grants per
//! plugin set, the extension rendered from the derived asset, and every Pi resource's
//! serialization and ownership verdict, also after a tampering edit.

mod support;

use navori_core::render::pi_extension::render_pi_extension;
use navori_core::render::pi_owned::{
    PiControls, PiManifest, PiManifestHook, owns_pi_agent, owns_pi_manifest, owns_pi_source,
    pi_manifest_schema_version, serialize_pi_agent, serialize_pi_manifest,
};
use navori_core::render::pi_roles::{
    PI_PARENT_ROLES, PI_ROLE_NAMES, pi_knowledge_grants, pi_role_tools,
};
use navori_core::render::plugins::load_enabled_plugins;
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;
use serde_json::{Value, json};
use support::{Shared, cli_module};

fn prelude() -> String {
    format!(
        "const k = await import({:?}); const x = await import({:?}); const o = await import({:?}); const p = await import({:?});",
        cli_module("engines/pi/knowledge-tools.ts"),
        cli_module("engines/pi/extension-source.ts"),
        cli_module("engines/pi/owned-file.ts"),
        cli_module("lib/config/plugins.ts"),
    )
}

static NODE: Shared = Shared::new(
    prelude,
    "switch (request.op) {\n\
       case 'grants': return k.piKnowledgeGrants(p.loadEnabledPlugins(request.plugins).loaded);\n\
       case 'roleTools': return request.roles.map((role) => k.piRoleTools(role, request.grants));\n\
       case 'extension': return o.serializePiSource(x.renderPiExtensionSource(request.ids, request.grants));\n\
       case 'agent': { const a = o.serializePiAgent(request.agent); return [a, o.ownsPiAgent(a, request.agent.name), o.ownsPiAgent(request.tampered ?? a, request.agent.name)]; }\n\
       case 'manifest': { const c = request.manifest.controls;\n\
         if (c) request.manifest.controls = { planTiers: c.planTiers, masterPlan: c.masterPlan, scribeOwnsMarkdown: c.scribeOwnsMarkdown, ...(c.auditMode ? { auditMode: c.auditMode } : {}), ...(c.sessionState === false ? { sessionState: false } : {}) };\n\
         const m = o.serializePiManifest(request.manifest); return [m, o.ownsPiManifest(m), o.piManifestSchemaVersion(m)]; }\n\
       case 'owns': return [o.ownsPiManifest(request.text), o.piManifestSchemaVersion(request.text), o.ownsPiSource(request.text)];\n\
     }",
);

/// Every role Pi renders as `.pi/agents/<role>.md`: the child roles, then the parent ones.
fn rendered_roles() -> Vec<&'static str> {
    PI_ROLE_NAMES
        .iter()
        .chain(PI_PARENT_ROLES.iter())
        .copied()
        .collect()
}

fn fail(error: impl ToString) -> TestCaseError {
    TestCaseError::fail(error.to_string())
}

fn plugins() -> impl Strategy<Value = Value> {
    prop::collection::vec(0u8..3, 4).prop_map(|states| {
        let mut out = serde_json::Map::new();
        for (id, s) in ["engram", "codegraph", "gh", "tgrep"].iter().zip(states) {
            if s > 0 {
                out.insert((*id).to_owned(), json!({ "enabled": s == 1 }));
            }
        }
        Value::Object(out)
    })
}

fn grants_json(grants: &[(String, Vec<String>)]) -> Value {
    Value::Object(
        grants
            .iter()
            .map(|(role, names)| (role.clone(), json!(names)))
            .collect(),
    )
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(40))]

    // Covers: R67
    #[test]
    fn knowledge_grants_and_extension_match_ts(plugins in plugins(), ids in prop::collection::vec(prop::sample::select(vec!["engram", "codegraph", "x-y"]), 0..3)) {
        let js = navori_core::js_json::parse(&plugins.to_string()).ok_or_else(|| fail("json"))?;
        let loaded = load_enabled_plugins(Some(&js)).map_err(|_| fail("plugins"))?;
        let grants = pi_knowledge_grants(&loaded.loaded).ok_or_else(|| fail("grants"))?;
        let reply = NODE.ask(&json!({ "op": "grants", "plugins": plugins })).map_err(TestCaseError::fail)?;
        prop_assert_eq!(&reply, &grants_json(&grants));
        // `piRoleTools` for every rendered role: a child gets its base tools plus its grants, a
        // parent role (`PI_PARENT_ROLES`) gets `tools: []` whatever the grants say. Real grants
        // never name a parent, so each one also gets a synthetic grant here: only the parent
        // early return keeps it out.
        let roles = rendered_roles();
        let mut with_parents = grants.clone();
        with_parents.extend(PI_PARENT_ROLES.iter().map(|role| ((*role).to_owned(), vec!["navori_mem_search".to_owned()])));
        let tools: Vec<Vec<String>> = roles.iter().map(|role| pi_role_tools(role, &with_parents)).collect();
        let reply = NODE.ask(&json!({ "op": "roleTools", "roles": roles, "grants": grants_json(&with_parents) })).map_err(TestCaseError::fail)?;
        prop_assert_eq!(reply, json!(tools));
        // The extension itself is compared against `dist` by the oracle's Pi cases: rendered from
        // the sources, `serializeAnonymousFunction` gives other bytes than the bundle (D29).
        let rust = render_pi_extension(&ids.into_iter().map(str::to_owned).collect::<Vec<_>>(), &grants);
        prop_assert!(owns_pi_source(&rust));
    }
}

fn text_piece() -> impl Strategy<Value = String> {
    prop::collection::vec(
        prop_oneof![
            3 => "[a-z ]{0,6}",
            1 => prop::sample::select(vec!["\n", "---", "\"", "\\", "é", "\u{2028}", "  ", "\n---\n"]).prop_map(str::to_owned),
        ],
        0..6,
    )
    .prop_map(|p| p.concat())
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(400))]

    // Covers: R68
    #[test]
    fn pi_agent_matches_owned_file_ts(
        role in prop::sample::select(rendered_roles()),
        description in text_piece(), instructions in text_piece(),
        model in prop::option::of(prop::sample::select(vec!["anthropic/claude", "", "x/y:thinking"])),
        tools in prop::collection::vec(prop::sample::select(vec!["read", "bash", "navori_mem_search"]), 0..4),
        tamper in prop::option::of(0usize..400),
    ) {
        let tools: Vec<String> = tools.into_iter().map(str::to_owned).collect();
        let rust = serialize_pi_agent(role, &description, model, &tools, &instructions);
        let tampered = tamper.map(|at| {
            let at = rust.char_indices().map(|(i, _)| i).nth(at % rust.chars().count()).unwrap_or(0);
            format!("{}X{}", &rust[..at], &rust[at..])
        });
        let mut agent = json!({ "name": role, "description": description, "tools": tools, "instructions": instructions });
        if let Some(model) = model { agent["model"] = json!(model); }
        let reply = NODE.ask(&json!({ "op": "agent", "agent": agent, "tampered": tampered })).map_err(TestCaseError::fail)?;
        let probe = tampered.as_deref().unwrap_or(&rust);
        prop_assert_eq!(reply, json!([rust, owns_pi_agent(&rust, role), owns_pi_agent(probe, role)]));
    }
}

fn manifest() -> impl Strategy<Value = PiManifest> {
    let hook = (
        prop::sample::select(vec!["guard-destructive", "plan-gate", "x1"]),
        prop::sample::select(vec!["tool_call", "tool_result", "session_shutdown"]),
        prop::option::of(prop::collection::vec(
            prop::sample::select(vec!["bash", "write"]),
            0..2,
        )),
        prop::sample::select(vec!["parent", "child", "all"]),
        prop::sample::select(vec!["enforced", "advisory", "lifecycle"]),
        any::<bool>(),
        prop::sample::select(vec![1000.0, 600_000.0]),
        any::<bool>(),
        any::<bool>(),
    )
        .prop_map(
            |(script, on, tools, scope, class, interactive, timeout_ms, skip, script_path)| {
                PiManifestHook {
                    script: script.to_owned(),
                    path: if script_path {
                        ".pi/navori/scripts/run.sh".to_owned()
                    } else {
                        format!(".pi/navori/hooks/{script}.sh")
                    },
                    on: on.to_owned(),
                    tools: tools.map(|t| t.into_iter().map(str::to_owned).collect()),
                    scope: scope.to_owned(),
                    class: class.to_owned(),
                    interactive,
                    timeout_ms,
                    skip_on_error: skip,
                }
            },
        );
    (
        prop::sample::select(vec![1u8, 2]),
        prop::collection::vec(
            prop::sample::select(vec!["scout", "reviewer", "implementer", "Zed"]),
            0..4,
        ),
        prop::option::of((
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
            any::<bool>(),
        )),
        prop::collection::vec(hook, 0..3),
        prop::collection::vec(
            prop::sample::select(vec![
                ".pi/navori.json",
                ".pi/agents/scout.md",
                ".pi/extensions/navori.ts",
            ]),
            0..3,
        ),
        prop::collection::vec(
            prop::sample::select(vec!["Bash(rm *)", "Bash(git push --force)"]),
            0..2,
        ),
    )
        .prop_map(
            |(version, agents, controls, hooks, owned, rules)| PiManifest {
                schema_version: version,
                agents: agents.into_iter().map(str::to_owned).collect(),
                controls: controls.map(
                    |(
                        plan_tiers,
                        master_plan,
                        scribe_owns_markdown,
                        audit_always,
                        session_state_off,
                    )| {
                        PiControls {
                            plan_tiers,
                            master_plan,
                            scribe_owns_markdown,
                            audit_always,
                            session_state_off,
                        }
                    },
                ),
                hooks: if version == 2 { hooks } else { Vec::new() },
                owned_paths: if version == 2 {
                    owned.into_iter().map(str::to_owned).collect()
                } else {
                    Vec::new()
                },
                ask: if version == 2 {
                    rules.iter().map(|r| (*r).to_owned()).collect()
                } else {
                    Vec::new()
                },
                deny: if version == 2 {
                    rules.into_iter().rev().map(str::to_owned).collect()
                } else {
                    Vec::new()
                },
            },
        )
}

fn manifest_json(m: &PiManifest) -> Value {
    let mut out = json!({ "schemaVersion": m.schema_version, "agents": m.agents });
    if let Some(c) = m.controls {
        let mut controls = json!({ "planTiers": c.plan_tiers, "masterPlan": c.master_plan, "scribeOwnsMarkdown": c.scribe_owns_markdown });
        if c.audit_always {
            controls["auditMode"] = json!("always");
        }
        if c.session_state_off {
            controls["sessionState"] = json!(false);
        }
        out["controls"] = controls;
    }
    if m.schema_version == 2 {
        out["hooks"] = Value::Array(m.hooks.iter().map(|h| {
            let mut hook = json!({ "script": h.script, "path": h.path, "on": h.on, "scope": h.scope, "class": h.class, "interactive": h.interactive, "timeoutMs": h.timeout_ms });
            if let Some(tools) = &h.tools { hook["tools"] = json!(tools); }
            if h.skip_on_error { hook["skipOnError"] = json!(true); }
            hook
        }).collect());
        out["ownedPaths"] = json!(m.owned_paths);
        out["permissionRules"] = json!({ "ask": m.ask, "deny": m.deny });
    }
    out
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(300))]

    // Covers: R68
    #[test]
    fn pi_manifest_matches_owned_file_ts(m in manifest(), tamper in prop::option::of((0usize..2000, prop::sample::select(vec!["X", "3", "\"", " "])))) {
        let rust = serialize_pi_manifest(&m);
        let reply = NODE.ask(&json!({ "op": "manifest", "manifest": manifest_json(&m) })).map_err(TestCaseError::fail)?;
        prop_assert_eq!(&reply[0], &json!(rust));
        prop_assert_eq!(&reply[1], &json!(owns_pi_manifest(&rust)));
        prop_assert_eq!(reply[2].as_f64(), pi_manifest_schema_version(&rust));
        if let Some((at, piece)) = tamper {
            let at = rust.char_indices().map(|(i, _)| i).nth(at % rust.chars().count()).unwrap_or(0);
            let edited = format!("{}{piece}{}", &rust[..at], &rust[at..]);
            let reply = NODE.ask(&json!({ "op": "owns", "text": edited })).map_err(TestCaseError::fail)?;
            prop_assert_eq!(&reply[0], &json!(owns_pi_manifest(&edited)));
            prop_assert_eq!(reply[1].as_f64(), pi_manifest_schema_version(&edited));
        }
    }
}

// Covers: R67, R68
#[test]
fn pi_source_ownership_matches_ts() -> Result<(), String> {
    let source = render_pi_extension(&[], &Vec::new());
    for text in [
        source.clone(),
        source.replacen("const ", "const  ", 1),
        source.replacen("hash=\"", "hash=\"0", 1),
        format!("{source}let x: = ;\n"),
    ] {
        let reply = NODE.ask(&json!({ "op": "owns", "text": text }))?;
        if reply[2] != json!(owns_pi_source(&text)) {
            return Err(format!("ownsPiSource differs: ts {}", reply[2]));
        }
    }
    Ok(())
}
