//! Managed-section markers: literal port of `packages/cli/src/lib/render/marker.ts`
//! (spec 0058 D21, R35–R37).
//!
//! The structure follows the TS function by function. Offsets are UTF-8 byte offsets: every TS
//! slice position comes from a regex match or a `\n`, so both indexings cut at the same characters.
//! JS `\s` differs from Rust's (it includes U+FEFF and excludes U+0085), so every pattern spells
//! the JS class out. The anti-rollback floor comes from the caller (D19), never from module state.

use std::sync::LazyLock;

use regex::Regex;

use crate::integrity::{is_js_whitespace, marker_hash, normalize_marker};
use crate::render::context::{Lang, max_semver};
use crate::semver;

/// JS `\s` as a regex class body.
const JS_WS: &str = r"\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";

/// Marker syntax of a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommentStyle {
    /// `<!-- navori:managed … -->`, for Markdown.
    Html,
    /// `# navori:managed start …` / `# navori:managed end …`, for shell scripts.
    Shell,
}

struct Syntax {
    open_prefix: &'static str,
    close_prefix: &'static str,
    suffix: &'static str,
    attrs_and_terminator: &'static str,
}

const HTML: Syntax = Syntax {
    open_prefix: "<!-- navori:managed",
    close_prefix: "<!-- /navori:managed",
    suffix: " -->",
    attrs_and_terminator: "[^>]*-->",
};

const SHELL: Syntax = Syntax {
    open_prefix: "# navori:managed start",
    close_prefix: "# navori:managed end",
    suffix: "",
    attrs_and_terminator: r"[^\n]*",
};

const fn syntax(style: CommentStyle) -> &'static Syntax {
    match style {
        CommentStyle::Html => &HTML,
        CommentStyle::Shell => &SHELL,
    }
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// Builds a regex from a pattern assembled from constants and escaped ids. Construction cannot
/// fail for those inputs; `None` keeps the caller total anyway (an unbuildable pattern matches
/// nothing, which every caller treats as "marker absent").
fn compile(pattern: &str) -> Option<Regex> {
    Regex::new(pattern).ok()
}

fn open_pattern(syntax: &Syntax, id: Option<&str>) -> String {
    let id = id.map_or_else(|| "([^\"]+)".to_owned(), regex::escape);
    format!(
        "{}[{JS_WS}]+id=\"{id}\"{}",
        regex::escape(syntax.open_prefix),
        syntax.attrs_and_terminator
    )
}

static OPEN_ANY: LazyLock<[Option<Regex>; 2]> = LazyLock::new(|| {
    [
        compile(&open_pattern(&HTML, None)),
        compile(&open_pattern(&SHELL, None)),
    ]
});

fn open_any(style: CommentStyle) -> Option<&'static Regex> {
    OPEN_ANY[usize::from(style == CommentStyle::Shell)].as_ref()
}

/// `FENCE_LINE_RE`: `/^\s*(```|~~~)/`.
fn is_fence_line(text: &str) -> bool {
    let rest = text.trim_start_matches(is_js_whitespace);
    rest.starts_with("```") || rest.starts_with("~~~")
}

fn close_marker(id: &str, syntax: &Syntax) -> String {
    format!("{} id=\"{id}\"{}", syntax.close_prefix, syntax.suffix)
}

/// `content.lastIndexOf("\n", from) + 1`.
fn line_start_at(content: &str, from: usize) -> usize {
    let bytes = content.as_bytes();
    if bytes.is_empty() {
        return 0;
    }
    let upto = from.min(bytes.len() - 1);
    bytes[..=upto]
        .iter()
        .rposition(|b| *b == b'\n')
        .map_or(0, |at| at + 1)
}

