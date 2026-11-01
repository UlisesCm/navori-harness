//! `navori plan classify|check|render <feature>`, native (spec 0060 T11, R73/R74).
//!
//! The command layer of `commands/plan.ts` over `navori_core::plan`. Everything is read and
//! decided before the first byte of output or the first write, so whatever Rust does not
//! reproduce returns `None` and the invocation goes to the TS: an argv citty might read
//! differently (`--no-*`, a repeated or empty value), a state root the TS throws on uncaught, a
//! config `readConfig` rejects or Rust does not model, a JSON `JSON.parse` or zod rejects (their
//! messages are V8's and zod's), a `matches:` only a JS `RegExp` judges, a `source` projection,
//! and `classify --diff` (git, D42). `update`, `escalation-reset`, `acknowledge` and `resume`
//! are not in the manifest, and the group delegates them with `gate`.

use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::process::ExitCode;

use navori_core::config::Config;
use navori_core::fs::{Fs, RealFs};
use navori_core::js_json::{self, JsValue};
use navori_core::plan::acceptance_index;
use navori_core::plan::check::ProjectContext;
use navori_core::plan::classify::{ClassifyInput, classify, declared_flags_from_signals};
use navori_core::plan::report::{self, Report};
use navori_core::posix::{js_trim, resolve};
use navori_core::state_files::{self, Refusal, StateRoot, StateWrite};

use crate::help::{ArgDef, ArgKind, CommandDef, Paint, Parent, citty_no_color};
use crate::native_io::{Output, json_line, member, number, object, read_config, string};
use crate::{NativeCall, Outcome};

const FEATURE: ArgDef = ArgDef {
    name: "feature",
    kind: ArgKind::Positional,
    description: "Feature slug",
};
const DIR: ArgDef = ArgDef {
    name: "dir",
    kind: ArgKind::String,
    description: "Progress directory",
};
const CWD: ArgDef = ArgDef {
    name: "cwd",
    kind: ArgKind::String,
    description: "Repo root",
};
const JSON: ArgDef = ArgDef {
    name: "json",
    kind: ArgKind::Boolean,
    description: "Output as JSON",
};

/// The declared booleans of `classify`, in declaration order: `(camelCase name, kebab-case
/// alias, description)`.
const DECLARED: [(&str, &str, &str); 7] = [
    (
        "criticalArea",
        "critical-area",
        "Declared: touches a critical area",
    ),
    (
        "moneyCredentialsPii",
        "money-credentials-pii",
        "Declared: handles money, credentials or PII",
    ),
    (
        "multiRepo",
        "multi-repo",
        "Declared: spans two or more repos",
    ),
    (
        "newExternalDependency",
        "new-external-dependency",
        "Declared: adds a new external dependency",
    ),
    (
        "sharedContract",
        "shared-contract",
        "Declared: changes a shared contract",
    ),
    (
        "dataSchemaMigration",
        "data-schema-migration",
        "Declared: includes a data or schema migration",
    ),
    (
        "bugWithoutRootCause",
        "bug-without-root-cause",
        "Declared: bug worked without a confirmed root cause",
    ),
];

const fn boolean(name: &'static str, description: &'static str) -> ArgDef {
    ArgDef {
        name,
        kind: ArgKind::Boolean,
        description,
    }
}

const CLASSIFY: CommandDef = CommandDef {
    name: "classify",
    description: "Compute a task's complexity score and level",
    args: &[
        FEATURE,
        DIR,
        CWD,
        JSON,
        ArgDef {
            name: "files",
            kind: ArgKind::String,
            description: "Comma-separated repo-relative paths touched by the task",
        },
        ArgDef {
            name: "diff",
            kind: ArgKind::String,
            description: "Classify the work tree's changes (committed, uncommitted and untracked) against the feature's workplan instead of --files; value is the base ref (default origin/<prTarget>)",
        },
        boolean(DECLARED[0].0, DECLARED[0].2),
        boolean(DECLARED[1].0, DECLARED[1].2),
        boolean(DECLARED[2].0, DECLARED[2].2),
        boolean(DECLARED[3].0, DECLARED[3].2),
        boolean(DECLARED[4].0, DECLARED[4].2),
        boolean(DECLARED[5].0, DECLARED[5].2),
        boolean(DECLARED[6].0, DECLARED[6].2),
    ],
    sub_commands: &[],
};

