//! The authorship test every delete path shares: `navoriAuthorship` and `isRemovableNavoriFile`
//! of `lib/render/removable.ts` (spec 0058 T14), without `requirePristine`, which only the
//! native-overlap retirement uses and Claude has no native unit.

use crate::STAMP_VERSION;
use crate::js_json::{self, JsValue};
use crate::markers::{
    CommentStyle, compute_managed_hash, extract_managed_content, locate_managed_blocks,
    read_marker_attrs,
};
use crate::render::collect::RepoView;
use crate::semver::is_downgrade;

/// `NavoriAuthorship`: only `Ours` may be deleted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Authorship {
    /// Navori wrote it, at this CLI's version or older.
    Ours,
    /// A newer navori wrote it.
    Newer,
    /// Nothing in it says navori wrote it (or it is not a regular file).
    Foreign,
    /// Its block hash no longer matches its body.
    Modified,
}

impl Authorship {
    /// The TS string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ours => "ours",
            Self::Newer => "newer",
            Self::Foreign => "foreign",
            Self::Modified => "modified",
        }
    }
}

/// `openingTagFor`: the opening marker line of `id`, html or shell.
fn opening_tag_for<'a>(content: &'a str, id: &str) -> Option<&'a str> {
    [
        format!("navori:managed id=\"{id}\""),
        format!("navori:managed start id=\"{id}\""),
    ]
    .iter()
    .find_map(|opener| {
        let start = content.find(opener.as_str())?;
        let end = content[start..]
            .find('\n')
            .map_or(content.len(), |n| start + n);
        Some(&content[start..end])
    })
}

/// `/version="([^"]+)"/`, first match.
fn marked_version(scope: &str) -> Option<&str> {
    let mut rest = scope;
    while let Some(at) = rest.find("version=\"") {
        let value = &rest[at + 9..];
        if let Some(end) = value.find('"')
            && end > 0
        {
            return Some(&value[..end]);
        }
        rest = &rest[at + 1..];
    }
    None
}

/// `readNavoriOwnership` narrowed to a generated file: `$navori.managed === true`, and its
/// non-empty `version`.
fn generated_json_version(content: &str) -> Option<Option<String>> {
    let JsValue::Object(object) = js_json::parse(content)? else {
        return None;
    };
    let JsValue::Object(navori) = object.get("$navori")? else {
        return None;
    };
    if navori.get("managed") != Some(&JsValue::Bool(true)) {
        return None;
    }
    Some(match navori.get("version") {
        Some(JsValue::String(version)) => version.to_rust().filter(|v| !v.is_empty()),
        _ => None,
    })
}

/// `writerVersion`: the release that wrote `content`, or `None` when nothing claims navori did.
fn writer_version(content: &str, marker_id: Option<&str>) -> Option<String> {
    let scope = match marker_id {
        None => Some(content),
        Some(id) => opening_tag_for(content, id),
    };
    if let Some(scope) = scope
        && scope.contains("navori:managed")
        && let Some(version) = marked_version(scope)
    {
        return Some(version.to_owned());
    }
    if marker_id.is_some() {
        return None;
    }
    generated_json_version(content).flatten()
}

fn style_of(content: &str) -> CommentStyle {
    if content.contains("# navori:managed start") {
        CommentStyle::Shell
    } else {
        CommentStyle::Html
    }
}

/// `navoriAuthorship(path, markerId, { verifyHash })`.
#[must_use]
pub fn navori_authorship(
    view: &dyn RepoView,
    rel: &str,
    marker_id: Option<&str>,
    verify_hash: bool,
) -> Authorship {
    // `lstat().isFile()` and a readable UTF-8 body, or it is not ours.
    let Some(content) = view.read_regular(rel) else {
        return Authorship::Foreign;
    };
    let Some(writer) = writer_version(&content, marker_id) else {
        return Authorship::Foreign;
    };
    if is_downgrade(Some(&writer), Some(STAMP_VERSION)) {
        return Authorship::Newer;
    }
    if verify_hash && content.contains("navori:managed") {
        let style = style_of(&content);
        for block in locate_managed_blocks(&content, style) {
            if marker_id.is_some_and(|id| block.id != id) {
                continue;
            }
            let stored =
                read_marker_attrs(&content, &block.id, style).and_then(|attrs| attrs.existing_hash);
            let body = extract_managed_content(&content, &block.id, style);
            if let (Some(stored), Some(body)) = (stored, body)
                && compute_managed_hash(&body) != stored
            {
                return Authorship::Modified;
            }
        }
    }
    Authorship::Ours
}

/// `isRemovableNavoriFile(path, markerId)`.
#[must_use]
pub fn is_removable_navori_file(view: &dyn RepoView, rel: &str, marker_id: Option<&str>) -> bool {
    navori_authorship(view, rel, marker_id, false) == Authorship::Ours
}