/// `closeStartAfter`: the close that terminates a block opened before `from`, fence-aware, with
/// the raw-scan fallback for an unbalanced fence in the body.
fn close_start_after(content: &str, close: &str, from: usize) -> Option<usize> {
    let mut line_start = line_start_at(content, from);
    let mut in_fence = false;
    while line_start <= content.len() {
        let nl = content[line_start..]
            .find('\n')
            .map_or(content.len(), |at| line_start + at);
        let text = &content[line_start..nl];
        if is_fence_line(text) {
            in_fence = !in_fence;
        } else if !in_fence {
            let skip = from.saturating_sub(line_start).min(text.len());
            if let Some(at) = text.get(skip..).and_then(|rest| rest.find(close)) {
                return Some(line_start + skip + at);
            }
        }
        line_start = nl + 1;
    }
    content.get(from..)?.find(close).map(|at| from + at)
}

/// A line outside every fence and every managed body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProseLine<'a> {
    /// Line text without its newline.
    pub text: &'a str,
    /// 0-based line number.
    pub index: usize,
    /// Byte offset of the line within the document.
    pub offset: usize,
}

/// `proseLines`: the single fence mechanism, with the fence-blind rescan of an unclosed fence.
#[must_use]
pub fn prose_lines<'a>(content: &'a str, styles: &[CommentStyle]) -> Vec<ProseLine<'a>> {
    let (lines, fence_left_open) = scan_prose(content, styles, true);
    if fence_left_open {
        scan_prose(content, styles, false).0
    } else {
        lines
    }
}

fn scan_prose<'a>(
    content: &'a str,
    styles: &[CommentStyle],
    fence_aware: bool,
) -> (Vec<ProseLine<'a>>, bool) {
    let lines: Vec<&str> = content.split('\n').collect();
    let mut out = Vec::new();
    let mut offset = 0;
    let mut in_fence = false;
    let mut li = 0;
    while li < lines.len() {
        let text = lines[li];
        let line_start = offset;
        offset += text.len() + 1;
        if fence_aware {
            if is_fence_line(text) {
                in_fence = !in_fence;
                li += 1;
                continue;
            }
            if in_fence {
                li += 1;
                continue;
            }
        }
        out.push(ProseLine {
            text,
            index: li,
            offset: line_start,
        });
        let mut body_end: Option<usize> = None;
        for style in styles {
            let syntax = syntax(*style);
            let Some(captures) = open_any(*style).and_then(|re| re.captures(text)) else {
                continue;
            };
            let (Some(whole), Some(id)) = (captures.get(0), captures.get(1)) else {
                continue;
            };
            let close = close_marker(id.as_str(), syntax);
            if let Some(close_start) = close_start_after(content, &close, line_start + whole.end())
            {
                let end = close_start + close.len();
                body_end = Some(body_end.map_or(end, |current| current.max(end)));
            }
        }
        if let Some(body_end) = body_end {
            while offset <= body_end && li + 1 < lines.len() {
                li += 1;
                offset += lines[li].len() + 1;
            }
        }
        li += 1;
    }
    (out, in_fence)
}

/// A managed block's id and span, markers included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocatedBlock {
    /// Block id.
    pub id: String,
    /// Offset of the open marker.
    pub open_start: usize,
    /// Offset just past the close marker.
    pub close_end: usize,
}

/// `locateManagedBlocks`: every closed block, in document order.
#[must_use]
pub fn locate_managed_blocks(content: &str, style: CommentStyle) -> Vec<LocatedBlock> {
    let syntax = syntax(style);
    let Some(open) = open_any(style) else {
        return Vec::new();
    };
    let mut blocks = Vec::new();
    for line in prose_lines(content, &[style]) {
        let Some(captures) = open.captures(line.text) else {
            continue;
        };
        let (Some(whole), Some(id)) = (captures.get(0), captures.get(1)) else {
            continue;
        };
        let open_start = line.offset + whole.start();
        let close = close_marker(id.as_str(), syntax);
        if let Some(close_start) = close_start_after(content, &close, line.offset + whole.end()) {
            blocks.push(LocatedBlock {
                id: id.as_str().to_owned(),
                open_start,
                close_end: close_start + close.len(),
            });
        }
    }
    blocks
}

