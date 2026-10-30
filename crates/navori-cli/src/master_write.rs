//! `navori master advance`, `status` without flags, `mode`, `ux` and `part`, native (spec 0060
//! T8): the commands of `master` that write the phase, the mode, the UX decision or a part.
//!
//! Both go through `navori_core::master::write`, which checks everything before its first write
//! and answers [`Outcome::Delegate`] when the TS would behave differently. `advance` also emits
//! an audit event in the TS (`appendCliEvent`), which is written only when an audit session is
//! reachable from the environment: the native command delegates whenever one of those variables
//! is set, because the audit writer is not ported (spec 0060 T18).

use std::ffi::OsString;

use navori_core::master::checks::build_stage_ctx;
use navori_core::master::part::{PartChange, PartOutcome, change_part};
use navori_core::master::write::{self, Advance, Set};

use crate::help::{ArgDef, ArgKind, CommandDef};
use crate::master::{MASTER_PARENT, part_config};
use crate::master_read::{Repo, argv, cwd_of, fail, parse_options, push_warnings};
use crate::native_io::Output;
use crate::{NativeCall, Outcome};

const ADVANCE: CommandDef = CommandDef {
    name: "advance",
    description: "Advance the active stage one phase (R8)",
    args: &[
        ArgDef {
            name: "stage",
            kind: ArgKind::String,
            description: "Closed stages are read-only",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Repo root",
        },
    ],
    sub_commands: &[],
};

const MODE: CommandDef = CommandDef {
    name: "mode",
    description: "Register the first stage's mode: template | en-curso | desde-cero (R16)",
    args: &[
        ArgDef {
            name: "value",
            kind: ArgKind::Positional,
            description: "template | en-curso | desde-cero",
        },
        ArgDef {
            name: "stage",
            kind: ArgKind::String,
            description: "Closed stages are read-only",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Repo root",
        },
    ],
    sub_commands: &[],
};

const UX: CommandDef = CommandDef {
    name: "ux",
    description: "Record the UX contract decision in phase ux: none | md | md-json",
    args: &[
        ArgDef {
            name: "value",
            kind: ArgKind::Positional,
            description: "none | md | md-json",
        },
        ArgDef {
            name: "stage",
            kind: ArgKind::String,
            description: "Closed stages are read-only",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Repo root",
        },
    ],
    sub_commands: &[],
};

const PART: CommandDef = CommandDef {
    name: "part",
    description: "Update a master-plan part or record acceptance evidence",
    args: &[
        ArgDef {
            name: "id",
            kind: ArgKind::Positional,
            description: "P<n>",
        },
        ArgDef {
            name: "state",
            kind: ArgKind::String,
            description: "Part state",
        },
        ArgDef {
            name: "reason",
            kind: ArgKind::String,
            description: "Reason for discarded/deferred state",
        },
        ArgDef {
            name: "spec",
            kind: ArgKind::String,
            description: "Existing linked spec directory",
        },
        ArgDef {
            name: "issue",
            kind: ArgKind::String,
            description: "GitHub issue number",
        },
        ArgDef {
            name: "accept",
            kind: ArgKind::String,
            description: "A<m> acceptance criterion",
        },
        ArgDef {
            name: "command",
            kind: ArgKind::String,
            description: "Command run for test/comando evidence",
        },
        ArgDef {
            name: "result",
            kind: ArgKind::String,
            description: "Observed result",
        },
        ArgDef {
            name: "approved-by",
            kind: ArgKind::String,
            description: "user for manual acceptance",
        },
        ArgDef {
            name: "stage",
            kind: ArgKind::String,
            description: "Closed stages are read-only",
        },
        ArgDef {
            name: "cwd",
            kind: ArgKind::String,
            description: "Repo root",
        },
    ],
    sub_commands: &[],
};

const MODES: [&str; 3] = ["template", "en-curso", "desde-cero"];
const UX_CHOICES: [&str; 3] = ["none", "md", "md-json"];

/// The environment variables `contextFromEnv` and `auditTarget` read (`lib/audit/cli-event.ts`).
const AUDIT_VARS: [&str; 5] = [
    "NAVORI_AUDIT_HOST",
    "NAVORI_AUDIT_SESSION_ID",
    "CLAUDE_CODE_SESSION_ID",
    "CODEX_SESSION_ID",
    "CODEX_THREAD_ID",
];

/// Whether `appendCliEvent` could find an audit session to write to.
fn audit_may_write() -> bool {
    AUDIT_VARS
        .iter()
        .any(|name| std::env::var_os(name).is_some())
}