const CHECK: CommandDef = CommandDef {
    name: "check",
    description: "Validate a workplan against its schema and R15's rules",
    args: &[FEATURE, DIR, CWD, JSON],
    sub_commands: &[],
};

const RENDER: CommandDef = CommandDef {
    name: "render",
    description: "Render workplan_<feature>.md from its JSON source",
    args: &[FEATURE, DIR, CWD, JSON],
    sub_commands: &[],
};

const PLAN: CommandDef = CommandDef {
    name: "plan",
    description: "Classify, render, update and check a level-1/2 workplan",
    args: &[],
    sub_commands: &[
        (
            "resume",
            "Revalidate continuity without reviving stale guarantees",
        ),
        ("classify", CLASSIFY.description),
        ("render", RENDER.description),
        (
            "update",
            "Change an A<n>'s progress or append a decision, then re-render",
        ),
        ("check", CHECK.description),
        (
            "gate",
            "PreToolUse(Agent) gate for harness.planTiers (R16/R17/R19) — reads the hook payload from stdin",
        ),
        (
            "acknowledge",
            "Record one bound user workflow escalation decision; does not approve review or protected effects",
        ),
        (
            "escalation-reset",
            "Restart the gate's rejection count for a level >= 2 feature (user approval)",
        ),
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

const PLAN_PARENT: Parent<'static> = Parent {
    name: "plan",
    version: None,
};

const NEUTRAL_DIR: &str = ".navori/state/handoffs";
const LEGACY_DIRS: [&str; 2] = [".claude/progress", ".codex/progress"];

/// Which manifest entry selected the invocation: each row runs only its own subcommand.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Row {
    Group,
    Classify,
    Check,
    Render,
}

/// `plan` alone: usage, `--help` and unknown subcommands.
#[must_use]
pub fn run_group(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Group))
}

/// `plan classify`.
#[must_use]
pub fn run_classify(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Classify))
}

/// `plan check`.
#[must_use]
pub fn run_check(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Check))
}

/// `plan render`.
#[must_use]
pub fn run_render(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Render))
}

fn outcome(code: Option<ExitCode>) -> Outcome {
    code.map_or(Outcome::Delegate, Outcome::Exit)
}

fn run(args: &[OsString], row: Row) -> Option<ExitCode> {
    let argv: Vec<&str> = args.iter().map(|a| a.to_str()).collect::<Option<_>>()?;
    let (first, rest) = argv.split_first()?;
    if *first != "plan" || rest.contains(&"--") {
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
        return Some(Output::usage(&PLAN, ROOT, error).emit());
    };
    let (leaf, leaf_row) = match rest[at] {
        "classify" => (&CLASSIFY, Row::Classify),
        "check" => (&CHECK, Row::Check),
        "render" => (&RENDER, Row::Render),
        name if row != Row::Group
            || PROTOTYPE_KEYS.contains(&name)
            || PLAN.sub_commands.iter().any(|(sub, _)| *sub == name) =>
        {
            return None;
        }
        name => {
            let error = (!help).then(|| {
                let paint = Paint {
                    color: !citty_no_color(),
                };
                format!("Unknown command {}", paint.cyan(name))
            });
            return Some(Output::usage(&PLAN, ROOT, error).emit());
        }
    };
    if leaf_row != row {
        return None;
    }
    if help {
        return Some(Output::usage(leaf, PLAN_PARENT, None).emit());
    }
    let (strings, booleans): (&[&str], &[&str]) = if row == Row::Classify {
        (
            &["dir", "cwd", "files"],
            &[
                "json",
                "criticalArea",
                "critical-area",
                "moneyCredentialsPii",
                "money-credentials-pii",
                "multiRepo",
                "multi-repo",
                "newExternalDependency",
                "new-external-dependency",
                "sharedContract",
                "shared-contract",
                "dataSchemaMigration",
                "data-schema-migration",
                "bugWithoutRootCause",
                "bug-without-root-cause",
            ],
        )
    } else {
        (&["dir", "cwd"], &["json"])
    };
    let options = parse_leaf(&rest[at + 1..], strings, booleans)?;
    let Some(feature) = options.feature else {
        let error = "Missing required positional argument: FEATURE".to_owned();
        return Some(Output::usage(leaf, PLAN_PARENT, Some(error)).emit());
    };
    let process_cwd = std::env::current_dir().ok()?;
    let process_cwd = process_cwd.to_str()?;
    // `resolveStateRoot` runs outside any `try`: its throw is an uncaught stack trace.
    let cwd = options.get("cwd").unwrap_or(process_cwd);
    let root =
        state_files::resolve_state_root(cwd, process_cwd, feature, options.get("dir")).ok()?;
    let out = match row {
        Row::Classify => classify_command(feature, &options, &root)?,
        Row::Check => check_command(feature, &options, &root)?,
        Row::Render => render_command(feature, &options, &root)?,
        Row::Group => return None,
    };
    Some(out.emit())
}