/// Attributes of an open marker.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MarkerAttrs {
    /// `hash="…"`.
    pub existing_hash: Option<String>,
    /// `version="…"`.
    pub existing_version: Option<String>,
    /// `source="…"`.
    pub existing_source: Option<String>,
    /// `fmkeys="a,b"`, split on commas.
    pub existing_fm_keys: Option<Vec<String>>,
}

struct MarkerMatch {
    open_start: usize,
    open_end: usize,
    close_end: usize,
    attrs: MarkerAttrs,
    content: String,
}

/// `extractAttr`: the first `name="…"` in the open marker.
fn extract_attr(open: &str, name: &str) -> Option<String> {
    let needle = format!("{name}=\"");
    let mut from = 0;
    while let Some(at) = open[from..].find(&needle) {
        let value_start = from + at + needle.len();
        let rest = &open[value_start..];
        match rest.find('"') {
            Some(0) => from = value_start,
            Some(end) => return Some(rest[..end].to_owned()),
            None => return None,
        }
    }
    None
}

fn attrs_of(open: &str) -> MarkerAttrs {
    MarkerAttrs {
        existing_hash: extract_attr(open, "hash"),
        existing_version: extract_attr(open, "version"),
        existing_source: extract_attr(open, "source"),
        existing_fm_keys: extract_attr(open, "fmkeys")
            .map(|raw| raw.split(',').map(str::to_owned).collect()),
    }
}

/// `findMarker`: the write path's parser, fence-aware on both halves.
fn find_marker(existing: &str, id: &str, style: CommentStyle) -> Option<MarkerMatch> {
    let syntax = syntax(style);
    let open = compile(&open_pattern(syntax, Some(id)))?;
    let close = close_marker(id, syntax);
    for line in prose_lines(existing, &[style]) {
        let Some(found) = open.find(line.text) else {
            continue;
        };
        let open_start = line.offset + found.start();
        let open_end = line.offset + found.end();
        let Some(close_start) = close_start_after(existing, &close, open_end) else {
            continue;
        };
        let normalized = normalize_marker(&existing[open_end..close_start]);
        let content = normalized
            .strip_prefix('\n')
            .unwrap_or(&normalized)
            .to_owned();
        return Some(MarkerMatch {
            open_start,
            open_end,
            close_end: close_start + close.len(),
            attrs: attrs_of(found.as_str()),
            content,
        });
    }
    None
}

/// `readMarkerAttrs`.
#[must_use]
pub fn read_marker_attrs(existing: &str, id: &str, style: CommentStyle) -> Option<MarkerAttrs> {
    find_marker(existing, id, style).map(|found| found.attrs)
}

/// `extractManagedContent`.
#[must_use]
pub fn extract_managed_content(existing: &str, id: &str, style: CommentStyle) -> Option<String> {
    find_marker(existing, id, style).map(|found| found.content)
}

/// `computeManagedHash`.
#[must_use]
pub fn compute_managed_hash(body: &str) -> String {
    marker_hash(body)
}

/// Marker metadata, `MarkerMeta`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MarkerMeta {
    /// Source package id.
    pub source: Option<String>,
    /// Version stamped into the marker.
    pub version: Option<String>,
    /// Frontmatter keys snapshot.
    pub fm_keys: Option<Vec<String>>,
    /// Per-block anti-rollback floor; input only, never written.
    pub floor_version: Option<String>,
}

fn open_marker(id: &str, hash: &str, meta: &MarkerMeta, syntax: &Syntax) -> String {
    let mut parts = vec![
        format!("{} id=\"{id}\"", syntax.open_prefix),
        format!("hash=\"{hash}\""),
    ];
    if let Some(version) = meta.version.as_deref().filter(|v| !v.is_empty()) {
        parts.push(format!("version=\"{version}\""));
    }
    if let Some(source) = meta.source.as_deref().filter(|s| !s.is_empty()) {
        parts.push(format!("source=\"{source}\""));
    }
    if let Some(keys) = meta.fm_keys.as_ref().filter(|keys| !keys.is_empty()) {
        parts.push(format!("fmkeys=\"{}\"", keys.join(",")));
    }
    parts.join(" ") + syntax.suffix
}

