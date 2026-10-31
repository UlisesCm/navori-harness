//! Registry adapter and host of master-plan-context (spec 0060 T9, R70, R72).
//!
//! Before stdin: the engine, the rendered values and the environment the script reads; the hook
//! extracts no payload field and no answer depends on the locale, so nothing is probed. After stdin the decision runs against [`SystemHost`]: `git rev-parse` for the
//! Codex root, the first line of `INDEX.md`, and `navori master status --line`, which is
//! read-only: in process when the `navori` of `PATH` is this build's TS version (R53 of 0059)
//! and the native `master status` reproduces the call, else through that `navori`. Nothing it
//! runs writes, so shadow evaluates the whole hook.

use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use navori_hooks::hooks::master_plan_context::{self as hook, Context, Host, Rendered};
use navori_hooks::runner::{Evaluation, Failure};
use navori_hooks::shell::prepare;
use navori_hooks::shell::subcommand::{self, Call, Capture, Input};

use crate::facts_cache::FactsCache;
use crate::hook::{Evaluator, Invocation, Recorder, Snapshot};
use crate::hook_facts::{navori_cli, shell_pwd};
use crate::journal;
use crate::quality_gate::{on_path, resolve};

/// The longest first line of `INDEX.md` the port reads; a longer one defers.
const FIRST_LINE_MAX: u64 = 1 << 20;

/// The real host of one invocation.
struct SystemHost<'a> {
    env: &'a [(OsString, OsString)],
    cwd: &'a Path,
    pwd: &'a str,
    cache: Option<&'a FactsCache>,
}

impl SystemHost<'_> {
    fn spawn(
        &self,
        program: &Path,
        args: &[&str],
        cwd: &Path,
        pwd: &OsStr,
        oldpwd: Option<&OsStr>,
    ) -> Result<subcommand::Finished, Failure> {
        let env = subcommand::child_env(self.env, pwd, oldpwd, program, &[]);
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        subcommand::run(&Call {
            program,
            args: &args,
            cwd,
            env: &env,
            input: Input::Bytes(&[]),
            capture: Capture::Separate,
            timeout: None,
        })
        .map_err(|error| Failure(format!("{} could not run: {error}", program.display())))
    }
}

/// `cd dir` succeeds: an absolute directory every class may search. Anything else Bash may
/// report on stderr, so it defers.
fn enterable(dir: &str) -> Result<PathBuf, Failure> {
    let path = Path::new(dir);
    let meta = fs::metadata(path).map_err(|_| Failure("cd would fail".to_owned()))?;
    if !path.is_absolute() || !meta.is_dir() || meta.permissions().mode() & 0o111 != 0o111 {
        return Err(Failure("cd may fail or set an unmodeled PWD".to_owned()));
    }
    Ok(path.to_path_buf())
}

impl Host for SystemHost<'_> {
    fn toplevel(&self) -> Result<Option<Vec<u8>>, Failure> {
        let Some(git) = resolve(self.env, "git", self.pwd) else {
            return Ok(None);
        };
        let done = self.spawn(
            &git,
            &["rev-parse", "--show-toplevel"],
            self.cwd,
            OsStr::new(self.pwd),
            None,
        )?;
        Ok((done.status == 0).then_some(done.stdout))
    }

    fn on_path(&self, name: &str) -> bool {
        on_path(self.env, name, self.pwd)
    }

    fn status_line(&self, project_dir: &str) -> Result<(i32, Vec<u8>), Failure> {
        let dir = enterable(project_dir)?;
        // Found but not executable: Bash fails the exec with 126, its message in /dev/null.
        let Some(program) = resolve(self.env, "navori", project_dir) else {
            return Ok((126, Vec::new()));
        };
        let same = navori_cli(self.env, &dir, self.cache)
            .ok()
            .filter(|cli| cli.path.as_deref() == Some(program.as_path()))
            .is_some_and(|cli| cli.in_process());
        if same {
            // `process.cwd()` of the TS is the physical directory.
            let physical = fs::canonicalize(&dir).map_err(|e| Failure(e.to_string()))?;
            if let Some((code, stdout)) = crate::master::status_line(&physical) {
                return Ok((i32::from(code), stdout.into_bytes()));
            }
        }
        let done = self.spawn(
            &program,
            &["master", "status", "--line"],
            &dir,
            OsStr::new(project_dir),
            Some(OsStr::new(self.pwd)),
        )?;
        Ok((done.status, done.stdout))
    }

    fn first_line(&self, path: &str) -> Result<Option<Vec<u8>>, Failure> {
        let Ok(meta) = fs::metadata(path) else {
            return Ok(None);
        };
        if meta.is_dir() {
            return Err(Failure("INDEX.md is a directory".to_owned()));
        }
        let Ok(file) = File::open(path) else {
            return Ok(None);
        };
        let mut line = Vec::new();
        BufReader::new(file.take(FIRST_LINE_MAX))
            .read_until(b'\n', &mut line)
            .map_err(|e| Failure(format!("INDEX.md: {e}")))?;
        if line.last() == Some(&b'\n') {
            line.pop();
        } else if line.len() as u64 == FIRST_LINE_MAX {
            return Err(Failure("INDEX.md's first line is too long".to_owned()));
        }
        Ok(Some(line))
    }
}

/// Registry adapter for master-plan-context.
///
/// # Errors
/// The ineligibility cause; the caller defers the call to the shell.
pub fn prepare<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    // The shared planner accredits PreToolUse entries; this hook's own event is checked here.
    if !matches!(invocation.event.as_deref(), None | Some("SessionStart"))
        || !hook::ENGINES.contains(&invocation.engine)
        || !invocation.args.is_empty()
    {
        return Err("unsupported engine, event or hook arguments".to_owned());
    }
    prepare::environment(snapshot.env).map_err(|e| e.to_string())?;
    let cache = journal::project_root(invocation.engine, &invocation.engine_root)
        .map(FactsCache::in_project);
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
        rendered,
        pwd: pwd.clone(),
        project_dir: text("CLAUDE_PROJECT_DIR")?.filter(|dir| !dir.is_empty()),
    };
    let (env, cwd) = (snapshot.env, snapshot.cwd);
    Ok(Box::new(
        move |payload: &[u8], _: &dyn Recorder| -> Result<Evaluation, Failure> {
            let host = SystemHost {
                env,
                cwd,
                pwd: &pwd,
                cache: cache.as_ref(),
            };
            hook::evaluate(payload, &context, &host)
        },
    ))
}
