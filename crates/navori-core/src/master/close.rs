//! `navori master close` on an active legacy stage, or with no active stage
//! (`lib/master/close.ts` `runMasterClose`), spec 0060 T8.
//!
//! The six durable steps of D10 are planned in memory before the first write: the outcome in
//! `state.json`, the last derived status, `CLOSURE.md`, the closed `state.json`, the registry and
//! its `INDEX.md`. The last step (the config with `harness.masterPlan` off and the render) belongs
//! to the caller, which must also plan it before writing anything. What this port does not
//! reproduce returns [`Delegate`] before any write: a `deliveries` stage, `run` evidence (its
//! closure line comes from `git`), a missing or invalid `state.json` or `parts.json`, and whatever
//! `readMasterStatus` or `writeMasterStatus` would delegate.

use std::fs;
use std::path::Path;

use super::check_part::PartConfig;
use super::checks::{js_join, sha256_normalized};
use super::index::{MasterIndex, StageEntry, StageState};
use super::markers::master_markers;
use super::state::{self, Evidence, MasterState, Part};
use super::status::{self, Delegate, LegacyStatus, read_json};
use super::write::{Planned, plan_status_writes, render_index_md, utc_today};
use crate::integrity::is_js_whitespace;
use crate::js_json::{JsObject, JsValue, number_to_js};

/// The options of `master close`, `undefined` as `None`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct CloseOptions<'a> {
    pub convert: Option<&'a str>,
    pub abandon: bool,
    pub reason: Option<&'a str>,
}

/// What `runMasterClose` does, up to its last step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClosePlan {
    /// The error the command reports, after `config_reads` more reads of the config.
    Failed {
        message: String,
        config_reads: usize,
    },
    /// No active stage and the config already off: nothing to write.
    Complete,
    /// Write `writes` in order, then turn `harness.masterPlan` off and render.
    Close {
        /// The stage closed, or `None` when only the last step is repaired.
        stage: Option<String>,
        outcome: Option<&'static str>,
        writes: Vec<Planned>,
        /// How many times the TS read the config again before the last step.
        config_reads: usize,
    },
}