/// The args of a leaf as citty would read them.
#[derive(Debug, Default, PartialEq, Eq)]
struct LeafOptions<'a> {
    feature: Option<&'a str>,
    strings: Vec<(&'static str, &'a str)>,
    booleans: Vec<&'static str>,
    json: bool,
}

impl<'a> LeafOptions<'a> {
    fn get(&self, name: &str) -> Option<&'a str> {
        self.strings
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, value)| *value)
    }

    /// A declared boolean given in either spelling.
    fn flag(&self, camel: &str, kebab: &str) -> bool {
        self.booleans.iter().any(|b| *b == camel || *b == kebab)
    }
}

/// `None` for any shape whose citty reading is not certain: unknown or short options, `--no-*`,
/// a boolean with `=`, a repeated string option, or a value that is empty or looks like an
/// option.
fn parse_leaf<'a>(
    tokens: &[&'a str],
    strings: &[&'static str],
    booleans: &[&'static str],
) -> Option<LeafOptions<'a>> {
    let mut options = LeafOptions::default();
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        let Some(body) = token.strip_prefix("--") else {
            if token.starts_with('-') {
                return None;
            }
            if options.feature.is_none() {
                options.feature = Some(token);
            }
            continue;
        };
        if let Some(name) = booleans.iter().find(|b| **b == body) {
            if *name == "json" {
                options.json = true;
            } else {
                options.booleans.push(name);
            }
            continue;
        }
        let (name, inline) = body
            .split_once('=')
            .map_or((body, None), |(n, v)| (n, Some(v)));
        let name = *strings.iter().find(|known| **known == name)?;
        if options.get(name).is_some() {
            return None;
        }
        let value = if let Some(inline) = inline {
            inline
        } else {
            let next = *tokens.get(index)?;
            index += 1;
            next
        };
        if value.is_empty() || value.starts_with('-') {
            return None;
        }
        options.strings.push((name, value));
    }
    Some(options)
}

fn print_warnings(out: &mut Output, config: &Config) {
    for warning in &config.warnings {
        out.stderr.push_str(warning);
        out.stderr.push('\n');
    }
}

