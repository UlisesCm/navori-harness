//! `navori master check` (`lib/master/checks.ts` and `check-helpers.ts`): the mechanical checks of
//! the transition out of the active legacy stage's phase, `STATUS.md` against its render, and the
//! integrity of a closed stage (`check --stage`). Nothing here writes.
//!
//! What it does not reproduce returns [`Delegate`]: the content checks of `UX.md`/`ux.json`,
//! the closed `deliveries` stage, and every place the TS throws (invalid JSON, a file that is not
//! UTF-8 or is a directory, a schema issue whose message is zod's).

use std::fs;
use std::path::Path;
use std::sync::LazyLock;

use regex::Regex;
use sha2::{Digest, Sha256};

use super::check_part::PartConfig;
use super::index::{self, MasterIndex, StageEntry, StageState};
use super::markers::{Markers, master_markers};
use super::render::{master_parts_region, render_master_parts, render_status_md};
use super::state::{self, MASTER_PHASES, MasterState};
use super::status::{self, Delegate, read_json, ux_artifacts, ux_decision};
use super::templates::{TemplateSection, split_template_sections, template_headers};
use crate::integrity::is_js_whitespace;
use crate::spec::text::ci;

/// What each check reads of the active stage.
pub struct CheckContext<'a> {
    pub english: bool,
    pub master_dir: &'a str,
    pub index: &'a MasterIndex,
    pub stage: &'a StageEntry,
    pub stage_path: &'a str,
    pub state: &'a MasterState,
}

/// The active stage with its parsed `state.json` (`CheckContext` without the config).
#[derive(Debug, Clone, PartialEq)]
pub struct StageCtx {
    pub stage: StageEntry,
    pub stage_path: String,
    pub state: MasterState,
}

/// Node's `path.join(base, rel)` over a POSIX absolute `base`: concatenated, normalized, and with
/// the trailing slash `rel` carries.
#[must_use]
pub fn js_join(base: &str, rel: &str) -> String {
    let combined = format!("{base}/{rel}");
    let mut parts: Vec<&str> = Vec::new();
    for part in combined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    let mut out = format!("/{}", parts.join("/"));
    if combined.ends_with('/') && out != "/" {
        out.push('/');
    }
    out
}

fn trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

fn normalize_eol(text: &str) -> String {
    text.replace("\r\n", "\n").replace('\r', "\n")
}

/// `readFileSync(path, "utf8")` when `path` exists; `Delegate` where Node would throw or decode
/// lossily.
fn read_text(path: &str) -> Result<Option<String>, Delegate> {
    if !Path::new(path).exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|_| Delegate)?;
    String::from_utf8(bytes).map(Some).map_err(|_| Delegate)
}

/// `readStageFile(ctx, rel)`: the file with normalized line endings, or `None` when it is absent.
fn read_stage_file(stage_path: &str, rel: &str) -> Result<Option<String>, Delegate> {
    Ok(read_text(&js_join(stage_path, rel))?.map(|t| normalize_eol(&t)))
}

fn section_of<'a>(sections: &'a [TemplateSection], heading: &str) -> Option<&'a TemplateSection> {
    // `new Map(entries)`: the last section with a heading wins.
    sections.iter().rev().find(|s| s.heading == heading)
}

/// `validateSections(content, expected, label, noAplica)`.
#[must_use]
pub fn validate_sections(
    content: &str,
    expected: &[String],
    label: &str,
    no_aplica: &str,
) -> Vec<String> {
    let sections = split_template_sections(content);
    let mut failures = Vec::new();
    for heading in expected {
        let Some(section) = section_of(&sections, heading) else {
            failures.push(format!("{label}: falta la sección \"## {heading}\""));
            continue;
        };
        if trim(&section.body).is_empty() {
            failures.push(format!("{label}: la sección \"## {heading}\" está vacía"));
            continue;
        }
        let line = section.body.split('\n').find(|l| {
            l.trim_start_matches(is_js_whitespace)
                .starts_with(no_aplica)
        });
        if let Some(line) = line {
            let after = line
                .find(no_aplica)
                .map_or("", |at| &line[at + no_aplica.len()..]);
            if trim(after).is_empty() {
                failures.push(format!(
                    "{label}: \"## {heading}\" dice \"{no_aplica}\" sin razón"
                ));
            }
        }
    }
    failures
}