fn build_block(id: &str, hash: &str, meta: &MarkerMeta, syntax: &Syntax, content: &str) -> String {
    let open = open_marker(id, hash, meta, syntax);
    let close = close_marker(id, syntax);
    if content.is_empty() {
        if syntax.suffix.is_empty() {
            format!("{open}\n{close}")
        } else {
            format!("{open}{close}")
        }
    } else {
        format!("{open}\n{content}\n{close}")
    }
}

static TRIPLE_NEWLINES: LazyLock<Option<Regex>> = LazyLock::new(|| compile(r"\n{3,}"));

/// `stripOrphanMarkers`: removes every unpaired open or close of `id`, outside fences.
fn strip_orphan_markers(existing: &str, id: &str, style: CommentStyle) -> String {
    let syntax = syntax(style);
    let close = close_marker(id, syntax);
    let Some(open) = compile(&open_pattern(syntax, Some(id))) else {
        return existing.to_owned();
    };
    let lines = prose_lines(existing, &[style]);
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut paired_closes: Vec<usize> = Vec::new();
    for line in &lines {
        for found in open.find_iter(line.text) {
            let index = line.offset + found.start();
            match close_start_after(existing, &close, index + found.len()) {
                None => spans.push((index, found.len())),
                Some(close_start) => paired_closes.push(close_start),
            }
        }
    }
    for line in &lines {
        let mut search = 0;
        while let Some(at) = line.text.get(search..).and_then(|rest| rest.find(&close)) {
            let at = search + at;
            let index = line.offset + at;
            if !paired_closes.contains(&index) {
                spans.push((index, close.len()));
            }
            search = at + 1;
        }
    }
    if spans.is_empty() {
        return existing.to_owned();
    }
    spans.sort_by_key(|span| std::cmp::Reverse(span.0));
    let mut cleaned = existing.to_owned();
    for (index, length) in spans {
        cleaned.replace_range(index..index + length, "");
    }
    match TRIPLE_NEWLINES.as_ref() {
        Some(re) => re.replace_all(&cleaned, "\n\n").into_owned(),
        None => cleaned,
    }
}

/// `InjectResult.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectStatus {
    /// The block did not exist.
    Created,
    /// Body or marker rewritten.
    Updated,
    /// Nothing to write.
    Unchanged,
    /// Hand-edited block preserved.
    UserModifiedSkipped,
    /// Block written by a newer navori preserved.
    DowngradeSkipped,
}

impl InjectStatus {
    /// The TS status string.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Created => "created",
            Self::Updated => "updated",
            Self::Unchanged => "unchanged",
            Self::UserModifiedSkipped => "user-modified-skipped",
            Self::DowngradeSkipped => "downgrade-skipped",
        }
    }
}

/// `InjectResult.details`. `version_drift` and `downgrade` are absent on `created`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectDetails {
    /// `hash=` of the existing marker.
    pub existing_hash: Option<String>,
    /// Hash of the existing body.
    pub actual_hash: String,
    /// Hash of the new body.
    pub new_hash: String,
    /// `version=` of the existing marker.
    pub existing_version: Option<String>,
    /// `source=` of the existing marker.
    pub existing_source: Option<String>,
    /// Body differs and the versions differ.
    pub version_drift: Option<bool>,
    /// The existing block is from a newer navori.
    pub downgrade: Option<bool>,
}

/// `InjectResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InjectResult {
    /// The document after the operation.
    pub output: String,
    /// What happened.
    pub status: InjectStatus,
    /// Hashes and versions involved.
    pub details: InjectDetails,
}

