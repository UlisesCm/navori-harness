//! `preparePiEngine` and its `finalize` (`engines/pi/index.ts`, spec 0059 T20) for a root
//! render: the shared hook copies and plugin scripts under `.pi/navori/`, the skills when Codex
//! does not own `.agents/skills`, and the whole-file resources (manifest, extension, one agent
//! per admitted role) under the all-or-nothing rule of `.pi/navori/**`; then the orphan scans,
//! skill sub-blocks, hook extensions and native wrapping.
//!
//! Not modeled, and delegated: workspaces, `project.localSkills`, a plugin that declares
//! `hooks`, a symlinked Pi parent directory, and a vetoed generation beside another engine (its
//! inventory exclusions would reach the shared seal).

use std::collections::BTreeMap;
use std::path::Path;

use crate::STAMP_VERSION;
use crate::config::effective_config;
use crate::js_json::JsValue;
use crate::manifest::Hook;
use crate::markers::{CommentStyle, InjectStatus};
use crate::render::claude_settings::collect_shell_permission_rules;
use crate::render::collect::{
    PendingWrite, RepoView, SkippedFile, collect_managed, read_if_exists,
};
use crate::render::context::Lang;
use crate::render::harness_files::asset_text;
use crate::render::harness_plan::{HarnessPlan, resolve_harness_plan};
use crate::render::interpolate::{InterpolateOptions, interpolate};
use crate::render::managed_file::{RenderManagedFileInput, parse_asset};
use crate::render::native_hook::NativeEngine;
use crate::render::native_hooks::{NativeHooksInput, finalize_native_hooks};
use crate::render::owned_paths::OwnedPaths;
use crate::render::pi_extension::render_pi_extension;
use crate::render::pi_owned::{
    PI_MANIFEST_SCHEMA, PiControls, PiManifest, PiManifestHook, owns_pi_agent, owns_pi_manifest,
    owns_pi_source, pi_manifest_schema_version, serialize_pi_agent, serialize_pi_manifest,
};
use crate::render::pi_projection::{
    PI_MAP_MIGRATION_WARNING, PiDelegate, active_pi_hook_bindings, apply_pi_skill_sub_blocks,
    build_pi_permission_rules, extend_with_orchestrator_blocks, mcp_plugin_ids,
    mcp_role_diagnostics, mcp_server_diagnostics, pi_hook_extension_target, pi_hook_path,
    pi_installed_plugin_scripts, pi_map_migration_pending, prefix_knowledge_names,
    role_plugin_prose,
};
use crate::render::pi_roles::{
    is_pi_child_role, is_pi_rendered_role, pi_knowledge_grants, pi_role_tools,
};
use crate::render::plan::{CORE_SOURCE_ID, condition_orchestration};
use crate::render::plugin_scripts::{
    ScriptEngine, plugin_script_collisions, plugin_script_placements,
};
use crate::render::plugins::{LoadedPlugin, load_disabled_plugins, load_enabled_plugins};
use crate::render::presets::load_preset;
use crate::render::prose::{AGENTS_MD, ProseOptions, ProsePlan, plan_prose_file};
use crate::render::removable::{Authorship, navori_authorship};
use crate::render::retirements::PendingRemoval;
use crate::render::sub_blocks::{
    SubBlockCtx, SubBlocks, apply_hook_extension, remove_hook_extension,
};

const EXTENSION: &str = ".pi/extensions/navori.ts";
const MANIFEST: &str = ".pi/navori.json";

/// What the Pi engine plans.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PiEnginePlan {
    /// Files to write.
    pub pending: Vec<PendingWrite>,
    /// Paths to delete.
    pub removals: Vec<PendingRemoval>,
    /// Files kept.
    pub skipped: Vec<SkippedFile>,
    /// Pi's warnings (the context file's own advisories are dropped, as in the TS).
    pub warnings: Vec<String>,
    /// `AGENTS.md`, when Pi is its only writer (`renderAgentsMdEngine` at commit).
    pub context: Option<ProsePlan>,
}

