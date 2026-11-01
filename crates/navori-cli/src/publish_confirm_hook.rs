//! Registry adapters and host of comment-draft-confirm and pr-publisher-confirm (spec 0060 T14,
//! R70, R72).
//!
//! Before stdin: the accredited extraction profile (which also says whether jq and node are on
//! `PATH`) and the programs the script carries. After stdin the rules run against
//! [`SystemHost`]: the draft file, the `jq`/`node` extraction the script runs on it, and, for the
//! Codex copy of pr-publisher-confirm, the `node` program that runs `navori codex approval
//! request`. That request records an approval, so a shadow call answers "unobserved" there.

use std::ffi::{OsStr, OsString};
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

use navori_hooks::hooks::{comment_draft_confirm, pr_publisher_confirm};
use navori_hooks::runner::{self, Evaluation, Failure};
use navori_hooks::shell::draft_body::DraftHost;
use navori_hooks::shell::prepare::{self, Limits, Request};
use navori_hooks::shell::subcommand::{self, Call, Capture, Input};

use crate::facts_cache::FactsCache;
use crate::hook::{Evaluator, Invocation, Recorder, Snapshot};
use crate::hook_facts::{collect_cached, shell_pwd};
use crate::journal;
use crate::quality_gate::{on_path, resolve};

/// `head -c 200000`.
const HEAD_BYTES: u64 = 200_000;

/// The real host of one invocation.
struct SystemHost<'a> {
    env: &'a [(OsString, OsString)],
    cwd: &'a Path,
    pwd: &'a str,
    shadow: bool,
}

impl SystemHost<'_> {
    /// `name args` from the hook's directory with `input` on stdin: `$?` and stdout, `None` when
    /// `PATH` holds no executable `name`.
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

impl DraftHost for SystemHost<'_> {
    fn read_head(&self, path: &str) -> Option<Vec<u8>> {
        let target = self.cwd.join(path);
        if !fs::metadata(&target).is_ok_and(|meta| meta.is_file()) {
            return None;
        }
        let mut bytes = Vec::new();
        File::open(&target)
            .ok()?
            .take(HEAD_BYTES)
            .read_to_end(&mut bytes)
            .ok()?;
        Some(bytes)
    }

    fn output(&self, program: &str, args: &[&str]) -> Result<Vec<u8>, Failure> {
        Ok(self
            .run(program, args, &[])?
            .map(|(_, stdout)| stdout)
            .unwrap_or_default())
    }
}

impl pr_publisher_confirm::Host for SystemHost<'_> {
    fn on_path(&self, name: &str) -> bool {
        on_path(self.env, name, self.pwd)
    }

    fn request_approval(&self, program: &str, payload: &[u8]) -> Result<Option<Vec<u8>>, Failure> {
        if self.shadow {
            return Err(runner::unobserved());
        }
        Ok(match self.run("node", &["-e", program], payload)? {
            Some((0, stdout)) => Some(stdout),
            _ => None,
        })
    }
}

/// The shared preparation: the accredited profile, the script text and `$PWD`.
fn prepared<'a>(
    invocation: &'a Invocation,
    snapshot: &Snapshot<'a>,
    engines: &'a [navori_hooks::runner::Engine],
) -> Result<(navori_hooks::shell::prepare::Prepared<'a>, &'a str, String), String> {
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
    let inherited = prepare::env_value(snapshot.env, "PWD")
        .map(|value| {
            value
                .to_str()
                .map(str::to_owned)
                .ok_or_else(|| "PWD is not UTF-8".to_owned())
        })
        .transpose()?;
    let pwd = shell_pwd(inherited, snapshot.cwd)?;
    Ok((prepared, source, pwd))
}

/// Registry adapter for comment-draft-confirm.
///
/// # Errors
/// The ineligibility cause; the caller defers the call to the shell.
pub fn prepare_comment_draft<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    let (prepared, source, pwd) = prepared(invocation, &snapshot, comment_draft_confirm::ENGINES)?;
    let context = comment_draft_confirm::Context {
        engine: invocation.engine,
        profile: prepared.profile(),
        capture: prepared.capture(),
        rendered: comment_draft_confirm::Rendered::from_script(source)?,
    };
    let (env, cwd) = (snapshot.env, snapshot.cwd);
    Ok(Box::new(
        move |payload: &[u8], recorder: &dyn Recorder| -> Result<Evaluation, Failure> {
            let host = SystemHost {
                env,
                cwd,
                pwd: &pwd,
                shadow: recorder.shadow(),
            };
            comment_draft_confirm::evaluate(payload, &context, &host)
        },
    ))
}

/// Registry adapter for pr-publisher-confirm.
///
/// # Errors
/// The ineligibility cause; the caller defers the call to the shell.
pub fn prepare_pr_publisher<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    let (prepared, source, pwd) = prepared(invocation, &snapshot, pr_publisher_confirm::ENGINES)?;
    let context = pr_publisher_confirm::Context {
        engine: invocation.engine,
        profile: prepared.profile(),
        capture: prepared.capture(),
        rendered: pr_publisher_confirm::Rendered::from_script(source)?,
    };
    let (env, cwd) = (snapshot.env, snapshot.cwd);
    Ok(Box::new(
        move |payload: &[u8], recorder: &dyn Recorder| -> Result<Evaluation, Failure> {
            let host = SystemHost {
                env,
                cwd,
                pwd: &pwd,
                shadow: recorder.shadow(),
            };
            pr_publisher_confirm::evaluate(payload, &context, &host)
        },
    ))
}