/// Options of [`inject_managed_section`] beyond the block itself.
#[derive(Debug, Clone, Copy, Default)]
pub struct InjectOptions<'a> {
    /// Shell markers instead of HTML ones.
    pub shell: bool,
    /// `forceOverwrite`: the "accept new" resolution.
    pub force_overwrite: bool,
    /// `restamp`: stamp the version even when the body is identical.
    pub restamp: bool,
    /// The run-wide floor (the TS `ambientFloorVersion`), from the render context.
    pub ambient_floor: Option<&'a str>,
}

/// `injectManagedSection`.
#[must_use]
pub fn inject_managed_section(
    existing: &str,
    id: &str,
    new_content: &str,
    meta: &MarkerMeta,
    options: InjectOptions<'_>,
) -> InjectResult {
    let style = if options.shell {
        CommentStyle::Shell
    } else {
        CommentStyle::Html
    };
    let syntax = syntax(style);
    let existing = strip_orphan_markers(existing, id, style);
    let new_hash = marker_hash(new_content);
    let canonical = normalize_marker(new_content);

    let Some(found) = find_marker(&existing, id, style) else {
        let details = InjectDetails {
            existing_hash: None,
            actual_hash: new_hash.clone(),
            new_hash: new_hash.clone(),
            existing_version: None,
            existing_source: None,
            version_drift: None,
            downgrade: None,
        };
        let block = build_block(id, &new_hash, meta, syntax, &canonical);
        let siblings = locate_managed_blocks(&existing, style);
        let output = if let Some(last) = siblings.last() {
            let head = &existing[..last.close_end];
            let tail = &existing[last.close_end..];
            let newline = if tail.starts_with('\n') { "" } else { "\n" };
            format!("{head}\n\n{block}{newline}{tail}")
        } else {
            let sep = if existing.is_empty() || existing.ends_with("\n\n") {
                ""
            } else if existing.ends_with('\n') {
                "\n"
            } else {
                "\n\n"
            };
            format!("{existing}{sep}{block}\n")
        };
        return InjectResult {
            output,
            status: InjectStatus::Created,
            details,
        };
    };

    let attrs = &found.attrs;
    let actual_hash = marker_hash(&found.content);
    let user_modified = attrs
        .existing_hash
        .as_ref()
        .is_some_and(|hash| *hash != actual_hash);
    let body_unchanged = canonical == found.content;
    let version_drift = !body_unchanged
        && attrs.existing_version.is_some()
        && meta.version.is_some()
        && attrs.existing_version != meta.version;
    let floor = meta.floor_version.as_deref().or(options.ambient_floor);
    let downgrade = semver::is_downgrade(
        max_semver(attrs.existing_version.as_deref(), floor),
        meta.version.as_deref(),
    );
    let details = InjectDetails {
        existing_hash: attrs.existing_hash.clone(),
        actual_hash: actual_hash.clone(),
        new_hash: new_hash.clone(),
        existing_version: attrs.existing_version.clone(),
        existing_source: attrs.existing_source.clone(),
        version_drift: Some(version_drift),
        downgrade: Some(downgrade),
    };
    let result = |output: String, status: InjectStatus| InjectResult {
        output,
        status,
        details: details.clone(),
    };

    if body_unchanged {
        let existing_keys = attrs.existing_fm_keys.clone().unwrap_or_default().join(",");
        let desired_keys = meta.fm_keys.clone().unwrap_or_default().join(",");
        let same_version = (!options.restamp && attrs.existing_version.is_some())
            || attrs.existing_version == meta.version;
        let same_meta = attrs.existing_hash.as_deref() == Some(new_hash.as_str())
            && same_version
            && attrs.existing_source == meta.source
            && existing_keys == desired_keys;
        if same_meta || (downgrade && !options.force_overwrite) {
            return result(existing.clone(), InjectStatus::Unchanged);
        }
        let replaced = format!(
            "{}{}{}",
            &existing[..found.open_start],
            open_marker(id, &new_hash, meta, syntax),
            &existing[found.open_end..]
        );
        return result(replaced, InjectStatus::Updated);
    }

    if downgrade && !options.force_overwrite {
        return result(existing.clone(), InjectStatus::DowngradeSkipped);
    }
    if user_modified && !options.force_overwrite {
        return result(existing.clone(), InjectStatus::UserModifiedSkipped);
    }
    let block = build_block(id, &new_hash, meta, syntax, &canonical);
    let replaced = format!(
        "{}{block}{}",
        &existing[..found.open_start],
        &existing[found.close_end..]
    );
    result(replaced, InjectStatus::Updated)
}

