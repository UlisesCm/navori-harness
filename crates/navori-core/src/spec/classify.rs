//! Spec classification, port of `classifySpec` (`lib/spec/classify.ts`, spec 0044 R4-R7, R14).

use super::tasks::{Format, ParsedTasks};

/// Effective `sdd.deliveries` thresholds (`DeliveryThresholds`), as JS numbers.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Thresholds {
    pub split_min_tasks: f64,
    pub split_min_loc: f64,
    pub max_prs_per_spec: f64,
}

/// `DEFAULT_DELIVERIES`.
pub const DEFAULT_THRESHOLDS: Thresholds = Thresholds {
    split_min_tasks: 12.0,
    split_min_loc: 1500.0,
    max_prs_per_spec: 4.0,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shape {
    Single,
    Split,
}

impl Shape {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::Split => "split",
        }
    }
}

/// A `SpecWarning`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Warning {
    pub rule: &'static str,
    pub where_: String,
    pub message: String,
}

/// A `SpecError` (ERROR / WHY / FIX plus its rule).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpecError {
    pub rule: &'static str,
    pub what: String,
    pub why: String,
    pub fix: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifiedMilestone {
    pub id: String,
    pub title: String,
    pub acceptance: Vec<String>,
    pub tasks: Vec<(String, bool)>,
    pub closes_unit: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ClassifiedDelivery {
    pub id: String,
    pub title: String,
    pub foundation: bool,
    pub estimated_loc: f64,
    pub last: bool,
    pub milestones: Vec<ClassifiedMilestone>,
}

/// `SpecSignals`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Signals {
    pub tasks: usize,
    pub deliveries: usize,
    pub milestones: usize,
    pub estimated_loc: f64,
    pub loc_declared: bool,
    pub exceeds_tasks: bool,
    pub exceeds_loc: bool,
}

/// `SpecClassification`; `validation` and the threshold comparison are constants of the
/// contract and are written by the caller.
#[derive(Debug, Clone, PartialEq)]
pub struct Classification {
    pub format: Format,
    pub shape: Shape,
    pub pr_count: usize,
    pub signals: Signals,
    pub thresholds: Thresholds,
    pub deliveries: Vec<ClassifiedDelivery>,
    pub warnings: Vec<Warning>,
    pub error: Option<SpecError>,
}

/// `${n}` of a JS number.
fn js(n: f64) -> String {
    crate::js_json::number_to_js(n)
}

/// `declaresCompletion`.
fn declares_completion(parsed: &ParsedTasks) -> bool {
    parsed.format == Format::Deliveries
        && !parsed.deliveries.is_empty()
        && parsed.orphan_tasks.is_empty()
        && parsed.orphan_criteria.is_empty()
        && parsed.malformed.is_empty()
        && parsed.deliveries.iter().all(|d| {
            !d.milestones.is_empty()
                && d.milestones
                    .iter()
                    .all(|m| !m.tasks.is_empty() && m.tasks.iter().all(|t| t.done))
        })
}

