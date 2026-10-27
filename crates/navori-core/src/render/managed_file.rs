//! `renderManagedFile` (`engines/shared/render-managed-file.ts`), with `parseAsset` and
//! `mergeFrontmatter` (spec 0058 T14): a bundled asset rendered into a destination file that
//! carries its frontmatter, one managed block and an optional user zone.
//!
//! The caller passes the asset text it resolved from the bundle; anything the TS would throw on
//! (a missing include, an unbalanced `navori:if`) is a [`ManagedFileDelegate`].

use std::collections::BTreeMap;

use crate::integrity::{is_js_whitespace, js_trim_end};
use crate::js_json::JsValue;
use crate::markers::{
    CommentStyle, InjectDetails, InjectOptions, InjectStatus, MarkerMeta, inject_managed_section,
    read_marker_attrs,
};
use crate::render::frontmatter::{
    format_frontmatter_field, format_frontmatter_field_raw, parse_frontmatter_fields,
    split_frontmatter, split_tool_list,
};
use crate::render::hook_includes::expand_hook_includes;
use crate::render::interpolate::{InterpolateOptions, interpolate};
use crate::render::plan::condition_orchestration;

/// The TS would throw rendering this asset.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManagedFileDelegate;

/// An ordered `Record<string, string>` (frontmatter keys in `Object.keys` order).
pub type FrontmatterMap = Vec<(String, String)>;

/// Members every JS object inherits: `key in record` is true for them.
const OBJECT_PROTOTYPE: &[&str] = &[
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

fn get<'a>(map: &'a FrontmatterMap, key: &str) -> Option<&'a str> {
    map.iter()
        .find_map(|(existing, value)| (existing == key).then_some(value.as_str()))
}

/// JS `key in record`.
fn has(map: &FrontmatterMap, key: &str) -> bool {
    get(map, key).is_some() || OBJECT_PROTOTYPE.contains(&key)
}

/// `record[key] = value`: an own key keeps its slot.
fn set(map: &mut FrontmatterMap, key: &str, value: String) {
    match map.iter_mut().find(|(existing, _)| existing == key) {
        Some(slot) => slot.1 = value,
        None => map.push((key.to_owned(), value)),
    }
}

