//! Registry adapter and host of session-start-context (spec 0059 T14, D30, D40).
//!
//! Before stdin: the accredited extraction profile, the rendered values and the environment the
//! script reads. After stdin the decision runs against [`SystemHost`]: facts read the disk and run
//! `git`, `navori --version` and `navori plan resume --json`; effects run the `navori` of `PATH`
//! (or `tools session-context` in process when that `navori` is this build's TS version) and, in
//! shadow, answer "unobserved" instead.

use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

use navori_core::js_json;
use navori_core::tools::notice::notice_reserve;
use navori_core::workspace::registry::Stop;
use navori_hooks::hooks::session_start_context::{self as hook, Called, Context, Host, Rendered};
use navori_hooks::runner::{self, Engine, Evaluation, Failure};
use navori_hooks::shell::capture::CaptureContext;
use navori_hooks::shell::prepare::{self, Limits, Request};
use navori_hooks::shell::subcommand::{self, Call, Capture, Input};

use crate::facts_cache::FactsCache;
use crate::hook::{Evaluator, Invocation, Recorder, Snapshot};
use crate::hook_facts::{collect_cached, navori_cli, shell_pwd};
use crate::journal;
use crate::quality_gate::{on_path, resolve};

/// Hosts that register session-start-context (Pi's extension has its own handler).
const ENGINES: &[Engine] = &[Engine::Claude, Engine::Codex];
/// `spawnSync(…, { timeout: 5500, maxBuffer: 65536 })` of the Codex resume branch.
const RESUME_TIMEOUT: Duration = Duration::from_millis(5500);
const RESUME_MAX: usize = 65_536;
const RESUME_UNAVAILABLE: &[u8] =
    br#"{"status":"pending","reason":"resume revalidation unavailable"}"#;

/// The real host of one invocation.
struct SystemHost<'a> {
    env: &'a [(OsString, OsString)],
    cwd: &'a Path,
    pwd: &'a str,
    cache: Option<&'a FactsCache>,
    shadow: bool,
}

impl SystemHost<'_> {
    fn effect(&self) -> Result<(), Failure> {
        if self.shadow {
            Err(runner::unobserved())
        } else {
            Ok(())
        }
    }

    fn path(&self, path: &str) -> PathBuf {
        self.cwd.join(path)
    }

    /// A command the shell runs from its working directory, with the environment Bash gives it.
    fn run(
        &self,
        name: &str,
        args: &[&str],
        extra: &[(&str, &OsStr)],
        capture: Capture,
        timeout: Option<Duration>,
    ) -> Option<subcommand::Finished> {
        let program = resolve(self.env, name, self.pwd)?;
        let vars = subcommand::child_env(self.env, OsStr::new(self.pwd), None, &program, extra);
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        subcommand::run(&Call {
            program: &program,
            args: &args,
            cwd: self.cwd,
            env: &vars,
            input: Input::Bytes(&[]),
            capture,
            timeout,
        })
        .ok()
    }

    /// `$(navori … 2>/dev/null || true)`: stdout, whatever the status.
    fn navori_stdout(&self, args: &[&str]) -> Vec<u8> {
        self.run("navori", args, &[], Capture::Separate, None)
            .map(|finished| finished.stdout)
            .unwrap_or_default()
    }

    /// `mktemp "${TMPDIR:-/tmp}/navori-sc.XXXXXX"` succeeds.
    fn mktemp_ok(&self) -> bool {
        let tmp = prepare::env_value(self.env, "TMPDIR")
            .filter(|dir| !dir.is_empty())
            .map_or_else(|| PathBuf::from("/tmp"), PathBuf::from);
        let Ok(suffix) = navori_core::atomic::random_bytes::<6>() else {
            return false;
        };
        let name: String = suffix.iter().map(|b| format!("{b:02x}")).collect();
        let probe = self.cwd.join(tmp).join(format!("navori-sc.{name}"));
        let created = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&probe)
            .is_ok();
        if created {
            let _ = fs::remove_file(&probe);
        }
        created
    }

    /// `tools session-context` in this process (D30), `None` when only the TS answers it.
    fn session_context_in_process(&self, reserve: &str) -> Option<Called> {
        let program = resolve(self.env, "navori", self.pwd)?;
        let same = navori_cli(self.env, self.cwd, self.cache)
            .is_ok_and(|cli| cli.in_process() && cli.path.as_deref() == Some(program.as_path()));
        if !same {
            return None;
        }
        let vars = subcommand::child_env(self.env, OsStr::new(self.pwd), None, &program, &[]);
        let printed = navori_core::tools::session_context(
            &vars,
            self.cwd,
            Some(notice_reserve(reserve)),
            &crate::tools::spawn_worker,
        );
        match printed {
            Ok(printed) => Some(Called {
                status: i32::from(printed.failed),
                stdout: printed.stdout.into_bytes(),
                stderr: printed
                    .stderr
                    .iter()
                    .flat_map(|line| format!("{line}\n").into_bytes())
                    .collect(),
            }),
            Err(Stop::Throw) => Some(Called {
                status: 1,
                stdout: Vec::new(),
                stderr: Vec::new(),
            }),
            Err(Stop::Delegate(_)) => None,
        }
    }
}