/// JS `\w`.
const fn is_word(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

/// `\bD(\d+)\b` at `at`: the end of the match.
fn decision_at(b: &[u8], at: usize) -> Option<usize> {
    if b.get(at) != Some(&b'D') || (at > 0 && is_word(b[at - 1])) {
        return None;
    }
    let digits = b[at + 1..]
        .iter()
        .take_while(|c| c.is_ascii_digit())
        .count();
    let end = at + 1 + digits;
    (digits > 0 && b.get(end).is_none_or(|c| !is_word(*c))).then_some(end)
}

/// The distinct `D<n>` and `NN-slug/D<n>` citations of `content`, in order of appearance
/// (`/(?:\b(\d{2}-[a-z0-9-]+)\/)?\bD(\d+)\b/g`).
fn cited_decisions(content: &str) -> Vec<String> {
    let b = content.as_bytes();
    let mut out: Vec<String> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let mut found: Option<(String, usize)> = None;
        let boundary = i == 0 || !is_word(b[i - 1]);
        if boundary
            && b[i].is_ascii_digit()
            && b.get(i + 1).is_some_and(u8::is_ascii_digit)
            && b.get(i + 2) == Some(&b'-')
        {
            let run = b[i + 3..]
                .iter()
                .take_while(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || **c == b'-')
                .count();
            let slash = i + 3 + run;
            if run >= 1
                && b.get(slash) == Some(&b'/')
                && let Some(end) = decision_at(b, slash + 1)
            {
                found = Some((
                    format!("{}/{}", &content[i..slash], &content[slash + 1..end]),
                    end,
                ));
            }
        }
        if found.is_none()
            && let Some(end) = decision_at(b, i)
        {
            found = Some((content[i..end].to_owned(), end));
        }
        match found {
            Some((key, end)) => {
                if !out.contains(&key) {
                    out.push(key);
                }
                i = end;
            }
            None => i += 1,
        }
    }
    out
}

/// `DECISION_HEADING` (`/^D(\d+)$/`).
fn decision_number(heading: &str) -> Option<&str> {
    let digits = heading.strip_prefix('D')?;
    (!digits.is_empty() && digits.bytes().all(|c| c.is_ascii_digit())).then_some(digits)
}

fn decision_ids(content: &str) -> Vec<String> {
    split_template_sections(content)
        .into_iter()
        .filter(|s| decision_number(&s.heading).is_some())
        .map(|s| s.heading)
        .collect()
}

/// `checkDecisionCitations(content, label, ctx)`.
fn check_decision_citations(
    content: &str,
    label: &str,
    stage_path: &str,
    master_dir: &str,
) -> Result<Vec<String>, Delegate> {
    let mut failures = Vec::new();
    let local = read_text(&js_join(stage_path, "DECISIONS.md"))?.unwrap_or_default();
    let local_ids = decision_ids(&local);
    for cited in cited_decisions(content) {
        let Some((stage_dir, id)) = cited.split_once('/') else {
            if !local_ids.contains(&cited) {
                failures.push(format!(
                    "{label}: cita {cited}, que no existe en DECISIONS.md"
                ));
            }
            continue;
        };
        let other = js_join(&js_join(master_dir, stage_dir), "DECISIONS.md");
        let Some(text) = read_text(&other)? else {
            failures.push(format!(
                "{label}: cita {cited}, y {stage_dir}/DECISIONS.md no existe"
            ));
            continue;
        };
        if !decision_ids(&text).iter().any(|d| d == id) {
            failures.push(format!("{label}: cita {cited}, que no existe"));
        }
    }
    Ok(failures)
}

/// `checkRawGitignore`.
#[must_use]
pub fn check_raw_gitignore(ctx: &CheckContext<'_>) -> Vec<String> {
    if Path::new(&js_join(ctx.stage_path, "context/raw/.gitignore")).exists() {
        return Vec::new();
    }
    vec![format!(
        "falta {}/context/raw/.gitignore (repárelo con: navori master init)",
        ctx.stage.dir
    )]
}

/// `checkHistoryChain`.
#[must_use]
pub fn check_history_chain(state: &MasterState, dir: &str) -> Vec<String> {
    let history = &state.history;
    let Some(first) = history.first() else {
        return vec![format!("{dir}: state.json.history está vacío")];
    };
    if *first != MASTER_PHASES[0] {
        return vec![format!(
            "{dir}: state.json.history no empieza en '{}'",
            MASTER_PHASES[0]
        )];
    }
    let index_of = |phase: &str| MASTER_PHASES.iter().position(|p| *p == phase);
    for pair in history.windows(2) {
        let (prev, curr) = (pair[0], pair[1]);
        // Legacy stages went mastered -> executing before `ux` existed: the one tolerated skip.
        let legacy_skip = prev == "mastered" && curr == "executing" && state.ux.is_none();
        if index_of(curr) != index_of(prev).map(|p| p + 1) && !legacy_skip {
            return vec![format!(
                "{dir}: state.json.history salta de '{prev}' a '{curr}'"
            )];
        }
    }
    Vec::new()
}

struct Table {
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
}

