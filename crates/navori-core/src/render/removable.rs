//! The authorship test every delete path shares: `navoriAuthorship` and `isRemovableNavoriFile`
//! of `lib/render/removable.ts` (spec 0058 T14), with `requirePristine` for the Codex orphan
//! scans that judge a file against its fresh render (spec 0059 T19).

use crate::STAMP_VERSION;
use crate::integrity::js_trim_end;
use crate::js_json::{self, JsValue};
use crate::markers::{
    CommentStyle, compute_managed_hash, extract_managed_content, locate_managed_blocks,
    read_marker_attrs,
};
use crate::posix::js_trim;
use crate::render::collect::RepoView;
use crate::render::frontmatter::{parse_frontmatter_fields, split_frontmatter};
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

/// `requirePristine`: the unit as navori renders it fresh, and the rewrite applied to the copy
/// on disk before comparing.
pub struct Pristine<'a> {
    /// `expected`.
    pub expected: &'a str,
    /// `normalize`.
    pub normalize: Option<&'a dyn Fn(&str) -> String>,
}

const BLOCK_TOKEN: &str = "@@navori-block@@";

static BLOCK_RUNS: std::sync::LazyLock<Option<regex::Regex>> =
    std::sync::LazyLock::new(|| regex::Regex::new(&format!("(\\n*{BLOCK_TOKEN}\\n*)+")).ok());

/// `outsideTheBlocks`: frontmatter fields (sorted, `mcp__*` tools dropped) and the text around
/// the managed blocks, normalized. Keys sort by UTF-16 units where the TS uses `localeCompare`:
/// they differ only for distinct keys `localeCompare` ranks equal, which frontmatter keys are not.
fn outside_the_blocks(content: &str) -> Option<(Vec<(String, String)>, String)> {
    let style = style_of(content);
    let split = split_frontmatter(content);
    let mut text = split.body.to_owned();
    let mut blocks = locate_managed_blocks(split.body, style);
    blocks.sort_by_key(|block| std::cmp::Reverse(block.open_start));
    for block in blocks {
        text = format!(
            "{}\n{BLOCK_TOKEN}\n{}",
            &text[..block.open_start],
            &text[block.close_end..]
        );
    }
    let mut fields: Vec<(String, String)> = parse_frontmatter_fields(split.frontmatter)
        .entries()
        .iter()
        .map(|(key, value)| {
            if key == "tools" {
                let kept: Vec<&str> = value
                    .split(',')
                    .map(js_trim)
                    .filter(|tool| !tool.starts_with("mcp__"))
                    .collect();
                (key.clone(), kept.join(", "))
            } else {
                (key.clone(), value.clone())
            }
        })
        .collect();
    fields.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
    let lines: Vec<&str> = text.split('\n').map(js_trim_end).collect();
    let kept: Vec<&str> = lines
        .iter()
        .enumerate()
        .filter(|(i, line)| !line.is_empty() || (*i > 0 && !lines[i - 1].is_empty()))
        .map(|(_, line)| *line)
        .collect();
    let joined = kept.join("\n");
    let collapsed = BLOCK_RUNS
        .as_ref()?
        .replace_all(&joined, format!("\n{BLOCK_TOKEN}\n").as_str());
    Some((fields, js_trim(&collapsed).to_owned()))
}

/// `hasUserWrittenText`: `content` differs from `expected` outside its managed blocks.
fn has_user_written_text(content: &str, expected: &str) -> bool {
    let actual = outside_the_blocks(crate::render::native_hooks::strip_signature(content));
    let wanted = outside_the_blocks(expected);
    actual.is_none() || actual != wanted
}

/// `navoriAuthorship(path, markerId, { verifyHash })`.
#[must_use]
pub fn navori_authorship(
    view: &dyn RepoView,
    rel: &str,
    marker_id: Option<&str>,
    verify_hash: bool,
) -> Authorship {
    navori_authorship_pristine(view, rel, marker_id, verify_hash, None)
}

/// `navoriAuthorship(path, markerId, { verifyHash, requirePristine })`.
#[must_use]
pub fn navori_authorship_pristine(
    view: &dyn RepoView,
    rel: &str,
    marker_id: Option<&str>,
    verify_hash: bool,
    pristine: Option<&Pristine<'_>>,
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
    if let Some(pristine) = pristine {
        let compared = pristine
            .normalize
            .map_or_else(|| content.clone(), |normalize| normalize(&content));
        if has_user_written_text(&compared, pristine.expected) {
            return Authorship::Modified;
        }
    }
    Authorship::Ours
}

/// `isRemovableNavoriFile(path, markerId)`.
#[must_use]
pub fn is_removable_navori_file(view: &dyn RepoView, rel: &str, marker_id: Option<&str>) -> bool {
    navori_authorship(view, rel, marker_id, false) == Authorship::Ours
}
