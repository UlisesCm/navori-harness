//! Bounded collection for the pure, implementation-hashed eligibility planner.
//! This module never reads process stdin, chooses a semantic profile, mutates env or activates hooks.
//! Unix sockets avoid pipe-reader threads that can hang when descendants retain output handles.

use std::ffi::OsString;
use std::fs;
use std::io::{self, Read};
use std::os::fd::OwnedFd;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use navori_hooks::hooks::subagent_no_background;
use navori_hooks::hooks::subagent_no_background::prepare::{
    self, Facts, Ineligible, Limits, Output, Prepared, Request, Tool,
};

use navori_hooks::hooks::guard_destructive::Rendered;
use navori_hooks::hooks::guard_destructive::entry::{self, Context};
use navori_hooks::shell::hook_input::Host;
use navori_hooks::shell::repo::System;

use crate::facts_cache::{self, FactsCache};
use crate::hook::{Evaluator, Invocation, Snapshot};
use crate::journal;

/// Registry adapter: collect host facts before stdin and keep the evaluation pure.
/// The script path is the one the shadow shell lane runs, so diagnostics compare equal bytes.
///
/// # Errors
/// Returns the ineligibility cause; the caller defers the call to the shell.
pub fn prepare_subagent_no_background<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    let request = Request {
        engine: invocation.engine,
        engines: subagent_no_background::ENGINES,
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
    Ok(Box::new(move |payload: &[u8]| {
        subagent_no_background::evaluate_prepared(&prepared, payload)
    }))
}

/// Registry adapter for guard-destructive: the same accredited extraction profile, plus the
/// rendered values and the environment facts the script reads before its rules run. Repository
/// facts are read after stdin, as the script reads them, through [`System`].
///
/// # Errors
/// Returns the ineligibility cause; the caller defers the call to the shell.
pub fn prepare_guard_destructive<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    let request = Request {
        engine: invocation.engine,
        engines: entry::ENGINES,
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
    let rendered = Rendered::from_script(source).ok_or("rendered values are not plain words")?;
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
    let requested = invocation
        .requested
        .to_str()
        .ok_or("hook path is not UTF-8")?;
    let hook_path = if requested.starts_with('/') {
        requested.to_owned()
    } else {
        format!("{pwd}/{requested}")
    };
    let context = Context {
        engine: prepared.engine(),
        profile: prepared.profile(),
        capture: prepared.capture(),
        rendered,
        host: Host {
            pwd,
            home: text("HOME")?,
            claude_project_dir: text("CLAUDE_PROJECT_DIR")?,
            // The planner rejects a CDPATH environment.
            cdpath: None,
            hook_path,
            path: text("PATH")?,
            ..Host::default()
        },
    };
    Ok(Box::new(move |payload: &[u8]| {
        entry::evaluate(payload, &context, &System)
    }))
}

/// Wall time allowed for `navori --version` (a cold TS CLI start is ~120 ms).
const NAVORI_CLI_PROBE: Duration = Duration::from_secs(5);

/// Host fact `navori_cli` (spec 0059 D30, R53): the `navori` that `PATH` resolves and the
/// version it prints. A ported subcommand runs in process only when that version is the TS CLI
/// this binary was built from; otherwise the hook runs that `navori`, as the shell does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NavoriCli {
    /// `command -v navori` (a relative `PATH` entry joined to the hook's working directory),
    /// not canonicalized: the path the shell runs and exports as `_`. `None` when `PATH`
    /// resolves no `navori`.
    pub path: Option<PathBuf>,
    /// First line of `navori --version` on a zero exit, trimmed; `None` when it printed none.
    pub version: Option<String>,
}

impl NavoriCli {
    /// Whether a ported subcommand may run in process instead of through this `navori`.
    #[must_use]
    pub fn in_process(&self) -> bool {
        self.version.as_deref() == Some(navori_core::STAMP_VERSION)
    }
}