/// `parseFirstTable`.
fn parse_first_table(content: &str) -> Option<Table> {
    let lines: Vec<&str> = content
        .split('\n')
        .filter(|l| trim(l).starts_with('|'))
        .collect();
    if lines.len() < 2 {
        return None;
    }
    let cells = |line: &str| -> Vec<String> {
        let segments: Vec<&str> = line.split('|').collect();
        segments[1..segments.len() - 1]
            .iter()
            .map(|c| trim(c).to_owned())
            .collect()
    };
    Some(Table {
        headers: cells(lines[0]),
        rows: lines[2..].iter().map(|l| cells(l)).collect(),
    })
}

/// `/context\/md\/[^\s)|]+/` first match.
fn context_md_ref(text: &str) -> Option<&str> {
    const PREFIX: &str = "context/md/";
    text.match_indices(PREFIX).find_map(|(at, _)| {
        let rest = &text[at + PREFIX.len()..];
        let run = rest
            .find(|c: char| is_js_whitespace(c) || c == ')' || c == '|')
            .unwrap_or(rest.len());
        (run > 0).then(|| &text[at..at + PREFIX.len() + run])
    })
}

fn includes_ci(haystack: &str, needle: &str) -> bool {
    haystack.to_lowercase().contains(&needle.to_lowercase())
}

/// `/markitdown\s+\d+\.\d+\.\d+/` and `/markitdown/i`.
struct MarkitdownPatterns {
    any_case: Regex,
    version: Regex,
}

static MARKITDOWN: LazyLock<Option<MarkitdownPatterns>> = LazyLock::new(|| {
    let ws = "\\t\\n\\x0B\\x0C\\r \\u{a0}\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}\\u{feff}";
    Some(MarkitdownPatterns {
        any_case: Regex::new(&ci("markitdown")).ok()?,
        version: Regex::new(&format!("markitdown[{ws}]+[0-9]+\\.[0-9]+\\.[0-9]+")).ok()?,
    })
});

/// The visible entries of `dir` (`readdirSync(dir).filter(f => !f.startsWith("."))`), sorted by
/// bytes as libuv's `scandir` does.
fn visible_entries(dir: &str) -> Result<Vec<String>, Delegate> {
    if !Path::new(dir).exists() {
        return Ok(Vec::new());
    }
    let mut names = Vec::new();
    for entry in fs::read_dir(dir).map_err(|_| Delegate)? {
        let name = entry
            .map_err(|_| Delegate)?
            .file_name()
            .into_string()
            .map_err(|_| Delegate)?;
        if !name.starts_with('.') {
            names.push(name);
        }
    }
    names.sort();
    Ok(names)
}

fn check_transcribed(ctx: &CheckContext<'_>) -> Result<Vec<String>, Delegate> {
    let markers = master_markers(ctx.english);
    let (dir, mut failures) = (&ctx.stage.dir, Vec::new());
    if ctx.state.mode.is_none() {
        failures.push(format!("{dir}: mode no está registrado"));
    }
    let raw_files = visible_entries(&js_join(ctx.stage_path, "context/raw"))?;
    if raw_files.is_empty() {
        failures.push(format!(
            "{dir}: context/raw/ no tiene ningún archivo visible (los que empiezan con . se ignoran)"
        ));
    }
    let Some(intake) = read_stage_file(ctx.stage_path, "context/INTAKE.md")? else {
        failures.push(format!("{dir}: falta context/INTAKE.md"));
        return Ok(failures);
    };
    let Some(table) = parse_first_table(&intake) else {
        failures.push(format!("{dir}: context/INTAKE.md no tiene una tabla"));
        return Ok(failures);
    };
    let column = |label: &str| table.headers.iter().position(|h| includes_ci(h, label));
    let (file_col, method_col, result_col) = (
        column(markers.archivo_column),
        column(markers.metodo_column),
        column(markers.resultado_column),
    );
    let cell = |row: &'_ [String], col: Option<usize>| col.and_then(|c| row.get(c)).cloned();
    let method_label = format!("{}:", markers.metodo_label);
    let patterns = MARKITDOWN.as_ref().ok_or(Delegate)?;
    for raw in &raw_files {
        let Some(row) = table
            .rows
            .iter()
            .find(|r| cell(r, file_col).is_some_and(|c| c.contains(raw.as_str())))
        else {
            failures.push(format!(
                "{dir}: context/INTAKE.md no tiene una fila para {raw}"
            ));
            continue;
        };
        let method = cell(row, method_col).unwrap_or_default();
        let result = cell(row, result_col).unwrap_or_default();
        if let Some(reference) = context_md_ref(&result) {
            let md_path = js_join(ctx.stage_path, reference);
            let Some(md) = read_text(&md_path)? else {
                failures.push(format!("{dir}: {raw} apunta a {reference}, que no existe"));
                continue;
            };
            let normalized = normalize_eol(&md);
            let first_line = normalized.split('\n').next().unwrap_or_default();
            if !first_line.contains(raw.as_str()) || !includes_ci(first_line, &method_label) {
                failures.push(format!(
                    "{dir}: {reference} no empieza con el archivo original y el método"
                ));
            }
            if patterns.any_case.is_match(&method) && !patterns.version.is_match(first_line) {
                failures.push(format!(
                    "{dir}: {reference} usa markitdown sin versión en su cabecera"
                ));
            }
        } else if trim(&result).is_empty() {
            failures.push(format!(
                "{dir}: {raw} no se convirtió y no tiene causa en INTAKE.md"
            ));
        }
    }
    Ok(failures)
}

