//! Registry adapter and effects of quality-gate-pre-commit (spec 0059 T7, D30, D40).
//!
//! Before stdin: the accredited extraction profile, the rendered values (a user section with
//! commands defers) and the environment facts. After stdin the pure decision runs; when it stops
//! at an effect, a shadow lane answers "unobserved" and any other lane runs it here: the gate
//! through Bash as `run_gate`'s `eval` does, or `navori gate foreign` through the `navori` of
//! `PATH`. `navori gate probe --clean` runs in process when that `navori` is this build's TS
//! version, else as the shell runs it.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::io;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use navori_core::gate::cache::{ProbeMode, probe_env};
use navori_hooks::hooks::quality_gate_pre_commit::{
    self as quality_gate, Context, Gate, GateRun, Rendered, Step, after_foreign, after_gate,
};
use navori_hooks::runner::{self, AuditLabel, Evaluation, Failure};
use navori_hooks::shell::hook_input::Host;
use navori_hooks::shell::prepare::{self, Limits, Request};
use navori_hooks::shell::repo::System;
use navori_hooks::shell::subcommand::{self, Call, Capture, Input};

use crate::facts_cache::FactsCache;
use crate::hook::{Evaluator, Invocation, Recorder, Snapshot};
use crate::hook_facts::{collect_cached, navori_cli, shell_pwd};
use crate::{gate_probe, journal};

/// Variables the shell's probe unsets before running `navori gate probe --clean`.
const PROBE_UNSET: [&str; 15] = [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
];

/// Host facts read after stdin, from the invocation's environment snapshot.
struct SystemGate<'a> {
    env: &'a [(OsString, OsString)],
    cache: Option<&'a FactsCache>,
}

fn env_text<'e>(env: &'e [(OsString, OsString)], name: &str) -> Option<&'e OsStr> {
    prepare::env_value(env, name)
}

/// One `PATH` entry joined to `dir` (an empty entry is the working directory).
fn entries<'p>(path: &'p OsStr, dir: &'p str) -> impl Iterator<Item = PathBuf> + 'p {
    std::env::split_paths(path).map(move |entry| {
        if entry.as_os_str().is_empty() {
            PathBuf::from(dir)
        } else if entry.is_absolute() {
            entry
        } else {
            Path::new(dir).join(entry)
        }
    })
}

fn executable(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
}

impl SystemGate<'_> {
    /// The program Bash runs for `name` from `dir`: the first executable along `PATH`.
    fn resolve(&self, name: &str, dir: &str) -> Option<PathBuf> {
        let path = env_text(self.env, "PATH")?;
        entries(path, dir)
            .map(|d| d.join(name))
            .find(|c| executable(c))
    }

    /// `$PWD`-relative `GIT_INDEX_FILE` made absolute, as the probe passes it.
    fn index_file(&self, dir: &str) -> Option<OsString> {
        let index = env_text(self.env, "GIT_INDEX_FILE").filter(|v| !v.is_empty())?;
        Some(if index.as_encoded_bytes().starts_with(b"/") {
            index.to_owned()
        } else {
            let mut joined = OsString::from(format!("{dir}/"));
            joined.push(index);
            joined
        })
    }

    /// The environment of the probe's `env -u … [GIT_INDEX_FILE=…] navori gate probe --clean`.
    fn probe_vars(&self, dir: &str, program: &Path) -> Vec<(OsString, OsString)> {
        let mut vars: Vec<(OsString, OsString)> = self
            .env
            .iter()
            .filter(|(name, _)| !PROBE_UNSET.iter().any(|unset| name == unset))
            .cloned()
            .collect();
        if let Some(index) = self.index_file(dir) {
            vars.push(("GIT_INDEX_FILE".into(), index));
        }
        subcommand::child_env(&vars, OsStr::new(dir), None, program, &[])
    }
}

impl Gate for SystemGate<'_> {
    fn on_path(&self, name: &str, dir: &str) -> bool {
        if name.contains('/') {
            let path = if name.starts_with('/') {
                PathBuf::from(name)
            } else {
                Path::new(dir).join(name)
            };
            return executable(&path);
        }
        let Some(path) = env_text(self.env, "PATH") else {
            return false;
        };
        entries(path, dir).any(|d| fs::metadata(d.join(name)).is_ok_and(|meta| !meta.is_dir()))
    }

    fn probe_hit(&self, dir: &str) -> bool {
        let Some(program) = self.resolve("navori", dir) else {
            return false;
        };
        let vars = self.probe_vars(dir, &program);
        let here = Path::new(dir);
        let same = navori_cli(self.env, here, self.cache)
            .is_ok_and(|cli| cli.in_process() && cli.path.as_deref() == Some(program.as_path()));
        if same
            && let Some((code, _)) =
                gate_probe::probe(here, here, &probe_env(vars.clone()), ProbeMode::Clean)
        {
            return code == 0;
        }
        let args = [
            OsString::from("gate"),
            OsString::from("probe"),
            OsString::from("--clean"),
        ];
        subcommand::run(&Call {
            program: &program,
            args: &args,
            cwd: here,
            env: &vars,
            input: Input::Bytes(&[]),
            capture: Capture::Discard,
            timeout: None,
        })
        .is_ok_and(|finished| finished.status == 0)
    }

    fn read(&self, path: &str) -> Option<Vec<u8>> {
        fs::read(path).ok()
    }

    fn cd_error(&self, dir: &str) -> Result<Option<&'static str>, String> {
        match fs::metadata(dir) {
            Ok(meta) if meta.is_dir() => Ok(None),
            Ok(_) => Ok(Some("Not a directory")),
            Err(error) => match error.kind() {
                io::ErrorKind::NotFound => Ok(Some("No such file or directory")),
                io::ErrorKind::NotADirectory => Ok(Some("Not a directory")),
                io::ErrorKind::PermissionDenied => Ok(Some("Permission denied")),
                _ => Err(format!("cd {dir}: {error}")),
            },
        }
    }
}