/// `z.array(z.string())`-like read of a config list: `None` when it is not one Rust carries.
fn string_list(value: Option<&JsValue>) -> Option<Option<Vec<String>>> {
    match value {
        None | Some(JsValue::Undefined) => Some(None),
        Some(JsValue::Array(items)) => items
            .iter()
            .map(|item| match item {
                JsValue::String(text) => text.to_rust(),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
            .map(Some),
        Some(_) => None,
    }
}

/// `projectClassifyContext(cwd)`, printing the warnings its `readConfig` writes.
fn project_context(out: &mut Output, cwd: &str) -> Option<ProjectContext> {
    let Some(config) = read_config(cwd)? else {
        // `readConfig` throws on a missing file and the TS catches it.
        return Some(ProjectContext::default());
    };
    print_warnings(out, &config);
    let project = member(Some(&config.data), "project");
    Some(ProjectContext {
        critical_paths: string_list(member(project, "criticalPaths"))?,
        local_skill_ids: string_list(member(project, "localSkills"))?,
    })
}

/// Reads a state artifact as text: `Ok(None)` when absent, `None` when Rust cannot reproduce the
/// read (an error the TS would throw, or bytes that are not UTF-8).
fn read_artifact(path: &str) -> Option<Option<String>> {
    if std::fs::metadata(path).is_err() {
        return Some(None);
    }
    let bytes = std::fs::read(path).ok()?;
    String::from_utf8(bytes).ok().map(Some)
}

fn fail(out: &mut Output, message: &str) {
    out.stderr.push_str(message);
    out.stderr.push('\n');
    out.code = 1;
}

// ---------------------------------------------------------------------------------------------
// classify

/// A draft's `files[].path` and `classification.signals`.
type Draft = (Vec<String>, Vec<String>);

/// `readDraftClassifyContext(path)`: `Ok(None)` without a draft, `Err(message)` for a broken one.
fn read_draft(path: &str) -> Option<Result<Option<Draft>, String>> {
    let Some(text) = read_artifact(path)? else {
        return Some(Ok(None));
    };
    // `cannot read draft workplan …: <V8's message>` is the TS's.
    let raw = js_json::parse(&text)?;
    let record = match &raw {
        JsValue::Object(record) => Some(record),
        JsValue::Array(_) => None,
        _ => return Some(Err(format!("draft workplan {path} is not a JSON object"))),
    };
    let mut files = Vec::new();
    if let Some(value) = record.and_then(|r| r.get("files")) {
        let JsValue::Array(entries) = value else {
            return Some(Err(format!(
                "draft workplan {path}: \"files\" must be an array"
            )));
        };
        for entry in entries {
            match member(Some(entry), "path") {
                Some(JsValue::String(text)) if matches!(entry, JsValue::Object(_)) => {
                    files.push(text.to_rust()?);
                }
                _ => {
                    return Some(Err(format!(
                        "draft workplan {path}: every \"files\" entry needs a string \"path\""
                    )));
                }
            }
        }
    }
    let classification = record.and_then(|r| r.get("classification"));
    let mut signals = Vec::new();
    if let Some(value @ JsValue::Object(_)) = classification
        && let Some(value) = member(Some(value), "signals")
    {
        let bad = || {
            Err(format!(
                "draft workplan {path}: \"classification.signals\" must be a string array"
            ))
        };
        let JsValue::Array(items) = value else {
            return Some(bad());
        };
        for item in items {
            let JsValue::String(text) = item else {
                return Some(bad());
            };
            signals.push(text.to_rust()?);
        }
    }
    Some(Ok(Some((files, signals))))
}

/// `splitList(value)`.
fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(|v| js_trim(v).to_owned())
        .filter(|v| !v.is_empty())
        .collect()
}

fn classify_command(feature: &str, options: &LeafOptions<'_>, root: &StateRoot) -> Option<Output> {
    let mut out = Output::default();
    let project = project_context(&mut out, &root.cwd)?;
    let files_arg = options.get("files");
    let mut draft = None;
    if files_arg.is_none() {
        let read = match state_files::artifact_path(root, &format!("workplan_{feature}.json")) {
            Ok(path) => read_draft(&path)?,
            Err(Refusal::Message(message)) => Err(message),
            Err(Refusal::Unmodeled) => return None,
        };
        match read {
            Ok(found) => draft = found,
            Err(message) => {
                fail(&mut out, &message);
                return Some(out);
            }
        }
    }
    if files_arg.is_none() && draft.as_ref().is_none_or(|(files, _)| files.is_empty()) {
        fail(
            &mut out,
            "classify needs --files, --diff or a workplan draft with files; refusing to report level 0 for an empty list",
        );
        return Some(out);
    }
    let declared = draft
        .as_ref()
        .map(|(_, signals)| declared_flags_from_signals(signals))
        .unwrap_or_default();
    let on = |index: usize, from_draft: bool| {
        let (camel, kebab, _) = DECLARED[index];
        options.flag(camel, kebab) || from_draft
    };
    let input = ClassifyInput {
        files: files_arg.map_or_else(
            || draft.map(|(files, _)| files).unwrap_or_default(),
            split_list,
        ),
        critical_area: on(0, declared.critical_area),
        money_credentials_pii: on(1, declared.money_credentials_pii),
        multi_repo: on(2, declared.multi_repo),
        new_external_dependency: on(3, declared.new_external_dependency),
        shared_contract: on(4, declared.shared_contract),
        data_schema_migration: on(5, declared.data_schema_migration),
        bug_without_root_cause: on(6, declared.bug_without_root_cause),
        critical_paths: project.critical_paths.unwrap_or_default(),
        local_skill_ids: project.local_skill_ids.map(|ids| ids.into_iter().collect()),
    };
    let result = classify(&input)?;
    if options.json {
        let signals = result.signals.iter().map(|s| string(s)).collect();
        json_line(
            &mut out,
            &object(vec![
                ("score", JsValue::Number(f64::from(result.score))),
                ("level", JsValue::Number(f64::from(result.level))),
                ("signals", JsValue::Array(signals)),
                ("nonTrivialCeiling", number(result.non_trivial_ceiling)),
            ]),
        );
    } else {
        let signals = if result.signals.is_empty() {
            "(none)".to_owned()
        } else {
            result.signals.join(", ")
        };
        out.stdout.push_str(&format!(
            "Complexity: {}/10 · Level: {}\nSignals: {signals}\n",
            result.score, result.level
        ));
    }
    Some(out)
}

// ---------------------------------------------------------------------------------------------
// check

fn report_json(report: &Report) -> JsValue {
    let list = |items: &[report::Finding]| {
        JsValue::Array(
            items
                .iter()
                .map(|f| {
                    object(vec![
                        ("rule", string(f.rule)),
                        ("message", string(&f.message)),
                    ])
                })
                .collect(),
        )
    };
    object(vec![
        ("ok", JsValue::Bool(report.ok)),
        ("findings", list(&report.findings)),
        ("warnings", list(&report.warnings)),
    ])
}

/// The workplan JSON of `feature`: `Ok(raw)`, `Err(())` once "workplan not found" is in `out`,
/// `None` where the TS's answer is its own (an artifact path it throws on, an unreadable or
/// unparsable file).
fn read_workplan(out: &mut Output, root: &StateRoot, feature: &str) -> Option<Result<JsValue, ()>> {
    let path = state_files::artifact_path(root, &format!("workplan_{feature}.json")).ok()?;
    let Some(text) = read_artifact(&path)? else {
        fail(out, &format!("workplan not found: {path}"));
        return Some(Err(()));
    };
    Some(Ok(js_json::parse(&text)?))
}

fn check_command(feature: &str, options: &LeafOptions<'_>, root: &StateRoot) -> Option<Output> {
    let mut out = Output::default();
    let raw = match read_workplan(&mut out, root, feature)? {
        Ok(raw) => raw,
        Err(()) => return Some(out),
    };
    let project = project_context(&mut out, &root.cwd)?;
    let report = report::check_report(&raw, feature, &project)?;
    if options.json {
        json_line(&mut out, &report_json(&report));
    } else {
        out.stdout.push_str(&report::format_report(&report));
        out.stdout.push('\n');
    }
    out.code = if report.ok { 0 } else { 2 };
    Some(out)
}

// ---------------------------------------------------------------------------------------------
// render

/// `withPlanStateLock`: `<stateRoot>/.plan-update.lock`, created exclusively like
/// `openSync(…, "wx")` with the pid breadcrumb, and removed when dropped. The lock coordinates
/// writers; it is not output of the command, so it does not go through [`Fs`].
struct PlanStateLock {
    path: String,
}

impl PlanStateLock {
    fn acquire(path: String) -> Result<Self, String> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o666)
            .open(&path)
            .map_err(|e| format!("cannot take {path}: {e}"))?;
        let _ = writeln!(file, "{}", std::process::id());
        Ok(Self { path })
    }
}