/// `removeManagedSection`: drops the block and one trailing newline.
#[must_use]
pub fn remove_managed_section(existing: &str, id: &str, style: CommentStyle) -> String {
    let Some(found) = find_marker(existing, id, style) else {
        return existing.to_owned();
    };
    let mut end = found.close_end;
    if existing.as_bytes().get(end) == Some(&b'\n') {
        end += 1;
    }
    format!("{}{}", &existing[..found.open_start], &existing[end..])
}

/// Why [`remove_managed_section_guarded`] kept a block.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kept {
    /// Written by a newer navori than `cli_version`.
    Newer,
    /// Hand-edited, or no `version` at all.
    Modified,
}

/// `removeManagedSectionGuarded`. `cli_version` is what the TS reads with `readCliVersion()`:
/// the stamp version (D20). The floor does not apply here, exactly as in the TS (F25).
///
/// # Errors
/// Returns why the block is not navori's to remove.
pub fn remove_managed_section_guarded(
    existing: &str,
    id: &str,
    style: CommentStyle,
    cli_version: &str,
) -> Result<String, Kept> {
    let Some(attrs) = read_marker_attrs(existing, id, style) else {
        return Ok(existing.to_owned());
    };
    let Some(version) = attrs.existing_version.as_deref() else {
        return Err(Kept::Modified);
    };
    if semver::is_downgrade(Some(version), Some(cli_version)) {
        return Err(Kept::Newer);
    }
    let body = extract_managed_content(existing, id, style);
    if let (Some(hash), Some(body)) = (attrs.existing_hash.as_deref(), body.as_deref())
        && compute_managed_hash(body) != hash
    {
        return Err(Kept::Modified);
    }
    Ok(remove_managed_section(existing, id, style))
}

/// `ReorderResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReorderResult {
    /// The document after reordering.
    pub output: String,
    /// The block order changed.
    pub reordered: bool,
    /// Skipped because prose sits between two blocks.
    pub blocked_by_interleaving: bool,
}

/// `reorderManagedBlocks`.
#[must_use]
pub fn reorder_managed_blocks(
    content: &str,
    canonical_order: &[&str],
    style: CommentStyle,
) -> ReorderResult {
    let unchanged = |blocked: bool| ReorderResult {
        output: content.to_owned(),
        reordered: false,
        blocked_by_interleaving: blocked,
    };
    let blocks = locate_managed_blocks(content, style);
    if blocks.len() < 2 {
        return unchanged(false);
    }
    let rank = |id: &str| canonical_order.iter().position(|known| *known == id);
    let mut desired: Vec<(usize, usize)> = blocks
        .iter()
        .enumerate()
        .map(|(i, block)| (rank(&block.id).unwrap_or(canonical_order.len() + i), i))
        .collect();
    desired.sort_unstable();
    if desired
        .iter()
        .enumerate()
        .all(|(i, (_, original))| i == *original)
    {
        return unchanged(false);
    }
    for pair in blocks.windows(2) {
        if !js_trim(&content[pair[0].close_end..pair[1].open_start]).is_empty() {
            return unchanged(true);
        }
    }
    let (Some(first), Some(last)) = (blocks.first(), blocks.last()) else {
        return unchanged(false);
    };
    let preamble = &content[..first.open_start];
    let suffix = &content[last.close_end..];
    let body = desired
        .iter()
        .map(|(_, i)| &content[blocks[*i].open_start..blocks[*i].close_end])
        .collect::<Vec<_>>()
        .join("\n\n");
    let pre = if preamble.is_empty() {
        String::new()
    } else {
        format!("{}\n\n", preamble.trim_end_matches('\n'))
    };
    ReorderResult {
        output: format!("{pre}{body}{suffix}"),
        reordered: true,
        blocked_by_interleaving: false,
    }
}

