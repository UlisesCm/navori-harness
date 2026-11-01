//! `navori plan classify|check|render <feature>`, native (spec 0060 T11, R73/R74).
//!
//! The command layer of `commands/plan.ts` over `navori_core::plan`. Everything is read and
//! decided before the first byte of output or the first write, so whatever Rust does not
//! reproduce returns `None` and the invocation goes to the TS: an argv citty might read
//! differently (`--no-*`, a repeated or empty value), a state root the TS throws on uncaught, a
//! config `readConfig` rejects or Rust does not model, a JSON `JSON.parse` or zod rejects (their
//! messages are V8's and zod's), a `matches:` only a JS `RegExp` judges, a `source` projection,
//! and `classify --diff` (git, D42). `resume` (`plan::resume`) delegates where its core does.
//! `acknowledge` is not in the manifest, and the group delegates it with `gate`.

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
use navori_core::plan::expected::{Expected, parse_expected};
use navori_core::plan::report::{self, Report};
use navori_core::plan::resume::{ConfigFacts, RESUME_BUDGET, ResumeInput, resume_plans};
use navori_core::plan::update::{self, Mutation};
use navori_core::posix::{js_trim, resolve};
use navori_core::process::RealRunner;
use navori_core::state_files::{self, Refusal, StateRoot, StateWrite};
use sha2::{Digest as _, Sha256};

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

const UPDATE: CommandDef = CommandDef {
    name: "update",
    description: "Change an A<n>'s progress or append a decision, then re-render",
    args: &[
        FEATURE,
        DIR,
        CWD,
        JSON,
        ArgDef {
            name: "progress",
            kind: ArgKind::String,
            description: "A<n>=status (pendiente|cumplido|bloqueado)",
        },
        ArgDef {
            name: "decision",
            kind: ArgKind::String,
            description: "Decision text to append",
        },
        ArgDef {
            name: "date",
            kind: ArgKind::String,
            description: "Decision date (ISO), required with --decision",
        },
    ],
    sub_commands: &[],
};

const ESCALATION_RESET: CommandDef = CommandDef {
    name: "escalation-reset",
    description: "Restart the gate's rejection count for a level >= 2 feature (user approval)",
    args: &[
        FEATURE,
        DIR,
        CWD,
        JSON,
        ArgDef {
            name: "approved-by",
            kind: ArgKind::String,
            description: "Must be user",
        },
        ArgDef {
            name: "reason",
            kind: ArgKind::String,
            description: "Why another review round is authorized",
        },
    ],
    sub_commands: &[],
};

const RESUME: CommandDef = CommandDef {
    name: "resume",
    description: "Revalidate continuity without reviving stale guarantees",
    args: &[ArgDef {
        name: "json",
        kind: ArgKind::Boolean,
        description: "Output JSON",
    }],
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
    Update,
    EscalationReset,
    Resume,
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

/// `plan update`.
#[must_use]
pub fn run_update(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Update))
}

/// `plan escalation-reset`.
#[must_use]
pub fn run_escalation_reset(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::EscalationReset))
}

