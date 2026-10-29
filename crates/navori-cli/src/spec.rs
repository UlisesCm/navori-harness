//! `navori spec [classify|check] <feature> [--cwd <dir>] [--json]`, native (spec 0060 T5, R73).
//!
//! Read-only, like the TS command (`commands/spec.ts`): it never runs acceptance commands and
//! writes nothing. Everything is computed before the first byte of output, so whatever Rust does
//! not reproduce exactly returns `None` and the invocation goes to the TS: an argv citty might
//! read differently, a config `readConfig` rejects or this port does not model, a spec linked to a
//! master plan (its mapping is `master`'s, spec 0060 M3), or a file that is not UTF-8.

use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

use navori_core::config;
use navori_core::js_json::JsValue;
use navori_core::spec::check::{self, SpecCheck};
use navori_core::spec::classify::{self, Classification, DEFAULT_THRESHOLDS, Thresholds};
use navori_core::spec::tasks::{self, ParsedTasks};
use navori_core::spec::{is_spec_name, requirement_ids};

use crate::help::{ArgDef, ArgKind, CommandDef, Paint, Parent, citty_no_color};
use crate::js_path::{js_relative, js_resolve};
use crate::native_io::{Output, json_line, member, number, object, read_config, specs_dir, string};
use crate::{NativeCall, Outcome};

/// Version of the `--json` contract (`FORMAT_VERSION`).
const FORMAT_VERSION: f64 = 1.0;

const SHARED_ARGS: &[ArgDef] = &[
    ArgDef {
        name: "feature",
        kind: ArgKind::Positional,
        description: "Spec directory name",
    },
    ArgDef {
        name: "cwd",
        kind: ArgKind::String,
        description: "Repo root",
    },
    ArgDef {
        name: "json",
        kind: ArgKind::Boolean,
        description: "Output as JSON",
    },
];

const CLASSIFY: CommandDef = CommandDef {
    name: "classify",
    description: "Classify a spec as single (1 PR) or split (1 PR per delivery)",
    args: SHARED_ARGS,
    sub_commands: &[],
};

const CHECK: CommandDef = CommandDef {
    name: "check",
    description: "Validate a spec's tasks.md: milestones, criteria, coverage, vertical deliveries",
    args: SHARED_ARGS,
    sub_commands: &[],
};

const SPEC: CommandDef = CommandDef {
    name: "spec",
    description: "Classify and validate a spec's tasks.md",
    args: &[],
    sub_commands: &[
        ("classify", CLASSIFY.description),
        ("check", CHECK.description),
    ],
};

/// Names `name in subCommands` finds on `Object.prototype`: citty would run them as commands.
const PROTOTYPE_KEYS: &[&str] = &[
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

const ROOT: Parent<'static> = Parent {
    name: "navori",
    version: Some(navori_core::VERSION),
};

const SPEC_PARENT: Parent<'static> = Parent {
    name: "spec",
    version: None,
};

/// Which manifest entry selected the invocation: each row runs only its own command, so an
/// unlisted subcommand that reaches `spec` by prefix is still delegated (R7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Row {
    Group,
    Classify,
    Check,
}

/// `spec` alone: usage, `--help` and unknown subcommands.
#[must_use]
pub fn run_group(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Group))
}

/// `spec classify`.
#[must_use]
pub fn run_classify(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Classify))
}

/// `spec check`.
#[must_use]
pub fn run_check(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Check))
}

fn outcome(code: Option<ExitCode>) -> Outcome {
    code.map_or(Outcome::Delegate, Outcome::Exit)
}

