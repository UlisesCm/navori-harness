//! `navori master advance` and `navori master status` without flags, native (spec 0060 T8): the
//! first commands of `master` that write.
//!
//! Both go through `navori_core::master::write`, which checks everything before its first write
//! and answers [`Outcome::Delegate`] when the TS would behave differently. `advance` also emits
//! an audit event in the TS (`appendCliEvent`), which is written only when an audit session is
//! reachable from the environment: the native command delegates whenever one of those variables
//! is set, because the audit writer is not ported (spec 0060 T18).

use std::ffi::OsString;

use navori_core::master::checks::build_stage_ctx;
use navori_core::master::write::{self, Advance};

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
