//! `resolveHarnessPlan` (`engines/shared/harness-plan.ts`) and the roster it reads (spec 0058
//! T14): which agents, skills and hooks a render materializes, from config + preset + libraries.
//! Knows nothing about destinations or formats; those belong to the engine adapter.

use std::collections::BTreeSet;

use crate::js_json::JsValue;
use crate::render::block_plan::{resolve_condition, truthy};
use crate::render::library_skills::library_skill_label;
use crate::render::presets::{AssetRoot, LoadedPreset};

/// `RosterAgent`: id, `harnessKey` and the sandbox Codex honors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RosterAgent {
    /// Agent id.
    pub id: &'static str,
    /// Key into `config.harness`, `config.models` and `config.effort`.
    pub harness_key: &'static str,
    /// Role sandbox.
    pub sandbox: Option<&'static str>,
}

/// `ROSTER_AGENTS` (`CORE_AGENTS`), in order.
pub const ROSTER_AGENTS: [RosterAgent; 8] = [
    roster("orchestrator", None),
    roster("implementer", None),
    roster("reviewer", Some("workspace-write")),
    roster("scout", Some("workspace-write")),
    roster("auditor", Some("workspace-write")),
    roster("publisher", None),
    roster("scribe", Some("workspace-write")),
    roster("architect", Some("workspace-write")),
];

const fn roster(id: &'static str, sandbox: Option<&'static str>) -> RosterAgent {
    RosterAgent {
        id,
        harness_key: id,
        sandbox,
    }
}

/// `ROSTER_CORE_SKILLS`.
pub const CORE_SKILLS: [&str; 7] = [
    "verify-before-done",
    "debug-failure",
    "review-diff",
    "security-invariants",
    "secure-by-design",
    "locate-code",
    "scoped-gate",
];

/// `ROSTER_WORKFLOW_SKILLS`.
pub const WORKFLOW_SKILLS: [&str; 11] = [
    "resolve-ticket",
    "solution-design",
    "spec-bootstrap",
    "dominio",
    "follow-up-prs",
    "quality-attributes",
    "author-skill",
    "plan-simple",
    "plan-advanced",
    "master-plan",
    "context-intake",
];

/// `WORKFLOW_SKILL_ENGINES` and `HOOK_ENGINES`: units that ship only to the engines listed.
fn engine_scope(id: &str) -> Option<&'static [&'static str]> {
    match id {
        "master-plan" | "context-intake" | "master-plan-context" => Some(&["claude", "codex"]),
        "master-accept-confirm" => Some(&["claude", "codex", "pi"]),
        "role-guard" | "engram-write-guard" => Some(&["codex"]),
        _ => None,
    }
}

/// `inEngineScope`.
fn in_engine_scope(id: &str, engine: Option<&str>) -> bool {
    engine_scope(id).is_none_or(|scope| engine.is_some_and(|engine| scope.contains(&engine)))
}

/// `MAIN_THREAD_ONLY_HOOKS`.
pub const MAIN_THREAD_ONLY_HOOKS: [&str; 1] = ["model-advisor"];

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

/// `isAgentEnabled`: `architect` always; an explicit `harness.<key>` wins; agents default on.
#[must_use]
pub fn is_agent_enabled(config: &JsValue, key: &str) -> bool {
    if key == "architect" {
        return true;
    }
    match get(config, "harness").and_then(|harness| get(harness, key)) {
        None | Some(JsValue::Undefined) => true,
        Some(explicit) => truthy(explicit),
    }
}

/// Where a planned unit's asset lives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetRef {
    /// `core-assets/` of the bundle, or a local preset folder.
    pub root: AssetRoot,
    /// Normalized path under `root`.
    pub rel: String,
}

impl AssetRef {
    fn core(rel: String) -> Self {
        Self {
            root: AssetRoot::Bundled,
            rel,
        }
    }

    fn preset(preset: &LoadedPreset, rel: &str) -> Self {
        Self {
            root: preset.asset_root.clone(),
            rel: rel
                .split('/')
                .filter(|segment| !segment.is_empty() && *segment != ".")
                .collect::<Vec<_>>()
                .join("/"),
        }
    }
}

/// `PlannedAgent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedAgent {
    /// Agent id.
    pub id: String,
    /// Source asset.
    pub asset: AssetRef,
    /// Canonical managed-block id.
    pub managed_id: String,
    /// `modelKey`, core agents only.
    pub model_key: Option<&'static str>,
    /// `sandbox`, core agents only.
    pub sandbox: Option<&'static str>,
}

/// `PlannedSkill`, and `PlannedHook` with `main_thread_only`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlannedUnit {
    /// Unit id.
    pub id: String,
    /// Source asset.
    pub asset: AssetRef,
    /// Managed-block id.
    pub managed_id: String,
    /// `mainThreadOnly` (hooks).
    pub main_thread_only: bool,
}

/// `HarnessPlan`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct HarnessPlan {
    /// Agents to render.
    pub agents: Vec<PlannedAgent>,
    /// Skills to render.
    pub skills: Vec<PlannedUnit>,
    /// Hooks to render.
    pub hooks: Vec<PlannedUnit>,
}

/// `extraConditionMet`.
fn extra_condition_met(extra: &JsValue, config: &JsValue) -> bool {
    match text(get(extra, "condition")) {
        Some(condition) if !condition.is_empty() => resolve_condition(config, &condition),
        _ => true,
    }
}

fn extras<'a>(preset: Option<&'a LoadedPreset>, kind: &str) -> &'a [JsValue] {
    match preset
        .and_then(|p| get(&p.def, "extras"))
        .and_then(|e| get(e, kind))
    {
        Some(JsValue::Array(items)) => items,
        _ => &[],
    }
}