fn run(args: &[OsString], row: Row) -> Option<ExitCode> {
    let argv: Vec<&str> = args.iter().map(|a| a.to_str()).collect::<Option<_>>()?;
    let (first, rest) = argv.split_first()?;
    if *first != "spec" || rest.contains(&"--") {
        return None;
    }
    let is_help = |a: &&str| *a == "--help" || *a == "-h";
    let help = rest.iter().any(is_help);
    let at = rest.iter().position(|a| !a.starts_with('-'));
    if rest[..at.unwrap_or(rest.len())].iter().any(|a| !is_help(a)) {
        return None;
    }
    let Some(at) = at else {
        if row != Row::Group {
            return None;
        }
        let error = (!help).then(|| "No command specified.".to_owned());
        return Some(Output::usage(&SPEC, ROOT, error).emit());
    };
    let leaf = match rest[at] {
        "classify" if row == Row::Classify => &CLASSIFY,
        "check" if row == Row::Check => &CHECK,
        "classify" | "check" => return None,
        name if PROTOTYPE_KEYS.contains(&name) || row != Row::Group => return None,
        name => {
            let error = (!help).then(|| {
                let paint = Paint {
                    color: !citty_no_color(),
                };
                format!("Unknown command {}", paint.cyan(name))
            });
            return Some(Output::usage(&SPEC, ROOT, error).emit());
        }
    };
    if help {
        return Some(Output::usage(leaf, SPEC_PARENT, None).emit());
    }
    let options = parse_leaf(&rest[at + 1..])?;
    let Some(feature) = options.feature else {
        let error = "Missing required positional argument: FEATURE".to_owned();
        return Some(Output::usage(leaf, SPEC_PARENT, Some(error)).emit());
    };
    let cwd = std::env::current_dir().ok()?;
    let cwd = js_resolve(&[cwd.to_str()?, options.cwd.unwrap_or_default()]);
    let out = if leaf.name == "classify" {
        classify_command(feature, &cwd, options.json)?
    } else {
        check_command(feature, &cwd, options.json)?
    };
    Some(out.emit())
}

/// The args of `classify` / `check` as citty would read them.
#[derive(Debug, Default, PartialEq, Eq)]
struct LeafOptions<'a> {
    feature: Option<&'a str>,
    cwd: Option<&'a str>,
    json: bool,
}

/// `None` for any shape whose citty reading is not certain: unknown or short options, `--no-*`,
/// `--json=<v>`, a repeated `--cwd`, or a `--cwd` value that looks like an option.
fn parse_leaf<'a>(tokens: &[&'a str]) -> Option<LeafOptions<'a>> {
    let mut options = LeafOptions::default();
    let mut positionals = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        if token == "--json" {
            options.json = true;
        } else if token == "--cwd" || token.starts_with("--cwd=") {
            if options.cwd.is_some() {
                return None;
            }
            let value = if let Some(inline) = token.strip_prefix("--cwd=") {
                inline
            } else {
                let next = *tokens.get(index)?;
                index += 1;
                next
            };
            if value.starts_with('-') {
                return None;
            }
            options.cwd = Some(value);
        } else if token.starts_with('-') {
            return None;
        } else {
            positionals.push(token);
        }
    }
    options.feature = positionals.first().copied();
    Some(options)
}

/// A Node `fs` error message for `readFileSync`, or `None` for one this port does not map.
fn node_read_error(error: &std::io::Error, path: &str) -> Option<String> {
    let (code, description, syscall) = match error.raw_os_error()? {
        2 => ("ENOENT", "no such file or directory", "open"),
        13 => ("EACCES", "permission denied", "open"),
        20 => ("ENOTDIR", "not a directory", "open"),
        21 => return Some("EISDIR: illegal operation on a directory, read".to_owned()),
        _ => return None,
    };
    Some(format!("{code}: {description}, {syscall} '{path}'"))
}

/// `resolveDeliveryThresholds(config)`, or the defaults without a config.
fn thresholds(config: Option<&config::Config>) -> Option<Thresholds> {
    let deliveries = member(member(config.map(|c| &c.data), "sdd"), "deliveries");
    let field = |key: &str, fallback: f64| match member(deliveries, key) {
        None | Some(JsValue::Undefined | JsValue::Null) => Some(fallback),
        Some(JsValue::Number(n)) => Some(*n),
        Some(_) => None,
    };
    Some(Thresholds {
        split_min_tasks: field("splitMinTasks", DEFAULT_THRESHOLDS.split_min_tasks)?,
        split_min_loc: field("splitMinLoc", DEFAULT_THRESHOLDS.split_min_loc)?,
        max_prs_per_spec: field("maxPrsPerSpec", DEFAULT_THRESHOLDS.max_prs_per_spec)?,
    })
}

/// A resolved spec (`SpecContext`).
struct SpecContext {
    tasks_path: String,
    dir: String,
    thresholds: Thresholds,
    parsed: ParsedTasks,
}

/// ERROR / WHY / FIX.
struct Failure {
    what: String,
    why: String,
    fix: String,
}