/// Collect [`NavoriCli`] before stdin. The probe runs once per binary: its answer is cached
/// by the canonical path with the binary's stamp (device, inode, size and both timestamps),
/// so replacing or touching the binary probes again. Without an absolute `PATH` nothing is
/// cached.
///
/// # Errors
/// A probe that cannot be spawned, outlives its deadline or overflows its output bound: the
/// caller defers the call to the shell.
pub fn navori_cli(
    env: &[(OsString, OsString)],
    cwd: &Path,
    cache: Option<&FactsCache>,
) -> Result<NavoriCli, Ineligible> {
    let Some(path) = prepare::env_value(env, "PATH") else {
        return Ok(NavoriCli {
            path: None,
            version: None,
        });
    };
    // `command -v navori`: relative entries resolve from the hook's working directory.
    let found = std::env::split_paths(path).find_map(|directory| {
        let directory = if directory.is_absolute() {
            directory
        } else {
            cwd.join(directory)
        };
        facts_cache::lookup(directory.as_os_str(), "navori")
    });
    let Some(found) = found else {
        return Ok(NavoriCli {
            path: None,
            version: None,
        });
    };
    // The cache is keyed by the binary behind any symlink; the probe runs the resolved path.
    let binary = found.canonicalize().map_err(io_failure)?;
    let absolute = std::env::split_paths(path).all(|entry| entry.is_absolute());
    let cache = cache
        .filter(|_| absolute)
        .and_then(|cache| Some((cache, facts_cache::stamp(&binary)?, facts_cache::now_ms()?)));
    if let Some((cache, stamp, now)) = &cache
        && let Some(version) = cache.load_cli(&binary, stamp, *now)
    {
        return Ok(NavoriCli {
            path: Some(found),
            version,
        });
    }
    let output = probe(
        &found,
        &["--version".into()],
        cwd,
        env,
        Instant::now() + NAVORI_CLI_PROBE,
    )?;
    let version = (output.code == Some(0))
        .then(|| String::from_utf8(output.stdout).ok())
        .flatten()
        .and_then(|text| text.lines().next().map(|line| line.trim().to_owned()))
        .filter(|line| !line.is_empty());
    if let Some((cache, stamp, now)) = &cache {
        cache.store_cli(&binary, stamp, version.as_deref(), *now);
    }
    Ok(NavoriCli {
        path: Some(found),
        version,
    })
}

/// Bash's `$PWD` at startup: an inherited absolute `PWD` naming the working directory, else
/// the physical directory. A `PWD` bash would canonicalize first (`.`, `..` or `//`
/// components) is not modeled and defers.
fn shell_pwd(inherited: Option<String>, cwd: &Path) -> Result<String, String> {
    use std::os::unix::fs::MetadataExt;
    let physical = || {
        cwd.to_str()
            .map(str::to_owned)
            .ok_or_else(|| "working directory is not UTF-8".to_owned())
    };
    let Some(pwd) = inherited.filter(|pwd| pwd.starts_with('/')) else {
        return physical();
    };
    let same = match (fs::metadata(&pwd), fs::metadata(cwd)) {
        (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
        _ => false,
    };
    if !same {
        return physical();
    }
    if pwd.len() > 1
        && (pwd.contains("//")
            || pwd.ends_with('/')
            || pwd.split('/').any(|part| part == "." || part == ".."))
    {
        return Err("PWD is not in canonical form".to_owned());
    }
    Ok(pwd)
}

/// Collect real facts under the exact snapshot and return eligibility before any stdin read.
/// Timeouts/output errors are explicit ineligibility, never evidence that jq/Node is absent.
pub fn collect<'a>(
    request: Request<'a>,
    cwd: &Path,
    limits: Limits,
) -> Result<Prepared<'a>, Ineligible> {
    collect_cached(request, cwd, limits, None)
}