impl Drop for PlanStateLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A planned write; `None` where `writeStateFileAtomic` would throw or Rust does not model it.
fn plan_write(root: &StateRoot, name: &str) -> Option<StateWrite> {
    state_files::plan_state_write(root, name, std::process::id())
        .ok()?
        .ok()
}

fn render_command(feature: &str, options: &LeafOptions<'_>, root: &StateRoot) -> Option<Output> {
    let mut out = Output::default();
    let raw = match read_workplan(&mut out, root, feature)? {
        Ok(raw) => raw,
        Err(()) => return Some(out),
    };
    let markdown = report::render_workplan(&raw)?;
    // `writeAcceptanceIndex`: the neutral directory, both legacy ones and the root's own.
    let mut dirs: Vec<String> = std::iter::once(NEUTRAL_DIR)
        .chain(LEGACY_DIRS)
        .map(|dir| resolve(&root.cwd, dir))
        .collect();
    dirs.push(root.path.clone());
    let index = acceptance_index::build(&dirs)?;
    let neutral = StateRoot {
        cwd: root.cwd.clone(),
        dir: NEUTRAL_DIR.to_owned(),
        path: resolve(&root.cwd, NEUTRAL_DIR),
    };
    // Every throw of the lock, the directories and the three writes is planned before the first.
    if !state_files::plan_state_dirs(root).ok()?.is_empty() {
        return None;
    }
    let lock = state_files::artifact_path(root, ".plan-update.lock").ok()?;
    if std::fs::symlink_metadata(&lock).is_ok() {
        return None;
    }
    let md = plan_write(root, &format!("workplan_{feature}.md"))?;
    state_files::artifact_path(&neutral, "acceptance-index").ok()?;
    let expected = plan_write(&neutral, "acceptance-expected.jsonl")?;
    let index_write = plan_write(&neutral, "acceptance-index")?;
    let mut fs = RealFs::default();
    let _lock = PlanStateLock::acquire(lock).ok()?;
    let fs: &mut dyn Fs = &mut fs;
    let written = state_files::write_state_file(fs, &md, &markdown)
        .and_then(|()| state_files::write_state_file(fs, &expected, &index.expected))
        // `expected` created the neutral directory if it was missing.
        .and_then(|()| state_files::write_state_file(fs, &index_write, &index.index));
    if let Err(message) = written {
        // The TS throws uncaught here, after the checks above: only stderr reports it.
        fail(&mut out, &format!("navori-rust: {message}"));
        return Some(out);
    }
    if options.json {
        json_line(&mut out, &object(vec![("rendered", JsValue::Bool(true))]));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn leaf_args_delegate_every_uncertain_shape() {
        let strings = &["dir", "cwd", "files"];
        let booleans = &["json", "criticalArea", "critical-area"];
        let ok = parse_leaf(
            &["x", "--critical-area", "--files=a,b", "--json"],
            strings,
            booleans,
        );
        assert_eq!(
            ok,
            Some(LeafOptions {
                feature: Some("x"),
                strings: vec![("files", "a,b")],
                booleans: vec!["critical-area"],
                json: true,
            })
        );
        for argv in [
            &["x", "--no-critical-area"][..],
            &["x", "--critical-area=true"],
            &["x", "--files"],
            &["x", "--files="],
            &["x", "--files", "a", "--files", "b"],
            &["x", "--diff"],
            &["x", "-j"],
        ] {
            assert_eq!(parse_leaf(argv, strings, booleans), None, "{argv:?}");
        }
        assert_eq!(split_list(" a , ,b,"), ["a", "b"]);
    }
}