/// Opening delimiter of the user zone.
pub const USER_SECTION_START: &str = "<!-- navori:user-start -->";
/// Closing delimiter of the user zone.
pub const USER_SECTION_END: &str = "<!-- navori:user-end -->";

/// `common.userSectionPlaceholder` per locale.
#[must_use]
pub const fn user_section_placeholder(lang: Lang) -> &'static str {
    match lang {
        Lang::Es => {
            "<!-- Escribe aquí el dominio y las convenciones específicas de tu repo. navori preserva intacto todo lo que esté entre estos marcadores en cada render. -->"
        }
        Lang::En => {
            "<!-- Write your repo's domain and specific conventions here. navori preserves everything between these markers verbatim on every render. -->"
        }
    }
}

static LEGACY_USER_HINT: LazyLock<Option<Regex>> = LazyLock::new(|| {
    compile(&format!(
        r"(?s)<!--[{JS_WS}]*Zona de proyecto \(no-managed\).*?-->"
    ))
});

/// `extractUserProse`: the real prose of a trailing region, fence-aware and line-oriented.
fn extract_user_prose(raw: &str) -> String {
    let normalized = normalize_marker(raw);
    let without_legacy = match LEGACY_USER_HINT.as_ref() {
        Some(re) => re.replace_all(&normalized, "").into_owned(),
        None => normalized,
    };
    let lines: Vec<&str> = without_legacy.split('\n').collect();
    let fence_aware = lines.iter().filter(|line| is_fence_line(line)).count() % 2 == 0;
    let placeholders = [
        user_section_placeholder(Lang::Es),
        user_section_placeholder(Lang::En),
    ];
    let mut in_fence = false;
    let kept: Vec<&str> = lines
        .into_iter()
        .filter(|line| {
            if fence_aware && is_fence_line(line) {
                in_fence = !in_fence;
                return true;
            }
            if in_fence {
                return true;
            }
            let trimmed = js_trim(line);
            trimmed != USER_SECTION_START
                && trimmed != USER_SECTION_END
                && !placeholders.contains(&trimmed)
        })
        .collect();
    js_trim(&kept.join("\n")).to_owned()
}

/// `UserSectionSplit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserSectionSplit {
    /// The document without the user zone.
    pub managed: String,
    /// The user prose, or `None` when there is nothing to preserve.
    pub user_body: Option<String>,
    /// Explicit user markers were present.
    pub had_markers: bool,
}

/// `splitUserSection`.
#[must_use]
pub fn split_user_section(content: &str, style: CommentStyle) -> UserSectionSplit {
    let blocks = locate_managed_blocks(content, style);
    let Some(last) = blocks.last() else {
        return UserSectionSplit {
            managed: content.to_owned(),
            user_body: None,
            had_markers: content.contains(USER_SECTION_START),
        };
    };
    let trailing = &content[last.close_end..];
    let body = extract_user_prose(trailing);
    UserSectionSplit {
        managed: content[..last.close_end].to_owned(),
        user_body: (!body.is_empty()).then_some(body),
        had_markers: trailing.contains(USER_SECTION_START),
    }
}

/// `emitUserSection`.
#[must_use]
pub fn emit_user_section(managed: &str, user_body: Option<&str>, lang: Lang) -> String {
    let base = managed.trim_end_matches(is_js_whitespace);
    let inner = match user_body.map(js_trim) {
        Some(body) if !body.is_empty() => body,
        _ => user_section_placeholder(lang),
    };
    format!("{base}\n\n{USER_SECTION_START}\n\n{inner}\n\n{USER_SECTION_END}\n")
}
