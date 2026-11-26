//! `resumePlans` (`lib/plan/resume.ts`, spec 0060 T11): read-only continuity that carries the
//! task text and revalidates each workplan's acceptance evidence, review and receipt, never
//! reviving a stale guarantee.
//!
//! [`resume_plans`] answers `None` where the TS's answer depends on something this port does not
//! reproduce (a document Rust cannot read exactly, a master-delivery `source`, a parallel
//! authority, a failure whose message is git's or Node's), and the command hands the call to the
//! TS. Nothing here writes.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::content_identity::{self, CONTENT_MAX_BYTES, Failure, Identity};
use crate::diagnose::receipt::{CheckOptions, check_receipt};
use crate::handoff::ownership::read_ownership;
use crate::handoff::review::parse_sidecar;
use crate::handoff::review_evidence::{EvidenceOptions, correlate_review};
use crate::js_json::{JsObject, JsValue};
use crate::plan::check::schema;
use crate::plan::evidence::{
    Current, EvidenceVerdict, FingerprintOptions, Git, ValidateInput, fingerprint_tree, read_head,
    validate_evidence,
};
use crate::process::{Env, ProcessRunner};
use crate::state_files::{Refusal, artifact_path, resolve_state_root};

/// The most a resume pass may take (`Math.min(5000, …)`).
pub const RESUME_BUDGET: Duration = Duration::from_secs(5);

/// Read budget of each state file (64 KiB).
const READ_BUDGET: u64 = 65536;

/// What `readConfig` gave `resumePlans`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigFacts {
    /// It threw: the message the TS would report.
    Thrown(String),
    /// `config.prTarget ?? config.branchBase` and `config.qualityGate?.full ?? ""`.
    Values { target: String, gate: String },
}

/// The inputs of [`resume_plans`].
pub struct ResumeInput<'a> {
    /// `process.cwd()`.
    pub cwd: &'a str,
    /// Transport for git (D42).
    pub runner: &'a dyn ProcessRunner,
    /// The environment the TS process would see.
    pub env: &'a Env,
    /// The pass budget, capped at [`RESUME_BUDGET`].
    pub budget: Duration,
    /// `readConfig(join(root.cwd, "navori.config.json"))` for a checkout root; `None` delegates.
    pub config: &'a dyn Fn(&str) -> Option<ConfigFacts>,
}

#[derive(Debug, Clone)]
enum Guarantee {
    Passed,
    Pending(String),
}

impl Guarantee {
    fn pending(reason: &str) -> Self {
        Self::Pending(reason.to_owned())
    }

    fn to_js(&self) -> JsValue {
        let mut o = JsObject::new();
        match self {
            Self::Passed => o.insert("status", JsValue::string("passed")),
            Self::Pending(reason) => {
                o.insert("status", JsValue::string("pending"));
                o.insert("reason", JsValue::string(reason));
            }
        }
        JsValue::Object(o)
    }
}

struct PlanResult {
    feature: String,
    acceptance: Vec<(String, Guarantee)>,
    review: Guarantee,
    receipt: Guarantee,
}

enum Stop {
    /// The TS throws (or returns early) with this reason.
    Thrown(String),
    Unmodeled,
}

impl From<crate::handoff::Unmodeled> for Stop {
    fn from(_: crate::handoff::Unmodeled) -> Self {
        Self::Unmodeled
    }
}

fn thrown<T>(reason: &str) -> Result<T, Stop> {
    Err(Stop::Thrown(reason.to_owned()))
}

fn refusal(r: Refusal) -> Stop {
    match r {
        Refusal::Message(m) => Stop::Thrown(m),
        Refusal::Unmodeled => Stop::Unmodeled,
    }
}

/// `existsSync(path) && statSync(path).size <= 65536`, then `readFileSync(path, "utf8")`.
fn read_bounded(path: &Path) -> Result<Option<String>, Stop> {
    let Ok(meta) = std::fs::metadata(path) else {
        return Ok(None);
    };
    if meta.len() > READ_BUDGET {
        return Ok(None);
    }
    // A directory throws `EISDIR` (Node's message); bytes that are not UTF-8 decode lossily.
    let bytes = std::fs::read(path).map_err(|_| Stop::Unmodeled)?;
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| Stop::Unmodeled)
}

/// `/^workplan_[a-z0-9][a-z0-9._-]*\.json$/`.
fn is_workplan_name(name: &str) -> bool {
    let Some(slug) = name
        .strip_prefix("workplan_")
        .and_then(|n| n.strip_suffix(".json"))
    else {
        return false;
    };
    let mut bytes = slug.bytes();
    bytes
        .next()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}