fn check_mapped(ctx: &CheckContext<'_>) -> Result<Vec<String>, Delegate> {
    let markers = master_markers(ctx.english);
    let (dir, mut failures) = (&ctx.stage.dir, Vec::new());
    match read_stage_file(ctx.stage_path, "context/DIGEST.md")? {
        None => failures.push(format!("{dir}: falta context/DIGEST.md")),
        Some(digest) => {
            let headers = template_headers("digest", ctx.english, None).ok_or(Delegate)?;
            failures.extend(validate_sections(
                &digest,
                &headers,
                &format!("{dir}/context/DIGEST.md"),
                markers.no_aplica,
            ));
            let sections = split_template_sections(&digest);
            // The first section and the last carry no citation requirement; each one between
            // them is a counting section whose bullets must cite an existing `context/md/…`.
            let counting = headers
                .get(1..headers.len().saturating_sub(1))
                .unwrap_or_default();
            for heading in counting {
                let body = section_of(&sections, heading).map_or("", |s| trim(&s.body));
                if body == markers.ninguno_digest {
                    continue;
                }
                for line in body.split('\n').filter(|l| trim(l).starts_with('-')) {
                    let Some(reference) = context_md_ref(line) else {
                        failures.push(format!(
                            "{dir}/context/DIGEST.md: una viñeta de \"{heading}\" no cita un context/md/… existente: \"{}\"",
                            trim(line)
                        ));
                        continue;
                    };
                    if !Path::new(&js_join(ctx.stage_path, reference)).exists() {
                        failures.push(format!(
                            "{dir}/context/DIGEST.md: cita {reference}, que no existe"
                        ));
                    }
                }
            }
        }
    }
    match read_stage_file(ctx.stage_path, "context/CODEBASE.md")? {
        None => failures.push(format!("{dir}: falta context/CODEBASE.md")),
        Some(codebase) => {
            let headers: Vec<String> = markers
                .codebase_headers
                .iter()
                .map(|h| (*h).to_owned())
                .collect();
            failures.extend(validate_sections(
                &codebase,
                &headers,
                &format!("{dir}/context/CODEBASE.md"),
                markers.no_aplica,
            ));
        }
    }
    Ok(failures)
}

/// `/https?:\/\/\S+/` finds a match in `line`.
fn has_url(line: &str) -> bool {
    line.match_indices("http").any(|(at, _)| {
        let rest = &line[at + 4..];
        let after = rest
            .strip_prefix("s://")
            .or_else(|| rest.strip_prefix("://"));
        after
            .and_then(|r| r.chars().next())
            .is_some_and(|c| !is_js_whitespace(c))
    })
}

/// `/\d{4}-\d{2}-\d{2}/` anywhere in `line`.
fn has_iso_date(line: &str) -> bool {
    let b = line.as_bytes();
    b.windows(10).any(|w| {
        w.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            _ => c.is_ascii_digit(),
        })
    })
}

