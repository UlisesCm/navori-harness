//! What `plan gate` needs of `lib/plan/check.ts` (`checkWorkplan`): whether a workplan passes,
//! and its level. A failing workplan is never judged here: its message quotes zod issues and
//! evidence notes the gate hands to the TS, so every failure is [`Checked::NeedsTs`]. Rejecting
//! more than the TS is therefore safe; accepting what the TS rejects is a parity bug.

use std::collections::BTreeSet;

use crate::js_json::{JsObject, JsValue};
use crate::plan::classify::{ClassifyInput, classify, declared_flags_from_signals};
use crate::plan::expected::{Expected, parse_expected};
use crate::posix::js_trim;

/// The verdict of [`check_workplan`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checked {
    /// `checkWorkplan(...).ok` with the workplan's `level` and `feature`.
    Ok { level: u8, feature: String },
    /// A failing workplan, or one Rust cannot judge exactly.
    NeedsTs,
}

/// Project context of `projectClassifyContext`: `project.criticalPaths` and `project.localSkills`.
#[derive(Debug, Clone, Default)]
pub struct ProjectContext {
    pub critical_paths: Option<Vec<String>>,
    pub local_skill_ids: Option<Vec<String>>,
}

type V<T> = Option<T>;

fn object(value: &JsValue) -> V<&JsObject> {
    match value {
        JsValue::Object(object) => Some(object),
        _ => None,
    }
}

fn text(value: &JsValue) -> V<String> {
    match value {
        JsValue::String(s) => s.to_rust(),
        _ => None,
    }
}

fn non_empty(value: &JsValue) -> V<String> {
    text(value).filter(|s| !s.is_empty())
}

/// `z.number().int()` within `[min, max]`.
fn int_in(value: &JsValue, min: f64, max: f64) -> V<f64> {
    match value {
        JsValue::Number(n) if n.fract() == 0.0 && *n >= min && *n <= max => Some(*n),
        _ => None,
    }
}

fn level(value: &JsValue) -> V<u8> {
    let n = int_in(value, 0.0, 3.0)?;
    // `z.literal(0)` also matches `-0`; the cast keeps it 0.
    Some(n.abs() as u8)
}

fn array(value: &JsValue) -> V<&[JsValue]> {
    match value {
        JsValue::Array(items) => Some(items),
        _ => None,
    }
}

/// An optional field: absent is fine, present must satisfy `check`.
fn optional<T>(object: &JsObject, key: &str, check: impl Fn(&JsValue) -> V<T>) -> V<Option<T>> {
    match object.get(key) {
        None | Some(JsValue::Undefined) => Some(None),
        Some(value) => check(value).map(Some),
    }
}

