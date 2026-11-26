//! Nested `.gitignore` files of the render (spec 0058 T14): `renderNestedGitignore` of
//! `engines/shared/nested-gitignore-harness.ts` in dry run, over the ephemeral paths of
//! `engines/shared/ephemeral-paths.ts`. The render command reconciles `.claude/`, `.codex/` and
//! `.navori/` on every run, whatever `gitignoreHarness` says.

use crate::STAMP_VERSION;
use crate::i18n;
use crate::markers::{InjectOptions, InjectStatus, MarkerMeta, inject_managed_section};
use crate::render::collect::{RepoView, read_if_exists};
use crate::render::context::Lang;
use crate::render::plan::CORE_SOURCE_ID;

/// `EPHEMERAL_HARNESS_PATHS`, in the order already hashed into onboarded repos.
pub const EPHEMERAL_HARNESS_PATHS: [&str; 7] = [
    ".claude/settings.local.json",
    ".claude/worktrees/",
    ".claude/progress/",
    ".codex/progress/",
    ".claude/.managed-drift-stamp",
    ".claude/.routing-watch/",
    ".navori/state/",
];

/// `NESTED_GITIGNORE_MANAGED_ID`.
pub const NESTED_GITIGNORE_MANAGED_ID: &str = "nested-gitignore-harness";

/// The directories the render command reconciles, in its order.
pub const NESTED_GITIGNORE_DIRS: [&str; 3] = [".claude", ".codex", ".navori"];

/// The TS throws: the `.gitignore` exists but is not a readable file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NestedGitignoreDelegate;

/// `GitignoreRenderResult` of a dry run, with the content a write would carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NestedGitignore {
    /// `<dir>/.gitignore`.
    pub rel_path: String,
    /// What the inject did.
    pub status: InjectStatus,
    /// The file after the inject (`created`/`updated` write it).
    pub content: String,
    /// Why a kept block was not touched.
    pub skipped_reason: Option<String>,
}

/// `nestedGitignoreEntries(dir)`: the ephemeral paths under `dir`, relative to it.
#[must_use]
pub fn nested_gitignore_entries(dir: &str) -> Vec<&'static str> {
    let prefix = if dir.ends_with('/') {
        dir.to_owned()
    } else {
        format!("{dir}/")
    };
    EPHEMERAL_HARNESS_PATHS
        .iter()
        .filter_map(|path| path.strip_prefix(prefix.as_str()))
        .collect()
}

/// `NESTED_GITIGNORE_OWNER`.
fn owner(dir: &str) -> Option<&'static str> {
    match dir {
        ".claude" => Some("claude"),
        ".codex" => Some("codex"),
        _ => None,
    }
}

/// `shouldHaveNestedGitignore`: the owning engine is enabled, or something the file ignores
/// already exists under `dir`. A dir with no owner is always kept.
#[must_use]
pub fn should_have_nested_gitignore(view: &dyn RepoView, dir: &str, engines: &[String]) -> bool {
    let Some(owner) = owner(dir) else {
        return true;
    };
    engines.iter().any(|engine| engine == owner)
        || nested_gitignore_entries(dir)
            .iter()
            .any(|entry| view.exists(&format!("{dir}/{entry}")))
}

/// `renderNestedGitignore(cwd, dir, { dryRun: true, force, lang, enabledEngines })`.
/// `engines` is `None` for `.navori` (the command passes no engines there).
///
/// # Errors
/// [`NestedGitignoreDelegate`] where the TS throws.
pub fn plan_nested_gitignore(
    view: &dyn RepoView,
    dir: &str,
    engines: Option<&[String]>,
    force: bool,
    lang: Lang,
    ambient_floor: Option<&str>,
) -> Result<Option<NestedGitignore>, NestedGitignoreDelegate> {
    let entries = nested_gitignore_entries(dir);
    if entries.is_empty() {
        return Ok(None);
    }
    if let Some(engines) = engines
        && !should_have_nested_gitignore(view, dir, engines)
    {
        return Ok(None);
    }
    let rel_path = format!("{dir}/.gitignore");
    let existing = read_if_exists(view, &rel_path)
        .map_err(|_| NestedGitignoreDelegate)?
        .unwrap_or_else(|| i18n::gitignore_header(lang).to_owned());
    let meta = MarkerMeta {
        source: Some(CORE_SOURCE_ID.to_owned()),
        version: Some(STAMP_VERSION.to_owned()),
        ..MarkerMeta::default()
    };
    let result = inject_managed_section(
        &existing,
        NESTED_GITIGNORE_MANAGED_ID,
        &entries.join("\n"),
        &meta,
        InjectOptions {
            shell: true,
            force_overwrite: force,
            ambient_floor,
            ..InjectOptions::default()
        },
    );
    let skipped_reason = match result.status {
        InjectStatus::UserModifiedSkipped => {
            Some(i18n::managed_block_edited_by_hand(lang).to_owned())
        }
        InjectStatus::DowngradeSkipped => Some(i18n::block_from_newer_navori(
            lang,
            result.details.existing_version.as_deref(),
        )),
        _ => None,
    };
    Ok(Some(NestedGitignore {
        rel_path,
        status: result.status,
        content: result.output,
        skipped_reason,
    }))
}