fn failed(message: impl Into<String>, config_reads: usize) -> Result<ClosePlan, Delegate> {
    Ok(ClosePlan::Failed {
        message: message.into(),
        config_reads,
    })
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// Node's `path.resolve(base, rel)` (POSIX) for an absolute `base`.
fn resolve(base: &str, rel: &str) -> String {
    let joined = if rel.starts_with('/') {
        rel.to_owned()
    } else {
        format!("{base}/{rel}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

/// Node's `path.relative` between two resolved POSIX paths.
fn relative(from: &str, to: &str) -> String {
    let from: Vec<&str> = from.split('/').filter(|p| !p.is_empty()).collect();
    let to: Vec<&str> = to.split('/').filter(|p| !p.is_empty()).collect();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut parts = vec![".."; from.len() - common];
    parts.extend(&to[common..]);
    parts.join("/")
}

fn real(path: &str) -> Result<String, Delegate> {
    let real = fs::canonicalize(path).map_err(|_| Delegate)?;
    real.to_str().map(str::to_owned).ok_or(Delegate)
}

/// `specPath(cwd, specsDir, requested)`: the spec path, or the message the TS throws.
fn spec_path(
    cwd: &str,
    specs_dir: &str,
    requested: &str,
) -> Result<Result<String, String>, Delegate> {
    let root = resolve(cwd, specs_dir);
    let target = resolve(cwd, requested);
    if target == root || !target.starts_with(&format!("{root}/")) {
        return Ok(Err(format!("--convert debe estar dentro de {specs_dir}")));
    }
    if relative(&root, &target).split('/').any(|p| p == "_master") {
        return Ok(Err("--convert no puede estar en _master/".to_owned()));
    }
    let mut existing = target.clone();
    while !Path::new(&existing).exists() {
        existing = resolve(&existing, "..");
    }
    let (real_root, real_existing) = (real(&root)?, real(&existing)?);
    if real_existing != real_root && !real_existing.starts_with(&format!("{real_root}/")) {
        return Ok(Err("--convert resuelve fuera de specsDir".to_owned()));
    }
    if Path::new(&target).exists() {
        let mut entries = fs::read_dir(&target).map_err(|_| Delegate)?;
        if entries.next().is_some() {
            return Ok(Err(format!(
                "--convert requiere una ruta libre o vacía: {requested}"
            )));
        }
    }
    Ok(Ok(relative(cwd, &target)))
}

/// `readFileSync(path, "utf8")`, or `None` when the file does not exist.
fn read_text(path: &str) -> Result<Option<String>, Delegate> {
    if !Path::new(path).exists() {
        return Ok(None);
    }
    let bytes = fs::read(path).map_err(|_| Delegate)?;
    String::from_utf8(bytes).map(Some).map_err(|_| Delegate)
}

/// `[...text.matchAll(/^## D\d+\b/gm)].length`.
fn decision_count(text: &str) -> usize {
    let mut count = 0;
    let mut line_start = true;
    let chars: Vec<char> = text.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if line_start && chars[i..].starts_with(&['#', '#', ' ', 'D']) {
            let digits = chars[i + 4..]
                .iter()
                .take_while(|c| c.is_ascii_digit())
                .count();
            let next = chars.get(i + 4 + digits);
            if digits > 0 && !next.is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_') {
                count += 1;
            }
        }
        line_start = matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}');
    }
    count
}

/// `escapeCell(value)`: `|` escaped, every run of line breaks as one space.
fn escape_cell(value: Option<&str>) -> String {
    let text = value.unwrap_or("—").replace('|', "\\|");
    let mut out = String::with_capacity(text.len());
    let mut in_break = false;
    for c in text.chars() {
        if c == '\r' || c == '\n' {
            if !in_break {
                out.push(' ');
            }
            in_break = true;
        } else {
            out.push(c);
            in_break = false;
        }
    }
    out
}

fn string_at(value: &JsValue, path: &[&str]) -> Option<String> {
    let mut current = value;
    for key in path {
        let JsValue::Object(object) = current else {
            return None;
        };
        current = object.get(key)?;
    }
    match current {
        JsValue::String(s) => s.to_rust(),
        _ => None,
    }
}

/// What `renderClosure` reads besides the final state.
struct ClosureInput<'a> {
    stage_path: &'a str,
    stage: &'a StageEntry,
    english: bool,
    parts: &'a [Part],
    status: Option<&'a LegacyStatus>,
    /// The files written before the closure: their content as the TS reads it back.
    written: &'a [Planned],
}

