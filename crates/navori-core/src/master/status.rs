//! `readMasterStatus` (`lib/master/status.ts`) for an active legacy stage, and `statusLine`.
//!
//! What this layer does not reproduce yet returns [`Delegate`] before anything is printed:
//! `run` evidence (its age comes from `git`, which goes through the process transport of spec
//! 0060 D42), the content checks of `UX.md`/`ux.json` (`checkUxContent`) and a `deliveries` stage.

use std::fs;
use std::path::{Path, PathBuf};

use super::check_part::{PartConfig, check_part};
use super::index::{MasterIndex, StageEntry, StageState};
use super::state::{self, Evidence, MASTER_PHASES, MasterState, Part};
use crate::integrity::is_js_whitespace;
use crate::js_json::{self, JsObject, JsValue};

/// The TS must answer this invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Delegate;

/// One acceptance criterion of an [`EffectivePart`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EffectiveCriterion {
    pub id: String,
    pub method: &'static str,
    pub verified: bool,
}

/// `EffectivePart`.
#[derive(Debug, Clone, PartialEq)]
pub struct EffectivePart {
    pub id: String,
    pub title: String,
    pub declared: &'static str,
    pub effective: &'static str,
    pub reason: Option<String>,
    pub tasks_done: usize,
    pub tasks_total: usize,
    pub spec: Option<String>,
    pub issue: Option<f64>,
    pub acceptance: Vec<EffectiveCriterion>,
}

/// `ArchitectContext`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchitectContext {
    pub full: Vec<String>,
    pub reference_only: Vec<String>,
}

/// The status of an active legacy stage.
#[derive(Debug, Clone, PartialEq)]
pub struct LegacyStatus {
    pub stage: StageEntry,
    pub state: MasterState,
    pub next_phase: Option<&'static str>,
    pub active_part: Option<String>,
    pub parts: Vec<EffectivePart>,
    pub discrepancies: Vec<String>,
    pub all_done: bool,
    pub closable: bool,
    pub blockers: Vec<String>,
    pub last_closed: Option<StageEntry>,
    /// Present (maybe `None` inside) only from stage 2 on.
    pub architect_context: Option<Option<ArchitectContext>>,
    /// How many times `checkPart` read the config again (its warnings print each time).
    pub config_reads: usize,
}

/// `path.resolve` over absolute UTF-8 POSIX paths.
fn resolve(segments: &[&str]) -> String {
    let start = segments
        .iter()
        .rposition(|s| s.starts_with('/'))
        .unwrap_or(0);
    let mut parts: Vec<&str> = Vec::new();
    for segment in &segments[start..] {
        for part in segment.split('/') {
            match part {
                "" | "." => {}
                ".." => {
                    parts.pop();
                }
                other => parts.push(other),
            }
        }
    }
    format!("/{}", parts.join("/"))
}

fn real(path: &str) -> Option<PathBuf> {
    fs::canonicalize(path).ok()
}

/// `path === root || path.startsWith(root + sep)`.
fn within(path: &Path, root: &Path) -> bool {
    path == root || path.starts_with(root)
}

/// `safeSpec`: the spec directory, when it exists inside `specsDir` physically.
fn safe_spec(cwd: &str, specs_dir: &str, relative: &str) -> Option<String> {
    let root = resolve(&[cwd, specs_dir]);
    let path = resolve(&[cwd, relative]);
    let lexical = path == root || path.starts_with(&format!("{root}/"));
    if !lexical || !Path::new(&path).exists() {
        return None;
    }
    let (real_path, real_root) = (real(&path)?, real(&root)?);
    within(&real_path, &real_root).then_some(path)
}