fn print_failure(out: &mut Output, failure: &Failure) {
    out.stderr.push_str(&format!(
        "ERROR: {}\nWHY:   {}\nFIX:   {}\n",
        failure.what, failure.why, failure.fix
    ));
}

/// `fail`: JSON on stdout in `--json` mode, the triple on stderr, exit 1.
fn fail(out: &mut Output, feature: &str, failure: &Failure, json: bool) {
    if json {
        let error = object(vec![
            ("what", string(&failure.what)),
            ("why", string(&failure.why)),
            ("fix", string(&failure.fix)),
        ]);
        json_line(
            out,
            &object(vec![
                ("formatVersion", JsValue::Number(FORMAT_VERSION)),
                ("feature", string(feature)),
                ("error", error),
            ]),
        );
    }
    print_failure(out, failure);
    out.code = 1;
}

/// `loadSpec`: `Ok` with the context, `Err(())` once the failure is in `out`, `None` to delegate.
fn load_spec(
    out: &mut Output,
    feature: &str,
    cwd: &str,
    json: bool,
) -> Option<Result<SpecContext, ()>> {
    let config = read_config(cwd)?;
    if let Some(config) = &config {
        for warning in &config.warnings {
            out.stderr.push_str(warning);
            out.stderr.push('\n');
        }
    }
    let specs_dir = specs_dir(config.as_ref())?;
    let thresholds = thresholds(config.as_ref())?;

    if !is_spec_name(feature) {
        let failure = Failure {
            what: format!("cannot resolve spec \"{feature}\""),
            why: format!(
                "\"{feature}\" is not a spec directory name (one path segment of letters, digits, \".\", \"_\" or \"-\")"
            ),
            fix: format!("pass the name of a directory under {specs_dir}/"),
        };
        fail(out, feature, &failure, json);
        return Some(Err(()));
    }
    let root = js_resolve(&[cwd, &specs_dir]);
    let dir = js_resolve(&[&root, feature]);
    let rel = js_relative(&root, &dir);
    if rel.is_empty() || rel.starts_with("..") || rel.contains('/') {
        let failure = Failure {
            what: format!("cannot resolve spec \"{feature}\""),
            why: format!("\"{feature}\" resolves outside {specs_dir}"),
            fix: format!("pass the name of a directory under {specs_dir}/"),
        };
        fail(out, feature, &failure, json);
        return Some(Err(()));
    }
    let tasks_file = js_resolve(&[&dir, "tasks.md"]);
    let tasks_path = js_relative(cwd, &tasks_file);
    let text = match std::fs::read(&tasks_file) {
        Ok(bytes) => String::from_utf8(bytes).ok()?,
        Err(error) => {
            let message = node_read_error(&error, &tasks_file)?;
            let failure = Failure {
                what: format!("cannot read {tasks_path}"),
                why: format!("expected {tasks_path} ({message})"),
                fix: format!(
                    "create {tasks_path} (see the spec-bootstrap skill) or check the spec name"
                ),
            };
            fail(out, feature, &failure, json);
            return Some(Err(()));
        }
    };
    let parsed = tasks::parse(&text);
    // `Infinity` prints differently in text and JSON; such a file is the TS's.
    let total: f64 = parsed
        .deliveries
        .iter()
        .filter_map(|d| d.estimated_loc)
        .sum();
    if !total.is_finite() {
        return None;
    }
    Some(Ok(SpecContext {
        tasks_path,
        dir,
        thresholds,
        parsed,
    }))
}