/// What the Pi engine reads besides the repo.
pub struct PiEngineInput<'a> {
    /// The configured config.
    pub config: &'a JsValue,
    /// The repo root (the render's cwd).
    pub repo_root: &'a Path,
    /// `setMarkerFloorVersion`.
    pub ambient_floor: Option<&'a str>,
    /// The ported hooks (`loadNativeHooks()`).
    pub native_manifest: &'a BTreeMap<String, Hook>,
}

fn get<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(key),
        _ => None,
    }
}

fn text(value: Option<&JsValue>) -> Option<String> {
    match value? {
        JsValue::String(text) => text.to_rust(),
        _ => None,
    }
}

fn flag(config: &JsValue, section: &str, key: &str) -> bool {
    get(config, section).and_then(|s| get(s, key)) == Some(&JsValue::Bool(true))
}

fn engines(config: &JsValue) -> Vec<String> {
    match get(config, "engines") {
        Some(JsValue::Array(items)) => items.iter().filter_map(|i| text(Some(i))).collect(),
        _ => vec!["claude".to_owned()],
    }
}

fn declares_hooks(plugin: &LoadedPlugin) -> bool {
    match get(&plugin.manifest, "hooks") {
        None | Some(JsValue::Undefined) => false,
        Some(JsValue::Array(items)) => !items.is_empty(),
        Some(_) => true,
    }
}

/// One placement of the Pi adapter.
struct Request {
    rel: String,
    asset: String,
    managed_id: String,
    source: String,
    style: CommentStyle,
    extra_vars: Option<BTreeMap<String, String>>,
    chmod_exec: bool,
    guard: bool,
}

/// The shared prepare of `pi_observed` and `plan_pi_engine`.
struct Prepared<'a> {
    cwd: &'a Path,
    config: JsValue,
    lang: Lang,
    floor: Option<&'a str>,
    plan: HarnessPlan,
    enabled: Vec<LoadedPlugin>,
    disabled: Vec<LoadedPlugin>,
    requests: Vec<Request>,
    installed_hooks: Vec<String>,
    installed_scripts: Vec<String>,
    codex: bool,
    warnings: Vec<String>,
    /// `(relPath, managedId-or-empty, authorship)` of every observed destination.
    destinations: Vec<(String, String, Option<Authorship>)>,
    collided: bool,
    resource_skipped: Vec<SkippedFile>,
    pi_pending: Vec<PendingWrite>,
    agent_removals: Vec<PendingRemoval>,
    needs_context: bool,
}

fn authorship_of(view: &dyn RepoView, rel: &str, managed_id: &str) -> Option<Authorship> {
    if !view.lexists(rel) {
        return None;
    }
    Some(navori_authorship(
        view,
        rel,
        (!managed_id.is_empty()).then_some(managed_id),
        true,
    ))
}

/// `/"_navori"\s*:\s*{\s*"id": "pi-runtime"/`, with JS whitespace.
fn claims_pi_manifest(content: &str) -> bool {
    let ws = crate::integrity::is_js_whitespace;
    content.match_indices("\"_navori\"").any(|(at, key)| {
        let rest = content[at + key.len()..].trim_start_matches(ws);
        let Some(rest) = rest.strip_prefix(':') else {
            return false;
        };
        let Some(rest) = rest.trim_start_matches(ws).strip_prefix('{') else {
            return false;
        };
        rest.trim_start_matches(ws)
            .starts_with("\"id\": \"pi-runtime\"")
    })
}

/// `piOwnershipVerdict(cwd, rel)` for a regular resource that did not validate.
fn ownership_verdict(content: &str) -> Authorship {
    if content.contains("navori:managed-file id=\"pi-") || claims_pi_manifest(content) {
        Authorship::Modified
    } else {
        Authorship::Foreign
    }
}

fn skipped(rel: &str, reason: &str, status: InjectStatus) -> SkippedFile {
    SkippedFile {
        rel_path: rel.to_owned(),
        reason: reason.to_owned(),
        status: Some(status),
        resolution: None,
        markerless_resolution: None,
        chmod_exec: false,
    }
}

