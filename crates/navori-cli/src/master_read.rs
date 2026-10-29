//! `navori master check --part|--fit` and `navori master template`, native (spec 0060 T8).
//!
//! Read-only like the TS (`commands/master.ts`). `master check` without `--part` or `--fit`
//! (the stage and phase checks) and `--stage` stay on the TS: the manifest entry `requires` one of
//! the native flags. Everything is computed before the first byte of output, and whatever is not
//! reproduced returns [`Outcome::Delegate`]: an argv citty might read differently, a missing or
//! invalid config, an index, state or parts file the schemas reject (their messages are zod's),
//! and the files `fit` reads when they are absent (the TS crashes there).

use std::ffi::OsString;
use std::path::Path;

use navori_core::integrity::is_js_whitespace;
use navori_core::js_json::JsValue;
use navori_core::master::check_part::check_part;
use navori_core::master::checks::{build_stage_ctx, check_closed_stage, run_master_check};
use navori_core::master::fit::{FitResult, evaluate_fit};
use navori_core::master::index::{self, StageEntry};
use navori_core::master::state;
use navori_core::master::status::read_json;
use navori_core::master::templates::{TEMPLATE_NAMES, print_issue_template, print_template};

use crate::help::{ArgDef, ArgKind, CommandDef};
use crate::js_path::js_resolve;
use crate::master::{MASTER_PARENT, part_config};
use crate::native_io::{self, Output, json_line, object, read_config, string};
use crate::{NativeCall, Outcome};

const CHECK: CommandDef = CommandDef {
    name: "check",
    description: "Validate the active stage, or a closed one with --stage (R50)",
    args: &[
        ArgDef {
            name: "stage",
            kind: ArgKind::String,
            description: "NN-slug of a closed stage to validate",
        },
        ArgDef {
            name: "part",
            kind: ArgKind::String,
            description: "P<n> of a linked part spec to validate",
        },
        ArgDef {
            name: "fit",
            kind: ArgKind::Boolean,
            description: "Count D9 fit criteria without making a decision",
        },
        ArgDef {
            name: "json",
            kind: ArgKind::Boolean,
            description: "Print machine-readable result for --fit",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Repo root",
        },
    ],
    sub_commands: &[],
};

const TEMPLATE: CommandDef = CommandDef {
    name: "template",
    description: "Print a master-plan template, or a filled issue (R42)",
    args: &[
        ArgDef {
            name: "name",
            kind: ArgKind::Positional,
            description: "plan | master | decisions | intake | digest | tasks | issue | ux | delivery-master | slice | parts",
        },
        ArgDef {
            name: "part",
            kind: ArgKind::String,
            description: "P<n>: print 'issue' filled from parts.json",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Repo root",
        },
    ],
    sub_commands: &[],
};

/// The tokens of a leaf command as citty would read them.
#[derive(Debug, Default, PartialEq, Eq)]
struct Parsed<'a> {
    positionals: Vec<&'a str>,
    bools: Vec<&'a str>,
    strings: Vec<(&'a str, &'a str)>,
}

impl<'a> Parsed<'a> {
    fn flag(&self, name: &str) -> bool {
        self.bools.contains(&name)
    }

    fn value(&self, name: &str) -> Option<&'a str> {
        self.strings
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, v)| *v)
    }
}

/// `None` for any shape whose citty reading is not certain: unknown or short options, `--no-*`,
/// `--flag=<v>` on a boolean, a repeated string option, or a value missing or shaped like an
/// option. `bools` and `strings` are the option names the command declares and this port reads.
fn parse_options<'a>(
    tokens: &[&'a str],
    bools: &[&'a str],
    strings: &[&'a str],
) -> Option<Parsed<'a>> {
    let mut parsed = Parsed::default();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        if let Some(name) = bools.iter().find(|b| token.strip_prefix("--") == Some(**b)) {
            parsed.bools.push(name);
        } else if let Some(name) = strings.iter().find(|s| {
            token.strip_prefix("--").is_some_and(|t| {
                t == **s || t.strip_prefix(**s).is_some_and(|r| r.starts_with('='))
            })
        }) {
            if parsed.value(name).is_some() {
                return None;
            }
            let value = if let Some(inline) = token
                .strip_prefix("--")
                .and_then(|t| t.strip_prefix(*name))
                .and_then(|r| r.strip_prefix('='))
            {
                inline
            } else {
                let next = *tokens.get(index)?;
                index += 1;
                next
            };
            if value.starts_with('-') {
                return None;
            }
            parsed.strings.push((name, value));
        } else if token.starts_with('-') {
            return None;
        } else {
            parsed.positionals.push(token);
        }
    }
    Some(parsed)
}

fn argv(args: &[OsString]) -> Option<Vec<&str>> {
    args.iter().map(|a| a.to_str()).collect()
}