/// `renderClosure(…)` for `final_state` serialized as `final_bytes`.
fn render_closure(
    input: &ClosureInput<'_>,
    final_state: &JsValue,
    final_bytes: &str,
) -> Result<String, Delegate> {
    let markers = master_markers(input.english);
    let l = markers.closure;
    let field = |path: &[&str]| string_at(final_state, path);
    let outcome = field(&["outcome"]).ok_or(Delegate)?;
    let mut lines = vec![
        format!("# {}: {}", l.title, input.stage.dir),
        String::new(),
        format!("- {}: {outcome}", l.outcome),
        format!("- {}: {}", l.opened, input.stage.opened_at),
        // A close resumed from a state without `closedAt` prints JS's `undefined`.
        format!(
            "- {}: {}",
            l.closed,
            field(&["closedAt"]).unwrap_or_else(|| "undefined".to_owned())
        ),
    ];
    if outcome == "abandonada" {
        let reason = field(&["abandonment", "reason"]);
        lines.push(format!(
            "- {}: {}",
            l.reason,
            escape_cell(reason.as_deref())
        ));
        let phase = field(&["abandonment", "phase"]).ok_or(Delegate)?;
        lines.push(format!("- {}: {phase}", l.phase));
    } else {
        if outcome == "convertida" {
            let reason = field(&["conversion", "reason"]);
            lines.push(format!(
                "- {}: {}",
                l.reason,
                escape_cell(reason.as_deref())
            ));
            let spec = field(&["conversion", "spec"]).ok_or(Delegate)?;
            lines.push(format!("- Spec: {spec}"));
        }
        lines.extend([
            String::new(),
            format!("## {}", l.parts),
            String::new(),
            format!("| {} |", l.part_columns.join(" | ")),
            "|---|---|---|---|---|".to_owned(),
        ]);
        for part in input.parts {
            let effective = input
                .status
                .and_then(|s| s.parts.iter().find(|p| p.id == part.id))
                .map_or(part.state, |p| p.effective);
            let issue = part.issue.map(number_to_js);
            lines.push(format!(
                "| {} | {effective} | {} | {} | {} |",
                part.id,
                escape_cell(part.spec.as_deref()),
                escape_cell(issue.as_deref()),
                escape_cell(part.reason.as_deref())
            ));
        }
        lines.extend([
            String::new(),
            format!("## {}", l.criteria),
            String::new(),
            format!("| {} |", l.criterion_columns.join(" | ")),
            "|---|---|---|---|".to_owned(),
        ]);
        for part in input.parts {
            let disposition = part.state == "descartada" || part.state == "diferida";
            for criterion in &part.acceptance {
                let (detail, date) = match (disposition, criterion.evidence) {
                    (false, Evidence::Approval) => {
                        (l.approved_by_user, criterion.evidence_date.as_deref())
                    }
                    // Its line comes from `git`: the caller never gets here with one.
                    (false, Evidence::Run) => return Err(Delegate),
                    _ => (l.unverified, None),
                };
                lines.push(format!(
                    "| {}.{} | {} | {} | {} |",
                    part.id,
                    criterion.id,
                    criterion.method,
                    escape_cell(Some(detail)),
                    date.unwrap_or("—")
                ));
            }
        }
        let decisions = read_text(&js_join(input.stage_path, "DECISIONS.md"))?;
        lines.push(String::new());
        lines.push(format!(
            "- {}: {}",
            l.decisions,
            decisions.as_deref().map_or(0, decision_count)
        ));
    }
    lines.extend([
        String::new(),
        format!("## {}", markers.integridad),
        String::new(),
        format!("| {} | SHA-256 |", markers.archivo_column),
        "|---|---|".to_owned(),
    ]);
    for file in [
        "MASTER.md",
        "DECISIONS.md",
        "UX.md",
        "ux.json",
        "parts.json",
        "state.json",
    ] {
        let path = js_join(input.stage_path, file);
        let content = if file == "state.json" {
            Path::new(&path).exists().then(|| final_bytes.to_owned())
        } else if let Some((_, written)) = input.written.iter().find(|(p, _)| *p == path) {
            Some(written.clone())
        } else {
            read_text(&path)?
        };
        if let Some(content) = content {
            lines.push(format!("| {file} | {} |", sha256_normalized(&content)));
        }
    }
    Ok(format!("{}\n", lines.join("\n")))
}

fn save(path: String, value: &JsValue) -> Result<Planned, Delegate> {
    Ok((
        path,
        format!("{}\n", value.stringify(Some(2)).ok_or(Delegate)?),
    ))
}