fn check_planned(ctx: &CheckContext<'_>) -> Result<Vec<String>, Delegate> {
    let markers = master_markers(ctx.english);
    let (dir, mut failures) = (&ctx.stage.dir, Vec::new());
    let headers = template_headers("plan", ctx.english, ctx.state.mode).ok_or(Delegate)?;
    let others: Vec<&StageEntry> = ctx.index.stages.iter().filter(|s| s.dir != *dir).collect();
    for plan_file in ["plan1.md", "plan2.md", "plan3.md"] {
        let Some(content) = read_stage_file(ctx.stage_path, &format!("plans/{plan_file}"))? else {
            failures.push(format!("{dir}: falta plans/{plan_file}"));
            continue;
        };
        let label = format!("{dir}/plans/{plan_file}");
        failures.extend(validate_sections(
            &content,
            &headers,
            &label,
            markers.no_aplica,
        ));
        for line in content.split('\n') {
            let t = trim(line);
            let is_rule = t
                .strip_prefix("RN-")
                .is_some_and(|r| r.starts_with(|c: char| c.is_ascii_digit()));
            if is_rule && !line.contains("context/md/") && !line.contains(markers.supuesto) {
                failures.push(format!(
                    "{label}: \"{t}\" no cita context/md/… ni {}",
                    markers.supuesto
                ));
            }
        }
        for line in content.split('\n') {
            if !has_url(line) {
                continue;
            }
            let consulted = line
                .to_lowercase()
                .contains(&markers.consultado.to_lowercase())
                && has_iso_date(line);
            if !consulted && !line.contains(markers.sin_verificar) {
                failures.push(format!(
                    "{label}: una URL no lleva \"{} AAAA-MM-DD\" ni {}: \"{}\"",
                    markers.consultado,
                    markers.sin_verificar,
                    trim(line)
                ));
            }
        }
        if ctx.stage.number >= 2.0 && !others.is_empty() {
            let sections = split_template_sections(&content);
            let metadata_heading = headers.first().ok_or(Delegate)?;
            let metadata = section_of(&sections, metadata_heading).map_or("", |s| s.body.as_str());
            if !others.iter().any(|s| metadata.contains(s.dir.as_str())) {
                failures.push(format!(
                    "{label}: \"{metadata_heading}\" no lista los archivos de etapas cerradas leídos"
                ));
            }
        }
    }
    Ok(failures)
}

/// `checkDecisionsFile`: the failures of a `DECISIONS.md`.
fn check_decisions_file(content: &str, label: &str, markers: &Markers) -> Vec<String> {
    if trim(content) == markers.sin_decisiones {
        return Vec::new();
    }
    let sections: Vec<TemplateSection> = split_template_sections(content)
        .into_iter()
        .filter(|s| decision_number(&s.heading).is_some())
        .collect();
    if sections.is_empty() {
        return vec![format!(
            "{label}: ni \"{}\" ni ningún \"## D<n>\"",
            markers.sin_decisiones
        )];
    }
    let mut failures = Vec::new();
    let mut ids: Vec<f64> = sections
        .iter()
        .map(|s| {
            decision_number(&s.heading)
                .and_then(|d| d.parse::<f64>().ok())
                .unwrap_or(f64::NAN)
        })
        .collect();
    ids.sort_by(f64::total_cmp);
    #[expect(
        clippy::cast_precision_loss,
        reason = "section counts are far below 2^53"
    )]
    if ids.iter().enumerate().any(|(i, n)| *n != (i + 1) as f64) {
        failures.push(format!(
            "{label}: los ids \"D<n>\" no son consecutivos desde D1"
        ));
    }
    for section in &sections {
        for field in [
            markers.pregunta,
            markers.elegida,
            markers.descartadas,
            markers.fecha,
        ] {
            if !section.body.contains(field) {
                let n = decision_number(&section.heading).unwrap_or_default();
                failures.push(format!("{label}: \"## D{n}\" no tiene \"{field}\""));
            }
        }
    }
    failures
}

fn check_questioned(ctx: &CheckContext<'_>) -> Result<Vec<String>, Delegate> {
    let markers = master_markers(ctx.english);
    let dir = &ctx.stage.dir;
    let Some(content) = read_stage_file(ctx.stage_path, "DECISIONS.md")? else {
        return Ok(vec![format!("{dir}: falta DECISIONS.md")]);
    };
    let label = format!("{dir}/DECISIONS.md");
    let mut failures = check_decisions_file(&content, &label, markers);
    if ctx.stage.number >= 2.0
        && let Some(last_closed) = ctx.index.last_closed()
    {
        let parts_path = js_join(&js_join(ctx.master_dir, &last_closed.dir), "parts.json");
        if Path::new(&parts_path).exists() {
            let raw = read_json(Path::new(&parts_path))?;
            // A parts file the schema rejects is skipped, not reported.
            if let Ok(parts) = state::parts(&raw) {
                for part in parts.iter().filter(|p| p.state == "diferida") {
                    let marker = format!("{}/{}", last_closed.dir, part.id);
                    if !content.contains(&marker) {
                        failures.push(format!(
                            "{label}: falta un D<n> para la parte diferida {marker}"
                        ));
                    }
                }
            }
        }
    }
    Ok(failures)
}