#[allow(clippy::too_many_lines, reason = "one TS function, step for step")]
fn prepare<'a>(
    view: &'a dyn RepoView,
    input: &PiEngineInput<'a>,
) -> Result<Prepared<'a>, PiDelegate> {
    let config = effective_config(input.config);
    let lang = Lang::resolve(text(get(&config, "language")).as_deref());
    let cwd = input.repo_root;
    let bindings = active_pi_hook_bindings(&config);
    let plugins_config = get(&config, "plugins").cloned();
    let loaded = load_enabled_plugins(plugins_config.as_ref()).map_err(|_| PiDelegate)?;
    let disabled = load_disabled_plugins(plugins_config.as_ref()).map_err(|_| PiDelegate)?;
    if loaded
        .loaded
        .iter()
        .chain(&disabled.loaded)
        .any(declares_hooks)
    {
        return Err(PiDelegate);
    }
    let local_skills = get(&config, "project").and_then(|p| get(p, "localSkills"));
    if matches!(local_skills, Some(JsValue::Array(items)) if !items.is_empty()) {
        return Err(PiDelegate);
    }
    let enabled = loaded.loaded;
    let grants = pi_knowledge_grants(&enabled).ok_or(PiDelegate)?;
    let preset = match text(get(&config, "preset")).as_deref() {
        None | Some("" | "custom") => None,
        Some(id) => load_preset(id, cwd).map_err(|_| PiDelegate)?,
    };
    let plan = resolve_harness_plan(&config, preset.as_ref(), false, Some("pi"));
    let codex = engines(&config).iter().any(|e| e == "codex");
    for rel in [
        ".pi",
        ".pi/extensions",
        ".pi/agents",
        ".pi/navori",
        ".pi/navori/hooks",
    ] {
        if view.symlink(rel) != Some(false) {
            return Err(PiDelegate);
        }
    }

    // Placements, in `retainPlan` order (no agents; skills; hooks; then `extraFiles`).
    let installed_hooks: Vec<String> = bindings.iter().map(|b| pi_hook_path(b.script)).collect();
    let installed_scripts = pi_installed_plugin_scripts(&enabled, &installed_hooks);
    let mut requests = Vec::new();
    if !codex {
        for skill in &plan.skills {
            requests.push(Request {
                rel: format!(".agents/skills/{}/SKILL.md", skill.id),
                asset: asset_text(&skill.asset).map_err(|_| PiDelegate)?,
                managed_id: skill.managed_id.clone(),
                source: CORE_SOURCE_ID.to_owned(),
                style: CommentStyle::Html,
                extra_vars: None,
                chmod_exec: false,
                guard: false,
            });
        }
    }
    let permissions = collect_shell_permission_rules(&config, &enabled).map_err(|_| PiDelegate)?;
    for hook in &plan.hooks {
        if !bindings.iter().any(|b| b.script == hook.id) {
            continue;
        }
        let guard = hook.id == "guard-destructive";
        requests.push(Request {
            rel: pi_hook_path(&hook.id),
            asset: asset_text(&hook.asset).map_err(|_| PiDelegate)?,
            managed_id: hook.managed_id.clone(),
            source: CORE_SOURCE_ID.to_owned(),
            style: CommentStyle::Shell,
            extra_vars: guard.then(|| {
                BTreeMap::from([(
                    "piPermissionRules".to_owned(),
                    build_pi_permission_rules(&permissions.ask, &permissions.deny),
                )])
            }),
            chmod_exec: true,
            guard,
        });
    }
    let collisions = plugin_script_collisions(&enabled);
    for plugin in &enabled {
        for script in plugin_script_placements(plugin, ScriptEngine::Pi) {
            if collisions.contains(&script.script.dest)
                || !installed_scripts.contains(&script.dest_rel_path)
            {
                continue;
            }
            requests.push(Request {
                rel: script.dest_rel_path.clone(),
                asset: script.template().ok_or(PiDelegate)?.to_owned(),
                managed_id: script.managed_id.clone(),
                source: script.source.clone(),
                style: CommentStyle::Shell,
                extra_vars: Some(BTreeMap::new()),
                chmod_exec: script.script.exec,
                guard: false,
            });
        }
    }
    let mut destinations: Vec<(String, String, Option<Authorship>)> = requests
        .iter()
        .map(|r| {
            (
                r.rel.clone(),
                r.managed_id.clone(),
                authorship_of(view, &r.rel, &r.managed_id),
            )
        })
        .collect();
    // `retainOverlay`.
    let selected: Vec<String> = destinations.iter().map(|(rel, _, _)| rel.clone()).collect();
    for (index, plugin) in enabled.iter().chain(&disabled.loaded).enumerate() {
        let is_enabled = index < enabled.len();
        let mut overlays: Vec<(String, String)> = Vec::new();
        if !codex {
            for skill in &plugin.skill_assets {
                let id = skill
                    .inject_into
                    .as_deref()
                    .and_then(|t| t.strip_prefix(".claude/skills/")?.strip_suffix("/SKILL.md"));
                if let Some(id) = id.filter(|id| {
                    !id.is_empty()
                        && id
                            .bytes()
                            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
                }) {
                    overlays.push((format!(".agents/skills/{id}/SKILL.md"), skill.id.clone()));
                }
            }
        }
        for extension in &plugin.hook_extension_assets {
            if let Some(target) = pi_hook_extension_target(&extension.target)
                && (!is_enabled || installed_hooks.contains(&target))
            {
                overlays.push((target, extension.id.clone()));
            }
        }
        for (target, id) in overlays {
            if selected.contains(&target) || view.lexists(&target) {
                let authorship = authorship_of(view, &target, &id);
                destinations.push((target, id, authorship));
            }
        }
    }

    let scribe = flag(&config, "harness", "scribeOwnsMarkdown");
    let admitted = |id: &str| is_pi_rendered_role(id) && (id != "scribe" || scribe);
    let roles: Vec<String> = plan
        .agents
        .iter()
        .filter(|a| admitted(&a.id))
        .map(|a| a.id.clone())
        .collect();
    let mut warnings: Vec<String> = plan
        .agents
        .iter()
        .filter(|a| !is_pi_rendered_role(&a.id))
        .map(|a| {
            format!(
                "Pi subagent role {} is unsupported and was not rendered.",
                a.id
            )
        })
        .collect();
    for id in &loaded.missing {
        warnings.push(format!("Pi could not load plugin {id}: unknown plugin id"));
    }
    warnings.extend(mcp_role_diagnostics(&enabled, &roles, &grants));
    warnings.extend(mcp_server_diagnostics(cwd, &enabled)?);
    if pi_map_migration_pending(&config) {
        warnings.push(PI_MAP_MIGRATION_WARNING.to_owned());
    }
    if scribe && !roles.iter().any(|r| r == "scribe") {
        warnings.push("harness.scribeOwnsMarkdown forbids implementer Markdown but the scribe role is disabled; Pi implementer dispatch is refused until harness.scribe is enabled or scribeOwnsMarkdown is turned off.".to_owned());
    }

    // The whole-file resources.
    let hooks: Vec<PiManifestHook> = bindings
        .iter()
        .map(|b| PiManifestHook {
            script: b.script.to_owned(),
            path: pi_hook_path(b.script),
            on: b.on.to_owned(),
            tools: b.tools.map(|t| t.iter().map(|s| (*s).to_owned()).collect()),
            scope: b.scope.to_owned(),
            class: b.class.to_owned(),
            interactive: b.interactive,
            timeout_ms: f64::from(b.timeout_ms),
            skip_on_error: b.skip_on_error,
        })
        .collect();
    let rule_strings =
        |items: &[JsValue]| -> Vec<String> { items.iter().filter_map(|i| text(Some(i))).collect() };
    let mut owned_paths = vec![MANIFEST.to_owned(), EXTENSION.to_owned()];
    owned_paths.extend(roles.iter().map(|r| format!(".pi/agents/{r}.md")));
    owned_paths.extend(hooks.iter().map(|h| h.path.clone()));
    let manifest = serialize_pi_manifest(&PiManifest {
        schema_version: 2,
        // Parent roles are rendered but never dispatchable, so the manifest does not list them.
        agents: roles
            .iter()
            .filter(|r| is_pi_child_role(r))
            .cloned()
            .collect(),
        controls: Some(PiControls {
            plan_tiers: flag(&config, "harness", "planTiers"),
            master_plan: flag(&config, "harness", "masterPlan"),
            scribe_owns_markdown: scribe,
            audit_always: text(get(&config, "audit").and_then(|a| get(a, "mode"))).as_deref()
                == Some("always"),
            session_state_off: get(&config, "harness").and_then(|h| get(h, "sessionState"))
                == Some(&JsValue::Bool(false)),
        }),
        hooks,
        owned_paths,
        ask: rule_strings(&permissions.ask),
        deny: rule_strings(&permissions.deny),
    });
    let extension = render_pi_extension(&mcp_plugin_ids(&enabled), &grants);
    let mut resources: Vec<(String, String)> = vec![
        (MANIFEST.to_owned(), manifest),
        (EXTENSION.to_owned(), extension),
    ];
    for agent in plan.agents.iter().filter(|a| admitted(&a.id)) {
        let parsed = parse_asset(
            &asset_text(&agent.asset).map_err(|_| PiDelegate)?,
            CommentStyle::Html,
        );
        let description = interpolate(
            parsed
                .frontmatter
                .iter()
                .find_map(|(k, v)| (k == "description").then_some(v.as_str()))
                .unwrap_or(&agent.id),
            &config,
            &InterpolateOptions::default(),
        );
        let instructions = interpolate(
            &condition_orchestration(&parsed.managed_body, &config, "pi")
                .map_err(|_| PiDelegate)?,
            &config,
            &InterpolateOptions::default(),
        );
        let models = get(&config, "models");
        let tier = agent
            .model_key
            .and_then(|key| text(models.and_then(|m| get(m, key))));
        let model = tier.and_then(|tier| {
            text(
                models
                    .and_then(|m| get(m, "piMap"))
                    .and_then(|p| get(p, &tier)),
            )
        });
        let body = format!(
            "{}{}",
            prefix_knowledge_names(&instructions, &agent.id, &grants),
            role_plugin_prose(&agent.id, &enabled, &config, &grants)?
        );
        let content = serialize_pi_agent(
            &agent.id,
            &description,
            model.as_deref(),
            &pi_role_tools(&agent.id, &grants),
            &body,
        );
        resources.push((format!(".pi/agents/{}.md", agent.id), content));
    }
    let owned = |rel: &str, content: &str| -> bool {
        if rel == MANIFEST {
            owns_pi_manifest(content)
        } else if rel == EXTENSION {
            owns_pi_source(content)
        } else {
            rel.strip_prefix(".pi/agents/")
                .and_then(|r| r.strip_suffix(".md"))
                .is_some_and(|name| owns_pi_agent(content, name))
        }
    };
    // Complete-generation validation precedes any pending write (the TS throws).
    for (rel, content) in &resources {
        if !owned(rel, content) {
            return Err(PiDelegate);
        }
    }
    let mut collided = destinations.iter().any(|(rel, _, a)| {
        rel.starts_with(".pi/navori/")
            && matches!(a, Some(Authorship::Modified | Authorship::Newer))
    });
    let mut resource_skipped = Vec::new();
    let mut pi_pending = Vec::new();
    for (rel, content) in &resources {
        let existing = view.lexists(rel);
        let current = view.read_regular(rel);
        let authorship = if !existing {
            None
        } else {
            Some(match &current {
                None => Authorship::Foreign,
                Some(current) if owned(rel, current) => Authorship::Ours,
                Some(current)
                    if rel == MANIFEST
                        && pi_manifest_schema_version(current).unwrap_or(0.0)
                            > PI_MANIFEST_SCHEMA =>
                {
                    Authorship::Newer
                }
                Some(current) => ownership_verdict(current),
            })
        };
        destinations.push((rel.clone(), String::new(), authorship));
        if !existing {
            pi_pending.push(PendingWrite {
                rel_path: rel.clone(),
                content: content.clone(),
                status: InjectStatus::Created,
                chmod_exec: false,
            });
            continue;
        }
        let Some(current) = current else {
            collided = true;
            resource_skipped.push(skipped(
                rel,
                "Pi resource is not a regular owned file.",
                InjectStatus::UserModifiedSkipped,
            ));
            continue;
        };
        if !owned(rel, &current) {
            collided = true;
            let newer = rel == MANIFEST
                && pi_manifest_schema_version(&current).unwrap_or(0.0) > PI_MANIFEST_SCHEMA;
            resource_skipped.push(if newer {
                skipped(
                    rel,
                    "Pi manifest was written by a newer Navori; update this CLI before rendering.",
                    InjectStatus::DowngradeSkipped,
                )
            } else {
                skipped(
                    rel,
                    "Pi resource ownership mismatch; preserved user file.",
                    InjectStatus::UserModifiedSkipped,
                )
            });
        } else if current != *content {
            pi_pending.push(PendingWrite {
                rel_path: rel.clone(),
                content: content.clone(),
                status: InjectStatus::Updated,
                chmod_exec: false,
            });
        }
    }
    let mut agent_removals = Vec::new();
    if view.exists(".pi/agents") {
        let mut names = view.list_dir(".pi/agents").unwrap_or_default();
        names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        for name in names {
            let Some(role) = name.strip_suffix(".md") else {
                continue;
            };
            if roles.iter().any(|r| r == role) || !is_pi_rendered_role(role) {
                continue;
            }
            let rel = format!(".pi/agents/{name}");
            match view.read_regular(&rel) {
                Some(content) if owns_pi_agent(&content, role) => {
                    agent_removals.push(PendingRemoval {
                        rel_path: rel,
                        recursive: false,
                    })
                }
                _ => {
                    collided = true;
                    resource_skipped.push(skipped(
                        &rel,
                        "Pi orphan ownership mismatch; preserved user file.",
                        InjectStatus::UserModifiedSkipped,
                    ));
                }
            }
        }
    }
    if collided {
        warnings.push("Pi generation was not committed because at least one owned destination collides or was edited.".to_owned());
    }
    let needs_context = !engines(&config)
        .iter()
        .any(|e| e == "codex" || e == "agents-md");
    if needs_context {
        let authorship = authorship_of(view, "AGENTS.md", "navori-agents");
        destinations.push((
            "AGENTS.md".to_owned(),
            "navori-agents".to_owned(),
            authorship,
        ));
    }
    Ok(Prepared {
        cwd,
        config,
        lang,
        floor: input.ambient_floor,
        plan,
        enabled,
        disabled: disabled.loaded,
        requests,
        installed_hooks,
        installed_scripts,
        codex,
        warnings,
        destinations,
        collided,
        resource_skipped,
        pi_pending,
        agent_removals,
        needs_context,
    })
}

