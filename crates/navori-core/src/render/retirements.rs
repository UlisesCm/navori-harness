//! The file retirements of `prepareClaudeEngine` (spec 0058 T14): the scripts of disabled
//! plugins (8.5), registry-removed, orphaned and retired skills, retired hooks and agents
//! (8.6–8.7d), the units gated behind an opt-in flag (8.7f, #1484) and flat skill twins (8.8),
//! each gated by the shared authorship test (8.7f also requires the file to be pristine).
//!
//! Not modeled, and delegated: a retired plugin's asset still on disk (8.5-bis needs the
//! hook-source scan of `retiredAssetKeepReason`). Native-overlap retirement (8.7e) is inert on
//! Claude ([`crate::render::harness_files::CLAUDE_NATIVE_UNITS`] is empty), and the workspace
//! prunes (8.9, 8.10) only run in workspace renders, which are delegated upstream.

use std::collections::BTreeMap;

use crate::STAMP_VERSION;
use crate::config::effective_config;
use crate::i18n;
use crate::js_json::{JsObject, JsValue};
use crate::markers::CommentStyle;
use crate::render::assets;
use crate::render::collect::RepoView;
use crate::render::context::Lang;
use crate::render::harness_plan::{GATED_HOOK_IDS, GATED_WORKFLOW_SKILL_FLAGS, HarnessPlan};
use crate::render::library_skills::{LIBRARY_SKILLS, REMOVED_LIB_SKILLS};
use crate::render::managed_file::{RenderManagedFileInput, render_managed_file};
use crate::render::plan::CORE_SOURCE_ID;
use crate::render::plugins::{LoadedPlugin, RETIRED_PLUGINS};
use crate::render::removable::{
    Authorship, Pristine, navori_authorship, navori_authorship_pristine,
};

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
    /// Destinations inspected: every removal, plus each disabled script kept (8.5 counts every
    /// script on disk).
    pub inspected: usize,
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

/// `isRemovableNavoriFile(path, markerId, { requirePristine })`: with a pristine the hash must
/// verify too; without one it is the marker and version test alone.
fn authorship(
    view: &dyn RepoView,
    rel: &str,
    marker: &str,
    pristine: Option<&Pristine<'_>>,
) -> Authorship {
    match pristine {
        Some(_) => navori_authorship_pristine(view, rel, Some(marker), true, pristine),
        None => navori_authorship(view, rel, Some(marker), false),
    }
}