/// `/^\s*- \[([ xX])\] /gm` over `text`: (checked, total). `^` follows any line terminator and
/// `\s*` may cross them, so a box counts when the whitespace before it reaches the text start or
/// holds a line terminator.
fn checkbox_counts(text: &str) -> (usize, usize) {
    let (mut done, mut total) = (0, 0);
    for (at, _) in text.match_indices("- [") {
        let rest = &text[at + 3..];
        let mark = rest.chars().next();
        if !matches!(mark, Some(' ' | 'x' | 'X')) || !rest[1..].starts_with("] ") {
            continue;
        }
        let before = &text[..at];
        let run_start = before.trim_end_matches(is_js_whitespace).len();
        let run = &before[run_start..];
        if run_start == 0 || run.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
            total += 1;
            if mark != Some(' ') {
                done += 1;
            }
        }
    }
    (done, total)
}

/// `taskCounts(spec)`; `Err` when `tasks.md` is not UTF-8 (Node would decode it lossily).
fn task_counts(spec: Option<&str>) -> Result<(usize, usize), Delegate> {
    let Some(spec) = spec else {
        return Ok((0, 0));
    };
    let path = format!("{spec}/tasks.md");
    if !Path::new(&path).exists() {
        return Ok((0, 0));
    }
    let (Some(real_path), Some(real_spec)) = (real(&path), real(spec)) else {
        return Ok((0, 0));
    };
    if real_path == real_spec || !real_path.starts_with(&real_spec) {
        return Ok((0, 0));
    }
    let bytes = fs::read(&path).map_err(|_| Delegate)?;
    let text = String::from_utf8(bytes).map_err(|_| Delegate)?;
    Ok(checkbox_counts(&text))
}

fn read_json(path: &Path) -> Result<JsValue, Delegate> {
    let bytes = fs::read(path).map_err(|_| Delegate)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| Delegate)?;
    js_json::parse(text).ok_or(Delegate)
}

/// `checkUxDecision` and the presence half of `checkUxArtifacts`; `Err` when the content checks
/// would run (a consistent presence with `UX.md` on disk).
fn ux_blockers(
    stage_dir: &str,
    stage_path: &Path,
    state: &MasterState,
) -> Result<Vec<String>, Delegate> {
    let mut blockers = Vec::new();
    let phase = state.phase;
    if (phase == "mastered" || phase == "ux") && state.ux.is_none() {
        blockers.push(format!(
            "{stage_dir}: falta la decisión de UX; registre una con: navori master ux <none|md|md-json>"
        ));
    }
    if phase == "mastered" || phase == "ux" || phase == "executing" {
        let has_md = stage_path.join("UX.md").exists();
        let has_json = stage_path.join("ux.json").exists();
        let mut failures = Vec::new();
        match state.ux {
            None => {
                if has_json && !has_md {
                    failures.push(format!("{stage_dir}: ux.json existe sin UX.md"));
                }
            }
            Some("none") => {
                if has_md {
                    failures.push(format!(
                        "{stage_dir}: la decisión de UX es 'none' pero existe UX.md"
                    ));
                }
                if has_json {
                    failures.push(format!(
                        "{stage_dir}: la decisión de UX es 'none' pero existe ux.json"
                    ));
                }
            }
            Some(choice) => {
                if !has_md {
                    failures.push(format!(
                        "{stage_dir}: la decisión de UX es '{choice}' pero falta UX.md"
                    ));
                }
                if choice == "md-json" && !has_json {
                    failures.push(format!(
                        "{stage_dir}: la decisión de UX es 'md-json' pero falta ux.json"
                    ));
                }
                if choice == "md" && has_json {
                    failures.push(format!(
                        "{stage_dir}: la decisión de UX es 'md' pero existe ux.json"
                    ));
                }
            }
        }
        if failures.is_empty() && has_md {
            return Err(Delegate);
        }
        blockers.extend(failures);
    }
    Ok(blockers)
}

/// `closeBlockers` is empty.
fn deliverable(state: &MasterState, parts: &[EffectivePart]) -> bool {
    ["mastered", "ux", "executing"].contains(&state.phase)
        && !parts.is_empty()
        && parts
            .iter()
            .all(|p| ["hecho", "descartada", "diferida"].contains(&p.effective))
}

