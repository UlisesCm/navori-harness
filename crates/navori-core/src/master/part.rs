//! `navori master part <P<n>>` on an active legacy stage (`lib/master/part.ts`
//! `changeMasterPart`, then `writeMasterStatus`), spec 0060 T8.
//!
//! Every guard runs before the first write, in the order the TS throws, and the derived files are
//! computed from the updated parts in memory: a native run either writes everything the TS would
//! or nothing at all. What this port does not reproduce returns [`Delegate`] before any write:
//! `run` evidence (`git status` and `git rev-parse` go through the process transport of spec 0060
//! D42), a missing or invalid `state.json` or `parts.json` (the TS reports Node's or zod's text),
//! and whatever `readMasterStatus` would delegate.

use std::fs;
use std::path::Path;

use super::check_part::PartConfig;
use super::checks::js_join;
use super::index::MasterIndex;
use super::state::{self, PART_STATES};
use super::status::{self, Delegate, read_json};
use super::write::{plan_status_writes_with_parts, utc_today, write_all};
use crate::integrity::is_js_whitespace;
use crate::js_json::{JsObject, JsValue, number_to_js};

/// The options of `master part`, `undefined` as `None`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PartChange<'a> {
    pub state: Option<&'a str>,
    pub reason: Option<&'a str>,
    pub spec: Option<&'a str>,
    pub issue: Option<&'a str>,
    pub accept: Option<&'a str>,
    pub command: Option<&'a str>,
    pub result: Option<&'a str>,
    pub approved_by: Option<&'a str>,
}

/// The result of `master part`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PartOutcome {
    /// The error the command reports with `reportError`, after `config_reads` more reads of the
    /// config (their warnings print each time).
    Failed {
        message: String,
        config_reads: usize,
    },
    /// `parts.json` and the derived files were written.
    Updated { config_reads: usize },
}

fn failed(message: impl Into<String>) -> Result<PartOutcome, Delegate> {
    Ok(PartOutcome::Failed {
        message: message.into(),
        config_reads: 0,
    })
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(is_js_whitespace)
}

/// `realpathSync(path).startsWith(`${root}${sep}`)`.
fn real_within(path: &str, root: &str) -> Result<bool, Delegate> {
    let real = fs::canonicalize(path).map_err(|_| Delegate)?;
    Ok(real
        .to_str()
        .ok_or(Delegate)?
        .starts_with(&format!("{root}/")))
}

/// `containedSpec(cwd, specsDir, input)`: `Err` is the message the TS throws.
fn contained_spec(cwd: &str, specs_dir: &str, input: &str) -> Result<Result<(), String>, Delegate> {
    if js_trim(input).is_empty() || input != js_trim(input) || input.starts_with('/') {
        return Ok(Err(
            "--spec requires a repository-relative path without edge whitespace".to_owned(),
        ));
    }
    let root = resolve(cwd, specs_dir);
    let path = resolve(cwd, input);
    let is_dir = fs::metadata(&path).is_ok_and(|m| m.is_dir());
    if path == root || !path.starts_with(&format!("{root}/")) || !is_dir {
        return Ok(Err(format!(
            "--spec must name an existing directory beneath {specs_dir}/"
        )));
    }
    let real_root = fs::canonicalize(&root).map_err(|_| Delegate)?;
    let real_root = real_root.to_str().ok_or(Delegate)?;
    if !real_within(&path, real_root)? {
        return Ok(Err("--spec resolves outside specsDir".to_owned()));
    }
    Ok(Ok(()))
}

/// Node's `path.resolve(cwd, rel)` (POSIX) for an absolute `cwd`.
fn resolve(cwd: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let joined = if rel.starts_with('/') {
        rel.to_owned()
    } else {
        format!("{cwd}/{rel}")
    };
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

fn object_mut(value: &mut JsValue) -> Result<&mut JsObject, Delegate> {
    match value {
        JsValue::Object(object) => Ok(object),
        _ => Err(Delegate),
    }
}

fn string_of(object: &JsObject, key: &str) -> Option<String> {
    match object.get(key) {
        Some(JsValue::String(s)) => s.to_rust(),
        _ => None,
    }
}

/// The part `id` of the normalized document, mutably.
fn part_mut<'a>(document: &'a mut JsValue, id: &str) -> Result<&'a mut JsObject, Delegate> {
    let Some(JsValue::Array(parts)) = object_mut(document)?.get_mut("parts") else {
        return Err(Delegate);
    };
    parts
        .iter_mut()
        .filter_map(|p| match p {
            JsValue::Object(o) => Some(o),
            _ => None,
        })
        .find(|o| string_of(o, "id").as_deref() == Some(id))
        .ok_or(Delegate)
}