/// `(relPath, foreign)` observations and the paths a vetoed generation excludes.
pub type PiObserved = (Vec<(String, bool)>, Vec<String>);

/// What Pi observes in the shared inventory, and the paths a vetoed generation excludes.
///
/// # Errors
/// [`PiDelegate`] where the engine delegates.
pub fn pi_observed(
    view: &dyn RepoView,
    input: &PiEngineInput<'_>,
) -> Result<PiObserved, PiDelegate> {
    let prepared = prepare(view, input)?;
    let observed = prepared
        .destinations
        .iter()
        .map(|(rel, _, a)| (rel.clone(), *a == Some(Authorship::Foreign)))
        .collect();
    let excluded = if prepared.collided {
        prepared
            .destinations
            .iter()
            .filter(|(rel, _, a)| a.is_none() && rel.starts_with(".pi/"))
            .map(|(rel, _, _)| rel.clone())
            .collect()
    } else {
        Vec::new()
    };
    Ok((observed, excluded))
}

/// The seal of Pi's own inventory (a render where Pi is the only guard owner).
///
/// # Errors
/// [`PiDelegate`] where `observe` throws.
pub fn pi_seal(observed: &[(String, bool)], excluded: &[String]) -> Result<String, PiDelegate> {
    let mut owned = OwnedPaths::default();
    for (rel, foreign) in observed {
        owned
            .observe_classified(rel, *foreign)
            .map_err(|_| PiDelegate)?;
    }
    for rel in excluded {
        owned.exclude(rel);
    }
    Ok(owned.seal())
}

