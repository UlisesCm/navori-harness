//! Port of the read side of `lib/workspace/dominio.ts` and `dominio-inject.ts` (spec 0059 D34):
//! the entries of a workspace's Dominio and the index `dominio inject` prints.

use std::cmp::Ordering;
use std::fs;
use std::sync::LazyLock;

use regex::Regex;

use super::registry::{self, Stop};
use crate::collate::{compare_ascii, default_locale_modeled};
use crate::js_re::ws;
use crate::posix::js_trim;
use crate::process::Env;
use crate::render::context::Lang;
use crate::render::frontmatter::{get_frontmatter_field, split_frontmatter};

const INDEX_NAME: &str = "DOMINIO.md";
const SUMMARY_MAX: usize = 140;

/// `DominioStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Status {
    Canonical,
    Deprecated,
    Superseded,
}

/// The fields of a `DominioEntry` the index reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// The file name without `.md`.
    pub id: String,
    /// `title`, trimmed, or the id.
    pub title: String,
    /// `applies-to`: `None` is `"all"`.
    pub applies_to: Option<Vec<String>>,
    /// `status`, `canonical` when unknown.
    pub status: Status,
    /// First non-empty body line, cleaned and capped.
    pub summary: String,
}

/// `parseList`: `[a, b]` or `a, b`, each item trimmed and stripped of one quote at each end.
fn parse_list(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return Vec::new();
    };
    let inner = js_trim(raw);
    let inner = inner.strip_prefix('[').unwrap_or(inner);
    let inner = inner.strip_suffix(']').unwrap_or(inner);
    inner
        .split(',')
        .map(|item| {
            let item = js_trim(item);
            let item = item.strip_prefix(['"', '\'']).unwrap_or(item);
            item.strip_suffix(['"', '\'']).unwrap_or(item).to_owned()
        })
        .filter(|item| !item.is_empty())
        .collect()
}

/// `parseAppliesTo`.
fn parse_applies_to(raw: Option<&str>) -> Option<Vec<String>> {
    if let Some(raw) = raw.filter(|r| !r.is_empty()) {
        // `.trim().replace(/^\[|\]$/g, "").trim().toLowerCase() === "all"`
        let trimmed = js_trim(raw);
        let trimmed = trimmed.strip_prefix('[').unwrap_or(trimmed);
        let trimmed = trimmed.strip_suffix(']').unwrap_or(trimmed);
        if js_trim(trimmed).to_lowercase() == "all" {
            return None;
        }
    }
    Some(parse_list(raw))
}

static NOISE: LazyLock<Option<(Regex, Regex)>> = LazyLock::new(|| {
    let s = ws();
    Some((
        Regex::new(&format!("^#+{s}+")).ok()?,
        Regex::new(&format!("^[-*]{s}+")).ok()?,
    ))
});

/// `firstBodyLine`: the summary, capped at 140 UTF-16 units with an ellipsis. A cut through a
/// surrogate pair leaves a lone surrogate in JS, which stdout writes as U+FFFD.
fn first_body_line(body: &str) -> Result<String, Stop> {
    let (heading, bullet) = NOISE.as_ref().ok_or(Stop::Delegate("summary patterns"))?;
    for line in body.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let trimmed = js_trim(line);
        if trimmed.is_empty() {
            continue;
        }
        let clean = heading.replace(trimmed, "");
        let clean = bullet.replace(&clean, "").replace("**", "");
        if clean.is_empty() {
            continue;
        }
        let units: Vec<u16> = clean.encode_utf16().collect();
        if units.len() <= SUMMARY_MAX {
            return Ok(clean);
        }
        let mut cut = String::from_utf16_lossy(&units[..SUMMARY_MAX - 1]);
        cut.push('…');
        return Ok(cut);
    }
    Ok(String::new())
}

/// `readEntry(path)`: an unreadable file is a blank entry.
fn read_entry(id: &str, path: &std::path::Path) -> Result<Entry, Stop> {
    let Ok(bytes) = fs::read(path) else {
        return Ok(Entry {
            id: id.to_owned(),
            title: id.to_owned(),
            applies_to: Some(Vec::new()),
            status: Status::Canonical,
            summary: String::new(),
        });
    };
    let raw = String::from_utf8(bytes).map_err(|_| Stop::Delegate("entry is not UTF-8"))?;
    parse_entry(id, &raw)
}

/// `readEntry` over the text of `<id>.md`.
///
/// # Errors
/// [`Stop::Delegate`] when the summary patterns do not compile.
pub fn parse_entry(id: &str, raw: &str) -> Result<Entry, Stop> {
    let split = split_frontmatter(raw);
    let field = |key: &str| get_frontmatter_field(split.frontmatter, key);
    let title = field("title")
        .map(|t| js_trim(&t).to_owned())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| id.to_owned());
    let status = match field("status").as_deref() {
        Some("deprecated") => Status::Deprecated,
        Some("superseded") => Status::Superseded,
        _ => Status::Canonical,
    };
    Ok(Entry {
        id: id.to_owned(),
        title,
        applies_to: parse_applies_to(field("applies-to").as_deref()),
        status,
        summary: first_body_line(split.body)?,
    })
}