/// `master advance`.
#[must_use]
pub fn run_advance(call: &NativeCall<'_>) -> Outcome {
    advance(call.args).map_or(Outcome::Delegate, |out| Outcome::Exit(out.emit()))
}

fn advance(args: &[OsString]) -> Option<Output> {
    let argv = argv(args)?;
    let ["master", "advance", rest @ ..] = argv.as_slice() else {
        return None;
    };
    if rest.contains(&"--") {
        return None;
    }
    if rest.iter().any(|a| *a == "--help" || *a == "-h") {
        return Some(Output::usage(&ADVANCE, MASTER_PARENT, None));
    }
    let parsed = parse_options(rest, &[], &["stage", "cwd"])?;
    if !parsed.positionals.is_empty() {
        return None;
    }
    if let Some(stage) = parsed.value("stage").filter(|s| !s.is_empty()) {
        return Some(fail(&format!(
            "--stage {stage} es de solo lectura; use 'navori master check --stage {stage}'"
        )));
    }
    if audit_may_write() {
        return None;
    }
    let cwd = cwd_of(&parsed)?;
    let mut out = Output::default();
    let repo = Repo::open(&mut out, cwd)?;
    let built = match build_stage_ctx(&repo.master_dir, repo.index.as_ref()).ok()? {
        Ok(built) => built,
        Err(message) => return Some(setup_failure(out, &message)),
    };
    let result = write::advance(
        &repo.cwd,
        &repo.specs_dir,
        &repo.master_dir,
        part_config(&repo.config),
        repo.index.as_ref()?,
        &built,
    )
    .ok()?;
    match result {
        Advance::Setup {
            message,
            config_reads,
        } => {
            for _ in 0..config_reads {
                push_warnings(&mut out, &repo.config.warnings);
            }
            Some(setup_failure(out, &message))
        }
        Advance::Blocked(failures) => {
            for failure in failures {
                out.stderr.push_str(&format!("[navori] {failure}\n"));
            }
            out.code = 1;
            Some(out)
        }
        Advance::Advanced {
            from,
            to,
            config_reads,
        } => {
            for _ in 0..config_reads {
                push_warnings(&mut out, &repo.config.warnings);
            }
            out.stdout.push_str(&format!("{from} -> {to}\n"));
            Some(out)
        }
    }
}

fn setup_failure(mut out: Output, message: &str) -> Output {
    out.stderr.push_str(&format!("{message}\n"));
    out.code = 1;
    out
}

/// `navori master status` without `--json` or `--line`: regenerate the derived files and print
/// the one-line summary.
pub(crate) fn status_plain(cwd: String) -> Option<Output> {
    let mut out = Output::default();
    let repo = Repo::open(&mut out, cwd)?;
    let result = write::write_master_status(
        &repo.cwd,
        &repo.specs_dir,
        &repo.master_dir,
        part_config(&repo.config),
        repo.index.as_ref(),
    )
    .ok()?;
    match result {
        Err(message) => {
            // The config was read for `readMasterStatus` and again for the write.
            push_warnings(&mut out, &repo.config.warnings);
            Some(setup_failure(out, &message))
        }
        Ok(written) => {
            for _ in 0..written.config_reads {
                push_warnings(&mut out, &repo.config.warnings);
            }
            out.stdout.push_str(&format!(
                "etapa {}: {}\n",
                written.stage.as_deref().unwrap_or("ninguna"),
                written.phase.unwrap_or("sin fase")
            ));
            Some(out)
        }
    }
}

/// `master mode <value>`.
#[must_use]
pub fn run_mode(call: &NativeCall<'_>) -> Outcome {
    setter(call.args, "mode", &MODE).map_or(Outcome::Delegate, |out| Outcome::Exit(out.emit()))
}

/// `master ux <value>`.
#[must_use]
pub fn run_ux(call: &NativeCall<'_>) -> Outcome {
    setter(call.args, "ux", &UX).map_or(Outcome::Delegate, |out| Outcome::Exit(out.emit()))
}

