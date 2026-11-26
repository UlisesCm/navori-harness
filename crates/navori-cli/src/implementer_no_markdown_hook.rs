//! Registry adapter and host of implementer-no-markdown (spec 0060 T12, R70).
//!
//! Before stdin: the accredited extraction profile, the analyzer programs the script carries
//! and the environment it reads. After stdin the rules run against [`SystemHost`]: `git` and
//! the file system for the registered-worktree rule, and the script's own analyzer programs
//! through the `node` and `python3` of `PATH`, exactly as the script pipes the command into
//! them. Every fact is read-only, so shadow evaluates the whole hook.

use std::ffi::{OsStr, OsString};
use std::fs;
use std::path::Path;

use navori_hooks::hooks::implementer_no_markdown::{
    self as hook, Analyzer, Context, Host, Rendered,
};
use navori_hooks::runner::{Evaluation, Failure};
use navori_hooks::shell::prepare::{self, Limits, Request};
use navori_hooks::shell::subcommand::{self, Call, Capture, Input};

use crate::facts_cache::FactsCache;
use crate::hook::{Evaluator, Invocation, Recorder, Snapshot};
use crate::hook_facts::{collect_cached, shell_pwd};
use crate::journal;
use crate::quality_gate::{on_path, resolve};

/// The real host of one invocation.
struct SystemHost<'a> {
    env: &'a [(OsString, OsString)],
    cwd: &'a Path,
    pwd: &'a str,
}

impl SystemHost<'_> {
    /// `$(name args 2>/dev/null)` with `input` on stdin: `$?` and stdout, `None` when `PATH`
    /// holds no executable `name` (Bash's own error goes to `/dev/null` too).
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

    fn path(&self, path: &str) -> std::path::PathBuf {
        self.cwd.join(path)
    }
}

/// `$(…)` of a successful run: stdout without trailing newlines.
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

impl Host for SystemHost<'_> {
    fn on_path(&self, name: &str) -> bool {
        on_path(self.env, name, self.pwd)
    }

    fn git(&self, args: &[&str]) -> Result<Option<String>, Failure> {
        match self.run("git", args, &[])? {
            Some((0, stdout)) => substitution(stdout).map(Some),
            _ => Ok(None),
        }
    }

    fn is_symlink(&self, path: &str) -> bool {
        fs::symlink_metadata(self.path(path)).is_ok_and(|meta| meta.file_type().is_symlink())
    }

    fn is_dir(&self, path: &str) -> bool {
        fs::metadata(self.path(path)).is_ok_and(|meta| meta.is_dir())
    }

    fn analyze(
        &self,
        analyzer: Analyzer,
        program: &str,
        input: &[u8],
    ) -> Result<Option<String>, Failure> {
        let (name, args): (&str, Vec<&str>) = match analyzer {
            Analyzer::Json | Analyzer::NodeWrite => ("node", vec!["-e", program]),
            Analyzer::Python => ("python3", vec!["-I", "-S", "-c", program]),
        };
        match self.run(name, &args, input)? {
            // Only an exact `ALLOW` counts; any other output, NUL included, keeps the block.
            Some((0, stdout)) => Ok(Some(substitution(stdout).unwrap_or_default())),
            _ => Ok(None),
        }
    }
}

/// Registry adapter for implementer-no-markdown.
///
/// # Errors
/// The ineligibility cause; the caller defers the call to the shell.
pub fn prepare<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    let request = Request {
        engine: invocation.engine,
        engines: hook::ENGINES,
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
        prepare::env_value(snapshot.env, name)
            .map(|value| {
                value
                    .to_str()
                    .map(str::to_owned)
                    .ok_or_else(|| format!("{name} is not UTF-8"))
            })
            .transpose()
    };
    let pwd = shell_pwd(text("PWD")?, snapshot.cwd)?;
    let context = Context {
        engine: invocation.engine,
        profile: prepared.profile(),
        capture: prepared.capture(),
        rendered,
        claude_project_dir: text("CLAUDE_PROJECT_DIR")?.filter(|dir| !dir.is_empty()),
    };
    let (env, cwd) = (snapshot.env, snapshot.cwd);
    Ok(Box::new(
        move |payload: &[u8], _: &dyn Recorder| -> Result<Evaluation, Failure> {
            let host = SystemHost {
                env,
                cwd,
                pwd: &pwd,
            };
            hook::evaluate(payload, &context, &host)
        },
    ))
}