fn strings(value: Option<&JsValue>) -> Vec<String> {
    match value {
        Some(JsValue::Array(items)) => items.iter().filter_map(|item| text(Some(item))).collect(),
        _ => Vec::new(),
    }
}

/// `effectiveLibraries`: project, extra and preset libraries, deduplicated in order.
#[must_use]
pub fn effective_libraries(config: &JsValue, preset: Option<&LoadedPreset>) -> Vec<String> {
    let project = get(config, "project");
    let mut seen = BTreeSet::new();
    strings(project.and_then(|p| get(p, "libraries")))
        .into_iter()
        .chain(strings(project.and_then(|p| get(p, "extraLibraries"))))
        .chain(strings(preset.and_then(|p| get(&p.def, "libraries"))))
        .filter(|id| seen.insert(id.clone()))
        .collect()
}

fn unit(id: &str, rel: String, managed_id: String) -> PlannedUnit {
    PlannedUnit {
        id: id.to_owned(),
        asset: AssetRef::core(rel),
        managed_id,
        main_thread_only: false,
    }
}

/// `resolveHarnessPlan`.
#[must_use]
pub fn resolve_harness_plan(
    config: &JsValue,
    preset: Option<&LoadedPreset>,
    include_orchestrator: bool,
    engine: Option<&str>,
) -> HarnessPlan {
    let mut plan = HarnessPlan::default();
    for agent in &ROSTER_AGENTS {
        if agent.id == "orchestrator" && !include_orchestrator {
            continue;
        }
        if !is_agent_enabled(config, agent.harness_key) {
            continue;
        }
        plan.agents.push(PlannedAgent {
            id: agent.id.to_owned(),
            asset: AssetRef::core(format!("agents/{}.md", agent.id)),
            managed_id: format!("{}-base", agent.id),
            model_key: Some(agent.harness_key),
            sandbox: agent.sandbox,
        });
    }
    for extra in extras(preset, "agents") {
        let (Some(preset), Some(id), Some(rel)) =
            (preset, text(get(extra, "id")), text(get(extra, "relPath")))
        else {
            continue;
        };
        if !extra_condition_met(extra, config) {
            continue;
        }
        plan.agents.push(PlannedAgent {
            asset: AssetRef::preset(preset, &rel),
            managed_id: id.clone(),
            id,
            model_key: None,
            sandbox: None,
        });
    }

    let sdd_off =
        get(config, "sdd").and_then(|sdd| get(sdd, "enabled")) == Some(&JsValue::Bool(false));
    plan.skills.extend(
        CORE_SKILLS
            .iter()
            .map(|id| unit(id, format!("skills/{id}.md"), format!("{id}-base"))),
    );
    plan.skills.extend(
        WORKFLOW_SKILLS
            .iter()
            .filter(|id| !(sdd_off && **id == "spec-bootstrap"))
            .filter(|id| in_engine_scope(id, engine))
            .map(|id| unit(id, format!("skills/{id}.md"), (*id).to_owned())),
    );
    let mut seen: BTreeSet<String> = plan.skills.iter().map(|s| s.id.clone()).collect();
    for extra in extras(preset, "skills") {
        let (Some(preset), Some(id), Some(rel)) =
            (preset, text(get(extra, "id")), text(get(extra, "relPath")))
        else {
            continue;
        };
        if !extra_condition_met(extra, config) || !seen.insert(id.clone()) {
            continue;
        }
        plan.skills.push(PlannedUnit {
            asset: AssetRef::preset(preset, &rel),
            managed_id: id.clone(),
            id,
            main_thread_only: false,
        });
    }
    for id in effective_libraries(config, preset) {
        if seen.contains(&id) || library_skill_label(&id).is_none() {
            continue;
        }
        seen.insert(id.clone());
        plan.skills
            .push(unit(&id, format!("lib-skills/{id}.md"), id.clone()));
    }

    let mut hooks: Vec<&str> = vec![
        "guard-destructive",
        "implementer-no-markdown",
        "subagent-no-background",
        "session-start-context",
        "model-advisor",
        "subagent-stop-handoff",
        "managed-drift-watch",
        "routing-watch",
        "bash-outcome-watch",
        "worktree-reclaim",
        "audit-mode-trigger",
        "audit-mode-close",
    ];
    hooks.extend(
        [
            "master-plan-context",
            "master-accept-confirm",
            "role-guard",
            "engram-write-guard",
        ]
        .into_iter()
        .filter(|id| in_engine_scope(id, engine)),
    );
    hooks.push("comment-draft-confirm");
    if is_agent_enabled(config, "publisher") {
        hooks.push("pr-publisher-confirm");
    }
    if is_agent_enabled(config, "scout") {
        hooks.push("general-purpose-confirm");
    }
    let flag = |section: &str, key: &str| {
        get(config, section)
            .and_then(|s| get(s, key))
            .is_some_and(truthy)
    };
    if flag("qualityGate", "fast") {
        hooks.push("quality-gate-pre-commit");
    }
    if flag("harness", "planTiers") {
        hooks.push("plan-gate");
    }
    if flag("hooks", "verifyOnStop") {
        hooks.push("stop-verify-reminder");
    }
    plan.hooks = hooks
        .into_iter()
        .map(|id| {
            let managed = if id == "quality-gate-pre-commit" {
                "qg-pre-commit-base".to_owned()
            } else {
                format!("{id}-base")
            };
            PlannedUnit {
                main_thread_only: MAIN_THREAD_ONLY_HOOKS.contains(&id),
                ..unit(id, format!("hooks/{id}.sh"), managed)
            }
        })
        .collect();
    plan
}