fn fail(message: &str) -> Output {
    Output {
        stderr: format!("{message}\n"),
        code: 1,
        ..Output::default()
    }
}

fn cwd_of(parsed: &Parsed<'_>) -> Option<String> {
    let cwd = std::env::current_dir().ok()?;
    Some(js_resolve(&[
        cwd.to_str()?,
        parsed.value("cwd").unwrap_or_default(),
    ]))
}

fn push_warnings(out: &mut Output, warnings: &[String]) {
    for warning in warnings {
        out.stderr.push_str(warning);
        out.stderr.push('\n');
    }
}

/// What the commands read of the config and the registry.
struct Repo {
    cwd: String,
    specs_dir: String,
    master_dir: String,
    config: navori_core::config::Config,
    index: Option<index::MasterIndex>,
}

impl Repo {
    /// `readConfig` (warnings into `out`) and `readMasterIndex`; `None` where the TS throws.
    fn open(out: &mut Output, cwd: String) -> Option<Self> {
        let config = read_config(&cwd)??;
        push_warnings(out, &config.warnings);
        let specs_dir = native_io::specs_dir(Some(&config))?;
        let master_dir = js_resolve(&[&cwd, &specs_dir, index::MASTER_DIR_NAME]);
        let index = index::read(Path::new(&master_dir)).ok()?;
        Some(Self {
            cwd,
            specs_dir,
            master_dir,
            config,
            index,
        })
    }

    fn active(&self) -> Option<&StageEntry> {
        self.index.as_ref().and_then(index::MasterIndex::active)
    }

    fn english(&self) -> bool {
        part_config(&self.config).english
    }
}

/// `master check`.
#[must_use]
pub fn run_check(call: &NativeCall<'_>) -> Outcome {
    check(call.args).map_or(Outcome::Delegate, |out| Outcome::Exit(out.emit()))
}

fn check(args: &[OsString]) -> Option<Output> {
    let argv = argv(args)?;
    let ["master", "check", rest @ ..] = argv.as_slice() else {
        return None;
    };
    if rest.contains(&"--") {
        return None;
    }
    if rest.iter().any(|a| *a == "--help" || *a == "-h") {
        return Some(Output::usage(&CHECK, MASTER_PARENT, None));
    }
    let parsed = parse_options(rest, &["fit", "json"], &["part", "stage", "cwd"])?;
    let (fit, json, part) = (
        parsed.flag("fit"),
        parsed.flag("json"),
        parsed.value("part"),
    );
    // `args.stage` is read for its truthiness: an empty value is no stage.
    let stage = parsed.value("stage").filter(|s| !s.is_empty());
    // The mutual-exclusion error belongs to the TS.
    let exclusive = [stage.is_some(), part.is_some(), fit]
        .iter()
        .filter(|b| **b)
        .count();
    if !parsed.positionals.is_empty() || exclusive > 1 || (json && !fit) {
        return None;
    }
    let cwd = cwd_of(&parsed)?;
    if fit {
        return check_fit(cwd, json);
    }
    if let Some(stage) = stage {
        return check_stage(cwd, stage);
    }
    let Some(part) = part else {
        return check_active(cwd);
    };
    let id = part.trim_matches(is_js_whitespace);
    if id.is_empty() {
        return Some(fail("--part requires a P<n> value"));
    }
    check_part_command(cwd, id)
}

/// Reports `failures` as `master check` does, one `[navori] …` line each with exit 1; whether
/// there were none.
fn report_failures(out: &mut Output, failures: &[String]) -> bool {
    for failure in failures {
        out.stderr.push_str(&format!("[navori] {failure}\n"));
    }
    if !failures.is_empty() {
        out.code = 1;
    }
    failures.is_empty()
}

/// `runMasterCheck(cwd)` and the report of a plain `master check`.
fn check_active(cwd: String) -> Option<Output> {
    let mut out = Output::default();
    let repo = Repo::open(&mut out, cwd)?;
    let built = match build_stage_ctx(&repo.master_dir, repo.index.as_ref()).ok()? {
        Ok(built) => built,
        Err(message) => {
            out.stderr.push_str(&format!("{message}\n"));
            out.code = 1;
            return Some(out);
        }
    };
    let result = run_master_check(
        &repo.cwd,
        &repo.specs_dir,
        &repo.master_dir,
        part_config(&repo.config),
        repo.index.as_ref()?,
        &built,
    )
    .ok()?;
    // `readMasterStatus` and each `checkPart` read the config again before the report.
    for _ in 0..result.config_reads {
        push_warnings(&mut out, &repo.config.warnings);
    }
    if report_failures(&mut out, &result.failures) {
        let next = result
            .next_phase
            .map_or_else(String::new, |n| format!(" · lista para avanzar a {n}"));
        out.stdout
            .push_str(&format!("fase {}{next}\n", result.phase));
    }
    Some(out)
}