/// [`collect`] that first replays cached facts of an unchanged host (R17) and caches the facts
/// of a freshly probed eligible host. Replayed facts still pass through the planner.
pub fn collect_cached<'a>(
    request: Request<'a>,
    cwd: &Path,
    limits: Limits,
    cache: Option<&FactsCache>,
) -> Result<Prepared<'a>, Ineligible> {
    let started = Instant::now();
    let plan = prepare::plan(request, limits)?;
    let deadline = started + plan.limits().total;
    let env = plan.environment();
    let path = prepare::env_value(env, "PATH").ok_or_else(|| Ineligible("missing PATH".into()))?;
    let mut bash = None;
    for directory in std::env::split_paths(path) {
        if Instant::now() >= deadline {
            return Err(Ineligible("probe deadline expired resolving Bash".into()));
        }
        let directory = if directory.is_absolute() {
            directory
        } else {
            cwd.join(directory)
        };
        let candidate = directory.join("bash");
        if fs::metadata(&candidate)
            .is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
        {
            bash = Some(candidate.canonicalize().map_err(io_failure)?);
            break;
        }
    }
    let bash = bash.ok_or_else(|| Ineligible("legacy Bash is absent".into()))?;
    let cache = cache
        .and_then(|cache| Some((cache, facts_cache::key(&bash, env)?, facts_cache::now_ms()?)));
    if let Some((cache, key, now)) = &cache
        && let Some(cached) = cache.load(key, *now)
        && let Ok(discovery) = plan.discover(&cached.facts.bootstrap)
        && facts_cache::tools_unchanged(&discovery, path, &cached.tools)
        && let Ok(prepared) = plan.prepare(&cached.facts)
    {
        return Ok(prepared);
    }
    let bootstrap = probe(
        &bash,
        &["-c".into(), prepare::DISCOVERY.into()],
        cwd,
        env,
        deadline,
    )?;
    let discovery = plan.discover(&bootstrap)?;
    let resolved = |tool: Tool| -> Result<Option<PathBuf>, Ineligible> {
        discovery
            .tools
            .get(&tool)
            .and_then(Option::as_ref)
            .map(|path| {
                let path = if path.is_absolute() {
                    path.clone()
                } else {
                    cwd.join(path)
                };
                path.canonicalize().map_err(io_failure)
            })
            .transpose()
    };
    let required = |tool: Tool| -> Result<PathBuf, Ineligible> {
        resolved(tool)?.ok_or_else(|| Ineligible("required tool missing".into()))
    };
    let jq = resolved(Tool::Jq)?
        .map(|path| probe(&path, &["--version".into()], cwd, env, deadline))
        .transpose()?;
    let node = resolved(Tool::Node)?
        .map(|path| probe(&path, &["--version".into()], cwd, env, deadline))
        .transpose()?;
    let system = probe(&required(Tool::Uname)?, &["-s".into()], cwd, env, deadline)?;
    let charmap = probe(
        &required(Tool::Locale)?,
        &["charmap".into()],
        cwd,
        env,
        deadline,
    )?;
    let text = probe(
        &bash,
        &[
            "-c".into(),
            prepare::TEXT.into(),
            "text-probe".into(),
            prepare::text_input().into(),
            required(Tool::Grep)?.into_os_string(),
            required(Tool::Sed)?.into_os_string(),
            required(Tool::Tr)?.into_os_string(),
            required(Tool::Cat)?.into_os_string(),
        ],
        cwd,
        env,
        deadline,
    )?;
    let facts = Facts {
        bootstrap,
        system,
        charmap,
        text,
        jq,
        node,
    };
    let prepared = plan.prepare(&facts)?;
    // Only an eligible host is cached: a failure is never replayed.
    if let Some((cache, key, now)) = &cache
        && let Some(tools) = facts_cache::tool_stamps(&discovery)
    {
        cache.store(key, &facts, &tools, *now);
    }
    Ok(prepared)
}

/// Execute a single probe with null stdin, bounded combined output and an absolute deadline.
/// Killing/reaping covers the direct child only; no promise is made to kill descendants.
fn probe(
    program: &Path,
    args: &[OsString],
    cwd: &Path,
    env: &[(OsString, OsString)],
    deadline: Instant,
) -> Result<Output, Ineligible> {
    if Instant::now() >= deadline {
        return Err(Ineligible("probe deadline expired".into()));
    }
    let (mut stdout, out_child) = UnixStream::pair().map_err(io_failure)?;
    let (mut stderr, err_child) = UnixStream::pair().map_err(io_failure)?;
    stdout.set_nonblocking(true).map_err(io_failure)?;
    stderr.set_nonblocking(true).map_err(io_failure)?;
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env_clear()
        .envs(env.iter().map(|(key, value)| (key, value)))
        .stdin(Stdio::null())
        .stdout(Stdio::from(OwnedFd::from(out_child)))
        .stderr(Stdio::from(OwnedFd::from(err_child)))
        .spawn()
        .map_err(io_failure)?;
    let mut output = Output::default();
    let mut out_done = false;
    let mut err_done = false;
    let mut status = None;
    let result = (|| {
        loop {
            if Instant::now() >= deadline {
                return Err(Ineligible("probe deadline expired".into()));
            }
            if !out_done {
                out_done = drain(&mut stdout, &mut output.stdout, output.stderr.len())?;
            }
            if !err_done {
                err_done = drain(&mut stderr, &mut output.stderr, output.stdout.len())?;
            }
            if status.is_none() {
                status = child.try_wait().map_err(io_failure)?;
            }
            if out_done
                && err_done
                && let Some(status) = status
            {
                output.code = status.code();
                return Ok(output);
            }
            thread::sleep(Duration::from_millis(1));
        }
    })();
    if result.is_err() {
        stop(&mut child);
    }
    result
}

fn drain(stream: &mut UnixStream, output: &mut Vec<u8>, other: usize) -> Result<bool, Ineligible> {
    let mut buffer = [0; 4096];
    loop {
        let available = (prepare::MAX_OUTPUT + 1)
            .saturating_sub(output.len() + other)
            .min(buffer.len());
        if available == 0 {
            return Err(Ineligible("probe output limit exceeded".into()));
        }
        match stream.read(&mut buffer[..available]) {
            Ok(0) => return Ok(true),
            Ok(count) => {
                output.extend_from_slice(&buffer[..count]);
                if output.len() + other > prepare::MAX_OUTPUT {
                    return Err(Ineligible("probe output limit exceeded".into()));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => return Ok(false),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(io_failure(error)),
        }
    }
}
fn stop(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}
fn io_failure(error: io::Error) -> Ineligible {
    Ineligible(format!("fact collection failed: {error}"))
}