fn fields(text: &str) -> FrontmatterMap {
    parse_frontmatter_fields(text).entries().to_vec()
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `ParsedAsset`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedAsset {
    /// Frontmatter fields.
    pub frontmatter: FrontmatterMap,
    /// navori-base content.
    pub managed_body: String,
    /// User-section template, written only on first render.
    pub user_template: Option<String>,
}

const fn is_line_terminator(ch: char) -> bool {
    matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `findSentinel`: html anywhere; shell only as a whole line (JS multiline `^…$`).
fn find_sentinel(haystack: &str, sentinel: &str, style: CommentStyle) -> Option<usize> {
    match style {
        CommentStyle::Html => haystack.find(sentinel),
        CommentStyle::Shell => haystack.match_indices(sentinel).map(|(i, _)| i).find(|&i| {
            let starts_line = haystack[..i]
                .chars()
                .next_back()
                .is_none_or(is_line_terminator);
            let ends_line = haystack[i + sentinel.len()..]
                .chars()
                .next()
                .is_none_or(is_line_terminator);
            starts_line && ends_line
        }),
    }
}

/// `parseAsset`.
#[must_use]
pub fn parse_asset(raw: &str, style: CommentStyle) -> ParsedAsset {
    let split = split_frontmatter(raw);
    let frontmatter = fields(split.frontmatter);
    let sentinel = match style {
        CommentStyle::Html => "<!-- navori:user-section -->",
        CommentStyle::Shell => "# navori:user-section",
    };
    let after = split.body;
    match find_sentinel(after, sentinel, style) {
        None => ParsedAsset {
            frontmatter,
            managed_body: js_trim(after).to_owned(),
            user_template: None,
        },
        Some(index) => {
            let tail = &after[index + sentinel.len()..];
            ParsedAsset {
                frontmatter,
                managed_body: js_trim(&after[..index]).to_owned(),
                user_template: Some(tail.strip_prefix('\n').unwrap_or(tail).to_owned()),
            }
        }
    }
}

/// `mergeFrontmatter`'s `serialized`: asset keys first, then the destination's leftovers.
#[must_use]
pub fn merge_frontmatter(
    asset: &FrontmatterMap,
    dest: &FrontmatterMap,
    previous_keys: Option<&[String]>,
) -> String {
    let mut merged = dest.clone();
    for (key, value) in asset {
        set(&mut merged, key, value.clone());
    }
    if let Some(previous) = previous_keys {
        for key in previous {
            if !has(asset, key) {
                merged.retain(|(existing, _)| existing != key);
            }
        }
    }
    if let (Some(asset_tools), Some(dest_tools)) = (get(asset, "tools"), get(dest, "tools")) {
        let asset_list = split_tool_list(asset_tools);
        let grants: Vec<String> = split_tool_list(dest_tools)
            .into_iter()
            .filter(|tool| tool.starts_with("mcp__") && !asset_list.contains(tool))
            .collect();
        if !grants.is_empty() {
            let joined = asset_list
                .into_iter()
                .chain(grants)
                .collect::<Vec<_>>()
                .join(", ");
            set(&mut merged, "tools", joined);
        }
    }
    let asset_keys: Vec<&str> = asset.iter().map(|(key, _)| key.as_str()).collect();
    let ordered = asset_keys.iter().copied().chain(
        merged
            .iter()
            .map(|(key, _)| key.as_str())
            .filter(|key| !asset_keys.contains(key)),
    );
    let lines: Vec<String> = ordered
        .filter_map(|key| get(&merged, key).map(|value| format_frontmatter_field(key, value)))
        .collect();
    serialize_lines(&lines)
}

fn serialize_lines(lines: &[String]) -> String {
    let mut out = vec!["---".to_owned()];
    out.extend(lines.iter().cloned());
    out.push("---".to_owned());
    out.join("\n")
}

fn serialize_frontmatter(fm: &FrontmatterMap) -> String {
    let lines: Vec<String> = fm
        .iter()
        .map(|(key, value)| format_frontmatter_field(key, value))
        .collect();
    serialize_lines(&lines)
}

/// `RenderManagedFileInput`, with the asset text instead of its path.
pub struct RenderManagedFileInput<'a> {
    /// Raw asset text, as read from the bundle.
    pub asset: &'a str,
    /// `inferCommentStyle(assetPath)` or the explicit override.
    pub style: CommentStyle,
    /// Current destination content.
    pub existing: Option<&'a str>,
    /// Managed-section id.
    pub managed_id: &'a str,
    /// Marker `source`.
    pub source: &'a str,
    /// Marker `version`.
    pub version: &'a str,
    /// Effective config.
    pub config: &'a JsValue,
    /// `extraVars`.
    pub extra_vars: BTreeMap<String, String>,
    /// Engine rewrite applied after includes, before parsing.
    pub transform: Option<&'a dyn Fn(&str) -> String>,
    /// `engine` (`"claude"` when `None`).
    pub engine: Option<&'a str>,
    /// `forceOverwrite`.
    pub force_overwrite: bool,
    /// The run-wide anti-rollback floor (`setMarkerFloorVersion`).
    pub ambient_floor: Option<&'a str>,
}

/// `RenderManagedFileResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderManagedFileResult {
    /// The destination's next content.
    pub content: String,
    /// What happened.
    pub status: InjectStatus,
    /// Inject details.
    pub details: InjectDetails,
    /// `collision.overwrittenKeys`: the destination had no marker and the asset has frontmatter.
    pub collision: Option<Vec<String>>,
}

/// `interpolateFrontmatter`.
fn interpolate_frontmatter(
    fm: &FrontmatterMap,
    config: &JsValue,
    extra_vars: &BTreeMap<String, String>,
) -> FrontmatterMap {
    if fm.is_empty() {
        return Vec::new();
    }
    let serialized = fm
        .iter()
        .map(|(key, value)| format_frontmatter_field_raw(key, value))
        .collect::<Vec<_>>()
        .join("\n");
    let options = InterpolateOptions {
        extra_vars: extra_vars.clone(),
        omit_unresolved_key_lines: true,
    };
    fields(&interpolate(&serialized, config, &options))
}

/// `/^---\n([\s\S]*?)\n---\n([\s\S]*)$/`: `(frontmatter, rest)`.
fn split_destination(existing: &str) -> Option<(&str, &str)> {
    let rest = existing.strip_prefix("---\n")?;
    let end = rest.find("\n---\n")?;
    Some((&rest[..end], &rest[end + 5..]))
}