fn check_master_document(ctx: &CheckContext<'_>) -> Result<Vec<String>, Delegate> {
    let markers = master_markers(ctx.english);
    let dir = &ctx.stage.dir;
    let Some(content) = read_stage_file(ctx.stage_path, "MASTER.md")? else {
        return Ok(vec![format!("{dir}: falta MASTER.md")]);
    };
    let label = format!("{dir}/MASTER.md");
    let headers = template_headers("master", ctx.english, ctx.state.mode).ok_or(Delegate)?;
    let mut failures = validate_sections(&content, &headers, &label, markers.no_aplica);
    let sections = split_template_sections(&content);
    let open_questions = headers.last().ok_or(Delegate)?;
    for heading in &headers {
        if heading == open_questions {
            continue;
        }
        if let Some(section) = section_of(&sections, heading)
            && !section.body.contains(markers.origen)
        {
            failures.push(format!(
                "{label}: \"## {heading}\" no tiene una línea \"{}\"",
                markers.origen
            ));
        }
    }
    if let Some(section) = section_of(&sections, open_questions)
        && trim(&section.body) != markers.ninguna
    {
        failures.push(format!(
            "{label}: \"## {open_questions}\" debe decir \"{}\" (R32)",
            markers.ninguna
        ));
    }
    for marker in [markers.supuesto, markers.sin_verificar] {
        if content.contains(marker) {
            failures.push(format!("{label}: contiene {marker} sin resolver"));
        }
    }
    let parts_path = js_join(ctx.stage_path, "parts.json");
    if Path::new(&parts_path).exists() {
        let parts = state::parts(&read_json(Path::new(&parts_path))?).map_err(|_| Delegate)?;
        if parts.is_empty() {
            failures.push(format!("{dir}/parts.json no declara ninguna parte"));
        } else {
            let expected = render_master_parts(&parts, ctx.state.mode, ctx.english);
            let region = master_parts_region(&content);
            if region.is_none() && content.contains("<!-- navori:master-parts") {
                failures.push(format!(
                    "{dir}/MASTER.md: marcador '<!-- navori:master-parts' sin cierre; corríjalo a mano"
                ));
            } else if region != Some(expected.as_str()) {
                failures.push(format!(
                    "{dir}/MASTER.md: navori:master-parts differs from parts.json; repare con 'navori master status'"
                ));
            }
        }
    } else {
        failures.push(format!("{dir}: falta parts.json"));
    }
    failures.extend(check_decision_citations(
        &content,
        &label,
        ctx.stage_path,
        ctx.master_dir,
    )?);
    Ok(failures)
}

/// `checksForTransition(ctx, target)`.
///
/// # Errors
/// [`Delegate`] for everything listed in the module docs.
pub fn checks_for_transition(
    ctx: &CheckContext<'_>,
    target: &str,
) -> Result<Vec<String>, Delegate> {
    match target {
        "transcribed" => check_transcribed(ctx),
        "mapped" => check_mapped(ctx),
        "planned" => check_planned(ctx),
        "questioned" => check_questioned(ctx),
        "mastered" | "ux" => check_master_document(ctx),
        "executing" => {
            let mut failures = ux_decision(&ctx.stage.dir, ctx.state);
            failures.extend(ux_artifacts(
                &ctx.stage.dir,
                Path::new(ctx.stage_path),
                ctx.state,
            )?);
            failures.extend(check_master_document(ctx)?);
            Ok(failures)
        }
        _ => Ok(vec![format!(
            "no hay comprobación mecánica para avanzar a '{target}'"
        )]),
    }
}

/// `nextPhase(phase)`.
#[must_use]
pub fn next_phase(phase: &str) -> Option<&'static str> {
    let at = MASTER_PHASES.iter().position(|p| *p == phase)?;
    MASTER_PHASES
        .get(at + 1)
        .copied()
        .filter(|p| *p != "closed")
}

/// A `CheckResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CheckResult {
    pub phase: &'static str,
    pub next_phase: Option<&'static str>,
    pub failures: Vec<String>,
    /// How many times the TS read the config again (its warnings print each time).
    pub config_reads: usize,
}

/// `buildCheckContext`'s stage half: `Ok(Err(message))` for the setup failures it reports.
///
/// # Errors
/// [`Delegate`] where the TS throws instead.
pub fn build_stage_ctx(
    master_dir: &str,
    index: Option<&MasterIndex>,
) -> Result<Result<StageCtx, String>, Delegate> {
    let Some(stage) = index.and_then(MasterIndex::active) else {
        return Ok(Err(
            "no hay etapa activa: corra 'navori master init <slug>'".to_owned(),
        ));
    };
    let dir = &stage.dir;
    if stage.deliveries {
        return Ok(Err(format!(
            "{dir}: deliveries workflow is not supported by legacy checks"
        )));
    }
    let stage_path = js_join(master_dir, dir);
    if !Path::new(&stage_path).exists() {
        return Ok(Err(format!(
            "{dir}: la etapa activa no tiene carpeta en disco (repárelo con: navori master init)"
        )));
    }
    let state_path = js_join(&stage_path, "state.json");
    if !Path::new(&state_path).exists() {
        return Ok(Err(format!("{dir}: falta state.json")));
    }
    let state = state::master_state(&read_json(Path::new(&state_path))?).map_err(|_| Delegate)?;
    Ok(Ok(StageCtx {
        stage: stage.clone(),
        stage_path,
        state,
    }))
}