/// `contextForArchitects(index, masterDir)`.
fn architect_context(index: &MasterIndex, master_dir: &Path) -> Option<ArchitectContext> {
    let stages = &index.stages;
    let non_active: Vec<&StageEntry> = stages
        .iter()
        .filter(|s| s.state != StageState::Active)
        .collect();
    if non_active.is_empty() {
        return None;
    }
    let exists = |relative: &String| master_dir.join(relative).exists();
    let Some(last_closed) = stages.iter().rposition(|s| s.state == StageState::Closed) else {
        let full = non_active
            .iter()
            .flat_map(|s| {
                [
                    format!("{}/DECISIONS.md", s.dir),
                    format!("{}/CLOSURE.md", s.dir),
                ]
            })
            .filter(|p| exists(p))
            .collect();
        return Some(ArchitectContext {
            full,
            reference_only: Vec::new(),
        });
    };
    let closed = &stages[last_closed];
    let mut full = vec![
        format!("{}/MASTER.md", closed.dir),
        format!("{}/DECISIONS.md", closed.dir),
        format!("{}/CLOSURE.md", closed.dir),
    ];
    for s in &stages[last_closed + 1..] {
        if s.state == StageState::Converted || s.state == StageState::Abandoned {
            full.push(format!("{}/DECISIONS.md", s.dir));
            full.push(format!("{}/CLOSURE.md", s.dir));
        }
    }
    let mut reference_only: Vec<String> = stages[..last_closed]
        .iter()
        .map(|s| format!("{}/CLOSURE.md", s.dir))
        .collect();
    reference_only.push("INDEX.md".to_owned());
    Some(ArchitectContext {
        full: full.into_iter().filter(|p| exists(p)).collect(),
        reference_only: reference_only.into_iter().filter(|p| exists(p)).collect(),
    })
}