fn classification_entries(classification: &Classification) -> Vec<(&'static str, JsValue)> {
    let s = &classification.signals;
    let t = &classification.thresholds;
    let deliveries = classification
        .deliveries
        .iter()
        .map(|d| {
            let milestones = d
                .milestones
                .iter()
                .map(|m| {
                    object(vec![
                        ("id", string(&m.id)),
                        ("title", string(&m.title)),
                        (
                            "acceptance",
                            JsValue::Array(m.acceptance.iter().map(|a| string(a)).collect()),
                        ),
                        (
                            "tasks",
                            JsValue::Array(
                                m.tasks
                                    .iter()
                                    .map(|(id, done)| {
                                        object(vec![
                                            ("id", string(id)),
                                            ("done", JsValue::Bool(*done)),
                                        ])
                                    })
                                    .collect(),
                            ),
                        ),
                        ("closesUnit", JsValue::Bool(m.closes_unit)),
                    ])
                })
                .collect();
            object(vec![
                ("id", string(&d.id)),
                ("title", string(&d.title)),
                ("foundation", JsValue::Bool(d.foundation)),
                ("estimatedLoc", JsValue::Number(d.estimated_loc)),
                ("last", JsValue::Bool(d.last)),
                ("milestones", JsValue::Array(milestones)),
            ])
        })
        .collect();
    let warnings = classification
        .warnings
        .iter()
        .map(|w| {
            object(vec![
                ("rule", string(w.rule)),
                ("where", string(&w.where_)),
                ("message", string(&w.message)),
            ])
        })
        .collect();
    vec![
        (
            "validation",
            object(vec![
                ("scope", string("structural")),
                ("functionalDelivery", string("unverified")),
            ]),
        ),
        ("format", string(classification.format.as_str())),
        ("shape", string(classification.shape.as_str())),
        ("prCount", number(classification.pr_count)),
        (
            "signals",
            object(vec![
                ("tasks", number(s.tasks)),
                ("deliveries", number(s.deliveries)),
                ("milestones", number(s.milestones)),
                ("estimatedLoc", JsValue::Number(s.estimated_loc)),
                ("locDeclared", JsValue::Bool(s.loc_declared)),
                ("exceedsTasks", JsValue::Bool(s.exceeds_tasks)),
                ("exceedsLoc", JsValue::Bool(s.exceeds_loc)),
            ]),
        ),
        (
            "thresholds",
            object(vec![
                ("splitMinTasks", JsValue::Number(t.split_min_tasks)),
                ("splitMinLoc", JsValue::Number(t.split_min_loc)),
                ("maxPrsPerSpec", JsValue::Number(t.max_prs_per_spec)),
                ("comparison", string("strict-greater")),
            ]),
        ),
        ("deliveries", JsValue::Array(deliveries)),
        ("warnings", JsValue::Array(warnings)),
    ]
}

fn error_value(classification: &Classification) -> JsValue {
    classification.error.as_ref().map_or(JsValue::Null, |e| {
        object(vec![
            ("rule", string(e.rule)),
            ("what", string(&e.what)),
            ("why", string(&e.why)),
            ("fix", string(&e.fix)),
        ])
    })
}

fn js_number(n: f64) -> String {
    navori_core::js_json::number_to_js(n)
}

/// `spec classify`.
fn classify_command(feature: &str, cwd: &str, json: bool) -> Option<Output> {
    let mut out = Output::default();
    let spec = match load_spec(&mut out, feature, cwd, json)? {
        Ok(spec) => spec,
        Err(()) => return Some(out),
    };
    let classification = classify::classify(&spec.parsed, spec.thresholds);
    for warning in &classification.warnings {
        out.stderr
            .push_str(&format!("WARN:  {}\n", warning.message));
    }
    if json {
        let mut entries = vec![
            ("formatVersion", JsValue::Number(FORMAT_VERSION)),
            ("feature", string(feature)),
            ("tasksPath", string(&spec.tasks_path)),
        ];
        entries.extend(classification_entries(&classification));
        entries.push(("error", error_value(&classification)));
        json_line(&mut out, &object(entries));
    } else {
        let s = &classification.signals;
        let t = &classification.thresholds;
        out.stdout.push_str(&format!(
            "{feature}: {} ({} PR{}) — {} tasks, {} deliveries, {} estimated LOC (thresholds >{} tasks, >{} LOC, max {} PRs); structural only, functional delivery unverified\n",
            classification.shape.as_str(),
            classification.pr_count,
            if classification.pr_count == 1 { "" } else { "s" },
            s.tasks,
            s.deliveries,
            js_number(s.estimated_loc),
            js_number(t.split_min_tasks),
            js_number(t.split_min_loc),
            js_number(t.max_prs_per_spec),
        ));
    }
    if let Some(error) = &classification.error {
        print_failure(
            &mut out,
            &Failure {
                what: error.what.clone(),
                why: error.why.clone(),
                fix: error.fix.clone(),
            },
        );
        out.code = 1;
    }
    Some(out)
}