impl Host for SystemHost<'_> {
    fn on_path(&self, name: &str) -> bool {
        on_path(self.env, name, self.pwd)
    }

    fn is_dir(&self, path: &str) -> bool {
        fs::metadata(self.path(path)).is_ok_and(|meta| meta.is_dir())
    }

    fn is_file(&self, path: &str) -> bool {
        fs::metadata(self.path(path)).is_ok_and(|meta| meta.is_file())
    }

    fn is_symlink(&self, path: &str) -> bool {
        fs::symlink_metadata(self.path(path)).is_ok_and(|meta| meta.file_type().is_symlink())
    }

    fn read(&self, path: &str) -> Option<Vec<u8>> {
        fs::read(self.path(path)).ok()
    }

    fn list(&self, dir: &str) -> Option<Vec<Vec<u8>>> {
        let entries = fs::read_dir(self.path(dir)).ok()?;
        Some(
            entries
                .flatten()
                .map(|entry| entry.file_name().into_encoded_bytes())
                .collect(),
        )
    }

    fn git(&self, args: &[&str]) -> Option<(i32, Vec<u8>)> {
        self.run("git", args, &[], Capture::Separate, None)
            .map(|finished| (finished.status, finished.stdout))
    }

    fn navori_version(&self) -> Vec<u8> {
        self.navori_stdout(&["--version"])
    }

    fn plan_resume(&self) -> Result<Vec<u8>, Failure> {
        let Some(finished) = self.run(
            "navori",
            &["plan", "resume", "--json"],
            &[],
            Capture::Separate,
            Some(RESUME_TIMEOUT),
        ) else {
            return Ok(RESUME_UNAVAILABLE.to_vec());
        };
        let text = String::from_utf8_lossy(&finished.stdout);
        // `JSON.parse(r.stdout)` throws first; only then is the status read.
        if finished.timed_out
            || finished.stdout.len() > RESUME_MAX
            || serde_json::from_str::<serde_json::Value>(&text).is_err()
            || finished.status != 0
        {
            return Ok(RESUME_UNAVAILABLE.to_vec());
        }
        js_json::parse(&text)
            .and_then(|value| value.stringify(None))
            .map(String::into_bytes)
            .ok_or_else(|| Failure("plan resume JSON outside the model".to_owned()))
    }

    fn session_context(&self, reserve: &str) -> Result<Option<Called>, Failure> {
        self.effect()?;
        if !self.mktemp_ok() {
            return Ok(None);
        }
        if let Some(called) = self.session_context_in_process(reserve) {
            return Ok(Some(called));
        }
        let finished = self
            .run(
                "navori",
                &["tools", "session-context", "--notice-reserve", reserve],
                &[],
                Capture::Separate,
                None,
            )
            .ok_or_else(|| Failure("navori could not run".to_owned()))?;
        Ok(Some(Called {
            status: finished.status,
            stdout: finished.stdout,
            stderr: finished.stderr,
        }))
    }

    fn write_memo(&self, path: &str, version: &[u8]) -> Result<(), Failure> {
        self.effect()?;
        let _ = fs::write(self.path(path), [version, b"\n"].concat());
        Ok(())
    }

    fn tools_notice(&self) -> Result<Vec<u8>, Failure> {
        self.effect()?;
        Ok(self.navori_stdout(&["tools", "notice"]))
    }

    fn consume_arm(&self, sid: &str, cwd: &str, host: &str, root: &str) -> Result<bool, Failure> {
        self.effect()?;
        let args = [
            "audit",
            "--consume-arm",
            "--start",
            sid,
            "--cwd",
            cwd,
            "--host",
            host,
            "--root",
            root,
        ];
        let extra = [("NAVORI_AUDITS_ROOT", OsStr::new(root))];
        Ok(self
            .run("navori", &args, &extra, Capture::Discard, None)
            .is_some_and(|finished| finished.status == 0))
    }

    fn take_kept_notice(&self, path: &str) -> Result<Vec<u8>, Failure> {
        self.effect()?;
        let body = fs::read(self.path(path)).unwrap_or_default();
        let _ = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(self.path(path));
        Ok(body)
    }

    fn dominio_inject(&self) -> Result<Vec<u8>, Failure> {
        self.effect()?;
        Ok(self.navori_stdout(&["dominio", "inject"]))
    }

    fn ack(&self, list: &[u8]) -> Result<(), Failure> {
        self.effect()?;
        let list = std::str::from_utf8(list).map_err(|_| Failure("ack is not UTF-8".to_owned()))?;
        let _ = self.run(
            "navori",
            &["tools", "notice", "--ack", list],
            &[],
            Capture::Discard,
            None,
        );
        Ok(())
    }
}