/// `^A\d+$` on a record key or an id.
fn acceptance_id(id: &str) -> bool {
    id.strip_prefix('A')
        .is_some_and(|digits| !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
}

fn string_array(value: &JsValue) -> V<Vec<String>> {
    array(value)?.iter().map(text).collect()
}

fn record(value: &JsValue) -> V<Vec<(String, &JsValue)>> {
    let object = object(value)?;
    object
        .ordered()
        .into_iter()
        .map(|(key, value)| {
            let key = key.to_rust().filter(|k| acceptance_id(k))?;
            Some((key, value))
        })
        .collect()
}

struct Criterion {
    id: String,
    command: String,
    expected: String,
}

fn criterion(value: &JsValue) -> V<Criterion> {
    let o = object(value)?;
    let id = text(o.get("id")?).filter(|id| acceptance_id(id))?;
    non_empty(o.get("description")?)?;
    Some(Criterion {
        id,
        command: non_empty(o.get("command")?)?,
        expected: non_empty(o.get("expected")?)?,
    })
}

fn progress_status(value: &JsValue) -> V<()> {
    let status = text(value)?;
    matches!(status.as_str(), "pendiente" | "cumplido" | "bloqueado").then_some(())
}

fn evidence(value: &JsValue) -> V<()> {
    let o = object(value)?;
    match text(o.get("kind")?)?.as_str() {
        "recorded" => {
            for key in ["command", "ranAt", "tree", "worktreeTree"] {
                non_empty(o.get(key)?)?;
            }
            text(o.get("head")?)?;
            matches!(o.get("dirty")?, JsValue::Bool(_)).then_some(())?;
            optional(o, "exit", |v| int_in(v, 0.0, 255.0))?;
            optional(o, "expected", text)?;
            optional(o, "outcome", |v| {
                let t = text(v)?;
                matches!(t.as_str(), "pass" | "fail" | "unevaluated").then_some(())
            })?;
            Some(())
        }
        "unevidenced" => (text(o.get("reason")?)? == "engine-without-signal").then_some(()),
        _ => None,
    }
}

fn pair(value: &JsValue, a: &str, b: &str) -> V<(String, String)> {
    let o = object(value)?;
    Some((non_empty(o.get(a)?)?, non_empty(o.get(b)?)?))
}

/// The parsed fields the structural rules read.
struct Plan {
    feature: String,
    level: u8,
    classification_level: u8,
    signals: Vec<String>,
    acceptance: Vec<Criterion>,
    files: Vec<String>,
    progress: Vec<String>,
    solution_blocked: bool,
    has_solution: bool,
    phases: Option<Vec<(String, Vec<String>)>>,
    risks: Option<usize>,
}

/// `WorkplanSchema.safeParse(raw).success`, with the fields the rules need. `source` (a master
/// delivery projection) is never judged here.
fn schema(raw: &JsValue) -> V<Plan> {
    let o = object(raw)?;
    let feature = non_empty(o.get("feature")?)?;
    let level = level(o.get("level")?)?;
    let classification = object(o.get("classification")?)?;
    int_in(classification.get("score")?, 0.0, 10.0)?;
    let classification_level = self::level(classification.get("level")?)?;
    let signals = string_array(classification.get("signals")?)?;
    non_empty(o.get("objective")?)?;
    optional(o, "request", |v| match v {
        JsValue::String(s) if !s.units().is_empty() && s.units().len() <= 20_000 => Some(()),
        _ => None,
    })?;
    let acceptance: Vec<Criterion> = array(o.get("acceptance")?)?
        .iter()
        .map(criterion)
        .collect::<V<_>>()?;
    if acceptance.is_empty() {
        return None;
    }
    optional(o, "outOfScope", string_array)?;
    let files = optional(o, "files", |v| {
        array(v)?
            .iter()
            .map(|f| {
                let f = object(f)?;
                matches!(f.get("new")?, JsValue::Bool(_)).then_some(())?;
                non_empty(f.get("path")?)
            })
            .collect::<V<Vec<_>>>()
    })?
    .unwrap_or_default();
    let progress = optional(o, "progress", |v| {
        record(v)?
            .into_iter()
            .map(|(k, v)| progress_status(v).map(|()| k))
            .collect::<V<Vec<_>>>()
    })?
    .unwrap_or_default();
    optional(o, "evidence", |v| {
        record(v)?.into_iter().try_for_each(|(_, v)| evidence(v))
    })?;
    optional(o, "decisions", |v| {
        array(v)?
            .iter()
            .try_for_each(|d| pair(d, "text", "date").map(|_| ()))
    })?;
    let solution = optional(o, "solution", |v| {
        let s = object(v)?;
        non_empty(s.get("path")?)?;
        let verdict = text(s.get("verdict")?)?;
        matches!(verdict.as_str(), "READY" | "CONCERNS" | "BLOCKED").then_some(verdict == "BLOCKED")
    })?;
    let phases = optional(o, "phases", |v| {
        array(v)?
            .iter()
            .map(|p| {
                let p = object(p)?;
                let name = non_empty(p.get("name")?)?;
                let ids = string_array(p.get("acceptance")?)?;
                ids.iter()
                    .all(|id| acceptance_id(id))
                    .then_some((name, ids))
            })
            .collect::<V<Vec<_>>>()
    })?;
    let risks = optional(o, "risks", |v| {
        let items = array(v)?;
        items
            .iter()
            .try_for_each(|r| pair(r, "risk", "rollback").map(|_| ()))?;
        Some(items.len())
    })?;
    if o.get("source")
        .is_some_and(|s| !matches!(s, JsValue::Undefined))
    {
        return None;
    }
    Some(Plan {
        feature,
        level,
        classification_level,
        signals,
        acceptance,
        files,
        progress,
        solution_blocked: solution == Some(true),
        has_solution: solution.is_some(),
        phases,
        risks,
    })
}

/// `checkStructural` has no finding.
fn structural(plan: &Plan, feature: &str) -> V<()> {
    if plan.feature != feature || plan.solution_blocked {
        return None;
    }
    let mut seen = BTreeSet::new();
    for c in &plan.acceptance {
        if !seen.insert(c.id.as_str())
            || js_trim(&c.command).is_empty()
            || js_trim(&c.expected).is_empty()
        {
            return None;
        }
        match parse_expected(&c.expected)? {
            Expected::Invalid(_) | Expected::NeedsJs => return None,
            Expected::Free | Expected::Exit(_) | Expected::Contains(_) => {}
        }
    }
    if plan.progress.iter().any(|id| !seen.contains(id.as_str())) {
        return None;
    }
    let phases = plan.phases.as_deref().unwrap_or_default();
    if phases
        .iter()
        .flat_map(|(_, ids)| ids)
        .any(|id| !seen.contains(id.as_str()))
    {
        return None;
    }
    if plan.level >= 2 && (!plan.has_solution || phases.is_empty() || plan.risks.unwrap_or(0) == 0)
    {
        return None;
    }
    Some(())
}

/// `checkLevel` has no finding.
fn level_ok(plan: &Plan, project: &ProjectContext) -> V<()> {
    let input = ClassifyInput {
        files: plan.files.clone(),
        critical_paths: project.critical_paths.clone().unwrap_or_default(),
        local_skill_ids: project
            .local_skill_ids
            .as_ref()
            .map(|ids| ids.iter().cloned().collect()),
        ..declared_flags_from_signals(&plan.signals)
    };
    let recomputed = classify(&input)?.level;
    (plan.classification_level.max(recomputed) <= plan.level).then_some(())
}

/// `checkWorkplan(raw, { cwd, feature }).ok` (evidence notes never fail it), with the level.
#[must_use]
pub fn check_workplan(raw: &JsValue, feature: &str, project: &ProjectContext) -> Checked {
    let verdict = schema(raw).and_then(|plan| {
        structural(&plan, feature)?;
        level_ok(&plan, project)?;
        Some(Checked::Ok {
            level: plan.level,
            feature: plan.feature,
        })
    });
    verdict.unwrap_or(Checked::NeedsTs)
}
