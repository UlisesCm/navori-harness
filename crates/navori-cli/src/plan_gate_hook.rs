//! Registry adapter of plan-gate (spec 0059 T12, D30, D40).
//!
//! Before stdin: the accredited extraction profile and the rendered values. After stdin the pure
//! decision runs up to `navori plan gate`; a shadow lane answers "unobserved" there (the call
//! claims Codex's dispatch marker and appends to the rejection log), and any other lane runs it
//! through [`plan_gate::call`]: in process when the `navori` of `PATH` is this build's TS
//! version, else that `navori`.

use std::fs;
use std::path::Path;

use navori_hooks::hooks::plan_gate::call::{self, Navori};
use navori_hooks::hooks::plan_gate::{self, Context, Rendered, Step, after_call, stale_hint};
use navori_hooks::runner::{self, Evaluation, Failure};
use navori_hooks::shell::capture::CaptureContext;
use navori_hooks::shell::prepare::{self, Limits, Request};

use crate::facts_cache::FactsCache;
use crate::hook::{Evaluator, Invocation, Recorder, Snapshot};
use crate::hook_facts::{collect_cached, navori_cli, shell_pwd};
use crate::journal;
use crate::quality_gate::{on_path, resolve};

/// Registry adapter for plan-gate.
///
/// # Errors
/// The ineligibility cause; the caller defers the call to the shell.
pub fn prepare<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    let request = Request {
        engine: invocation.engine,
        engines: plan_gate::ENGINES,
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
    // `${CLAUDE_PROJECT_DIR:-$PWD}/navori.config.json`, read only on a denial.
    let config = format!(
        "{}/navori.config.json",
        text("CLAUDE_PROJECT_DIR")?
            .filter(|dir| !dir.is_empty())
            .unwrap_or_else(|| pwd.clone())
    );
    let script = invocation
        .requested
        .to_str()
        .ok_or("hook path is not UTF-8")?
        .to_owned();
    let context = Context {
        profile: prepared.profile(),
        capture: CaptureContext {
            input_line: rendered.input_line,
            ..prepared.capture()
        },
        rendered,
        script,
    };
    let (env, cwd) = (snapshot.env, snapshot.cwd);
    Ok(Box::new(
        move |payload: &[u8], recorder: &dyn Recorder| -> Result<Evaluation, Failure> {
            let step = plan_gate::evaluate(payload, &context, || on_path(env, "navori", &pwd))?;
            let (pending, request) = match step {
                Step::Done(evaluation) => return Ok(evaluation),
                Step::Call(..) if recorder.shadow() => return Err(runner::unobserved()),
                Step::Call(pending, request) => (pending, request),
            };
            let program = resolve(env, "navori", &pwd)
                .ok_or_else(|| Failure("navori is not executable on PATH".to_owned()))?;
            // A probe that fails only costs the in-process lane: the subprocess is the shell's.
            let version = navori_cli(env, cwd, cache.as_ref())
                .ok()
                .filter(|cli| cli.path.as_deref() == Some(program.as_path()))
                .and_then(|cli| cli.version);
            let navori = Navori {
                program: &program,
                version: version.as_deref(),
                env,
                cwd,
                pwd: pwd.as_ref(),
            };
            let answer = call::run(&navori, &request)?;
            after_call(pending, answer.status, &answer.output, || {
                let Ok(bytes) = read_config(&config) else {
                    return Ok(None);
                };
                stale_hint(
                    Some(&bytes),
                    || call::cli_version(&navori, answer.lane),
                    context.profile.locale,
                )
            })
        },
    ))
}

/// `[ -r "$pg_cfg" ]` and its bytes.
fn read_config(path: &str) -> std::io::Result<Vec<u8>> {
    fs::read(Path::new(path))
}