/// `master mode` and `master ux`: a positional value, `--stage` (read-only) and `--cwd`.
fn setter(args: &[OsString], name: &str, command: &CommandDef) -> Option<Output> {
    let argv = argv(args)?;
    let ["master", _, rest @ ..] = argv.as_slice() else {
        return None;
    };
    if rest.contains(&"--") {
        return None;
    }
    if rest.iter().any(|a| *a == "--help" || *a == "-h") {
        return Some(Output::usage(command, MASTER_PARENT, None));
    }
    let parsed = parse_options(rest, &[], &["stage", "cwd"])?;
    if parsed.positionals.len() > 1 {
        return None;
    }
    let Some(value) = parsed.positionals.first().copied() else {
        let error = "Missing required positional argument: VALUE".to_owned();
        return Some(Output::usage(command, MASTER_PARENT, Some(error)));
    };
    if let Some(stage) = parsed.value("stage").filter(|s| !s.is_empty()) {
        return Some(fail(&format!(
            "--stage {stage} es de solo lectura; use 'navori master check --stage {stage}'"
        )));
    }
    let (choices, label) = if name == "mode" {
        (&MODES, "mode")
    } else {
        (&UX_CHOICES, "ux choice")
    };
    if !choices.contains(&value) {
        let expected = choices
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ");
        return Some(fail(&format!(
            "invalid {label} \"{value}\": expected {expected}"
        )));
    }
    let cwd = cwd_of(&parsed)?;
    let mut out = Output::default();
    let repo = Repo::open(&mut out, cwd)?;
    let config = part_config(&repo.config);
    let result = if name == "mode" {
        write::set_mode(&repo.master_dir, repo.index.as_ref(), value)
    } else {
        write::set_ux(
            &repo.cwd,
            &repo.specs_dir,
            &repo.master_dir,
            config,
            repo.index.as_ref(),
            value,
        )
    }
    .ok()?;
    let reads = match &result {
        Set::Failed { config_reads, .. } | Set::Done { config_reads } => *config_reads,
    };
    for _ in 0..reads {
        push_warnings(&mut out, &repo.config.warnings);
    }
    if let Set::Failed { message, .. } = result {
        return Some(setup_failure(out, &message));
    }
    Some(out)
}

/// `/^P[1-9]\d*$/`.
fn is_part_id(id: &str) -> bool {
    id.strip_prefix('P').is_some_and(|d| {
        d.starts_with(|c: char| ('1'..='9').contains(&c)) && d.bytes().all(|b| b.is_ascii_digit())
    })
}

/// `master part <P<n>>`.
#[must_use]
pub fn run_part(call: &NativeCall<'_>) -> Outcome {
    part(call.args).map_or(Outcome::Delegate, |out| Outcome::Exit(out.emit()))
}

fn part(args: &[OsString]) -> Option<Output> {
    let argv = argv(args)?;
    let ["master", "part", rest @ ..] = argv.as_slice() else {
        return None;
    };
    if rest.contains(&"--") {
        return None;
    }
    if rest.iter().any(|a| *a == "--help" || *a == "-h") {
        return Some(Output::usage(&PART, MASTER_PARENT, None));
    }
    let parsed = parse_options(
        rest,
        &[],
        &[
            "state",
            "reason",
            "spec",
            "issue",
            "accept",
            "command",
            "result",
            "approved-by",
            "stage",
            "cwd",
        ],
    )?;
    if parsed.positionals.len() > 1 {
        return None;
    }
    let Some(id) = parsed.positionals.first().copied() else {
        let error = "Missing required positional argument: ID".to_owned();
        return Some(Output::usage(&PART, MASTER_PARENT, Some(error)));
    };
    if let Some(stage) = parsed.value("stage").filter(|s| !s.is_empty()) {
        return Some(fail(&format!(
            "--stage {stage} es de solo lectura; use 'navori master check --stage {stage}'"
        )));
    }
    if !is_part_id(id) {
        return Some(fail(&format!("invalid part id: {id}")));
    }
    let change = PartChange {
        state: parsed.value("state"),
        reason: parsed.value("reason"),
        spec: parsed.value("spec"),
        issue: parsed.value("issue"),
        accept: parsed.value("accept"),
        command: parsed.value("command"),
        result: parsed.value("result"),
        approved_by: parsed.value("approved-by"),
    };
    // An accepted criterion emits `master-part-accept` through the audit writer (T18).
    if change.accept.is_some_and(|a| !a.is_empty()) && audit_may_write() {
        return None;
    }
    let cwd = cwd_of(&parsed)?;
    let mut out = Output::default();
    let repo = Repo::open(&mut out, cwd)?;
    let result = change_part(
        &repo.cwd,
        &repo.specs_dir,
        &repo.master_dir,
        part_config(&repo.config),
        repo.index.as_ref(),
        id,
        &change,
    )
    .ok()?;
    let (PartOutcome::Failed { config_reads, .. } | PartOutcome::Updated { config_reads }) =
        &result;
    for _ in 0..*config_reads {
        push_warnings(&mut out, &repo.config.warnings);
    }
    if let PartOutcome::Failed { message, .. } = result {
        return Some(setup_failure(out, &message));
    }
    out.stdout.push_str(&format!("{id}: updated\n"));
    Some(out)
}