/// `runMasterClose(cwd, options)` up to its last step, once the config has been read.
/// `master_plan` is `config.harness?.masterPlan` when it is a boolean.
///
/// # Errors
/// [`Delegate`] before any write wherever the TS would behave differently or throw an error this
/// port does not reproduce.
#[allow(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "`runMasterClose`, step for step"
)]
pub fn plan_close(
    cwd: &str,
    specs_dir: &str,
    master_dir: &str,
    config: PartConfig,
    master_plan: Option<bool>,
    index: Option<&MasterIndex>,
    options: &CloseOptions<'_>,
) -> Result<ClosePlan, Delegate> {
    let convert = options.convert.filter(|c| !c.is_empty());
    let reason_truthy = options.reason.is_some_and(|r| !r.is_empty());
    if convert.is_some() && options.abandon {
        return failed("--convert y --abandon son excluyentes", 0);
    }
    if options.reason.is_some_and(|r| js_trim(r).is_empty()) {
        return failed("--reason no puede estar vacío", 0);
    }
    let any_option = convert.is_some() || options.abandon || reason_truthy;
    let active = index.and_then(MasterIndex::active);
    let (Some(index), Some(stage)) = (index, active) else {
        if !any_option && index.is_some_and(|i| !i.stages.is_empty()) && master_plan == Some(false)
        {
            return Ok(ClosePlan::Complete);
        }
        if !any_option && master_plan == Some(true) {
            return Ok(ClosePlan::Close {
                stage: None,
                outcome: None,
                writes: Vec::new(),
                config_reads: 0,
            });
        }
        return failed(
            "no hay etapa activa; una etapa cerrada es de solo lectura",
            0,
        );
    };
    if stage.deliveries {
        return Err(Delegate);
    }
    let stage_path = js_join(master_dir, &stage.dir);
    let state_path = js_join(&stage_path, "state.json");
    let state = state::master_state(&read_json(Path::new(&state_path))?).map_err(|_| Delegate)?;
    let existing = state.outcome;
    let outcome = existing.unwrap_or(if convert.is_some() {
        "convertida"
    } else if options.abandon {
        "abandonada"
    } else {
        "entregada"
    });
    if existing.is_some() && any_option {
        return failed(
            "cierre ya iniciado: reanude con 'navori master close' sin opciones",
            0,
        );
    }
    if options.reason.is_some() && convert.is_none() && !options.abandon {
        return failed("--reason solo aplica con --abandon o --convert", 0);
    }
    let parts_path = js_join(&stage_path, "parts.json");
    let parts: Vec<Part> = if Path::new(&parts_path).exists() {
        state::parts(&read_json(Path::new(&parts_path))?).map_err(|_| Delegate)?
    } else {
        Vec::new()
    };
    if parts
        .iter()
        .flat_map(|p| &p.acceptance)
        .any(|c| c.evidence == Evidence::Run)
    {
        return Err(Delegate);
    }
    let mut config_reads = 0;
    let mut conversion_spec = None;
    if existing.is_none() {
        let early =
            ["context", "transcribed", "mapped", "planned", "questioned"].contains(&state.phase);
        if outcome == "entregada" {
            let status = status::legacy_with(
                cwd,
                specs_dir,
                Path::new(master_dir),
                index,
                stage,
                config,
                state.clone(),
                parts.clone(),
            )?;
            config_reads += 1 + status.config_reads;
            let blocked: Vec<String> = if !["mastered", "ux", "executing"].contains(&state.phase) {
                vec![format!("no se puede entregar en fase {}", state.phase)]
            } else if status.parts.is_empty() {
                vec!["no se puede entregar sin partes".to_owned()]
            } else {
                status
                    .parts
                    .iter()
                    .filter(|p| !["hecho", "descartada", "diferida"].contains(&p.effective))
                    .map(|p| format!("{}: {}", p.id, p.effective))
                    .collect()
            };
            if !blocked.is_empty() {
                return failed(blocked.join("\n"), config_reads);
            }
            if !status.closable {
                return failed(
                    format!(
                        "no se puede cerrar; blockers:\n{}",
                        status.blockers.join("\n")
                    ),
                    config_reads,
                );
            }
        } else {
            let no_parts = parts.is_empty();
            if !(early || (outcome == "abandonada" && no_parts)) {
                return failed(
                    format!(
                        "en fase {} use 'navori master close' para entregar",
                        state.phase
                    ),
                    0,
                );
            }
            if options.reason.is_none_or(|r| js_trim(r).is_empty()) {
                return failed("--reason no puede estar vacío", 0);
            }
            if let Some(requested) = convert {
                match spec_path(cwd, specs_dir, requested)? {
                    Ok(path) => conversion_spec = Some(path),
                    Err(message) => return failed(message, 0),
                }
            }
        }
    }
    let closed_at = string_at(&state.normalized, &["closedAt"]).unwrap_or_else(utc_today);
    let updated: MasterState = if existing.is_some() {
        state.clone()
    } else {
        // `MasterStateSchema.parse({ ...state, outcome, closedAt, conversion | abandonment })`.
        let mut raw = state.normalized.clone();
        let JsValue::Object(object) = &mut raw else {
            return Err(Delegate);
        };
        object.insert("outcome", JsValue::string(outcome));
        object.insert("closedAt", JsValue::string(&closed_at));
        let reason = js_trim(options.reason.unwrap_or_default());
        if let Some(spec) = &conversion_spec {
            let mut conversion = JsObject::new();
            conversion.insert("spec", JsValue::string(spec));
            conversion.insert("reason", JsValue::string(reason));
            object.insert("conversion", JsValue::Object(conversion));
        }
        if outcome == "abandonada" {
            let mut abandonment = JsObject::new();
            abandonment.insert("reason", JsValue::string(reason));
            abandonment.insert("phase", JsValue::string(state.phase));
            object.insert("abandonment", JsValue::Object(abandonment));
        }
        state::master_state(&raw).map_err(|_| Delegate)?
    };
    let mut writes: Vec<Planned> = Vec::new();
    // Step 1: durable outcome and date.
    if existing.is_none() {
        writes.push(save(state_path.clone(), &updated.normalized)?);
    }
    let open = updated.phase != "closed";
    // Step 2: the last derived status while the stage is still active.
    let status = if open {
        let status = status::legacy_with(
            cwd,
            specs_dir,
            Path::new(master_dir),
            index,
            stage,
            config,
            updated.clone(),
            parts.clone(),
        )?;
        writes.extend(plan_status_writes(
            cwd,
            specs_dir,
            master_dir,
            config.english,
            index,
            Some(&status),
        )?);
        // `writeMasterStatus` reads the config for the status and again for itself.
        config_reads += 2 + status.config_reads;
        Some(status)
    } else {
        None
    };
    // `{ ...updated, phase: "closed", history: [...history, { phase: "closed", at: closedAt }] }`.
    let mut final_state = updated.normalized.clone();
    if open {
        let JsValue::Object(object) = &mut final_state else {
            return Err(Delegate);
        };
        object.insert("phase", JsValue::string("closed"));
        let mut entry = JsObject::new();
        entry.insert("phase", JsValue::string("closed"));
        entry.insert("at", JsValue::string(&closed_at));
        match object.get_mut("history") {
            Some(JsValue::Array(history)) => history.push(JsValue::Object(entry)),
            _ => return Err(Delegate),
        }
    }
    let final_bytes = format!("{}\n", final_state.stringify(Some(2)).ok_or(Delegate)?);
    // Step 3: `CLOSURE.md` hashes the exact state bytes step 4 persists.
    let closure_path = js_join(&stage_path, "CLOSURE.md");
    if !Path::new(&closure_path).exists() {
        // `readMasterStatus` again, over the files step 2 wrote.
        if let Some(status) = &status {
            config_reads += 1 + status.config_reads;
        }
        let input = ClosureInput {
            stage_path: &stage_path,
            stage,
            english: config.english,
            parts: &parts,
            status: status.as_ref(),
            written: &writes,
        };
        let closure = render_closure(&input, &final_state, &final_bytes)?;
        writes.push((closure_path, closure));
    }
    // Step 4: the stage becomes immutable.
    if open {
        writes.push((state_path, final_bytes));
    }
    // Step 5: the registry and its derived index move together.
    let final_index = MasterIndex {
        version: index.version,
        stages: index
            .stages
            .iter()
            .map(|entry| {
                if entry.dir != stage.dir {
                    return entry.clone();
                }
                let mut closed = entry.clone();
                closed.state = match outcome {
                    "entregada" => StageState::Closed,
                    "convertida" => StageState::Converted,
                    _ => StageState::Abandoned,
                };
                closed.closed_at = Some(closed_at.clone());
                closed.spec = string_at(&final_state, &["conversion", "spec"]);
                closed
            })
            .collect(),
    };
    writes.push(save(
        js_join(master_dir, "index.json"),
        &final_index.to_json(),
    )?);
    writes.push((
        js_join(master_dir, "INDEX.md"),
        render_index_md(&final_index, specs_dir),
    ));
    Ok(ClosePlan::Close {
        stage: Some(stage.dir.clone()),
        outcome: Some(outcome),
        writes,
        config_reads,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decisions_are_counted_like_the_regex() {
        let text = "## D1 uno\n## D12\n## D3a no\n##  D4 no\n x ## D5 no\r## D6-b\n## D";
        assert_eq!(decision_count(text), 3);
    }

    #[test]
    fn cells_escape_pipes_and_fold_line_breaks() {
        assert_eq!(escape_cell(Some("a|b\r\n\nc\rd")), "a\\|b c d");
        assert_eq!(escape_cell(None), "—");
    }

    #[test]
    fn paths_follow_node_posix() {
        assert_eq!(resolve("/r/specs/x", ".."), "/r/specs");
        assert_eq!(relative("/r", "/r/specs/a/b"), "specs/a/b");
    }
}