/// `plan resume`.
#[must_use]
pub fn run_resume(call: &NativeCall<'_>) -> Outcome {
    outcome(run(call.args, Row::Resume))
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
        "update" => (&UPDATE, Row::Update),
        "escalation-reset" => (&ESCALATION_RESET, Row::EscalationReset),
        "resume" => (&RESUME, Row::Resume),
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
    if row == Row::Resume {
        return resume_command(&rest[at + 1..]).map(Output::emit);
    }
    let (strings, booleans): (&[&str], &[&str]) = if row == Row::Update {
        (&["dir", "cwd", "progress", "decision", "date"], &["json"])
    } else if row == Row::EscalationReset {
        (&["dir", "cwd", "approved-by", "reason"], &["json"])
    } else if row == Row::Classify {
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
    let (tokens, diff) = if row == Row::Classify {
        extract_diff(&rest[at + 1..])?
    } else {
        (rest[at + 1..].to_vec(), None)
    };
    let options = parse_leaf(&tokens, strings, booleans)?;
    let Some(feature) = options.feature else {
        let error = "Missing required positional argument: FEATURE".to_owned();
        return Some(Output::usage(leaf, PLAN_PARENT, Some(error)).emit());
    };
    let process_cwd = std::env::current_dir().ok()?;
    let process_cwd = process_cwd.to_str()?;
    if row == Row::EscalationReset {
        // Its flags are checked before the state root, which may still throw after them.
        if let Some(out) = reset_usage(&options) {
            return Some(out.emit());
        }
    }
    // `resolveStateRoot` runs outside any `try`: its throw is an uncaught stack trace.
    let cwd = options.get("cwd").unwrap_or(process_cwd);
    let root =
        state_files::resolve_state_root(cwd, process_cwd, feature, options.get("dir")).ok()?;
    let out = match row {
        Row::Classify => match diff {
            Some(base) => classify_diff(feature, &options, &root, base)?,
            None => classify_command(feature, &options, &root)?,
        },
        Row::Check => check_command(feature, &options, &root)?,
        Row::Render => render_command(feature, &options, &root)?,
        Row::Update => update_command(feature, &options, &root)?,
        Row::EscalationReset => reset_command(feature, &options, &root)?,
        Row::Group | Row::Resume => return None,
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
        // Only `--progress` repeats (`restoreRepeatedFlags`); any other repeat is the TS's.
        if name != "progress" && options.get(name).is_some() {
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

/// `--diff [<base>]` as `reparseBareValueFlags` reads it: a bare `--diff` (last, or before
/// another flag) is `""`. The other tokens go to [`parse_leaf`]; a repeated `--diff` is the TS's.
fn extract_diff<'a>(tokens: &[&'a str]) -> Option<(Vec<&'a str>, Option<&'a str>)> {
    let mut rest = Vec::new();
    let mut diff = None;
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index];
        index += 1;
        let value = if token == "--diff" {
            match tokens.get(index) {
                Some(next) if !next.starts_with('-') => {
                    index += 1;
                    *next
                }
                _ => "",
            }
        } else if let Some(value) = token.strip_prefix("--diff=") {
            value
        } else {
            rest.push(token);
            continue;
        };
        if diff.replace(value).is_some() {
            return None;
        }
    }
    Some((rest, diff))
}