/// `checkClosedStage` and the report of `master check --stage <NN-slug>`.
fn check_stage(cwd: String, stage: &str) -> Option<Output> {
    let mut out = Output::default();
    let repo = Repo::open(&mut out, cwd)?;
    let failures = check_closed_stage(&repo.cwd, &repo.master_dir, stage, repo.english()).ok()?;
    if report_failures(&mut out, &failures) {
        out.stdout.push_str(&format!("{stage}: ok\n"));
    }
    Some(out)
}

/// `/^P[1-9]\d*$/`.
fn is_part_id(id: &str) -> bool {
    id.strip_prefix('P').is_some_and(|d| {
        d.starts_with(|c: char| ('1'..='9').contains(&c)) && d.bytes().all(|b| b.is_ascii_digit())
    })
}

/// `checkPart(cwd, id)` and the report of `master check --part`.
fn check_part_command(cwd: String, id: &str) -> Option<Output> {
    let mut out = Output::default();
    let findings: Vec<String> = if is_part_id(id) {
        let repo = Repo::open(&mut out, cwd)?;
        let config = part_config(&repo.config);
        if !config.master_plan {
            vec!["harness.masterPlan is disabled".to_owned()]
        } else if let Some(stage) = repo.active() {
            if stage.deliveries {
                vec![format!(
                    "{}: deliveries workflow is not supported by legacy part checks",
                    stage.dir
                )]
            } else {
                let parts_path = format!("{}/{}/parts.json", repo.master_dir, stage.dir);
                if Path::new(&parts_path).exists() {
                    let parts = state::parts(&read_json(Path::new(&parts_path)).ok()?).ok()?;
                    match parts.iter().find(|p| p.id == id) {
                        None => vec![format!("part {id} is not in parts.json")],
                        Some(part) => {
                            check_part(&repo.cwd, &repo.specs_dir, config, part, &parts)
                                .ok()?
                                .0
                        }
                    }
                } else {
                    vec![format!("missing {parts_path}")]
                }
            }
        } else {
            vec!["no active master-plan stage".to_owned()]
        }
    } else {
        vec![format!("invalid part id {id}")]
    };
    for finding in &findings {
        out.stderr.push_str(&format!("[navori] {finding}\n"));
    }
    if findings.iter().any(|f| !f.starts_with("warning:")) {
        out.code = 1;
    } else {
        out.stdout.push_str(&format!("{id}: ok\n"));
    }
    Some(out)
}

fn fit_json(fit: &FitResult) -> JsValue {
    let value = |v: navori_core::master::fit::FitValue| match v {
        navori_core::master::fit::FitValue::Count(n) => native_io::number(n),
        navori_core::master::fit::FitValue::Flag(b) => JsValue::Bool(b),
    };
    let criteria = fit
        .verifiable
        .iter()
        .map(|c| {
            object(vec![
                ("id", string(c.id)),
                ("value", value(c.value)),
                ("threshold", value(c.threshold)),
                ("pass", JsValue::Bool(c.pass)),
            ])
        })
        .collect();
    object(vec![
        ("verifiable", JsValue::Array(criteria)),
        ("allVerifiablePass", JsValue::Bool(fit.all_verifiable_pass)),
        (
            "judgment",
            JsValue::Array(vec![string("J1"), string("J2"), string("J3")]),
        ),
    ])
}

/// `checkFit(cwd)` and the report of `master check --fit [--json]`.
fn check_fit(cwd: String, json: bool) -> Option<Output> {
    let mut out = Output::default();
    let repo = Repo::open(&mut out, cwd)?;
    // `buildCheckContext`: its setup failures are reported, the rest is thrown.
    let built = match build_stage_ctx(&repo.master_dir, repo.index.as_ref()).ok()? {
        Ok(built) => built,
        Err(message) => {
            out.stderr.push_str(&format!("{message}\n"));
            out.code = 1;
            return Some(out);
        }
    };
    let stage_path = built.stage_path;
    let read = |name: &str| -> Option<String> {
        let path = format!("{stage_path}/context/{name}");
        // A missing file is a plain `Error` in the TS: it crashes there.
        String::from_utf8(std::fs::read(path).ok()?).ok()
    };
    let (digest, codebase) = (read("DIGEST.md")?, read("CODEBASE.md")?);
    let fit = evaluate_fit(&digest, &codebase)?;
    if json {
        json_line(&mut out, &fit_json(&fit));
    } else {
        for c in &fit.verifiable {
            out.stdout.push_str(&format!(
                "{}: {} / {} {}\n",
                c.id,
                c.value.text(),
                c.threshold.text(),
                if c.pass { "pass" } else { "fail" }
            ));
        }
        out.stdout.push_str("J1, J2, J3: juicio\n");
    }
    if !fit.all_verifiable_pass {
        out.code = 1;
    }
    Some(out)
}

