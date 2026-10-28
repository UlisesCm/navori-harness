//! The file retirements of `prepareClaudeEngine` (spec 0058 T14): the scripts of disabled
//! plugins (8.5), registry-removed, orphaned and retired skills, retired hooks and agents
//! (8.6–8.7d) and flat skill twins (8.8), each gated by the shared authorship test.
//!
//! Not modeled, and delegated: a retired plugin's asset still on disk (8.5-bis needs the
//! hook-source scan of `retiredAssetKeepReason`). Native-overlap retirement (8.7e) is inert on
//! Claude ([`crate::render::harness_files::CLAUDE_NATIVE_UNITS`] is empty), and the workspace
//! prunes (8.9, 8.10) only run in workspace renders, which are delegated upstream.

use crate::i18n;
use crate::js_json::JsValue;
use crate::render::collect::RepoView;
use crate::render::context::Lang;
use crate::render::harness_plan::HarnessPlan;
use crate::render::library_skills::{LIBRARY_SKILLS, REMOVED_LIB_SKILLS};
use crate::render::plugins::{LoadedPlugin, RETIRED_PLUGINS};
use crate::render::removable::{Authorship, is_removable_navori_file, navori_authorship};

/// A path the render would delete (`PendingRemoval`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingRemoval {
    /// Path relative to the repo root.
    pub rel_path: String,
    /// Delete a directory with its contents.
    pub recursive: bool,
}

/// A retired unit (`Retired`): its id, successor and the marker id Claude stamped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Retired {
    /// Retired id.
    pub id: &'static str,
    /// The id that replaced it.
    pub successor: Option<&'static str>,
    /// `markerIdByAdapter.claude`.
    pub claude_marker: &'static str,
}

const fn retired(
    id: &'static str,
    successor: Option<&'static str>,
    claude_marker: &'static str,
) -> Retired {
    Retired {
        id,
        successor,
        claude_marker,
    }
}

/// `RETIRED_SKILLS` (`engines/shared/roster.ts`).
pub const RETIRED_SKILLS: &[Retired] = &[
    retired("pr-create", None, "pr-create"),
    retired("debug-error", Some("debug-failure"), "debug-error-base"),
    retired(
        "loop-back-debug",
        Some("debug-failure"),
        "loop-back-debug-base",
    ),
    retired(
        "structural-search",
        Some("locate-code"),
        "structural-search-base",
    ),
    retired(
        "security-guidance",
        Some("security-invariants"),
        "security-guidance-base",
    ),
    retired("ticket-intake", Some("resolve-ticket"), "ticket-intake"),
    retired("babysit-prs", Some("follow-up-prs"), "babysit-prs"),
];

/// `RETIRED_HOOKS`.
pub const RETIRED_HOOKS: &[Retired] = &[
    retired(
        "precompact-session-summary",
        None,
        "precompact-session-summary-base",
    ),
    retired(
        "pr-pilot-confirm",
        Some("pr-publisher-confirm"),
        "pr-pilot-confirm-base",
    ),
];

/// `RETIRED_AGENTS`.
pub const RETIRED_AGENTS: &[Retired] = &[
    retired("leader", Some("orchestrator"), "leader-base"),
    retired("explorer", Some("scout"), "explorer-base"),
    retired("researcher", Some("scout"), "researcher-base"),
    retired("ticket-audit", Some("auditor"), "ticket-audit-base"),
    retired("commit-pr-pilot", Some("publisher"), "commit-pr-pilot-base"),
];

/// A retired plugin's asset is on disk, or a unit id would leave its directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RetirementsDelegate;

/// What the retirements add to the plan.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Retirements {
    /// Paths to delete, in step order.
    pub removals: Vec<PendingRemoval>,
    /// Notes on the disabled scripts kept (step 8.5), before the sub-block step 8.5-ter.
    pub script_warnings: Vec<String>,
    /// `kept …` notes of steps 8.6–8.7d.
    pub warnings: Vec<String>,
}

/// What the retirements read besides the repo.
pub struct RetirementInput<'a> {
    /// Effective config.
    pub config: &'a JsValue,
    /// Message language.
    pub lang: Lang,
    /// The harness plan this render places (after `filterInventory`).
    pub plan: &'a HarnessPlan,
    /// `isPresetLoaded(config, preset)`.
    pub preset_loaded: bool,
    /// Disabled plugins, in config order.
    pub disabled: &'a [LoadedPlugin],
    /// The content of `.claude/settings.json` when this render skips it (not navori's).
    pub skipped_settings: Option<&'a str>,
}