/// `gitLines(cwd, args)`: the NUL-split stdout of a successful git; `None` where `execFileSync`
/// throws (its message carries git's stderr).
fn git_lines(cwd: &str, args: &[&str]) -> Option<Vec<String>> {
    let env = navori_core::plan::evidence::process_env();
    let mut full = vec!["-c", "core.fsmonitor=false", "--no-optional-locks"];
    full.extend_from_slice(args);
    let output = navori_core::process::ProcessRunner::run(
        &RealRunner,
        &navori_core::process::Request {
            program: "git",
            args: &full,
            cwd: std::path::Path::new(cwd),
            env: &env,
            input: None,
            timeout: std::time::Duration::from_secs(60 * 60),
        },
    )
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8(output.stdout).ok()?;
    Some(
        text.split('\0')
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}

/// `classifyDiff(root, feature, base, json, project)` (`plan classify <feature> --diff`).
fn classify_diff(
    feature: &str,
    options: &LeafOptions<'_>,
    root: &StateRoot,
    base: &str,
) -> Option<Output> {
    let mut out = Output::default();
    let project = project_context(&mut out, &root.cwd)?;
    let base = if base.is_empty() {
        // `defaultDiffBase`: a second `readConfig` (its warnings print again), or `origin/main`.
        match read_config(&root.cwd)? {
            None => "origin/main".to_owned(),
            Some(config) => {
                for warning in &config.warnings {
                    out.stderr.push_str(warning);
                    out.stderr.push('\n');
                }
                let effective = navori_core::config::effective_config(&config.data);
                match (
                    member(Some(&effective), "prTarget"),
                    member(Some(&effective), "branchBase"),
                ) {
                    (Some(JsValue::String(t)), _)
                    | (None | Some(JsValue::Undefined), Some(JsValue::String(t))) => {
                        format!("origin/{}", t.to_rust()?)
                    }
                    _ => return None,
                }
            }
        }
    } else {
        base.to_owned()
    };
    let path = match state_files::artifact_path(root, &format!("workplan_{feature}.json")) {
        Ok(path) => path,
        Err(_) => return None,
    };
    let has_workplan = std::path::Path::new(&path).exists();
    let plan = if has_workplan {
        // `readWorkplanOrExit`: its message is V8's or zod's.
        let raw = js_json::parse(&read_artifact(&path)??)?;
        Some(navori_core::plan::check::workplan_level_signals(&raw)?)
    } else {
        None
    };
    let declared_level = plan.as_ref().map_or(0, |(level, _)| *level);
    let merge_base = git_lines(&root.cwd, &["merge-base", "HEAD", &base])?
        .first()
        .map(|s| js_trim(s).to_owned())
        .unwrap_or_default();
    let since = if merge_base.is_empty() {
        base.as_str()
    } else {
        merge_base.as_str()
    };
    // `[...new Set([...tracked, ...untracked])].sort()`.
    let mut files = git_lines(&root.cwd, &["diff", "--name-only", "-z", since])?;
    files.extend(git_lines(
        &root.cwd,
        &["ls-files", "-z", "--others", "--exclude-standard"],
    )?);
    files.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    files.dedup();
    let declared = plan
        .as_ref()
        .map(|(_, signals)| declared_flags_from_signals(signals))
        .unwrap_or_default();
    let input = ClassifyInput {
        files: files.clone(),
        critical_area: declared.critical_area,
        money_credentials_pii: declared.money_credentials_pii,
        multi_repo: declared.multi_repo,
        new_external_dependency: declared.new_external_dependency,
        shared_contract: declared.shared_contract,
        data_schema_migration: declared.data_schema_migration,
        bug_without_root_cause: declared.bug_without_root_cause,
        critical_paths: project.critical_paths.clone().unwrap_or_default(),
        local_skill_ids: project.local_skill_ids.map(|ids| ids.into_iter().collect()),
    };
    let result = classify(&input)?;
    let exceeds = result.level > declared_level;
    // `reviewDepth(hasWorkplan, result, criticalPaths)`.
    let depth: (&str, Option<&str>) = if has_workplan {
        ("full", Some("workplan"))
    } else if result.level != 0 {
        ("full", Some("level"))
    } else if result.signals.iter().any(|s| s.starts_with("floor:")) {
        ("full", Some("floor"))
    } else if project.critical_paths.as_ref().is_none_or(Vec::is_empty) {
        ("full", Some("criticalPaths-undeclared"))
    } else if result
        .signals
        .iter()
        .any(|s| s.starts_with("critical-area:"))
    {
        ("full", Some("critical-path-matched"))
    } else {
        ("light", None)
    };
    if options.json {
        let mut fields = vec![
            ("score", JsValue::Number(f64::from(result.score))),
            ("level", JsValue::Number(f64::from(result.level))),
            (
                "signals",
                JsValue::Array(result.signals.iter().map(|s| string(s)).collect()),
            ),
            ("nonTrivialCeiling", number(result.non_trivial_ceiling)),
            ("base", string(&base)),
            (
                "files",
                JsValue::Array(files.iter().map(|f| string(f)).collect()),
            ),
            ("declaredLevel", JsValue::Number(f64::from(declared_level))),
            ("exceedsDeclared", JsValue::Bool(exceeds)),
            ("workplan", JsValue::Bool(has_workplan)),
            ("reviewDepth", string(depth.0)),
        ];
        if let Some(reason) = depth.1 {
            fields.push(("depthReason", string(reason)));
        }
        json_line(&mut out, &object(fields));
    } else {
        let signals = if result.signals.is_empty() {
            "(none)".to_owned()
        } else {
            result.signals.join(", ")
        };
        out.stdout.push_str(&format!(
            "Diff vs {base}: Complexity: {}/10 · Level: {} (declared: {declared_level})\nSignals: {signals}\n",
            result.score, result.level
        ));
        out.stdout.push_str(&if exceeds {
            format!(
                "Exceeds declared level: yes — the diff outgrew the workplan (level {} > {declared_level}).\n",
                result.level
            )
        } else {
            "Exceeds declared level: no.\n".to_owned()
        });
        out.stdout.push_str(&format!(
            "Review depth: {}{}\n",
            depth.0,
            depth.1.map_or_else(String::new, |r| format!(" ({r})"))
        ));
    }
    out.code = u8::from(exceeds);
    Some(out)
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

/// Writes a workplan's files under `withPlanStateLock` as `writeWorkplanAndRender` does: the
/// JSON (`plan update` only), the Markdown and the acceptance index. Every throw is planned
/// before the first write: `None` hands the call to the TS, `Some(Err)` is a write that failed
/// after them (the TS throws uncaught there).
fn write_plan(
    root: &StateRoot,
    feature: &str,
    json: Option<&str>,
    markdown: &str,
) -> Option<Result<(), String>> {
    // `writeAcceptanceIndex`: the neutral directory, both legacy ones and the root's own.
    let mut dirs: Vec<String> = std::iter::once(NEUTRAL_DIR)
        .chain(LEGACY_DIRS)
        .map(|dir| resolve(&root.cwd, dir))
        .collect();
    dirs.push(root.path.clone());
    let json_name = format!("workplan_{feature}.json");
    let json_path = state_files::artifact_path(root, &json_name).ok()?;
    let index = acceptance_index::build(&dirs, json.map(|text| (json_path.as_str(), text)))?;
    let neutral = StateRoot {
        cwd: root.cwd.clone(),
        dir: NEUTRAL_DIR.to_owned(),
        path: resolve(&root.cwd, NEUTRAL_DIR),
    };
    if !state_files::plan_state_dirs(root).ok()?.is_empty() {
        return None;
    }
    let lock = state_files::artifact_path(root, ".plan-update.lock").ok()?;
    if std::fs::symlink_metadata(&lock).is_ok() {
        return None;
    }
    let json_write = match json {
        Some(_) => Some(plan_write(root, &json_name)?),
        None => None,
    };
    let md = plan_write(root, &format!("workplan_{feature}.md"))?;
    state_files::artifact_path(&neutral, "acceptance-index").ok()?;
    let expected = plan_write(&neutral, "acceptance-expected.jsonl")?;
    let index_write = plan_write(&neutral, "acceptance-index")?;
    let mut fs = RealFs::default();
    let _lock = PlanStateLock::acquire(lock).ok()?;
    let fs: &mut dyn Fs = &mut fs;
    let written = match (&json_write, json) {
        (Some(write), Some(text)) => state_files::write_state_file(fs, write, text),
        _ => Ok(()),
    }
    .and_then(|()| state_files::write_state_file(fs, &md, markdown))
    .and_then(|()| state_files::write_state_file(fs, &expected, &index.expected))
    // `expected` created the neutral directory if it was missing.
    .and_then(|()| state_files::write_state_file(fs, &index_write, &index.index));
    Some(written)
}

fn render_command(feature: &str, options: &LeafOptions<'_>, root: &StateRoot) -> Option<Output> {
    let mut out = Output::default();
    let raw = match read_workplan(&mut out, root, feature)? {
        Ok(raw) => raw,
        Err(()) => return Some(out),
    };
    let markdown = report::render_workplan(&raw)?;
    if let Err(message) = write_plan(root, feature, None, &markdown)? {
        // The TS throws uncaught here, after the checks above: only stderr reports it.
        fail(&mut out, &format!("navori-rust: {message}"));
        return Some(out);
    }
    if options.json {
        json_line(&mut out, &object(vec![("rendered", JsValue::Bool(true))]));
    }
    Some(out)
}

// ---------------------------------------------------------------------------------------------
// update

/// `failUsage(message)`: one stderr line, exit 1.
fn usage_error(out: &mut Output, message: &str) {
    fail(out, &format!("ERROR: {message}"));
}

/// `evidenceRequired` may be true: an identified Claude child, Pi or Codex session, where
/// `validateEvidence` (git, D42) decides a `cumplido`.
fn evidence_session() -> bool {
    let var = |name: &str| std::env::var_os(name);
    let pi = var("PI_SESSION_ID").is_some_and(|v| {
        v.to_str().is_none_or(|v| {
            !v.is_empty()
                && v.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
        })
    });
    var("CLAUDE_CODE_CHILD_SESSION").is_some_and(|v| v == "1")
        || pi
        || var("CODEX_THREAD_ID").is_some_and(|v| !v.is_empty())
}

/// `rejectCumplido` without its audit event (an audit session delegates).
fn reject_cumplido(out: &mut Output, id: &str, command: &str, json: bool) {
    let what = format!("{id} not marked cumplido — no valid evidence");
    let why = "comparison not recorded for the current expected value";
    let fix = "Structured expectations require host-recorded evidence; an unsupported-engine acknowledgement cannot verify them.";
    if json {
        let error = object(vec![
            ("what", string(&what)),
            ("why", string(why)),
            ("fix", string(fix)),
            ("command", string(command)),
        ]);
        json_line(
            out,
            &object(vec![
                ("updated", JsValue::Bool(false)),
                ("id", string(id)),
                ("error", error),
            ]),
        );
    }
    out.stderr
        .push_str(&format!("ERROR: {what}\nWHY:   {why}\nFIX:   {fix}\n"));
    out.code = 1;
}

fn update_command(feature: &str, options: &LeafOptions<'_>, root: &StateRoot) -> Option<Output> {
    // An audit session records a rejected `cumplido`; an identified session needs git evidence.
    if crate::master_write::audit_may_write() || evidence_session() {
        return None;
    }
    let mut out = Output::default();
    let raw = match read_workplan(&mut out, root, feature)? {
        Ok(raw) => raw,
        Err(()) => return Some(out),
    };
    // A workplan zod rejects prints zod's issues: the TS's.
    let criteria = report::criteria(&raw)?;
    let progress: Vec<&str> = options
        .strings
        .iter()
        .filter(|(key, _)| *key == "progress")
        .map(|(_, value)| *value)
        .collect();
    let decision = options.get("decision");
    let date = options.get("date");
    if !progress.is_empty() && decision.is_some() {
        usage_error(&mut out, "--progress and --decision are mutually exclusive");
        return Some(out);
    }
    if let Some(date) = date
        && !update::is_iso_date(date)
    {
        let quoted = JsValue::string(date).stringify(None)?;
        usage_error(
            &mut out,
            &format!("--date must be an ISO date (YYYY-MM-DD), got {quoted}"),
        );
        return Some(out);
    }
    let mut updates = Vec::new();
    if !progress.is_empty() {
        for entry in &progress {
            let Some((id, status)) = update::progress_entry(entry) else {
                usage_error(
                    &mut out,
                    &format!(
                        "--progress must look like A1=pendiente|cumplido|bloqueado, got \"{entry}\""
                    ),
                );
                return Some(out);
            };
            updates.push(Mutation::Progress { id, status });
        }
    } else if let Some(text) = decision {
        let Some(date) = date else {
            usage_error(&mut out, "--decision requires --date");
            return Some(out);
        };
        updates.push(Mutation::Decision {
            text: text.to_owned(),
            date: date.to_owned(),
        });
    } else {
        usage_error(&mut out, "plan update requires --progress or --decision");
        return Some(out);
    }
    // `applyWorkplanUpdate` over every update first: an unknown id throws.
    for update in &updates {
        if let Mutation::Progress { id, .. } = update
            && !criteria.iter().any(|(known, _, _)| known == id)
        {
            fail(&mut out, &format!("unknown acceptance id: {id}"));
            return Some(out);
        }
    }
    let mut mutations = Vec::new();
    for update in updates {
        let Mutation::Progress { id, status } = &update else {
            mutations.push(update);
            continue;
        };
        let (id, status) = (id.clone(), status.clone());
        mutations.push(update);
        if status != "cumplido" {
            mutations.push(Mutation::Evidence { id, value: None });
            continue;
        }
        let Some((_, command, expected)) = criteria.iter().find(|(known, _, _)| *known == id)
        else {
            continue;
        };
        if parse_expected(expected)? != Expected::Free {
            reject_cumplido(&mut out, &id, command, options.json);
            return Some(out);
        }
        mutations.push(Mutation::Evidence {
            id: id.clone(),
            value: Some(update::unevidenced()),
        });
        out.stderr.push_str(&format!(
            "WARNING: {id} marked cumplido without evidence — this engine/session exposes no verifiable Bash success signal\n"
        ));
    }
    let next = update::apply_mutations(&raw, &mutations)?;
    // An update that zod would reject prints zod's message: the TS's.
    let markdown = report::render_workplan(&next)?;
    let json = format!("{}\n", next.stringify(Some(2))?);
    if let Err(message) = write_plan(root, feature, Some(&json), &markdown)? {
        fail(&mut out, &format!("navori-rust: {message}"));
        return Some(out);
    }
    if options.json {
        json_line(&mut out, &object(vec![("updated", JsValue::Bool(true))]));
    }
    Some(out)
}

// ---------------------------------------------------------------------------------------------
// escalation-reset

/// The flag checks `escalation-reset` runs before the state root.
fn reset_usage(options: &LeafOptions<'_>) -> Option<Output> {
    let mut out = Output::default();
    let reason = js_trim(options.get("reason").unwrap_or_default());
    if options.get("approved-by") != Some("user") {
        usage_error(&mut out, "escalation-reset requires --approved-by user");
    } else if reason.is_empty() {
        usage_error(&mut out, "escalation-reset requires a non-empty --reason");
    } else if reason.encode_utf16().count() > 4096 {
        usage_error(&mut out, "escalation-reset reason exceeds 4096 characters");
    } else {
        return None;
    }
    Some(out)
}

/// `readPlanSnapshot(path, maximum)`: `Some(None)` when absent, `None` where the TS throws.
fn snapshot(path: &str, maximum: u64) -> Option<Option<String>> {
    match std::fs::metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Some(None),
        Err(_) => None,
        Ok(meta) if !meta.is_file() || meta.len() > maximum => None,
        Ok(_) => String::from_utf8(std::fs::read(path).ok()?).ok().map(Some),
    }
}

/// `reconcileHistory`: only an escalation directory without escalation records is modeled.
fn escalation_records_absent(root: &StateRoot, feature: &str) -> Option<()> {
    let neutral =
        state_files::resolve_state_root(&root.cwd, &root.cwd, feature, Some(NEUTRAL_DIR)).ok()?;
    let Ok(entries) = std::fs::read_dir(&neutral.path) else {
        return std::fs::metadata(&neutral.path).is_err().then_some(());
    };
    let mut count = 0;
    for entry in entries {
        let name = entry.ok()?.file_name().into_string().ok()?;
        count += 1;
        let private = name
            .strip_prefix("escalation_private_")
            .and_then(|rest| rest.strip_suffix(".tmp"))
            .is_some_and(|id| {
                id.len() == 36
                    && id
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || b == b'-')
            });
        if count > 8192 || (name.starts_with("escalation_") && !private) {
            return None;
        }
    }
    Some(())
}