/// `runMasterCheck(cwd)` over a built context.
///
/// # Errors
/// [`Delegate`] for everything listed in the module docs.
pub fn run_master_check(
    cwd: &str,
    specs_dir: &str,
    master_dir: &str,
    config: PartConfig,
    index: &MasterIndex,
    built: &StageCtx,
) -> Result<CheckResult, Delegate> {
    let ctx = CheckContext {
        english: config.english,
        master_dir,
        index,
        stage: &built.stage,
        stage_path: &built.stage_path,
        state: &built.state,
    };
    let dir = &built.stage.dir;
    let phase = built.state.phase;
    let target = next_phase(phase);
    let mut failures = check_raw_gitignore(&ctx);
    failures.extend(check_history_chain(&built.state, dir));
    if let Some(target) = target {
        failures.extend(checks_for_transition(&ctx, target)?);
    } else if phase == "executing" {
        failures.extend(ux_artifacts(
            dir,
            Path::new(&built.stage_path),
            &built.state,
        )?);
        failures.extend(check_master_document(&ctx)?);
    }
    let mut config_reads = 0;
    let status_path = js_join(&built.stage_path, "STATUS.md");
    if let Some(on_disk) = read_text(&status_path)? {
        // `readMasterStatus` reads the config once more, and `checkPart` again per finished part.
        let status = status::legacy(
            cwd,
            specs_dir,
            Path::new(master_dir),
            index,
            &built.stage,
            config,
        )?;
        config_reads = 1 + status.config_reads;
        if normalize_eol(&on_disk) != render_status_md(&status, config.english) {
            failures.push(format!(
                "{dir}/STATUS.md differs from its render; repare con 'navori master status'"
            ));
        }
    } else if ["mastered", "ux", "executing"].contains(&phase) {
        failures.push(format!(
            "{dir}: missing STATUS.md; run navori master status"
        ));
    }
    Ok(CheckResult {
        phase,
        next_phase: target,
        failures,
        config_reads,
    })
}