/// `--accept`: `Ok(Err(message))` for a refusal, `Err(Delegate)` where `git` is needed.
fn accept(
    cwd: &str,
    id: &str,
    target: &mut JsObject,
    change: &PartChange<'_>,
    criterion_id: &str,
) -> Result<Result<(), String>, Delegate> {
    if change.state.is_some()
        || change.reason.is_some()
        || change.spec.is_some()
        || change.issue.is_some()
    {
        return Ok(Err(
            "--accept cannot be combined with other part mutations".to_owned()
        ));
    }
    let part_state = string_of(target, "state").ok_or(Delegate)?;
    if part_state == "descartada" || part_state == "diferida" {
        return Ok(Err(format!("{id} is {part_state}")));
    }
    let Some(JsValue::Array(acceptance)) = target.get_mut("acceptance") else {
        return Err(Delegate);
    };
    let Some(criterion) = acceptance
        .iter_mut()
        .filter_map(|c| match c {
            JsValue::Object(o) => Some(o),
            _ => None,
        })
        .find(|o| string_of(o, "id").as_deref() == Some(criterion_id))
    else {
        return Ok(Err(format!("criterion {id}.{criterion_id} not found")));
    };
    let method = string_of(criterion, "method").ok_or(Delegate)?;
    if method == "manual" {
        if change.approved_by != Some("user") || change.command.is_some() || change.result.is_some()
        {
            return Ok(Err(
                "manual acceptance requires only --approved-by user".to_owned()
            ));
        }
        let mut evidence = JsObject::new();
        evidence.insert("kind", JsValue::string("approval"));
        evidence.insert("approvedBy", JsValue::string("user"));
        evidence.insert("date", JsValue::string(&utc_today()));
        criterion.insert("evidence", JsValue::Object(evidence));
        return Ok(Ok(()));
    }
    let (Some(command), Some(_)) = (
        change.command.filter(|c| !js_trim(c).is_empty()),
        change.result.filter(|r| !js_trim(r).is_empty()),
    ) else {
        return Ok(Err(
            "run acceptance requires --command and --result, without --approved-by".to_owned(),
        ));
    };
    if change.approved_by.is_some() {
        return Ok(Err(
            "run acceptance requires --command and --result, without --approved-by".to_owned(),
        ));
    }
    let block = |key: &str| match criterion.get(key) {
        Some(JsValue::Object(o)) => Ok(o.clone()),
        _ => Err(Delegate),
    };
    if method == "test" {
        let file = string_of(&block("test")?, "file").ok_or(Delegate)?;
        let path = resolve(cwd, &file);
        let repo = fs::canonicalize(cwd).map_err(|_| Delegate)?;
        let repo = repo.to_str().ok_or(Delegate)?;
        let inside = path.starts_with(&format!("{}/", resolve(cwd, "")))
            && Path::new(&path).exists()
            && real_within(&path, repo)?;
        if !inside || !command.contains(&file) {
            return Ok(Err(format!("test command must reference existing {file}")));
        }
    } else {
        let run = string_of(&block("command")?, "run").ok_or(Delegate)?;
        if js_trim(command) != js_trim(&run) {
            return Ok(Err(format!("command must equal declared run: {run}")));
        }
    }
    // `cleanOutsideSpecs` and the commit come from `git`.
    Err(Delegate)
}

/// The mutations without `--accept`: `Ok(Err(message))` for a refusal.
fn mutate(
    cwd: &str,
    specs_dir: &str,
    id: &str,
    target: &mut JsObject,
    change: &PartChange<'_>,
) -> Result<Result<(), String>, Delegate> {
    if change.command.is_some() || change.result.is_some() || change.approved_by.is_some() {
        return Ok(Err(
            "--command, --result and --approved-by require --accept".to_owned(),
        ));
    }
    if change.state.is_none()
        && change.reason.is_none()
        && change.spec.is_none()
        && change.issue.is_none()
    {
        return Ok(Err("part requires a mutation".to_owned()));
    }
    if let Some(value) = change.state {
        if !PART_STATES.contains(&value) {
            return Ok(Err(format!("invalid state {value}")));
        }
        let needs_reason = value == "descartada" || value == "diferida";
        if change.reason.is_some() && !needs_reason {
            return Ok(Err(
                "--reason is only valid with --state descartada or diferida".to_owned(),
            ));
        }
        target.insert("state", JsValue::string(value));
        let reason = change.reason.map(js_trim).filter(|r| !r.is_empty());
        let reason = match reason {
            Some(r) if needs_reason => JsValue::string(r),
            _ => JsValue::Null,
        };
        let missing = reason == JsValue::Null;
        target.insert("reason", reason);
        if needs_reason && missing {
            return Ok(Err(format!("--state {value} requires --reason")));
        }
    } else if change.reason.is_some() {
        return Ok(Err("--reason requires --state".to_owned()));
    }
    if let Some(spec) = change.spec {
        if let Err(message) = contained_spec(cwd, specs_dir, spec)? {
            return Ok(Err(message));
        }
        target.insert("spec", JsValue::string(spec));
    }
    if let Some(issue) = change.issue {
        match target.get("issue") {
            Some(JsValue::Null) => {}
            Some(JsValue::Number(n)) => {
                return Ok(Err(format!("{id} already has issue {}", number_to_js(*n))));
            }
            _ => return Err(Delegate),
        }
        let digits = issue.strip_prefix(|c: char| ('1'..='9').contains(&c));
        let number = digits
            .filter(|d| d.bytes().all(|b| b.is_ascii_digit()))
            .and_then(|_| issue.parse::<f64>().ok())
            .filter(|n| *n <= 9_007_199_254_740_991.0);
        let Some(number) = number else {
            return Ok(Err("--issue requires a positive integer".to_owned()));
        };
        target.insert("issue", JsValue::Number(number));
    }
    Ok(Ok(()))
}