fn reset_command(feature: &str, options: &LeafOptions<'_>, root: &StateRoot) -> Option<Output> {
    // The reset ends with an audit event (`appendCliEvent`, T18).
    if crate::master_write::audit_may_write() {
        return None;
    }
    let mut out = Output::default();
    let path = state_files::artifact_path(root, &format!("workplan_{feature}.json")).ok()?;
    let Some(text) = read_artifact(&path)? else {
        usage_error(&mut out, &format!("workplan not found: {path}"));
        return Some(out);
    };
    let level = match js_json::parse(&text)? {
        JsValue::Object(o) => match o.get("level") {
            Some(JsValue::Number(n)) => Some(*n),
            _ => None,
        },
        _ => None,
    };
    if level.is_none_or(|l| l < 2.0) {
        usage_error(
            &mut out,
            "escalation-reset applies to level >= 2 workplans; at level 0/1 the way out is a new solution and its challenge",
        );
        return Some(out);
    }
    // `recordAndCountRejections`: read, reconcile, maybe record the current rejection.
    let log_name = format!("workplan_{feature}.gate.jsonl");
    let log_path = state_files::artifact_path(root, &log_name).ok()?;
    let review_path = state_files::artifact_path(root, &format!("review_{feature}.md")).ok()?;
    let log = snapshot(&log_path, 1024 * 1024)?.unwrap_or_default();
    let review = snapshot(&review_path, 4 * 1024 * 1024)?.unwrap_or_default();
    let mut history = update::read_history(&log)?;
    escalation_records_absent(root, feature)?;
    let mut appends = Vec::new();
    if update::rejects(&review)? {
        let hash: String = Sha256::digest(review.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        if !history.hashes.contains(&hash) {
            let ts = navori_core::handoff::review::iso_now();
            appends.push(format!("{}\n", update::rejection_line(&ts, &hash)));
            history.active.push(ts);
        }
    }
    let count = history.active.len();
    let reset = if count < 2 {
        None
    } else {
        let line = update::reset_line(
            &navori_core::handoff::review::iso_now(),
            js_trim(options.get("reason").unwrap_or_default()),
            count,
        )?;
        (line.len() <= 8192).then_some(line)
    };
    if let Some(line) = &reset {
        appends.push(format!("{line}\n"));
    }
    if !appends.is_empty() && !state_files::plan_state_dirs(root).ok()?.is_empty() {
        return None;
    }
    let mut fs = RealFs::default();
    for text in &appends {
        if let Err(error) = fs.append(std::path::Path::new(&log_path), text.as_bytes()) {
            fail(
                &mut out,
                &format!("navori-rust: cannot append {log_path}: {error}"),
            );
            return Some(out);
        }
    }
    if count < 2 {
        usage_error(
            &mut out,
            &format!("escalation-reset needs two recorded rejections (found {count})"),
        );
    } else if reset.is_none() {
        usage_error(&mut out, "escalation-reset record exceeds 8192 bytes");
    } else if options.json {
        json_line(
            &mut out,
            &object(vec![
                ("reset", JsValue::Bool(true)),
                ("rejectionsBefore", number(count)),
            ]),
        );
    }
    Some(out)
}

// resume

/// `plan resume [--json]`: `resumePlans(process.cwd())`, compact with `--json` and indented
/// otherwise. Anything after `resume` other than `--json` is the TS's (citty would accept it).
fn resume_command(tokens: &[&str]) -> Option<Output> {
    let json = match tokens {
        [] => false,
        ["--json"] => true,
        _ => return None,
    };
    let process_cwd = std::env::current_dir().ok()?;
    let process_cwd = process_cwd.to_str()?;
    let warnings = std::cell::RefCell::new(Vec::new());
    let config = |root: &str| -> Option<ConfigFacts> {
        let Some(config) = read_config(root)? else {
            let path = format!("{root}/navori.config.json");
            return Some(ConfigFacts::Thrown(format!(
                "Cannot read {path}: ENOENT: no such file or directory, open '{path}'"
            )));
        };
        let target = match (
            member(Some(&config.data), "prTarget"),
            member(Some(&config.data), "branchBase"),
        ) {
            (Some(JsValue::String(t)), _) | (None, Some(JsValue::String(t))) => t.to_rust()?,
            _ => return None,
        };
        let gate = match member(member(Some(&config.data), "qualityGate"), "full") {
            None | Some(JsValue::Undefined | JsValue::Null) => String::new(),
            Some(JsValue::String(t)) => t.to_rust()?,
            Some(_) => return None,
        };
        warnings.borrow_mut().extend(config.warnings);
        Some(ConfigFacts::Values { target, gate })
    };
    let env = navori_core::plan::evidence::process_env();
    let result = resume_plans(&ResumeInput {
        cwd: process_cwd,
        runner: &RealRunner,
        env: &env,
        budget: RESUME_BUDGET,
        config: &config,
    })?;
    let mut out = Output::default();
    for warning in warnings.into_inner() {
        out.stderr.push_str(&warning);
        out.stderr.push('\n');
    }
    out.stdout = result.stringify((!json).then_some(2))?;
    out.stdout.push('\n');
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