/// `readMasterStatus` for the active legacy `stage` of `index`.
///
/// # Errors
/// [`Delegate`] for every case listed in the module docs and wherever the TS throws.
pub fn legacy(
    cwd: &str,
    specs_dir: &str,
    master_dir: &Path,
    index: &MasterIndex,
    stage: &StageEntry,
    config: PartConfig,
) -> Result<LegacyStatus, Delegate> {
    if stage.deliveries {
        return Err(Delegate);
    }
    let stage_path = master_dir.join(&stage.dir);
    let state =
        state::master_state(&read_json(&stage_path.join("state.json"))?).map_err(|_| Delegate)?;
    let parts_path = stage_path.join("parts.json");
    let parts: Vec<Part> = if parts_path.exists() {
        state::parts(&read_json(&parts_path)?).map_err(|_| Delegate)?
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
    let mut discrepancies = Vec::new();
    let mut blockers = ux_blockers(&stage.dir, &stage_path, &state)?;
    let mut mapped = Vec::new();
    let mut config_reads = 0;
    for part in &parts {
        let spec = part
            .spec
            .as_deref()
            .and_then(|s| safe_spec(cwd, specs_dir, s));
        let (done, total) = task_counts(spec.as_deref())?;
        let missing: Vec<String> = part
            .acceptance
            .iter()
            .filter(|c| c.evidence == Evidence::None)
            .map(|c| format!("{}.{}: sin evidencia", part.id, c.id))
            .collect();
        let mut effective = part.state;
        if part.state != "descartada" && part.state != "diferida" {
            if part.spec.is_some() {
                effective = if spec.is_none() {
                    "pendiente"
                } else if total > 0 && done == total && missing.is_empty() {
                    "hecho"
                } else if done > 0 || (total > 0 && !missing.is_empty()) {
                    "parcial"
                } else {
                    "pendiente"
                };
            } else if part.state == "hecho" && !missing.is_empty() {
                effective = "parcial";
            }
        }
        if effective != part.state {
            discrepancies.push(format!(
                "{}: declarado {}, efectivo {effective}",
                part.id, part.state
            ));
        }
        if let (Some(declared), None) = (&part.spec, &spec) {
            blockers.push(format!("{}: spec no encontrada: {declared}", part.id));
        }
        if !["hecho", "descartada", "diferida"].contains(&effective) {
            blockers.push(format!("{}: {effective}", part.id));
        }
        if effective == "parcial" {
            blockers.extend(missing.iter().cloned());
        }
        if effective == "hecho" && part.spec.is_some() {
            let (failures, read) = check_part(cwd, specs_dir, config, part, &parts)?;
            config_reads += usize::from(read);
            blockers.extend(
                failures
                    .iter()
                    .filter(|f| !f.starts_with("warning:"))
                    .map(|f| format!("{}: {f}", part.id)),
            );
        }
        mapped.push(EffectivePart {
            id: part.id.clone(),
            title: part.title.clone(),
            declared: part.state,
            effective,
            reason: part.reason.clone(),
            tasks_done: done,
            tasks_total: total,
            spec: part.spec.clone(),
            issue: part.issue,
            acceptance: part
                .acceptance
                .iter()
                .map(|c| EffectiveCriterion {
                    id: c.id.clone(),
                    method: c.method,
                    verified: c.evidence != Evidence::None,
                })
                .collect(),
        });
    }
    let effective_of = |id: &str| mapped.iter().find(|p| p.id == id).map(|p| p.effective);
    let active = mapped
        .iter()
        .find(|p| p.effective == "parcial")
        .or_else(|| {
            mapped.iter().find(|p| {
                p.effective == "pendiente"
                    && parts
                        .iter()
                        .find(|part| part.id == p.id)
                        .is_some_and(|part| {
                            part.depends_on
                                .iter()
                                .all(|d| effective_of(d) == Some("hecho"))
                        })
            })
        })
        .map(|p| p.id.clone());
    let phase_index = MASTER_PHASES
        .iter()
        .position(|p| *p == state.phase)
        .unwrap_or(0);
    let next_phase = if state.phase == "executing" || state.phase == "closed" {
        None
    } else {
        MASTER_PHASES.get(phase_index + 1).copied()
    };
    let all_done = !mapped.is_empty() && mapped.iter().all(|p| p.effective == "hecho");
    let closable = !mapped.is_empty() && blockers.is_empty() && deliverable(&state, &mapped);
    Ok(LegacyStatus {
        stage: stage.clone(),
        state,
        next_phase,
        active_part: active,
        parts: mapped,
        discrepancies,
        all_done,
        closable,
        blockers,
        last_closed: index.last_closed().cloned(),
        architect_context: (stage.number >= 2.0).then(|| architect_context(index, master_dir)),
        config_reads,
    })
}

fn string(text: &str) -> JsValue {
    JsValue::string(text)
}

fn strings(items: &[String]) -> JsValue {
    JsValue::Array(items.iter().map(|s| string(s)).collect())
}

fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
    let mut out = JsObject::new();
    for (key, value) in entries {
        out.insert(key, value);
    }
    JsValue::Object(out)
}

#[expect(
    clippy::cast_precision_loss,
    reason = "task counts are far below 2^53, as JS numbers"
)]
fn count(n: usize) -> JsValue {
    JsValue::Number(n as f64)
}

fn optional(value: Option<&str>) -> JsValue {
    value.map_or(JsValue::Null, string)
}

/// `lastClosed` of the status.
#[must_use]
pub fn last_closed_json(stage: Option<&StageEntry>) -> JsValue {
    stage.map_or(JsValue::Null, |s| {
        object(vec![
            ("number", JsValue::Number(s.number)),
            ("slug", string(&s.slug)),
            ("state", string(s.state.as_str())),
            ("closedAt", optional(s.closed_at.as_deref())),
        ])
    })
}

