//! Delegation to the TS CLI (D3): resolution, version notice, anti-loop token and `exec`.
//!
//! [`plan`] only probes the filesystem; the single place that replaces the process is [`exec`],
//! so a failed resolution (R6) launches nothing.

use std::ffi::{OsStr, OsString};
use std::fmt::Write as _;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};

/// Exit code when there is no TS CLI (or no `node` to run it) (R6).
pub const EXIT_NO_TS: u8 = 69;
/// Exit code when the delegation loops back into this very process (R7).
pub const EXIT_LOOP: u8 = 70;
/// Env var carrying the delegator's pid.
pub const DELEGATED_VAR: &str = "NAVORI_DELEGATED";
/// Env var that overrides the TS CLI location.
pub const TS_CLI_VAR: &str = "NAVORI_TS_CLI";

/// Where resolution looks, injectable so it can be tested without touching the process env.
#[derive(Debug, Clone)]
pub struct Locations {
    /// Value of `NAVORI_TS_CLI`.
    pub ts_cli: Option<OsString>,
    /// `<checkout>/packages/cli/dist/index.js`, fixed at compile time.
    pub checkout_dist: PathBuf,
    /// Value of `PATH`.
    pub path: Option<OsString>,
    /// Path of the running binary, to exclude it from the `PATH` search.
    pub self_exe: Option<PathBuf>,
}

impl Locations {
    /// Locations of the running process.
    #[must_use]
    pub fn from_process() -> Self {
        Self {
            ts_cli: std::env::var_os(TS_CLI_VAR).filter(|v| !v.is_empty()),
            checkout_dist: PathBuf::from(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../packages/cli/dist/index.js"
            )),
            path: std::env::var_os("PATH"),
            self_exe: std::env::current_exe().ok(),
        }
    }
}

/// How to learn the version of the chosen TS CLI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VersionSource {
    /// `version` field of this `package.json`.
    PackageJson(PathBuf),
    /// Output of `<binary> --version`.
    Probe(PathBuf),
    /// Unknown; no notice.
    Unknown,
}

/// A resolved delegation target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// Program to `exec` (`node` for a `.js` file).
    pub program: PathBuf,
    /// Arguments placed before the user's (the `.js` path).
    pub prefix: Vec<PathBuf>,
    /// The TS CLI that was chosen.
    pub target: PathBuf,
    /// How to read its version.
    pub version: VersionSource,
}

/// Resolution failed; `message` is what the user sees on stderr (exit 69).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoTs {
    /// Full stderr text.
    pub message: String,
}