/// `master template`.
#[must_use]
pub fn run_template(call: &NativeCall<'_>) -> Outcome {
    template(call.args).map_or(Outcome::Delegate, |out| Outcome::Exit(out.emit()))
}

fn template(args: &[OsString]) -> Option<Output> {
    let argv = argv(args)?;
    let ["master", "template", rest @ ..] = argv.as_slice() else {
        return None;
    };
    if rest.contains(&"--") {
        return None;
    }
    if rest.iter().any(|a| *a == "--help" || *a == "-h") {
        return Some(Output::usage(&TEMPLATE, MASTER_PARENT, None));
    }
    let parsed = parse_options(rest, &[], &["part", "cwd"])?;
    if parsed.positionals.len() > 1 {
        return None;
    }
    let Some(name) = parsed.positionals.first().copied() else {
        let error = "Missing required positional argument: NAME".to_owned();
        return Some(Output::usage(&TEMPLATE, MASTER_PARENT, Some(error)));
    };
    let cwd = cwd_of(&parsed)?;
    if !TEMPLATE_NAMES.contains(&name) {
        return Some(fail(&format!(
            "plantilla desconocida \"{name}\": {}",
            TEMPLATE_NAMES.join(", ")
        )));
    }
    let mut out = Output::default();
    let repo = Repo::open(&mut out, cwd)?;
    let active = repo.active();
    let delivery_template = name == "delivery-master" || name == "slice";
    let report = |mut out: Output, message: String| {
        out.stderr.push_str(&format!("{message}\n"));
        out.code = 1;
        Some(out)
    };
    if delivery_template && !active.is_some_and(|s| s.deliveries) {
        return report(out, format!("{name} requires an active deliveries stage"));
    }
    if let Some(stage) = active.filter(|s| !delivery_template && s.deliveries) {
        return report(
            out,
            format!(
                "{}: legacy templates are not available for deliveries",
                stage.dir
            ),
        );
    }
    let english = repo.english();
    if let Some(part_id) = parsed.value("part").filter(|p| !p.is_empty()) {
        if name != "issue" {
            return report(
                out,
                "--part solo aplica a 'navori master template issue'".to_owned(),
            );
        }
        let Some(stage) = active else {
            return report(out, "no hay etapa activa".to_owned());
        };
        let parts_path = format!("{}/{}/parts.json", repo.master_dir, stage.dir);
        if !Path::new(&parts_path).exists() {
            return report(out, format!("falta {}/parts.json", stage.dir));
        }
        let parts = state::parts(&read_json(Path::new(&parts_path)).ok()?).ok()?;
        let Some(part) = parts.iter().find(|p| p.id == part_id) else {
            return report(out, format!("no existe la parte {part_id}"));
        };
        let issue = print_issue_template(part, &stage.dir, &repo.specs_dir, english)?;
        out.stdout.push_str(&format!("{issue}\n"));
        return Some(out);
    }
    // `activeStageState`: the active legacy stage's `state.json`, when it exists.
    let mode = if delivery_template {
        None
    } else if let Some(stage) = active {
        let state_path = format!("{}/{}/state.json", repo.master_dir, stage.dir);
        if Path::new(&state_path).exists() {
            state::master_state(&read_json(Path::new(&state_path)).ok()?)
                .ok()?
                .mode
        } else {
            None
        }
    } else {
        None
    };
    out.stdout.push_str(&print_template(name, english, mode)?);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_delegate_every_uncertain_shape() {
        let ok = parse_options(
            &["x", "--fit", "--part=P1", "--cwd", "d"],
            &["fit", "json"],
            &["part", "cwd"],
        );
        assert_eq!(
            ok,
            Some(Parsed {
                positionals: vec!["x"],
                bools: vec!["fit"],
                strings: vec![("part", "P1"), ("cwd", "d")],
            })
        );
        for argv in [
            &["--fit=true"][..],
            &["--no-fit"],
            &["--part"],
            &["--part", "--fit"],
            &["--part=a", "--part", "b"],
            &["--stage", "x"],
            &["-f"],
            &["--partial", "x"],
        ] {
            assert_eq!(
                parse_options(argv, &["fit", "json"], &["part", "cwd"]),
                None,
                "{argv:?}"
            );
        }
    }

    #[test]
    fn part_ids_are_p_then_a_positive_number() {
        assert!(is_part_id("P1") && is_part_id("P12"));
        for bad in ["P0", "P01", "p1", "P", "P1a", "1", ""] {
            assert!(!is_part_id(bad), "{bad}");
        }
    }
}
