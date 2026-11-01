//! Registry adapters and host of role-guard and engram-write-guard, Codex only (spec 0060 T13,
//! R70).
//!
//! Before stdin: the accredited extraction profile (which also says whether jq or node is on
//! `PATH`) and the policy the renderer wrote. After stdin role-guard reads the file system and
//! `git` through [`SystemHost`] and, for a reviewer's write outside the repo, runs the script's own
//! binding program; engram-write-guard needs nothing beyond the payload. Every fact is
//! read-only, so shadow evaluates both hooks whole.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::Path;

use navori_hooks::hooks::{engram_write_guard, role_guard};
use navori_hooks::runner::{Engine, Evaluation, Failure};
use navori_hooks::shell::prepare::{self, Limits, Prepared, Request};
use navori_hooks::shell::subcommand::{self, Call, Capture, Input};

use crate::facts_cache::FactsCache;
use crate::hook::{Evaluator, Invocation, Recorder, Snapshot};
use crate::hook_facts::{collect_cached, shell_pwd};
use crate::journal;
use crate::quality_gate::resolve;

/// The real host of one role-guard invocation.
struct SystemHost<'a> {
    env: &'a [(OsString, OsString)],
    cwd: &'a Path,
    pwd: &'a str,
}

impl SystemHost<'_> {
    fn run(
        &self,
        name: &str,
        args: &[&str],
        input: &[u8],
    ) -> Result<Option<(i32, Vec<u8>)>, Failure> {
        let Some(program) = resolve(self.env, name, self.pwd) else {
            return Ok(None);
        };
        let env = subcommand::child_env(self.env, OsStr::new(self.pwd), None, &program, &[]);
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        let done = subcommand::run(&Call {
            program: &program,
            args: &args,
            cwd: self.cwd,
            env: &env,
            input: Input::Bytes(input),
            capture: Capture::Separate,
            timeout: None,
        })
        .map_err(|error| Failure(format!("{name} could not run: {error}")))?;
        Ok(Some((done.status, done.stdout)))
    }
}

/// `$(…)`: stdout without trailing newlines; a NUL or non-UTF-8 output is not reproduced.
fn substitution(mut stdout: Vec<u8>) -> Result<String, Failure> {
    if stdout.contains(&0) {
        return Err(Failure(
            "a command substitution printed a NUL byte".to_owned(),
        ));
    }
    while stdout.last() == Some(&b'\n') {
        stdout.pop();
    }
    String::from_utf8(stdout).map_err(|_| Failure("command output is not UTF-8".to_owned()))
}

impl role_guard::Host for SystemHost<'_> {
    fn exists(&self, path: &str) -> bool {
        fs::metadata(self.cwd.join(path)).is_ok()
    }

    fn is_symlink(&self, path: &str) -> bool {
        fs::symlink_metadata(self.cwd.join(path)).is_ok_and(|meta| meta.file_type().is_symlink())
    }

    fn is_dir(&self, path: &str) -> bool {
        fs::metadata(self.cwd.join(path)).is_ok_and(|meta| meta.is_dir())
    }

    fn physical(&self, dir: &str) -> Option<String> {
        // Residual: `cd` also needs search permission on the directory itself.
        let real = fs::canonicalize(self.cwd.join(dir)).ok()?;
        if !real.is_dir() {
            return None;
        }
        real.to_str().map(str::to_owned)
    }

    fn readlink(&self, path: &str) -> Option<String> {
        let target = fs::read_link(self.cwd.join(path)).ok()?;
        let text = target.to_str()?.trim_end_matches('\n').to_owned();
        Some(text)
    }

    fn git(&self, args: &[&str]) -> Result<Option<String>, Failure> {
        match self.run("git", args, &[])? {
            Some((0, stdout)) => substitution(stdout).map(Some),
            _ => Ok(None),
        }
    }

    fn tmpdir(&self) -> Option<String> {
        prepare::env_value(self.env, "TMPDIR").and_then(|v| v.to_str().map(str::to_owned))
    }

    fn bind(&self, program: &str, args: &[&str]) -> Result<Option<(bool, String)>, Failure> {
        let mut argv = vec!["-"];
        argv.extend_from_slice(args);
        match self.run("node", &argv, program.as_bytes())? {
            Some((status, stdout)) => Ok(Some((status == 0, substitution(stdout)?))),
            None => Ok(None),
        }
    }
}

fn prepared<'a>(
    invocation: &'a Invocation,
    snapshot: &Snapshot<'a>,
    engines: &'a [Engine],
) -> Result<(Prepared<'a>, &'a str), String> {
    let request = Request {
        engine: invocation.engine,
        engines,
        event: invocation.event.as_deref(),
        args: &invocation.args,
        script: &invocation.requested,
        source: snapshot.source,
        env: snapshot.env,
    };
    let cache = journal::project_root(invocation.engine, &invocation.engine_root)
        .map(FactsCache::in_project);
    let prepared = collect_cached(request, snapshot.cwd, Limits::default(), cache.as_ref())
        .map_err(|e| e.to_string())?;
    let source = std::str::from_utf8(snapshot.source).map_err(|_| "script is not UTF-8")?;
    Ok((prepared, source))
}

/// Registry adapter for role-guard.
///
/// # Errors
/// The ineligibility cause; the caller defers the call to the shell.
pub fn prepare_role_guard<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    let (prepared, source) = prepared(invocation, &snapshot, role_guard::ENGINES)?;
    let context = role_guard::Context {
        profile: prepared.profile(),
        capture: prepared.capture(),
        rendered: role_guard::Rendered::from_script(source)?,
    };
    let inherited = prepare::env_value(snapshot.env, "PWD")
        .map(|value| {
            value
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| "PWD is not UTF-8".to_owned())
        })
        .transpose()?;
    let pwd = shell_pwd(inherited, snapshot.cwd)?;
    let (env, cwd) = (snapshot.env, snapshot.cwd);
    Ok(Box::new(
        move |payload: &[u8], _: &dyn Recorder| -> Result<Evaluation, Failure> {
            let host = SystemHost {
                env,
                cwd,
                pwd: &pwd,
            };
            role_guard::evaluate(payload, &context, &host)
        },
    ))
}

/// Registry adapter for engram-write-guard.
///
/// # Errors
/// The ineligibility cause; the caller defers the call to the shell.
pub fn prepare_engram_write_guard<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    let (prepared, source) = prepared(invocation, &snapshot, engram_write_guard::ENGINES)?;
    let context = engram_write_guard::Context {
        profile: prepared.profile(),
        capture: prepared.capture(),
        rendered: engram_write_guard::Rendered::from_script(source)?,
    };
    Ok(Box::new(
        move |payload: &[u8], _: &dyn Recorder| -> Result<Evaluation, Failure> {
            engram_write_guard::evaluate(payload, &context)
        },
    ))
}