/// `{ ...base, ...overrides }` over an object (anything else spreads to nothing).
fn spread(base: Option<&JsValue>) -> JsObject {
    let mut out = JsObject::new();
    if let Some(JsValue::Object(object)) = base {
        for (key, value) in object.entries() {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}

/// The `flagsOn` config of step 8.7f (`claude/index.ts:1535-1545`): every opt-in the gated
/// units hang on is true, so the pristine render is what a flags-on render wrote. `hooks`
/// is `{ verifyOnStop: false, ...config.hooks, modelAdvisor: true, auditMode: true }`.
fn flags_on(config: &JsValue) -> JsValue {
    let JsValue::Object(root) = config else {
        return config.clone();
    };
    let mut out = root.clone();
    let mut harness = spread(root.get("harness"));
    for flag in ["planTiers", "authoring", "scribeOwnsMarkdown", "masterPlan"] {
        harness.insert(flag, JsValue::Bool(true));
    }
    out.insert("harness", JsValue::Object(harness));
    let mut hooks = JsObject::new();
    hooks.insert("verifyOnStop", JsValue::Bool(false));
    for (key, value) in spread(root.get("hooks")).entries() {
        hooks.insert(key.clone(), value.clone());
    }
    hooks.insert("modelAdvisor", JsValue::Bool(true));
    hooks.insert("auditMode", JsValue::Bool(true));
    out.insert("hooks", JsValue::Object(hooks));
    effective_config(&JsValue::Object(out))
}

/// `pristineFor` (`claude/index.ts:1546-1558`): the core asset rendered into an empty destination
/// under the flags-on config.
fn pristine_for(
    config: &JsValue,
    asset: &str,
    managed_id: &str,
    style: CommentStyle,
) -> Result<String, RetirementsDelegate> {
    let bytes = assets::core(&format!("core-assets/{asset}")).ok_or(RetirementsDelegate)?;
    let text = std::str::from_utf8(bytes).map_err(|_| RetirementsDelegate)?;
    render_managed_file(&RenderManagedFileInput {
        asset: text,
        style,
        existing: None,
        managed_id,
        source: CORE_SOURCE_ID,
        version: STAMP_VERSION,
        config,
        extra_vars: BTreeMap::new(),
        transform: None,
        engine: Some("claude"),
        force_overwrite: false,
        ambient_floor: None,
    })
    .map(|rendered| rendered.content)
    .map_err(|_| RetirementsDelegate)
}

struct Planner<'a> {
    view: &'a dyn RepoView,
    out: Retirements,
}

impl Planner<'_> {
    fn remove(&mut self, rel_path: String, recursive: bool) {
        self.out.inspected += 1;
        self.out.removals.push(PendingRemoval {
            rel_path,
            recursive,
        });
    }

    /// `planFlatSkillRemoval`.
    fn flat_skill(
        &mut self,
        id: &str,
        marker: &str,
        pristine: Option<&Pristine<'_>>,
    ) -> Result<(), RetirementsDelegate> {
        let flat = format!(".claude/skills/{}.md", plain(id)?);
        if authorship(self.view, &flat, marker, pristine) == Authorship::Ours {
            self.remove(flat, false);
        }
        Ok(())
    }

    /// `planDirSkillRemoval`: the whole directory when `SKILL.md` is its only entry.
    fn dir_skill(
        &mut self,
        id: &str,
        marker: &str,
        pristine: Option<&Pristine<'_>>,
    ) -> Result<(), RetirementsDelegate> {
        let dir = format!(".claude/skills/{}", plain(id)?);
        let skill = format!("{dir}/SKILL.md");
        if authorship(self.view, &skill, marker, pristine) != Authorship::Ours {
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
    fn whole_file(&mut self, rel: String, marker: &str, pristine: Option<&Pristine<'_>>) {
        if authorship(self.view, &rel, marker, pristine) == Authorship::Ours {
            self.remove(rel, false);
        }
    }

    /// `reportKeptRetired`: a surviving retired file is reported, not silently left.
    fn report_kept(
        &mut self,
        paths: &[String],
        marker: &str,
        retired: &Retired,
        pristine: Option<&Pristine<'_>>,
    ) {
        for path in paths {
            if !self.view.exists(path) {
                continue;
            }
            let authorship = authorship(self.view, path, marker, pristine);
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
                        self.out.inspected += 1;
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
            self.flat_skill(id, id, None)?;
            self.dir_skill(id, id, None)?;
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
                self.flat_skill(id, id, None)?;
                self.dir_skill(id, id, None)?;
            }
        }

        for unit in RETIRED_SKILLS {
            if local.iter().any(|s| s == unit.id) {
                continue;
            }
            self.flat_skill(unit.id, unit.claude_marker, None)?;
            self.dir_skill(unit.id, unit.claude_marker, None)?;
            let paths = [
                format!(".claude/skills/{}.md", unit.id),
                format!(".claude/skills/{}/SKILL.md", unit.id),
            ];
            self.report_kept(&paths, unit.claude_marker, unit, None);
        }
        for unit in RETIRED_HOOKS {
            let path = format!(".claude/hooks/{}.sh", unit.id);
            self.whole_file(path.clone(), unit.claude_marker, None);
            self.report_kept(&[path], unit.claude_marker, unit, None);
        }
        for unit in RETIRED_AGENTS {
            let path = format!(".claude/agents/{}.md", unit.id);
            self.whole_file(path.clone(), unit.claude_marker, None);
            self.report_kept(&[path], unit.claude_marker, unit, None);
        }

        self.gated_units(input, &local)?;

        // 8.8: the flat twin of every skill this render writes in directory form.
        for skill in &input.plan.skills {
            self.flat_skill(&skill.id, &skill.managed_id, None)?;
        }
        Ok(())
    }

    /// 8.7f (`claude/index.ts:1527-1608`, #1484): a gated workflow skill, a gated hook or the
    /// `scribe` agent the plan no longer places goes only when navori wrote it and it still
    /// equals its flags-on render; otherwise it stays with a `kept …` note. Paths a step
    /// before already queued are not queued twice, and the TS counts none of these as inspected.
    fn gated_units(
        &mut self,
        input: &RetirementInput<'_>,
        local: &[String],
    ) -> Result<(), RetirementsDelegate> {
        let config = flags_on(input.config);
        let before = (self.out.removals.len(), self.out.inspected);
        let none = |id: &'static str| Retired {
            id,
            successor: None,
            claude_marker: id,
        };

        for (id, _) in GATED_WORKFLOW_SKILL_FLAGS {
            if input.plan.skills.iter().any(|s| s.id == id) || local.iter().any(|s| s == id) {
                continue;
            }
            let expected =
                pristine_for(&config, &format!("skills/{id}.md"), id, CommentStyle::Html)?;
            let pristine = Pristine {
                expected: &expected,
                normalize: None,
            };
            self.flat_skill(id, id, Some(&pristine))?;
            self.dir_skill(id, id, Some(&pristine))?;
            let paths = [
                format!(".claude/skills/{id}.md"),
                format!(".claude/skills/{id}/SKILL.md"),
            ];
            self.report_kept(&paths, id, &none(id), Some(&pristine));
        }
        for id in GATED_HOOK_IDS {
            if input.plan.hooks.iter().any(|h| h.id == id) {
                continue;
            }
            let marker = format!("{id}-base");
            let expected = pristine_for(
                &config,
                &format!("hooks/{id}.sh"),
                &marker,
                CommentStyle::Shell,
            )?;
            let pristine = Pristine {
                expected: &expected,
                normalize: None,
            };
            let path = format!(".claude/hooks/{id}.sh");
            self.whole_file(path.clone(), &marker, Some(&pristine));
            self.report_kept(&[path], &marker, &none(id), Some(&pristine));
        }
        if !input.plan.agents.iter().any(|a| a.id == "scribe") {
            let expected = pristine_for(
                &config,
                "agents/scribe.md",
                "scribe-base",
                CommentStyle::Html,
            )?;
            let pristine = Pristine {
                expected: &expected,
                normalize: None,
            };
            let path = ".claude/agents/scribe.md".to_owned();
            self.whole_file(path.clone(), "scribe-base", Some(&pristine));
            self.report_kept(&[path], "scribe-base", &none("scribe"), Some(&pristine));
        }

        // `queue`: dedup by path against everything planned before, and no `inspected` bump.
        let added = self.out.removals.split_off(before.0);
        self.out.inspected = before.1;
        for removal in added {
            if !self
                .out
                .removals
                .iter()
                .any(|r| r.rel_path == removal.rel_path)
            {
                self.out.removals.push(removal);
            }
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

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::render::harness_plan::resolve_harness_plan;

    /// In-memory repo: regular files by repo-relative path.
    struct Files(BTreeMap<String, String>);

    impl RepoView for Files {
        fn read(&self, rel: &str) -> Option<String> {
            self.0.get(rel).cloned()
        }

        fn read_regular(&self, rel: &str) -> Option<String> {
            self.read(rel)
        }

        fn exists(&self, rel: &str) -> bool {
            self.0.contains_key(rel)
        }

        fn lexists(&self, rel: &str) -> bool {
            self.exists(rel)
        }

        fn list_dir(&self, rel: &str) -> Option<Vec<String>> {
            let prefix = format!("{rel}/");
            let children: Vec<String> = self
                .0
                .keys()
                .filter_map(|path| path.strip_prefix(&prefix))
                .map(|rest| rest.split('/').next().unwrap_or(rest).to_owned())
                .collect();
            (!children.is_empty()).then_some(children)
        }

        fn symlink(&self, _rel: &str) -> Option<bool> {
            Some(false)
        }
    }

    fn config(json: &str) -> JsValue {
        let read = crate::config::read(json.as_bytes());
        assert!(read.is_ok(), "config parses");
        read.map_or(JsValue::Undefined, |parsed| effective_config(&parsed.data))
    }

    /// The pristine render of a gated unit, as the 8.7f guard computes it.
    fn pristine(config: &JsValue, asset: &str, marker: &str, style: CommentStyle) -> String {
        let rendered = pristine_for(&flags_on(config), asset, marker, style);
        assert!(rendered.is_ok(), "core asset {asset} renders");
        rendered.unwrap_or_default()
    }

    /// Runs the retirements over `files` with the plan `config` resolves.
    fn run(files: BTreeMap<String, String>, config: &JsValue) -> Retirements {
        let plan = resolve_harness_plan(config, None, true, Some("claude"));
        let input = RetirementInput {
            config,
            lang: Lang::Es,
            plan: &plan,
            preset_loaded: true,
            disabled: &[],
            skipped_settings: None,
        };
        let out = plan_retirements(&Files(files), &input);
        assert!(out.is_ok(), "the retirements do not delegate");
        out.unwrap_or_default()
    }

    const OFF: &str =
        r#"{"name":"d","engines":["claude"],"preset":"custom","language":"es","project":{}}"#;

    /// With every flag on the plan places the gated units, so nothing is retired.
    #[test]
    fn flags_on_retire_nothing_gated() {
        let config = config(
            r#"{"name":"d","engines":["claude"],"preset":"custom","language":"es","project":{},"harness":{"planTiers":true,"authoring":true,"scribeOwnsMarkdown":true,"masterPlan":true},"hooks":{"modelAdvisor":true,"auditMode":true}}"#,
        );
        let skill = pristine(&config, "skills/dominio.md", "dominio", CommentStyle::Html);
        let files = BTreeMap::from([(".claude/skills/dominio/SKILL.md".to_owned(), skill)]);
        let out = run(files, &config);
        assert!(out.removals.is_empty(), "{:?}", out.removals);
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);
    }

    #[test]
    fn pristine_gated_units_are_removed() {
        let config = config(OFF);
        let files = BTreeMap::from([
            (
                ".claude/skills/dominio/SKILL.md".to_owned(),
                pristine(&config, "skills/dominio.md", "dominio", CommentStyle::Html),
            ),
            (
                ".claude/skills/plan-simple.md".to_owned(),
                pristine(
                    &config,
                    "skills/plan-simple.md",
                    "plan-simple",
                    CommentStyle::Html,
                ),
            ),
            (
                ".claude/hooks/routing-watch.sh".to_owned(),
                pristine(
                    &config,
                    "hooks/routing-watch.sh",
                    "routing-watch-base",
                    CommentStyle::Shell,
                ),
            ),
            (
                ".claude/agents/scribe.md".to_owned(),
                pristine(
                    &config,
                    "agents/scribe.md",
                    "scribe-base",
                    CommentStyle::Html,
                ),
            ),
        ]);
        let out = run(files, &config);
        let paths: Vec<&str> = out.removals.iter().map(|r| r.rel_path.as_str()).collect();
        assert_eq!(
            paths,
            [
                ".claude/skills/plan-simple.md",
                ".claude/skills/dominio",
                ".claude/hooks/routing-watch.sh",
                ".claude/agents/scribe.md",
            ]
        );
        assert!(out.removals[1].recursive);
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);
        assert_eq!(out.inspected, 0, "8.7f does not bump `inspected`");
    }

    #[test]
    fn edited_gated_units_are_kept_with_a_note() {
        let config = config(OFF);
        let skill = pristine(&config, "skills/dominio.md", "dominio", CommentStyle::Html);
        let hook = pristine(
            &config,
            "hooks/routing-watch.sh",
            "routing-watch-base",
            CommentStyle::Shell,
        );
        let agent = pristine(
            &config,
            "agents/scribe.md",
            "scribe-base",
            CommentStyle::Html,
        );
        let files = BTreeMap::from([
            (
                ".claude/skills/dominio.md".to_owned(),
                format!("{skill}\nmine\n"),
            ),
            (
                ".claude/hooks/routing-watch.sh".to_owned(),
                format!("{hook}\n# mine\n"),
            ),
            (
                ".claude/agents/scribe.md".to_owned(),
                format!("{agent}\nmine\n"),
            ),
        ]);
        let out = run(files, &config);
        assert!(out.removals.is_empty(), "{:?}", out.removals);
        assert_eq!(
            out.warnings,
            [
                "kept .claude/skills/dominio.md \u{2014} retired id \"dominio\" (successor: none), modified file, not navori's to remove",
                "kept .claude/hooks/routing-watch.sh \u{2014} retired id \"routing-watch\" (successor: none), modified file, not navori's to remove",
                "kept .claude/agents/scribe.md \u{2014} retired id \"scribe\" (successor: none), modified file, not navori's to remove",
            ]
        );
    }

    #[test]
    fn newer_gated_unit_is_kept() {
        let config = config(OFF);
        let agent = pristine(
            &config,
            "agents/scribe.md",
            "scribe-base",
            CommentStyle::Html,
        )
        .replace(
            &format!("version=\"{STAMP_VERSION}\""),
            "version=\"999.0.0\"",
        );
        let files = BTreeMap::from([(".claude/agents/scribe.md".to_owned(), agent)]);
        let out = run(files, &config);
        assert!(out.removals.is_empty());
        assert_eq!(out.warnings.len(), 1, "{:?}", out.warnings);
        assert!(out.warnings[0].contains("newer file"), "{:?}", out.warnings);
    }

    #[test]
    fn local_skill_is_skipped_silently() {
        let config = config(
            r#"{"name":"d","engines":["claude"],"preset":"custom","language":"es","project":{"localSkills":["dominio"]}}"#,
        );
        let skill = pristine(&config, "skills/dominio.md", "dominio", CommentStyle::Html);
        let edited = format!("{skill}\nmine\n");
        let files = BTreeMap::from([(".claude/skills/dominio.md".to_owned(), edited)]);
        let out = run(files, &config);
        assert!(out.removals.is_empty());
        assert!(out.warnings.is_empty(), "{:?}", out.warnings);
    }

    #[test]
    fn dir_skill_with_another_child_loses_only_skill_md() {
        let config = config(OFF);
        let skill = pristine(
            &config,
            "skills/plan-advanced.md",
            "plan-advanced",
            CommentStyle::Html,
        );
        let files = BTreeMap::from([
            (".claude/skills/plan-advanced/SKILL.md".to_owned(), skill),
            (
                ".claude/skills/plan-advanced/notes.md".to_owned(),
                "mine\n".to_owned(),
            ),
        ]);
        let out = run(files, &config);
        assert_eq!(
            out.removals,
            [PendingRemoval {
                rel_path: ".claude/skills/plan-advanced/SKILL.md".to_owned(),
                recursive: false,
            }]
        );
    }

    #[test]
    fn foreign_gated_files_are_kept_with_a_note() {
        let config = config(OFF);
        let files = BTreeMap::from([(
            ".claude/hooks/model-advisor.sh".to_owned(),
            "#!/bin/sh\n".to_owned(),
        )]);
        let out = run(files, &config);
        assert!(out.removals.is_empty());
        assert_eq!(out.warnings.len(), 1);
        assert!(
            out.warnings[0].contains("foreign file"),
            "{:?}",
            out.warnings
        );
    }
}
