//! The managed-file branch of `collectRequest` (`engines/shared/execute-plan.ts`) and
//! `planManagedFile` (`engines/claude/index.ts`), with `attachResolution` (spec 0058 T14): one
//! asset rendered onto its destination becomes a write, a skip or nothing.

use crate::i18n;
use crate::markers::InjectStatus;
use crate::render::context::Lang;
use crate::render::managed_file::{
    ManagedFileDelegate, RenderManagedFileInput, forced_managed_file_content, render_managed_file,
};

/// Read access to the repo being rendered, by path relative to its root.
pub trait RepoView {
    /// `existsSync` + `readFileSync`: follows symlinks; `None` when absent or unreadable.
    fn read(&self, rel: &str) -> Option<String>;
    /// The content of a regular file (`lstat().isFile()`): `None` for symlinks and directories.
    fn read_regular(&self, rel: &str) -> Option<String>;
    /// `existsSync`: follows symlinks, true for directories.
    fn exists(&self, rel: &str) -> bool;
    /// `readdirSync` entry names; `None` when it throws.
    fn list_dir(&self, rel: &str) -> Option<Vec<String>>;
}

/// The path exists but `readFileSync` throws on it (a directory, say).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Unreadable;

/// `existsSync(p) ? readFileSync(p, "utf-8") : null`.
///
/// # Errors
/// [`Unreadable`] when the path exists and is not a readable text file, where the TS throws.
pub fn read_if_exists(view: &dyn RepoView, rel: &str) -> Result<Option<String>, Unreadable> {
    if !view.exists(rel) {
        return Ok(None);
    }
    view.read(rel).map(Some).ok_or(Unreadable)
}

/// A file the render would write (`PendingWrite`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingWrite {
    /// Path relative to the repo root.
    pub rel_path: String,
    /// Full content.
    pub content: String,
    /// `created` or `updated`.
    pub status: InjectStatus,
    /// `chmod +x` after the write.
    pub chmod_exec: bool,
}

/// A file navori refused to touch (`SkippedFile`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkippedFile {
    /// Path relative to the repo root.
    pub rel_path: String,
    /// Localized reason.
    pub reason: String,
    /// `user-modified-skipped` or `downgrade-skipped`.
    pub status: InjectStatus,
    /// `resolution.content`: what `sync` would write to accept the rendered version.
    pub resolution: Option<String>,
    /// `markerlessResolution.content`: the whole-file replace only `sync --interactive` offers.
    pub markerless_resolution: Option<String>,
}

/// What one managed file contributes to the plan.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Collected {
    /// The write, when the destination changes.
    pub write: Option<PendingWrite>,
    /// The skip, when the destination is kept.
    pub skip: Option<SkippedFile>,
    /// `collision.overwrittenKeys`: a markerless destination adopted by name.
    pub collision: Option<Vec<String>>,
}

/// Renders `input` (whose `existing` is the destination read through `view`) onto `rel_path`.
///
/// # Errors
/// [`ManagedFileDelegate`] where the TS throws.
pub fn collect_managed(
    view: &dyn RepoView,
    rel_path: &str,
    input: &RenderManagedFileInput<'_>,
    chmod_exec: bool,
    lang: Lang,
) -> Result<Collected, ManagedFileDelegate> {
    let rendered = render_managed_file(input)?;
    let mut collected = Collected {
        collision: rendered.collision,
        ..Collected::default()
    };
    match rendered.status {
        InjectStatus::Unchanged => {}
        InjectStatus::UserModifiedSkipped => {
            // `attachResolution`: an existing regular file whose forced render differs can be
            // resolved by `sync`, and the reason says so.
            let resolution = input
                .existing
                .and(view.read_regular(rel_path))
                .and(forced_managed_file_content(input).ok().flatten());
            let reason = if resolution.is_some() {
                i18n::managed_file_edited_resolvable(lang)
            } else {
                i18n::managed_block_edited_by_hand(lang)
            };
            collected.skip = Some(SkippedFile {
                rel_path: rel_path.to_owned(),
                reason: reason.to_owned(),
                status: rendered.status,
                resolution,
                markerless_resolution: None,
            });
        }
        InjectStatus::DowngradeSkipped => {
            collected.skip = Some(SkippedFile {
                rel_path: rel_path.to_owned(),
                reason: i18n::block_from_newer_navori(
                    lang,
                    rendered.details.existing_version.as_deref(),
                ),
                status: rendered.status,
                resolution: None,
                markerless_resolution: None,
            });
        }
        status => {
            collected.write = Some(PendingWrite {
                rel_path: rel_path.to_owned(),
                content: rendered.content,
                status,
                chmod_exec,
            });
        }
    }
    Ok(collected)
}