impl LegacyStatus {
    /// `JSON.stringify(status)` value, keys in the TS order.
    #[must_use]
    pub fn to_json(&self) -> JsValue {
        let parts = self
            .parts
            .iter()
            .map(|p| {
                object(vec![
                    ("id", string(&p.id)),
                    ("title", string(&p.title)),
                    ("declared", string(p.declared)),
                    ("effective", string(p.effective)),
                    ("reason", optional(p.reason.as_deref())),
                    ("tasksDone", count(p.tasks_done)),
                    ("tasksTotal", count(p.tasks_total)),
                    ("spec", optional(p.spec.as_deref())),
                    ("issue", p.issue.map_or(JsValue::Null, JsValue::Number)),
                    (
                        "acceptance",
                        JsValue::Array(
                            p.acceptance
                                .iter()
                                .map(|c| {
                                    object(vec![
                                        ("id", string(&c.id)),
                                        ("method", string(c.method)),
                                        ("verified", JsValue::Bool(c.verified)),
                                        ("commitsBehind", JsValue::Null),
                                        ("orphan", JsValue::Bool(false)),
                                    ])
                                })
                                .collect(),
                        ),
                    ),
                ])
            })
            .collect();
        let mut entries = vec![
            (
                "stage",
                object(vec![
                    ("number", JsValue::Number(self.stage.number)),
                    ("slug", string(&self.stage.slug)),
                    ("dir", string(&self.stage.dir)),
                ]),
            ),
            ("phase", string(self.state.phase)),
            ("nextPhase", optional(self.next_phase)),
            ("mode", optional(self.state.mode)),
        ];
        if let Some(ux) = self.state.ux {
            entries.push(("ux", string(ux)));
        }
        entries.extend([
            ("activePart", optional(self.active_part.as_deref())),
            ("parts", JsValue::Array(parts)),
            ("discrepancies", strings(&self.discrepancies)),
            ("allDone", JsValue::Bool(self.all_done)),
            ("closable", JsValue::Bool(self.closable)),
            ("blockers", strings(&self.blockers)),
            ("evidenceBlockers", JsValue::Array(Vec::new())),
            ("lastClosed", last_closed_json(self.last_closed.as_ref())),
        ]);
        if let Some(context) = &self.architect_context {
            entries.push((
                "architectContext",
                context.as_ref().map_or(JsValue::Null, |c| {
                    object(vec![
                        ("full", strings(&c.full)),
                        ("referenceOnly", strings(&c.reference_only)),
                    ])
                }),
            ));
        }
        object(entries)
    }

    /// `statusLine(status, specsDir)` for a legacy stage (no orphan evidence in this layer).
    #[must_use]
    pub fn line(&self, specs_dir: &str) -> String {
        let part = self
            .active_part
            .as_deref()
            .and_then(|id| self.parts.iter().find(|p| p.id == id));
        let clean: String = part
            .map_or("", |p| p.title.as_str())
            .chars()
            .map(|c| {
                if (c as u32) < 32 || c as u32 == 127 {
                    ' '
                } else {
                    c
                }
            })
            .collect();
        let clean = crate::spec::text::squash(&clean);
        let short: String = clean.chars().take(60).collect::<String>().replace('"', "'");
        let what = part.map_or_else(
            || "sin parte activa".to_owned(),
            |p| format!("parte activa {} \"{short}\"", p.id),
        );
        let dir = &self.stage.dir;
        format!(
            "Plan maestro — etapa {dir}: {what} · {}/{} tareas · {specs_dir}/_master/{dir}/STATUS.md. En tu primera respuesta de la sesión, ofrece continuar con el plan maestro en una sola línea, sin interrumpir lo que el usuario pidió.",
            part.map_or(0, |p| p.tasks_done),
            part.map_or(0, |p| p.tasks_total),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checkbox_counts_follow_the_multiline_regex() {
        assert_eq!(
            checkbox_counts("- [ ] a\n  - [x] b\n\n\t- [X] c\nx - [ ] d\n"),
            (2, 3)
        );
        assert_eq!(checkbox_counts("a\r- [ ] b\u{2028}- [x] c"), (1, 2));
        assert_eq!(checkbox_counts("- [y] a\n- [ ]b"), (0, 0));
    }
}