fn is_executable_file(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

fn is_js(path: &Path) -> bool {
    path.extension() == Some(OsStr::new("js"))
}

/// `<dist>/../package.json` for a `dist/index.js`.
fn package_json_next_to(js: &Path) -> VersionSource {
    js.parent()
        .and_then(Path::parent)
        .map_or(VersionSource::Unknown, |dir| {
            VersionSource::PackageJson(dir.join("package.json"))
        })
}

/// First executable named `name` in `path`, skipping any whose canonical path is `exclude`.
fn find_in_path(
    name: &str,
    path: Option<&OsString>,
    exclude: Option<&Path>,
    skipped_self: &mut bool,
) -> Option<PathBuf> {
    let path = path?;
    for dir in std::env::split_paths(path) {
        let candidate = dir.join(name);
        if !is_executable_file(&candidate) {
            continue;
        }
        if let (Some(own), Ok(real)) = (exclude, candidate.canonicalize())
            && real == own
        {
            *skipped_self = true;
            continue;
        }
        return Some(candidate);
    }
    None
}

/// Resolves the TS CLI (D3): `NAVORI_TS_CLI`, the checkout's `dist/`, then `navori` in `PATH`
/// without this binary. Launches nothing.
///
/// # Errors
/// [`NoTs`] naming `subcommand`, every probed location and, for a `.js`, a missing `node`.
pub fn plan(locations: &Locations, subcommand: &str) -> Result<Plan, NoTs> {
    let mut tried = Vec::new();
    let mut chosen: Option<(PathBuf, VersionSource)> = None;

    match &locations.ts_cli {
        Some(value) => {
            let p = PathBuf::from(value);
            if p.is_file() {
                let version = if is_js(&p) {
                    package_json_next_to(&p)
                } else {
                    VersionSource::Unknown
                };
                chosen = Some((p, version));
            } else {
                tried.push(format!("{TS_CLI_VAR}={} (not found)", p.display()));
            }
        }
        None => tried.push(format!("{TS_CLI_VAR} (unset)")),
    }

    if chosen.is_none() {
        let dist = &locations.checkout_dist;
        if dist.is_file() {
            chosen = Some((dist.clone(), package_json_next_to(dist)));
        } else {
            tried.push(format!("{} (not found)", dist.display()));
        }
    }

    if chosen.is_none() {
        let own = locations
            .self_exe
            .as_deref()
            .and_then(|p| p.canonicalize().ok());
        let mut skipped_self = false;
        match find_in_path(
            "navori",
            locations.path.as_ref(),
            own.as_deref(),
            &mut skipped_self,
        ) {
            Some(found) => chosen = Some((found.clone(), VersionSource::Probe(found))),
            None if skipped_self => {
                tried.push("navori in PATH (only navori-rust itself, excluded)".to_owned());
            }
            None => tried.push("navori in PATH (not found)".to_owned()),
        }
    }

    let Some((target, version)) = chosen else {
        return Err(no_ts(subcommand, "no TS CLI found", &tried));
    };

    if is_js(&target) {
        let mut ignored = false;
        let Some(node) = find_in_path("node", locations.path.as_ref(), None, &mut ignored) else {
            let cause = format!("`node` is not in PATH, needed to run {}", target.display());
            return Err(no_ts(subcommand, &cause, &tried_with(&tried, &target)));
        };
        return Ok(Plan {
            program: node,
            prefix: vec![target.clone()],
            target,
            version,
        });
    }
    Ok(Plan {
        program: target.clone(),
        prefix: Vec::new(),
        target,
        version,
    })
}

fn tried_with(tried: &[String], found: &Path) -> Vec<String> {
    let mut all = tried.to_vec();
    all.push(format!("{} (found)", found.display()));
    all
}

fn no_ts(subcommand: &str, cause: &str, tried: &[String]) -> NoTs {
    let mut message =
        format!("navori-rust: cannot delegate `{subcommand}` to the TS CLI: {cause}\ntried:\n");
    for (index, entry) in tried.iter().enumerate() {
        // Writing to a String cannot fail.
        let _ = writeln!(message, "  {}. {entry}", index + 1);
    }
    NoTs { message }
}

/// One-line notice when the chosen TS CLI is another version than this binary (F8), or `None`.
#[must_use]
pub fn version_notice(plan: &Plan, own_version: &str) -> Option<String> {
    let theirs = match &plan.version {
        VersionSource::PackageJson(file) => {
            let text = fs::read_to_string(file).ok()?;
            let json: serde_json::Value = serde_json::from_str(&text).ok()?;
            json.get("version")?.as_str()?.to_owned()
        }
        VersionSource::Probe(binary) => {
            let out = Command::new(binary)
                .arg("--version")
                .env_remove(DELEGATED_VAR)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .output()
                .ok()?;
            String::from_utf8(out.stdout)
                .ok()?
                .lines()
                .next()?
                .trim()
                .to_owned()
        }
        VersionSource::Unknown => return None,
    };
    (theirs != own_version).then(|| {
        format!(
            "navori-rust: warning: delegating to TS navori {theirs} at {} (navori-rust is {own_version})",
            plan.target.display()
        )
    })
}

/// True when `value` is the pid of this very process, i.e. the delegation looped back (D3).
#[must_use]
pub fn is_loop(value: Option<&OsStr>, own_pid: u32) -> bool {
    value
        .and_then(OsStr::to_str)
        .and_then(|v| v.parse::<u32>().ok())
        .is_some_and(|pid| pid == own_pid)
}

/// Replaces this process with the TS CLI. Returns only if `exec` itself failed.
#[must_use]
pub fn exec(plan: &Plan, args: &[OsString]) -> ExitCode {
    let error = Command::new(&plan.program)
        .args(&plan.prefix)
        .args(args)
        .env(DELEGATED_VAR, std::process::id().to_string())
        .exec();
    eprintln!(
        "navori-rust: cannot launch {}: {error}",
        plan.program.display()
    );
    ExitCode::from(EXIT_NO_TS)
}

/// Like [`run`] for a native command that already read its stdin: the TS child gets those exact
/// bytes on a pipe, inherits stdout and stderr, and its exit status becomes ours (a signal
/// becomes 128 + its number, as a shell reports it).
#[must_use]
pub fn run_with_stdin(args: &[OsString], subcommand: &str, stdin: &[u8]) -> ExitCode {
    use std::io::Write as _;
    use std::os::unix::process::ExitStatusExt as _;
    let plan = match plan(&Locations::from_process(), subcommand) {
        Ok(plan) => plan,
        Err(NoTs { message }) => {
            eprint!("{message}");
            return ExitCode::from(EXIT_NO_TS);
        }
    };
    if let Some(notice) = version_notice(&plan, navori_core::VERSION) {
        eprintln!("{notice}");
    }
    let child = Command::new(&plan.program)
        .args(&plan.prefix)
        .args(args)
        .env(DELEGATED_VAR, std::process::id().to_string())
        .stdin(Stdio::piped())
        .spawn();
    let mut child = match child {
        Ok(child) => child,
        Err(error) => {
            eprintln!(
                "navori-rust: cannot launch {}: {error}",
                plan.program.display()
            );
            return ExitCode::from(EXIT_NO_TS);
        }
    };
    if let Some(mut pipe) = child.stdin.take() {
        let bytes = stdin.to_vec();
        // A child that exits without reading stdin breaks the pipe; its status still decides.
        std::thread::spawn(move || {
            let _ = pipe.write_all(&bytes);
        });
    }
    match child.wait() {
        Ok(status) => {
            let code = status
                .code()
                .or_else(|| status.signal().map(|signal| 128 + signal))
                .unwrap_or(1);
            ExitCode::from(u8::try_from(code).unwrap_or(1))
        }
        Err(error) => {
            eprintln!(
                "navori-rust: cannot wait for {}: {error}",
                plan.program.display()
            );
            ExitCode::FAILURE
        }
    }
}

/// Delegates `args` to the TS CLI, or exits 69 explaining why not.
#[must_use]
pub fn run(args: &[OsString], subcommand: &str) -> ExitCode {
    match plan(&Locations::from_process(), subcommand) {
        Ok(plan) => {
            if let Some(notice) = version_notice(&plan, navori_core::VERSION) {
                eprintln!("{notice}");
            }
            exec(&plan, args)
        }
        Err(NoTs { message }) => {
            eprint!("{message}");
            ExitCode::from(EXIT_NO_TS)
        }
    }
}
