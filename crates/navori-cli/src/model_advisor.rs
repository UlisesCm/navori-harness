//! Registry adapter and host of model-advisor (spec 0059 T16, D31, D40).
//!
//! The script has no payload-extraction partial: its fields are read by `node`. The shared
//! planner still supplies the one fact the port needs, the Bash dialect of the NUL warning, so it
//! is handed the two contract lines it looks for. `node` must be on `PATH`, or the call defers.
//! Scratchpad writes are skipped in shadow: nothing after them reads them.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use navori_hooks::hooks::model_advisor::{self as hook, Context, Host};
use navori_hooks::runner::{Engine, Evaluation, Failure};
use navori_hooks::shell::capture::CaptureContext;
use navori_hooks::shell::prepare::{self, Limits, Request};

use crate::facts_cache::FactsCache;
use crate::hook::{Evaluator, Invocation, Recorder, Snapshot};
use crate::hook_facts::{collect_cached, shell_pwd};
use crate::journal;
use crate::quality_gate::on_path;

const ENGINES: &[Engine] = &[Engine::Claude, Engine::Codex];
const BLOCK_END: &str = "# navori:managed end id=\"model-advisor-base\"";
const INPUT: &str = "payload=$(cat 2>/dev/null) || payload=\"\"";
/// The extract-cmd lines the planner locates; this script does not carry them.
const CONTRACT: &[u8] = b"payload=${payload-\"$(cat)\"}\n    printf -v \"${_pf_spec%%=*}\" '%s' \"$(payload_field \"${_pf_spec#*=}\")\"\n";
const SENTINELS: [&str; 2] = [
    "navori-model-advisor.skip",
    "navori-model-advisor.effort-gated",
];

struct SystemHost<'a> {
    cwd: &'a Path,
    shadow: bool,
}

impl SystemHost<'_> {
    fn path(&self, path: &str) -> PathBuf {
        self.cwd.join(path)
    }
}

fn thrown(error: &io::Error) -> Failure {
    Failure(format!("node would throw: {error}"))
}

impl Host for SystemHost<'_> {
    fn is_file(&self, path: &str) -> bool {
        fs::metadata(self.path(path)).is_ok_and(|meta| meta.is_file())
    }

    fn read(&self, path: &str) -> Option<Vec<u8>> {
        fs::read(self.path(path)).ok()
    }

    fn write_state(&self, dir: &str, path: &str, content: &str) -> Result<(), Failure> {
        if self.shadow {
            return Ok(());
        }
        fs::create_dir_all(self.path(dir)).map_err(|e| thrown(&e))?;
        fs::write(self.path(path), content).map_err(|e| thrown(&e))
    }

    fn sentinel(&self, dir: &str, name: Option<&str>) -> Result<(), Failure> {
        if self.shadow {
            return Ok(());
        }
        for other in SENTINELS {
            if Some(other) == name {
                continue;
            }
            match fs::remove_file(self.path(&format!("{dir}/{other}"))) {
                Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(thrown(&e)),
                _ => {}
            }
        }
        if let Some(name) = name {
            fs::write(self.path(&format!("{dir}/{name}")), "").map_err(|e| thrown(&e))?;
        }
        Ok(())
    }
}

/// Registry adapter for model-advisor.
///
/// # Errors
/// The ineligibility cause; the caller defers the call to the shell.
pub fn prepare<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    let phase = hook::phase(&invocation.args).ok_or("hook mode is not ported")?;
    if !invocation
        .event
        .as_deref()
        .is_none_or(|event| event == phase)
    {
        return Err("unsupported hook event".to_owned());
    }
    let mode = invocation.args[0]
        .to_str()
        .ok_or("mode is not UTF-8")?
        .to_owned();
    let source = std::str::from_utf8(snapshot.source).map_err(|_| "script is not UTF-8")?;
    if let Some(end) = source.find(BLOCK_END)
        && source[end + BLOCK_END.len()..].lines().any(|line| {
            let line = line.trim_start_matches([' ', '\t']);
            !line.is_empty() && !line.starts_with('#')
        })
    {
        return Err("the user section holds commands".to_owned());
    }
    let mut inputs = source.split('\n').enumerate().filter(|(_, l)| *l == INPUT);
    let input_line = inputs.next().ok_or("the payload capture is missing")?.0 + 1;
    if inputs.next().is_some() {
        return Err("the payload capture is ambiguous".to_owned());
    }
    let request = Request {
        engine: invocation.engine,
        engines: ENGINES,
        event: None,
        args: &[],
        script: &invocation.requested,
        source: CONTRACT,
        env: snapshot.env,
    };
    let cache = journal::project_root(invocation.engine, &invocation.engine_root)
        .map(FactsCache::in_project);
    let prepared = collect_cached(request, snapshot.cwd, Limits::default(), cache.as_ref())
        .map_err(|e| e.to_string())?;
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
    if !on_path(snapshot.env, "node", &pwd) {
        return Err("node is not on PATH".to_owned());
    }
    let context = Context {
        capture: CaptureContext {
            input_line,
            ..prepared.capture()
        },
        mode,
        effort: text("CLAUDE_EFFORT")?.filter(|e| !e.is_empty()),
    };
    let cwd = snapshot.cwd;
    Ok(Box::new(
        move |payload: &[u8], recorder: &dyn Recorder| -> Result<Evaluation, Failure> {
            let host = SystemHost {
                cwd,
                shadow: recorder.shadow(),
            };
            hook::evaluate(payload, &context, &host)
        },
    ))
}