struct Pass<'a> {
    input: &'a ResumeInput<'a>,
    deadline: Instant,
    current: String,
    plans: Vec<PlanResult>,
}

impl Pass<'_> {
    fn expired(&self) -> bool {
        Instant::now() >= self.deadline
    }

    fn run(&mut self) -> Result<(), Stop> {
        for name in [
            "progress/current.md",
            ".claude/progress/current.md",
            ".codex/progress/current.md",
        ] {
            if let Some(text) = read_bounded(&Path::new(self.input.cwd).join(name))? {
                self.current = text;
                break;
            }
        }
        let root =
            resolve_state_root(self.input.cwd, self.input.cwd, "resume", None).map_err(refusal)?;
        if std::fs::metadata(&root.path).is_err() {
            return thrown("no workplans");
        }
        let mut names: Vec<String> = std::fs::read_dir(&root.path)
            .map_err(|_| Stop::Unmodeled)?
            .filter_map(|e| e.ok()?.file_name().into_string().ok())
            .filter(|n| is_workplan_name(n))
            .collect();
        // Node's `readdirSync` (libuv `scandir`) sorts by bytes.
        names.sort();
        if names.is_empty() || names.len() > 32 {
            return thrown("workplan enumeration unavailable or exceeds budget");
        }
        let (default_target, gate) = match (self.input.config)(&root.cwd).ok_or(Stop::Unmodeled)? {
            ConfigFacts::Thrown(message) => return Err(Stop::Thrown(message)),
            ConfigFacts::Values { target, gate } => (target, gate),
        };
        let git = Git {
            runner: self.input.runner,
            env: self.input.env,
            deadline: Some(self.deadline),
        };
        let tree = PathBuf::from(&root.cwd);
        let current = Current {
            cwd: tree.clone(),
            head: String::new(),
            fingerprint: fingerprint_tree(&git, &tree, FingerprintOptions::default()),
        };
        let current = Current {
            head: read_head(&git, &tree),
            ..current
        };
        let mut identities: HashMap<String, Result<Identity, Failure>> = HashMap::new();
        for name in &names {
            let path = artifact_path(&root, name).map_err(refusal)?;
            let meta = std::fs::metadata(&path).map_err(|_| Stop::Unmodeled)?;
            if meta.len() > READ_BUDGET {
                return thrown("workplan exceeds read budget");
            }
            let text = std::fs::read(&path)
                .ok()
                .and_then(|b| String::from_utf8(b).ok())
                .ok_or(Stop::Unmodeled)?;
            let raw = crate::js_json::parse(&text).ok_or(Stop::Unmodeled)?;
            // `schema` also refuses a `source` projection, which is never judged here.
            let plan = schema(&raw).ok_or(Stop::Unmodeled)?;
            if *name != format!("workplan_{}.json", plan.feature) {
                return thrown("invalid workplan binding");
            }
            let target = read_ownership(&root.cwd, &plan.feature, Some(&root.dir))?
                .map_or_else(|| default_target.clone(), |o| o.target);
            if !identities.contains_key(&target) {
                let content = if self.expired() {
                    Err(Failure::Timeout)
                } else {
                    content_identity::working_for(
                        &tree,
                        self.input.env,
                        Some(&target),
                        self.deadline.saturating_duration_since(Instant::now()),
                        CONTENT_MAX_BYTES,
                    )
                };
                identities.insert(target.clone(), content);
            }
            let content = &identities[&target];
            let mut acceptance: Vec<(String, Guarantee)> = Vec::new();
            for criterion in &plan.acceptance {
                let guarantee = if self.expired() {
                    Guarantee::pending("deadline or source authority unavailable")
                } else {
                    let verdict = validate_evidence(
                        &git,
                        &ValidateInput {
                            root: &root,
                            feature: &plan.feature,
                            id: &criterion.id,
                            command: &criterion.command,
                            expected: &criterion.expected,
                            impl_worktree: None,
                            delivery_binding: None,
                            current: Some(&current),
                        },
                    )
                    .ok_or(Stop::Unmodeled)?;
                    match verdict {
                        EvidenceVerdict::Ok(_) => Guarantee::Passed,
                        EvidenceVerdict::Failed { why, .. } => Guarantee::Pending(why),
                    }
                };
                match acceptance.iter_mut().find(|(id, _)| *id == criterion.id) {
                    Some(slot) => slot.1 = guarantee,
                    None => acceptance.push((criterion.id.clone(), guarantee)),
                }
            }
            let options = EvidenceOptions {
                target: &target,
                gate: &gate,
                current_content: Some(content),
                timeout: None,
            };
            let mut review = Guarantee::pending("review unavailable");
            let review_path =
                artifact_path(&root, &format!("review_{}.json", plan.feature)).map_err(refusal)?;
            if !self.expired()
                && let Some(text) = read_bounded(Path::new(&review_path))?
            {
                let raw = crate::js_json::parse(&text).ok_or(Stop::Unmodeled)?;
                if crate::handoff::ownership::has_lone_surrogate(&raw) {
                    return Err(Stop::Unmodeled);
                }
                if let Some(sidecar) = parse_sidecar(&raw) {
                    let correlation =
                        correlate_review(&root, &sidecar, Some(&options), self.input.env)?
                            .correlation;
                    let approved =
                        matches!(&sidecar.verdict, JsValue::String(v) if v.is("APPROVED"));
                    review = if approved && correlation == "correlated" {
                        Guarantee::Passed
                    } else {
                        Guarantee::pending(correlation)
                    };
                }
            }
            let mut receipt = Guarantee::pending("receipt unavailable");
            if !self.expired() {
                let checked = check_receipt(&CheckOptions {
                    cwd: &root.cwd,
                    process_cwd: &root.cwd,
                    feature: &plan.feature,
                    target: &target,
                    dir: &root.dir,
                    gate: &gate,
                    include_consumed: true,
                    deadline: Some(self.deadline),
                    current_content: Some(content),
                    runner: self.input.runner,
                    env: self.input.env,
                })
                .ok_or(Stop::Unmodeled)?;
                receipt = if checked.status == "ok" && checked.fresh {
                    Guarantee::Passed
                } else {
                    Guarantee::Pending(
                        checked
                            .error
                            .unwrap_or_else(|| "receipt stale or changed".to_owned()),
                    )
                };
            }
            self.plans.push(PlanResult {
                feature: plan.feature,
                acceptance,
                review,
                receipt,
            });
        }
        if self.expired() {
            return thrown("resume deadline exceeded");
        }
        Ok(())
    }

    fn to_js(&self, reason: Option<&str>) -> JsValue {
        let mut o = JsObject::new();
        o.insert(
            "status",
            JsValue::string(if reason.is_some() {
                "pending"
            } else {
                "evaluated"
            }),
        );
        o.insert("current", JsValue::string(&self.current));
        let plans = self
            .plans
            .iter()
            .map(|p| {
                let mut plan = JsObject::new();
                plan.insert("feature", JsValue::string(&p.feature));
                let mut acceptance = JsObject::new();
                for (id, g) in &p.acceptance {
                    acceptance.insert(id.as_str(), g.to_js());
                }
                plan.insert("acceptance", JsValue::Object(acceptance));
                plan.insert("review", p.review.to_js());
                plan.insert("receipt", p.receipt.to_js());
                JsValue::Object(plan)
            })
            .collect();
        o.insert("plans", JsValue::Array(plans));
        if let Some(reason) = reason {
            o.insert("reason", JsValue::string(reason));
        }
        JsValue::Object(o)
    }
}