/// `listEntries(ws)`: canonical, then deprecated, then superseded, by title within. Titles are
/// ordered by `localeCompare`; only the shape [`compare_ascii`] models is native.
///
/// # Errors
/// [`Stop::Throw`] when the Dominio directory cannot be read; [`Stop::Delegate`] for a title
/// order or file the port does not model.
pub fn list_entries(env: &Env, workspace: &str) -> Result<Vec<Entry>, Stop> {
    let dir = registry::directory(env, workspace)?.join("dominio");
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|_| Stop::Throw)? {
        let entry = entry.map_err(|_| Stop::Throw)?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| Stop::Delegate("non-UTF-8 entry name"))?;
        names.push(name);
    }
    // libuv's scandir sorts by byte order, so `readdirSync` does too.
    names.sort();
    let mut out = Vec::new();
    for name in names {
        let Some(id) = name.strip_suffix(".md") else {
            continue;
        };
        if name == INDEX_NAME {
            continue;
        }
        let full = dir.join(&name);
        if !fs::metadata(&full).is_ok_and(|meta| meta.is_file()) {
            continue;
        }
        out.push(read_entry(id, &full)?);
    }
    // `rank[a] - rank[b] || a.title.localeCompare(b.title)`: titles are compared only on a tie.
    let modeled = default_locale_modeled(env);
    let mut unmodeled = false;
    out.sort_by(|a, b| {
        a.status.cmp(&b.status).then_with(|| {
            modeled
                .then(|| compare_ascii(&a.title, &b.title))
                .flatten()
                .unwrap_or_else(|| {
                    unmodeled = true;
                    Ordering::Equal
                })
        })
    });
    if unmodeled {
        return Err(Stop::Delegate("title order outside the modeled collation"));
    }
    Ok(out)
}

/// `dominio.injectHeader` and `dominio.injectHint`.
#[must_use]
pub fn inject_strings(lang: Lang, workspace: &str) -> (String, &'static str) {
    match lang {
        Lang::Es => (
            format!(
                "## Dominio del workspace '{workspace}' — conocimiento canónico transversal a los repos"
            ),
            "Consulta estas entradas antes de asumir modelo de datos o reglas de negocio; abre el archivo completo cuando necesites el detalle.",
        ),
        Lang::En => (
            format!("## Workspace Dominio for '{workspace}' — canonical cross-repo knowledge"),
            "Consult these entries before assuming a data model or business rule; open the full file when you need the detail.",
        ),
    }
}

/// `workspaceLang(name)`: the workspace's `defaults.language`, Spanish when it does not load.
fn workspace_lang(env: &Env, workspace: &str) -> Result<Lang, Stop> {
    match registry::load(env, workspace) {
        Ok(found) => Ok(Lang::resolve(found.and_then(|w| w.language).as_deref())),
        Err(Stop::Throw) => Ok(Lang::resolve(None)),
        Err(stop) => Err(stop),
    }
}

fn render_block(workspace: &str, entries: &[Entry], lang: Lang) -> String {
    let (header, hint) = inject_strings(lang, workspace);
    let mut lines = vec![header, String::new(), hint.to_owned(), String::new()];
    for e in entries {
        let scope = match &e.applies_to {
            None => "all".to_owned(),
            Some(list) => list.join(", "),
        };
        let scope_tag = if scope.is_empty() {
            String::new()
        } else {
            format!(" ({scope})")
        };
        let dep = if e.status == Status::Deprecated {
            " [deprecated]"
        } else {
            ""
        };
        let summary = if e.summary.is_empty() {
            String::new()
        } else {
            format!(" — {}", e.summary)
        };
        lines.push(format!(
            "- **{}**{dep}{summary}  ·  `workspace://{workspace}/dominio/{}.md`{scope_tag}",
            e.title, e.id
        ));
    }
    lines.join("\n")
}

/// `dominioInjectText()` from `cwd`: the index of every workspace `cwd` belongs to, or `""`.
///
/// # Errors
/// [`Stop::Throw`] where the TS throws (a broken store); [`Stop::Delegate`] where only it answers.
pub fn inject_text(env: &Env, cwd: &str) -> Result<String, Stop> {
    let mut blocks = Vec::new();
    for workspace in registry::for_cwd(env, cwd)? {
        let entries: Vec<Entry> = list_entries(env, &workspace)?
            .into_iter()
            .filter(|e| e.status != Status::Superseded)
            .collect();
        if entries.is_empty() {
            continue;
        }
        blocks.push(render_block(
            &workspace,
            &entries,
            workspace_lang(env, &workspace)?,
        ));
    }
    Ok(if blocks.is_empty() {
        String::new()
    } else {
        format!("{}\n", blocks.join("\n\n"))
    })
}