/// `changeMasterPart(cwd, id, change)` followed by `writeMasterStatus(cwd)`, once `id` matches
/// `/^P[1-9]\d*$/` and the config has been read.
///
/// # Errors
/// [`Delegate`] before any write wherever the TS would behave differently or throw an error this
/// port does not reproduce.
pub fn change_part(
    cwd: &str,
    specs_dir: &str,
    master_dir: &str,
    config: PartConfig,
    index: Option<&MasterIndex>,
    id: &str,
    change: &PartChange<'_>,
) -> Result<PartOutcome, Delegate> {
    if !config.master_plan {
        return failed("harness.masterPlan is disabled; run navori master init");
    }
    let (Some(index), Some(stage)) = (index, index.and_then(MasterIndex::active)) else {
        return failed("no active stage; run navori master init");
    };
    if stage.deliveries {
        return failed(format!(
            "{}: deliveries workflow is not supported by legacy part operations",
            stage.dir
        ));
    }
    let stage_path = js_join(master_dir, &stage.dir);
    let master_state =
        state::master_state(&read_json(Path::new(&js_join(&stage_path, "state.json")))?)
            .map_err(|_| Delegate)?;
    if master_state.phase == "closed" {
        return failed("closed stage is read-only");
    }
    if let Some(outcome) = master_state.outcome {
        return failed(format!(
            "{}: cierre iniciado ({outcome}); reanude con 'navori master close'",
            stage.dir
        ));
    }
    let parts_path = js_join(&stage_path, "parts.json");
    let repo_root = fs::canonicalize(cwd).map_err(|_| Delegate)?;
    let repo_root = repo_root.to_str().ok_or(Delegate)?;
    if !real_within(&stage_path, repo_root)? || !real_within(&parts_path, repo_root)? {
        return failed("refusing to write parts.json outside repository");
    }
    let mut document =
        state::parts_normalized(&read_json(Path::new(&parts_path))?).map_err(|_| Delegate)?;
    let target = match part_mut(&mut document, id) {
        Ok(target) => target,
        Err(Delegate) => return failed(format!("part {id} not found")),
    };
    let refused = match change.accept {
        Some(criterion) => accept(cwd, id, target, change, criterion)?,
        None => mutate(cwd, specs_dir, id, target, change)?,
    };
    if let Err(message) = refused {
        return failed(message);
    }
    // `PartsSchema.parse(updated)`: a refusal there is zod's text.
    let normalized = state::parts_normalized(&document).map_err(|_| Delegate)?;
    let parts = state::parts(&normalized).map_err(|_| Delegate)?;
    let text = format!("{}\n", normalized.stringify(Some(2)).ok_or(Delegate)?);
    let legacy = status::legacy_with(
        cwd,
        specs_dir,
        Path::new(master_dir),
        index,
        stage,
        config,
        master_state,
        parts.clone(),
    )?;
    let files = plan_status_writes_with_parts(
        cwd,
        specs_dir,
        master_dir,
        config.english,
        index,
        &legacy,
        &parts,
    )?;
    // `parts.json` is atomic: if it fails nothing changed and the TS can take over.
    write_all(&[(parts_path, text)]).map_err(|_| Delegate)?;
    // `writeMasterStatus` reads the config for the status and again for itself.
    let config_reads = 2 + legacy.config_reads;
    Ok(match write_all(&files) {
        Ok(()) => PartOutcome::Updated { config_reads },
        // The catch reads the config once more for the stage it names.
        Err(detail) => PartOutcome::Failed {
            message: format!(
                "{}: parts.json actualizado; falló la escritura derivada: {detail}. Repare con 'navori master status'; no repita 'navori master part'.",
                stage.dir
            ),
            config_reads: config_reads + 1,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_follows_node_posix() {
        assert_eq!(resolve("/r", "specs/x/"), "/r/specs/x");
        assert_eq!(resolve("/r", "../x"), "/x");
        assert_eq!(resolve("/r", ""), "/r");
        assert_eq!(resolve("/r", "/abs"), "/abs");
    }
}