/// `resumePlans(cwd, budgetMs)` as the object the TS returns; `None` hands the call to the TS.
#[must_use]
pub fn resume_plans(input: &ResumeInput<'_>) -> Option<JsValue> {
    let mut pass = Pass {
        input,
        deadline: Instant::now() + input.budget.min(RESUME_BUDGET),
        current: String::new(),
        plans: Vec::new(),
    };
    match pass.run() {
        Ok(()) => Some(pass.to_js(None)),
        Err(Stop::Unmodeled) => None,
        Err(Stop::Thrown(reason)) => {
            // A partial pass is not a current guarantee.
            for plan in &mut pass.plans {
                for (_, g) in &mut plan.acceptance {
                    *g = Guarantee::pending("resume incomplete");
                }
                plan.review = Guarantee::pending("resume incomplete");
                plan.receipt = Guarantee::pending("resume incomplete");
            }
            Some(pass.to_js(Some(&reason)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::is_workplan_name;

    #[test]
    fn workplan_names_follow_the_ts_pattern() {
        assert!(is_workplan_name("workplan_feat.json"));
        assert!(is_workplan_name("workplan_0060-e1.d_x.json"));
        assert!(!is_workplan_name("workplan_.json"));
        assert!(!is_workplan_name("workplan_-x.json"));
        assert!(!is_workplan_name("workplan_Feat.json"));
        assert!(!is_workplan_name("workplan_feat.md"));
    }
}