/// A shell integer the script compares with `[ -le ]`: plain digits that fit Bash's arithmetic.
fn shell_integer(text: &str) -> Option<i64> {
    (!text.is_empty() && text.len() <= 18 && text.bytes().all(|b| b.is_ascii_digit()))
        .then(|| text.parse().ok())
        .flatten()
}

/// Registry adapter for session-start-context.
///
/// # Errors
/// The ineligibility cause; the caller defers the call to the shell.
pub fn prepare<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    // The shared planner accredits PreToolUse entries; this hook's own event is checked here.
    if !matches!(invocation.event.as_deref(), None | Some("SessionStart")) {
        return Err("unsupported hook event".to_owned());
    }
    let request = Request {
        engine: invocation.engine,
        engines: ENGINES,
        event: None,
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
    // `set -u`: an unset HOME kills the script on its first `$HOME`.
    let home = text("HOME")?.ok_or("HOME is unset")?;
    let pwd = shell_pwd(text("PWD")?, snapshot.cwd)?;
    let nonempty = |name: &str| -> Result<Option<String>, String> {
        Ok(text(name)?.filter(|value| !value.is_empty()))
    };
    let budget = match nonempty("NAVORI_CTX_BUDGET")? {
        None => 8000,
        Some(value) => shell_integer(&value).ok_or("NAVORI_CTX_BUDGET is not a plain integer")?,
    };
    let reserve = nonempty("NAVORI_NOTICE_RESERVE")?
        .filter(|value| value.bytes().all(|b| b.is_ascii_digit()))
        .unwrap_or_else(|| "300".to_owned());
    let reserve_number =
        shell_integer(&reserve).ok_or("NAVORI_NOTICE_RESERVE is not a plain integer")?;
    let audits_root =
        nonempty("NAVORI_AUDITS_ROOT")?.unwrap_or_else(|| format!("{home}/.navori/audits"));
    let project_or_pwd = nonempty("CLAUDE_PROJECT_DIR")?.unwrap_or_else(|| pwd.clone());
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
        home,
        project_or_pwd,
        audits_root,
        opted_out: text("NAVORI_NO_UPDATE_NOTIFIER")?.as_deref() == Some("1"),
        budget,
        notice_reserve: (reserve, reserve_number),
    };
    let (env, cwd) = (snapshot.env, snapshot.cwd);
    Ok(Box::new(
        move |payload: &[u8], recorder: &dyn Recorder| -> Result<Evaluation, Failure> {
            let host = SystemHost {
                env,
                cwd,
                pwd: &pwd,
                cache: cache.as_ref(),
                shadow: recorder.shadow(),
            };
            hook::evaluate(payload, &context, &host)
        },
    ))
}

/// The audit phase the script declares.
#[must_use]
pub fn phase(_: &[OsString]) -> Option<&'static str> {
    Some("SessionStart")
}