/// `renderManagedFile`.
///
/// # Errors
/// [`ManagedFileDelegate`] where the TS throws.
pub fn render_managed_file(
    input: &RenderManagedFileInput<'_>,
) -> Result<RenderManagedFileResult, ManagedFileDelegate> {
    let expanded = expand_hook_includes(input.asset).map_err(|_| ManagedFileDelegate)?;
    let transformed = match input.transform {
        Some(transform) => transform(&expanded),
        None => expanded,
    };
    let raw = condition_orchestration(&transformed, input.config, input.engine.unwrap_or("claude"))
        .map_err(|_| ManagedFileDelegate)?;
    let asset = parse_asset(&raw, input.style);
    let fm = interpolate_frontmatter(&asset.frontmatter, input.config, &input.extra_vars);
    let options = InterpolateOptions {
        extra_vars: input.extra_vars.clone(),
        omit_unresolved_key_lines: false,
    };
    let body = interpolate(&asset.managed_body, input.config, &options);
    let user_template = asset
        .user_template
        .as_deref()
        .map(|template| interpolate(template, input.config, &options));

    let fm_keys: Vec<String> = fm.iter().map(|(key, _)| key.clone()).collect();
    let meta = MarkerMeta {
        source: Some(input.source.to_owned()),
        version: Some(input.version.to_owned()),
        fm_keys: (!fm.is_empty()).then(|| fm_keys.clone()),
        floor_version: None,
    };
    let inject_options = |restamp: bool| InjectOptions {
        shell: input.style == CommentStyle::Shell,
        force_overwrite: input.force_overwrite,
        restamp,
        ambient_floor: input.ambient_floor,
    };

    let Some(existing) = input.existing else {
        let inject =
            inject_managed_section("", input.managed_id, &body, &meta, inject_options(false));
        let fm_block = if fm.is_empty() {
            String::new()
        } else {
            format!("{}\n\n", serialize_frontmatter(&fm))
        };
        let user_tail = user_template
            .as_deref()
            .filter(|template| !template.is_empty())
            .map_or_else(String::new, |template| {
                format!("\n{}\n", js_trim_end(template))
            });
        return Ok(RenderManagedFileResult {
            content: format!("{fm_block}{}\n{user_tail}", js_trim_end(&inject.output)),
            status: InjectStatus::Created,
            details: inject.details,
            collision: None,
        });
    };

    let split = split_destination(existing);
    let dest_fm = split.map(|(block, _)| fields(block)).unwrap_or_default();
    let rest = split.map_or(existing, |(_, rest)| rest);
    let attrs = read_marker_attrs(rest, input.managed_id, input.style);
    let previous_keys = if fm.is_empty() {
        None
    } else {
        attrs.as_ref().and_then(|a| a.existing_fm_keys.clone())
    };
    let fm_header = if !fm.is_empty() {
        format!(
            "{}\n",
            merge_frontmatter(&fm, &dest_fm, previous_keys.as_deref())
        )
    } else if let Some((block, _)) = split {
        format!("---\n{block}\n---\n")
    } else {
        String::new()
    };

    let inject =
        inject_managed_section(rest, input.managed_id, &body, &meta, inject_options(false));
    let mut content = format!("{fm_header}{}", inject.output);
    let mut injected = inject.clone();
    if inject.status == InjectStatus::Unchanged && content != existing {
        injected =
            inject_managed_section(rest, input.managed_id, &body, &meta, inject_options(true));
        content = format!("{fm_header}{}", injected.output);
    }
    let status = if inject.status == InjectStatus::Unchanged {
        if content == existing {
            InjectStatus::Unchanged
        } else {
            InjectStatus::Updated
        }
    } else {
        inject.status
    };
    let collision = (!fm.is_empty() && attrs.is_none()).then(|| {
        fm_keys
            .iter()
            .filter(|key| has(&dest_fm, key))
            .cloned()
            .collect()
    });
    Ok(RenderManagedFileResult {
        content,
        status,
        details: injected.details,
        collision,
    })
}

/// `forcedManagedFileContent`: the "accept new" body, `None` for a downgrade or a no-op.
///
/// # Errors
/// As [`render_managed_file`].
pub fn forced_managed_file_content(
    input: &RenderManagedFileInput<'_>,
) -> Result<Option<String>, ManagedFileDelegate> {
    let forced = render_managed_file(&RenderManagedFileInput {
        force_overwrite: true,
        transform: input.transform,
        extra_vars: input.extra_vars.clone(),
        ..*input
    })?;
    if forced.details.downgrade == Some(true) || Some(forced.content.as_str()) == input.existing {
        return Ok(None);
    }
    Ok(Some(forced.content))
}