/// `classifySpec`.
#[must_use]
#[expect(
    clippy::cast_precision_loss,
    reason = "task and delivery counts are far below 2^53, as JS numbers"
)]
pub fn classify(parsed: &ParsedTasks, thresholds: Thresholds) -> Classification {
    let legacy = parsed.format == Format::Legacy;
    let mut warnings = Vec::new();
    let task_count = if legacy {
        parsed.legacy_task_count
    } else {
        parsed.all_tasks().count()
    };
    let estimated_loc = parsed
        .deliveries
        .iter()
        .fold(0.0, |sum, d| sum + d.estimated_loc.unwrap_or(0.0));
    let loc_declared = !legacy
        && !parsed.deliveries.is_empty()
        && parsed.deliveries.iter().all(|d| d.estimated_loc.is_some());
    if !legacy {
        for delivery in &parsed.deliveries {
            if delivery.estimated_loc.is_none() {
                warnings.push(Warning {
                    rule: "loc-undeclared",
                    where_: delivery.id.clone(),
                    message: format!(
                        "{} declares no \"Estimated LOC:\"; counted as 0, so only the task threshold decides",
                        delivery.id
                    ),
                });
            }
        }
    }
    let exceeds_tasks = task_count as f64 > thresholds.split_min_tasks;
    let exceeds_loc = estimated_loc > thresholds.split_min_loc;
    let delivery_count = if legacy { 1 } else { parsed.deliveries.len() };

    let mut shape = Shape::Single;
    if legacy {
        warnings.push(Warning {
            rule: "legacy-format",
            where_: "tasks.md".to_owned(),
            message: "tasks.md uses the previous format (no E<n> deliveries); treated as one delivery — shape single".to_owned(),
        });
        if exceeds_tasks || exceeds_loc {
            warnings.push(Warning {
                rule: "single-over-threshold",
                where_: "tasks.md".to_owned(),
                message: format!(
                    "{task_count} tasks exceed splitMinTasks={}; consider splitting the spec into deliveries",
                    js(thresholds.split_min_tasks)
                ),
            });
        }
    } else if delivery_count >= 2 {
        if exceeds_tasks || exceeds_loc {
            shape = Shape::Split;
        } else {
            warnings.push(Warning {
                rule: "merged-deliveries",
                where_: "tasks.md".to_owned(),
                message: format!(
                    "{delivery_count} deliveries do not exceed splitMinTasks={} or splitMinLoc={}; they ship as one PR",
                    js(thresholds.split_min_tasks),
                    js(thresholds.split_min_loc)
                ),
            });
        }
    }

    let deliveries = if legacy {
        vec![ClassifiedDelivery {
            id: "E1".to_owned(),
            title: "(previous format)".to_owned(),
            foundation: false,
            estimated_loc: 0.0,
            last: true,
            milestones: Vec::new(),
        }]
    } else {
        let total = parsed.deliveries.len();
        parsed
            .deliveries
            .iter()
            .enumerate()
            .map(|(di, delivery)| ClassifiedDelivery {
                id: delivery.id.clone(),
                title: delivery.title.clone(),
                foundation: delivery.foundation,
                estimated_loc: delivery.estimated_loc.unwrap_or(0.0),
                last: di == total - 1,
                milestones: delivery
                    .milestones
                    .iter()
                    .enumerate()
                    .map(|(mi, m)| ClassifiedMilestone {
                        id: m.id.clone(),
                        title: m.title.clone(),
                        acceptance: m.criteria.iter().map(|c| c.id.clone()).collect(),
                        tasks: m.tasks.iter().map(|t| (t.id.clone(), t.done)).collect(),
                        closes_unit: mi == delivery.milestones.len() - 1
                            && (shape == Shape::Split || di == total - 1),
                    })
                    .collect(),
            })
            .collect()
    };

    let mut error = None;
    if delivery_count as f64 > thresholds.max_prs_per_spec {
        let cap = js(thresholds.max_prs_per_spec);
        if declares_completion(parsed) {
            warnings.push(Warning {
                rule: "completed-over-budget",
                where_: "tasks.md".to_owned(),
                message: format!(
                    "spec declares {delivery_count} deliveries above sdd.deliveries.maxPrsPerSpec={cap}; all active task declarations are checked; reopening a task restores the cap error. This does not attest historical approval or acceptance execution; structural checks and the full closing gate remain required"
                ),
            });
        } else {
            error = Some(SpecError {
                rule: "too-many-deliveries",
                what: format!(
                    "spec declares {delivery_count} deliveries; sdd.deliveries.maxPrsPerSpec is {cap}"
                ),
                why: "each delivery ships as its own PR, and a spec beyond the cap is too large to review as one unit".to_owned(),
                fix: "split the spec into several specs of at most maxPrsPerSpec deliveries each, or raise sdd.deliveries.maxPrsPerSpec".to_owned(),
            });
        }
    }

    Classification {
        format: parsed.format,
        shape,
        pr_count: if shape == Shape::Split {
            delivery_count
        } else {
            1
        },
        signals: Signals {
            tasks: task_count,
            deliveries: delivery_count,
            milestones: parsed.deliveries.iter().map(|d| d.milestones.len()).sum(),
            estimated_loc,
            loc_declared,
            exceeds_tasks,
            exceeds_loc,
        },
        thresholds,
        deliveries,
        warnings,
        error,
    }
}