/// `spec check`.
fn check_command(feature: &str, cwd: &str, json: bool) -> Option<Output> {
    let mut out = Output::default();
    let spec = match load_spec(&mut out, feature, cwd, json)? {
        Ok(spec) => spec,
        Err(()) => return Some(out),
    };
    let requirements = match std::fs::read(format!("{}/requirements.md", spec.dir)) {
        Ok(bytes) => Some(requirement_ids(&String::from_utf8(bytes).ok()?)),
        Err(_) => None,
    };
    // `deliveryIdsForSpec` reads the config again (its warnings print twice), then maps the spec
    // only when `<specsDir>/_master/index.json` exists: that case belongs to `master`.
    let again = read_config(cwd)?;
    if let Some(config) = &again {
        for warning in &config.warnings {
            out.stderr.push_str(warning);
            out.stderr.push('\n');
        }
    }
    let index = js_resolve(&[cwd, &specs_dir(again.as_ref())?, "_master", "index.json"]);
    if Path::new(&index).exists() {
        return None;
    }
    let result: SpecCheck =
        check::check(&spec.parsed, spec.thresholds, requirements.as_deref()).ok()?;
    let where_ = |line: Option<usize>| {
        line.map_or_else(
            || spec.tasks_path.clone(),
            |n| format!("{}:{n}", spec.tasks_path),
        )
    };
    let errors: Vec<_> = result
        .findings
        .iter()
        .filter(|f| f.severity == check::Severity::Error)
        .collect();
    for f in &result.findings {
        if f.severity == check::Severity::Warning {
            out.stderr.push_str(&format!(
                "WARN:  [{}] {} — {}\n",
                f.rule,
                where_(f.line),
                f.message
            ));
        }
    }
    if json {
        let findings = result
            .findings
            .iter()
            .map(|f| {
                let mut entries = vec![
                    ("rule", string(f.rule)),
                    ("severity", string(f.severity.as_str())),
                    ("where", string(&f.where_)),
                    ("message", string(&f.message)),
                ];
                if let Some(line) = f.line {
                    entries.push(("line", number(line)));
                }
                object(entries)
            })
            .collect();
        let mut classification = classification_entries(&result.classification);
        classification.push(("error", error_value(&result.classification)));
        json_line(
            &mut out,
            &object(vec![
                ("formatVersion", JsValue::Number(FORMAT_VERSION)),
                ("feature", string(feature)),
                ("format", string(result.format.as_str())),
                ("ok", JsValue::Bool(result.ok)),
                (
                    "validation",
                    object(vec![
                        ("scope", string("structural")),
                        ("functionalDelivery", string("unverified")),
                    ]),
                ),
                ("findings", JsValue::Array(findings)),
                ("classification", object(classification)),
            ]),
        );
    } else {
        out.stdout.push_str(&format!(
            "{feature}: {} — {} error(s), {} warning(s); structural only, functional delivery unverified\n",
            if result.ok { "ok" } else { "findings" },
            errors.len(),
            result.findings.len() - errors.len()
        ));
    }
    if !errors.is_empty() {
        let why = errors
            .iter()
            .map(|f| format!("[{}] {} — {}", f.rule, where_(f.line), f.message))
            .collect::<Vec<_>>()
            .join("\n       ");
        print_failure(
            &mut out,
            &Failure {
                what: format!(
                    "{} has {} error finding(s)",
                    spec.tasks_path,
                    errors.len()
                ),
                why,
                fix: "correct each finding in tasks.md (or the requirements file), then run `navori spec check` again".to_owned(),
            },
        );
        out.code = 2;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leaf_args_delegate_every_uncertain_shape() {
        let ok = parse_leaf(&["x", "--json", "--cwd", "d", "extra"]);
        assert_eq!(
            ok,
            Some(LeafOptions {
                feature: Some("x"),
                cwd: Some("d"),
                json: true
            })
        );
        assert_eq!(parse_leaf(&["--cwd=d"]).map(|o| o.cwd), Some(Some("d")));
        for argv in [
            &["x", "--no-json"][..],
            &["x", "--json=false"],
            &["x", "--cwd"],
            &["x", "--cwd", "--json"],
            &["x", "--cwd", "a", "--cwd", "b"],
            &["x", "-j"],
            &["x", "--feature", "y"],
        ] {
            assert_eq!(parse_leaf(argv), None, "{argv:?}");
        }
    }
}