/// `sha256Normalized(content)`.
fn sha256_normalized(content: &str) -> String {
    Sha256::digest(normalize_eol(content).as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// `parseIntegrityTable(closure, heading)`: file → hash, in order, last duplicate winning.
fn parse_integrity_table(closure: &str, heading: &str) -> Option<Vec<(String, String)>> {
    let sections = split_template_sections(closure);
    let section = sections.iter().find(|s| s.heading == heading)?;
    let table = parse_first_table(&section.body)?;
    if table.rows.is_empty() {
        return None;
    }
    let mut map: Vec<(String, String)> = Vec::new();
    for row in &table.rows {
        let (Some(file), Some(hash)) = (row.first(), row.get(1)) else {
            continue;
        };
        if file.is_empty() || hash.is_empty() {
            continue;
        }
        match map.iter_mut().find(|(f, _)| f == file) {
            Some(entry) => entry.1.clone_from(hash),
            None => map.push((file.clone(), hash.clone())),
        }
    }
    (!map.is_empty()).then_some(map)
}

/// `checkClosedStage(cwd, specsDir, stageDir, language)`.
///
/// # Errors
/// [`Delegate`] for a `stage_dir` that is not a plain `NN-slug` name, a closed `deliveries`
/// stage, and everything listed in the module docs.
pub fn check_closed_stage(
    cwd: &str,
    master_dir: &str,
    stage_dir: &str,
    english: bool,
) -> Result<Vec<String>, Delegate> {
    let plain = !stage_dir.is_empty()
        && stage_dir != "."
        && stage_dir != ".."
        && stage_dir
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'));
    if !plain {
        return Err(Delegate);
    }
    let markers = master_markers(english);
    let stage_path = js_join(master_dir, stage_dir);
    if !Path::new(&stage_path).exists() {
        return Ok(vec![format!("{stage_dir}: no existe")]);
    }
    let mut failures = Vec::new();
    let index = index::read(Path::new(master_dir)).map_err(|_| Delegate)?;
    let entry = index
        .as_ref()
        .and_then(|i| i.stages.iter().find(|s| s.dir == stage_dir));
    if let Some(entry) = entry
        && entry.state == StageState::Converted
        && let Some(spec) = entry.spec.as_deref().filter(|s| !s.is_empty())
        && !Path::new(&js_join(cwd, spec)).exists()
    {
        failures.push(format!("{stage_dir}: spec aún no creada: {spec}"));
    }
    let gitignore = js_join(&stage_path, "context/raw/.gitignore");
    if !Path::new(&gitignore).exists() {
        failures.push(format!(
            "{stage_dir}: falta context/raw/.gitignore (repárelo con: git checkout -- {gitignore})"
        ));
    }
    if entry.is_some_and(|e| e.deliveries) {
        return Err(Delegate);
    }
    let state_path = js_join(&stage_path, "state.json");
    if Path::new(&state_path).exists() {
        match state::master_state(&read_json(Path::new(&state_path))?) {
            Err(_) => failures.push(format!("{stage_dir}/state.json no es válido")),
            Ok(state) if state.phase != "closed" => {
                failures.push(format!(
                    "{stage_dir}: state.json.phase es '{}', no 'closed'",
                    state.phase
                ));
            }
            Ok(_) => {}
        }
    } else {
        failures.push(format!("{stage_dir}: falta state.json"));
    }
    let Some(closure) = read_text(&js_join(&stage_path, "CLOSURE.md"))? else {
        failures.push(format!("{stage_dir}: falta CLOSURE.md"));
        return Ok(failures);
    };
    let Some(integrity) = parse_integrity_table(&normalize_eol(&closure), markers.integridad)
    else {
        failures.push(format!(
            "{stage_dir}: CLOSURE.md no tiene una tabla de \"{}\" con al menos una fila — no se puede verificar la etapa",
            markers.integridad
        ));
        return Ok(failures);
    };
    for (file, expected) in &integrity {
        let Some(text) = read_text(&js_join(&stage_path, file))? else {
            failures.push(format!(
                "{stage_dir}: falta {file} (referenciado en \"{}\")",
                markers.integridad
            ));
            continue;
        };
        if sha256_normalized(&text) != *expected {
            failures.push(format!(
                "{stage_dir}: {file} no coincide con el hash de \"{}\" en CLOSURE.md",
                markers.integridad
            ));
        }
    }
    Ok(failures)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_normalizes_like_node() {
        assert_eq!(js_join("/a/b", "c/../d/./e"), "/a/b/d/e");
        assert_eq!(js_join("/a/b", "/x"), "/a/b/x");
        assert_eq!(js_join("/a/b", "../../.."), "/");
        assert_eq!(js_join("/a", "b/"), "/a/b/");
    }

    #[test]
    fn decision_citations_follow_the_regex() {
        let text =
            "ver D1, 01-uno/D12 y x01-uno/D3, D1 otra vez; DD4, D5x, _D6, D7_, (D8) 02-dos/D9.";
        assert_eq!(
            cited_decisions(text),
            vec!["D1", "01-uno/D12", "D3", "D8", "02-dos/D9"]
        );
    }

    #[test]
    fn first_table_skips_the_separator_and_trims_cells() {
        let table = parse_first_table(
            "x\n | Archivo | Método |\n|---|---|\n| a.pdf | markitdown |\ntexto\n",
        );
        let table = table.map(|t| (t.headers, t.rows));
        assert_eq!(
            table,
            Some((
                vec!["Archivo".to_owned(), "Método".to_owned()],
                vec![vec!["a.pdf".to_owned(), "markitdown".to_owned()]]
            ))
        );
        assert!(parse_first_table("| solo una |").is_none());
    }

    #[test]
    fn urls_dates_and_references_are_found_like_the_regexes() {
        assert!(has_url("ver https://x.dev/a y mas"));
        assert!(has_url("http://x"));
        assert!(!has_url("http:// vacio") && !has_url("ftp://x") && !has_url("https:/x"));
        assert!(has_iso_date("consultado 2026-09-25.") && !has_iso_date("2026-9-25"));
        assert_eq!(
            context_md_ref("| context/md/a.md) |"),
            Some("context/md/a.md")
        );
        assert_eq!(
            context_md_ref("context/md/ context/md/b"),
            Some("context/md/b")
        );
        assert_eq!(context_md_ref("context/md/"), None);
    }

    #[test]
    fn history_must_be_a_consecutive_chain() {
        let state = |history: &[&'static str], ux: Option<&'static str>| MasterState {
            phase: "executing",
            mode: None,
            ux,
            outcome: None,
            history: history.to_vec(),
            normalized: crate::js_json::JsValue::Null,
        };
        let chain = ["context", "transcribed", "mapped"];
        assert!(check_history_chain(&state(&chain, None), "d").is_empty());
        assert_eq!(check_history_chain(&state(&[], None), "d").len(), 1);
        assert!(check_history_chain(&state(&["mapped"], None), "d")[0].contains("no empieza"));
        assert!(
            check_history_chain(&state(&["context", "mapped"], None), "d")[0].contains("salta")
        );
        let legacy = [
            "context",
            "transcribed",
            "mapped",
            "planned",
            "questioned",
            "mastered",
            "executing",
        ];
        assert!(check_history_chain(&state(&legacy, None), "d").is_empty());
        assert_eq!(
            check_history_chain(&state(&legacy, Some("md")), "d").len(),
            1
        );
    }
}