/// `run_gate`'s `eval "$1"`: Bash with `-u` and `pipefail` (the `||` suspends `-e`), `$0` the
/// script and `$1` the gate, from the shell's working directory.
fn run_gate(
    env: &[(OsString, OsString)],
    script: &str,
    run: &GateRun,
) -> Result<subcommand::Finished, Failure> {
    let bash = SystemGate { env, cache: None }
        .resolve("bash", &run.pwd)
        .ok_or_else(|| Failure("bash is not on PATH".to_owned()))?;
    let mut vars: Vec<(OsString, OsString)> = env
        .iter()
        .filter(|(name, _)| name != "PWD" && name != "OLDPWD")
        .cloned()
        .collect();
    vars.push(("PWD".into(), run.pwd.clone().into()));
    if let Some(old) = &run.oldpwd {
        vars.push(("OLDPWD".into(), old.clone().into()));
    } else if let Some(old) = env_text(env, "OLDPWD") {
        vars.push(("OLDPWD".into(), old.to_owned()));
    }
    let args = [
        OsString::from("-c"),
        OsString::from("set -uo pipefail; eval \"$1\""),
        OsString::from(script),
        OsString::from(&run.command),
    ];
    subcommand::run(&Call {
        program: &bash,
        args: &args,
        cwd: Path::new(&run.pwd),
        env: &vars,
        input: Input::Bytes(&[]),
        capture: Capture::Separate,
        timeout: None,
    })
    .map_err(|error| Failure(format!("gate run failed: {error}")))
}

/// `navori gate foreign --cwd <root> 2>&1 </dev/null` from the hook's working directory.
fn run_foreign(
    env: &[(OsString, OsString)],
    pwd: &str,
    root: &str,
) -> Result<subcommand::Finished, Failure> {
    let gate = SystemGate { env, cache: None };
    let program = gate
        .resolve("navori", pwd)
        .ok_or_else(|| Failure("navori is not executable on PATH".to_owned()))?;
    let vars = subcommand::child_env(env, OsStr::new(pwd), None, &program, &[]);
    let args = [
        OsString::from("gate"),
        OsString::from("foreign"),
        OsString::from("--cwd"),
        OsString::from(root),
    ];
    subcommand::run(&Call {
        program: &program,
        args: &args,
        cwd: Path::new(pwd),
        env: &vars,
        input: Input::Null,
        capture: Capture::Merged,
        timeout: None,
    })
    .map_err(|error| Failure(format!("navori gate foreign failed: {error}")))
}

fn started() -> AuditLabel {
    AuditLabel {
        verdict: "gate-started",
        reason: "inicio del quality gate".to_owned(),
    }
}

/// Registry adapter for quality-gate-pre-commit.
///
/// # Errors
/// The ineligibility cause; the caller defers the call to the shell.
pub fn prepare<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    let request = Request {
        engine: invocation.engine,
        engines: quality_gate::ENGINES,
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
    let rendered = Rendered::from_script(source)?;
    let text = |name: &str| -> Result<Option<String>, String> {
        env_text(snapshot.env, name)
            .map(|value| {
                value
                    .to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| format!("{name} is not UTF-8"))
            })
            .transpose()
    };
    let pwd = shell_pwd(text("PWD")?, snapshot.cwd)?;
    let script = invocation
        .requested
        .to_str()
        .ok_or("hook path is not UTF-8")?
        .to_owned();
    let hook_path = if script.starts_with('/') {
        script.clone()
    } else {
        format!("{pwd}/{script}")
    };
    let context = Context {
        engine: prepared.engine(),
        profile: prepared.profile(),
        capture: prepared.capture(),
        rendered,
        host: Host {
            pwd: pwd.clone(),
            home: text("HOME")?,
            claude_project_dir: text("CLAUDE_PROJECT_DIR")?,
            cdpath: None,
            hook_path,
            path: text("PATH")?,
            ..Host::default()
        },
        script: script.clone(),
    };
    let env = snapshot.env;
    Ok(Box::new(
        move |payload: &[u8], recorder: &dyn Recorder| -> Result<Evaluation, Failure> {
            let gate = SystemGate {
                env,
                cache: cache.as_ref(),
            };
            match quality_gate::evaluate(payload, &context, &System, &gate)? {
                Step::Done(evaluation) => Ok(evaluation),
                _ if recorder.shadow() => Err(runner::unobserved()),
                Step::Gate(pending, run) => {
                    recorder.record(&started());
                    let finished = run_gate(env, &script, &run)?;
                    Ok(after_gate(
                        pending,
                        &run,
                        finished.status,
                        &finished.stdout,
                        &finished.stderr,
                    ))
                }
                Step::Foreign(pending, root) => {
                    recorder.record(&started());
                    let finished = run_foreign(env, &pwd, &root)?;
                    Ok(after_foreign(
                        pending,
                        &root,
                        finished.status,
                        &finished.stdout,
                    ))
                }
            }
        },
    ))
}