/// A `file` orphan scan without `expected`: a hand-edited block or a newer one is kept.
fn scan_files(
    view: &dyn RepoView,
    dir: &str,
    desired: &[String],
    removals: &mut Vec<PendingRemoval>,
) {
    let mut names = view.list_dir(dir).unwrap_or_default();
    names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    for name in names {
        let rel = format!("{dir}/{name}");
        if !name.ends_with(".sh") || view.read_regular(&rel).is_none() || desired.contains(&rel) {
            continue;
        }
        if navori_authorship(view, &rel, None, true) == Authorship::Ours {
            removals.push(PendingRemoval {
                rel_path: rel,
                recursive: false,
            });
        }
    }
}

/// `preparePiEngine(...)` then `finalize()`, with `owned_paths` the sealed target inventory.
///
/// # Errors
/// [`PiDelegate`] where the TS throws or Rust does not model the render.
#[allow(clippy::too_many_lines, reason = "one TS function, step for step")]
pub fn plan_pi_engine(
    view: &dyn RepoView,
    input: &PiEngineInput<'_>,
    owned_paths: &str,
) -> Result<PiEnginePlan, PiDelegate> {
    let mut p = prepare(view, input)?;
    let mut pending: Vec<PendingWrite> = Vec::new();
    let mut collected_skipped: Vec<SkippedFile> = Vec::new();
    let mut render_vars: BTreeMap<String, BTreeMap<String, String>> = BTreeMap::new();
    for request in &p.requests {
        let extra_vars = if request.guard {
            let mut vars = request.extra_vars.clone().unwrap_or_default();
            vars.insert("navoriOwnedPaths".to_owned(), owned_paths.to_owned());
            Some(vars)
        } else {
            request.extra_vars.clone()
        };
        if let Some(vars) = &extra_vars {
            render_vars.insert(request.rel.clone(), vars.clone());
        }
        if request.source.starts_with("@navori/plugin-")
            && view.lexists(&request.rel)
            && navori_authorship(view, &request.rel, Some(&request.managed_id), true)
                != Authorship::Ours
        {
            return Err(PiDelegate);
        }
        let existing = read_if_exists(view, &request.rel).map_err(|_| PiDelegate)?;
        let render = RenderManagedFileInput {
            asset: &request.asset,
            style: request.style,
            existing: existing.as_deref(),
            managed_id: &request.managed_id,
            source: &request.source,
            version: STAMP_VERSION,
            config: &p.config,
            extra_vars: extra_vars.unwrap_or_default(),
            transform: None,
            engine: Some("pi"),
            force_overwrite: false,
            ambient_floor: p.floor,
        };
        let collected = collect_managed(view, &request.rel, &render, request.chmod_exec, p.lang)
            .map_err(|_| PiDelegate)?;
        pending.extend(collected.write);
        collected_skipped.extend(collected.skip.map(|mut s| {
            s.resolution = None;
            s
        }));
    }
    // The orphan scans (`collectOrphans`).
    let mut removals = Vec::new();
    let desired_hooks: Vec<String> = p
        .plan
        .hooks
        .iter()
        .map(|h| pi_hook_path(&h.id))
        .filter(|path| p.installed_hooks.contains(path))
        .collect();
    scan_files(view, ".pi/navori/hooks", &desired_hooks, &mut removals);
    scan_files(
        view,
        ".pi/navori/scripts",
        &p.installed_scripts,
        &mut removals,
    );
    if !p.codex {
        let desired: Vec<String> = p
            .plan
            .skills
            .iter()
            .map(|s| format!(".agents/skills/{}/SKILL.md", s.id))
            .collect();
        let mut names = view.list_dir(".agents/skills").unwrap_or_default();
        names.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
        for name in names {
            let dir = format!(".agents/skills/{name}");
            let rel = format!("{dir}/SKILL.md");
            if view.symlink(&dir) != Some(false) || desired.contains(&rel) || !view.exists(&rel) {
                continue;
            }
            if crate::render::removable::is_removable_navori_file(view, &rel, None) {
                let children = view.list_dir(&dir).unwrap_or_default();
                let only = children.len() == 1 && children[0] == "SKILL.md";
                removals.push(PendingRemoval {
                    rel_path: if only { dir } else { rel },
                    recursive: only,
                });
            }
        }
    }

    // `finalize`.
    let mut warnings = std::mem::take(&mut p.warnings);
    if !p.codex {
        apply_pi_skill_sub_blocks(
            view,
            &p.config,
            &p.enabled,
            &p.disabled,
            &mut pending,
            &mut warnings,
            p.floor,
            p.lang,
        )?;
    }
    let ctx = SubBlockCtx {
        view,
        config: &p.config,
        lang: p.lang,
        ambient_floor: p.floor,
    };
    let mut extension_out = SubBlocks::default();
    for plugin in &p.enabled {
        for extension in &plugin.hook_extension_assets {
            let Some(target) = pi_hook_extension_target(&extension.target) else {
                continue;
            };
            if !p.installed_hooks.contains(&target) {
                continue;
            }
            apply_hook_extension(
                &ctx,
                plugin,
                extension,
                &target,
                &mut pending,
                &mut extension_out,
            )
            .map_err(|_| PiDelegate)?;
        }
    }
    for plugin in &p.disabled {
        for extension in &plugin.hook_extension_assets {
            if let Some(target) = pi_hook_extension_target(&extension.target) {
                remove_hook_extension(&ctx, extension, &target, &mut pending)
                    .map_err(|_| PiDelegate)?;
            }
        }
    }
    if !p.collided
        && (!extension_out.skipped.is_empty()
            || collected_skipped
                .iter()
                .any(|s| s.rel_path.starts_with(".pi/navori/")))
    {
        return Err(PiDelegate);
    }
    let mut skipped = std::mem::take(&mut p.resource_skipped);
    skipped.extend(collected_skipped);
    skipped.extend(extension_out.skipped);
    let mut pending: Vec<PendingWrite> = if p.collided {
        pending
            .into_iter()
            .filter(|w| !w.rel_path.starts_with(".pi/navori/"))
            .collect()
    } else {
        pending
    };
    if !p.collided {
        pending.extend(std::mem::take(&mut p.pi_pending));
        let hooks: Vec<_> = p
            .plan
            .hooks
            .iter()
            .filter(|h| p.installed_hooks.contains(&pi_hook_path(&h.id)))
            .cloned()
            .collect();
        finalize_native_hooks(
            &NativeHooksInput {
                view,
                config: &p.config,
                hooks: &hooks,
                plugins: &p.enabled,
                manifest: input.native_manifest,
                ambient_floor: p.floor,
                owned_paths: Some(owned_paths),
                engine: NativeEngine::Pi,
                render_vars: Some(&render_vars),
            },
            &mut pending,
        )
        .map_err(|_| PiDelegate)?;
    }
    let removals: Vec<PendingRemoval> = if p.collided {
        removals
            .into_iter()
            .filter(|r| !r.rel_path.starts_with(".pi/navori/"))
            .collect()
    } else {
        removals
            .into_iter()
            .chain(std::mem::take(&mut p.agent_removals))
            .collect()
    };
    let context = if p.needs_context {
        extend_with_orchestrator_blocks("", &p.enabled, &p.config, p.floor)?;
        let plugins = p.enabled.clone();
        let config = p.config.clone();
        let floor = p.floor;
        let extend = move |body: String| {
            extend_with_orchestrator_blocks(&body, &plugins, &config, floor).unwrap_or(body)
        };
        Some(
            plan_prose_file(
                view,
                input.config,
                p.cwd,
                AGENTS_MD,
                ProseOptions {
                    include_plugin_blocks: true,
                    ambient_floor: p.floor,
                    ..ProseOptions::default()
                },
                Some(&extend),
            )
            .map_err(|_| PiDelegate)?,
        )
    } else {
        None
    };
    Ok(PiEnginePlan {
        pending,
        removals,
        skipped,
        warnings,
        context,
    })
}