fn strings_at(config: &JsValue, section: &str, key: &str) -> Vec<String> {
    let JsValue::Object(root) = config else {
        return Vec::new();
    };
    let Some(JsValue::Object(section)) = root.get(section) else {
        return Vec::new();
    };
    match section.get(key) {
        Some(JsValue::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                JsValue::String(text) => text.to_rust(),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// An id `join` would keep inside `.claude/<dir>/` as one segment.
fn plain(id: &str) -> Result<&str, RetirementsDelegate> {
    if id.is_empty() || id == "." || id == ".." || id.contains(['/', '\\', '\0']) {
        Err(RetirementsDelegate)
    } else {
        Ok(id)
    }
}

struct Planner<'a> {
    view: &'a dyn RepoView,
    out: Retirements,
}

impl Planner<'_> {
    fn remove(&mut self, rel_path: String, recursive: bool) {
        self.out.removals.push(PendingRemoval {
            rel_path,
            recursive,
        });
    }

    /// `planFlatSkillRemoval`.
    fn flat_skill(&mut self, id: &str, marker: &str) -> Result<(), RetirementsDelegate> {
        let flat = format!(".claude/skills/{}.md", plain(id)?);
        if is_removable_navori_file(self.view, &flat, Some(marker)) {
            self.remove(flat, false);
        }
        Ok(())
    }

    /// `planDirSkillRemoval`: the whole directory when `SKILL.md` is its only entry.
    fn dir_skill(&mut self, id: &str, marker: &str) -> Result<(), RetirementsDelegate> {
        let dir = format!(".claude/skills/{}", plain(id)?);
        let skill = format!("{dir}/SKILL.md");
        if !is_removable_navori_file(self.view, &skill, Some(marker)) {
            return Ok(());
        }
        let children = self.view.list_dir(&dir).unwrap_or_default();
        if children.len() == 1 && children[0] == "SKILL.md" {
            self.remove(dir, true);
        } else {
            self.remove(skill, false);
        }
        Ok(())
    }

    /// `planRetiredHookRemoval` / `planRetiredAgentRemoval`.
    fn whole_file(&mut self, rel: String, marker: &str) {
        if is_removable_navori_file(self.view, &rel, Some(marker)) {
            self.remove(rel, false);
        }
    }

    /// `reportKeptRetired`: a surviving retired file is reported, not silently left.
    fn report_kept(&mut self, paths: &[String], marker: &str, retired: &Retired) {
        for path in paths {
            if !self.view.exists(path) {
                continue;
            }
            let authorship = navori_authorship(self.view, path, Some(marker), false);
            if authorship == Authorship::Ours {
                continue;
            }
            self.out.warnings.push(format!(
                "kept {path} \u{2014} retired id \"{}\" (successor: {}), {} file, not navori's to remove",
                retired.id,
                retired.successor.unwrap_or("none"),
                authorship.as_str(),
            ));
        }
    }

    /// 8.5: a disabled plugin's scripts, unless edited or newer.
    fn disabled_scripts(&mut self, input: &RetirementInput<'_>) {
        for plugin in input.disabled {
            for script in &plugin.script_assets {
                let rel = format!(".claude/scripts/{}", script.dest);
                if !self.view.exists(&rel) {
                    continue;
                }
                match navori_authorship(self.view, &rel, None, true) {
                    Authorship::Ours | Authorship::Foreign => self.remove(rel, false),
                    kept => {
                        self.out
                            .script_warnings
                            .push(format!("kept {rel} \u{2014} {} file", kept.as_str()));
                        if input
                            .skipped_settings
                            .is_some_and(|settings| settings.contains(&script.dest))
                        {
                            self.out
                                .script_warnings
                                .push(i18n::claude_residual_plugin_hook(input.lang, &rel));
                        }
                    }
                }
            }
        }
    }

    /// 8.6 to 8.8 in order.
    fn skills_hooks_agents(
        &mut self,
        input: &RetirementInput<'_>,
    ) -> Result<(), RetirementsDelegate> {
        for id in REMOVED_LIB_SKILLS {
            self.flat_skill(id, id)?;
            self.dir_skill(id, id)?;
        }

        let mut selected = strings_at(input.config, "project", "libraries");
        selected.extend(strings_at(input.config, "project", "extraLibraries"));
        selected.extend(input.plan.skills.iter().map(|s| s.id.clone()));
        let local = strings_at(input.config, "project", "localSkills");
        if input.preset_loaded {
            for (id, _) in LIBRARY_SKILLS {
                if selected.iter().any(|s| s == id) || local.iter().any(|s| s == id) {
                    continue;
                }
                self.flat_skill(id, id)?;
                self.dir_skill(id, id)?;
            }
        }

        for unit in RETIRED_SKILLS {
            if local.iter().any(|s| s == unit.id) {
                continue;
            }
            self.flat_skill(unit.id, unit.claude_marker)?;
            self.dir_skill(unit.id, unit.claude_marker)?;
            let paths = [
                format!(".claude/skills/{}.md", unit.id),
                format!(".claude/skills/{}/SKILL.md", unit.id),
            ];
            self.report_kept(&paths, unit.claude_marker, unit);
        }
        for unit in RETIRED_HOOKS {
            let path = format!(".claude/hooks/{}.sh", unit.id);
            self.whole_file(path.clone(), unit.claude_marker);
            self.report_kept(&[path], unit.claude_marker, unit);
        }
        for unit in RETIRED_AGENTS {
            let path = format!(".claude/agents/{}.md", unit.id);
            self.whole_file(path.clone(), unit.claude_marker);
            self.report_kept(&[path], unit.claude_marker, unit);
        }

        // 8.8: the flat twin of every skill this render writes in directory form.
        for skill in &input.plan.skills {
            self.flat_skill(&skill.id, &skill.managed_id)?;
        }
        Ok(())
    }
}

/// Steps 8.5 (scripts), 8.6–8.7d and 8.8 of a full Claude render.
///
/// # Errors
/// [`RetirementsDelegate`] when a retired plugin's asset is on disk (8.5-bis) or a planned
/// skill id is not a single path segment.
pub fn plan_retirements(
    view: &dyn RepoView,
    input: &RetirementInput<'_>,
) -> Result<Retirements, RetirementsDelegate> {
    let mut planner = Planner {
        view,
        out: Retirements::default(),
    };
    planner.disabled_scripts(input);
    if RETIRED_PLUGINS
        .iter()
        .any(|(_, plugin)| plugin.assets.iter().any(|asset| view.exists(asset)))
    {
        return Err(RetirementsDelegate);
    }
    planner.skills_hooks_agents(input)?;
    Ok(planner.out)
}
