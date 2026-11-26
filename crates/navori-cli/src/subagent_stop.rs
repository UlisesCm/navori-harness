//! Registry adapter and host of subagent-stop-handoff (spec 0059 T15, D40).
//!
//! The script's writes (its per-session stamp and compaction mark) and the Codex child capture
//! feed nothing it reads afterwards, so in shadow this host skips them and predicts the error a
//! failed redirection prints; the whole decision is compared with the shell.

use std::ffi::{OsStr, OsString};
use std::fs::{self, OpenOptions};
use std::io::{self, Read as _, Seek as _, SeekFrom, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use navori_hooks::hooks::subagent_stop_handoff::{self as hook, Context, Host, Rendered};
use navori_hooks::runner::{Engine, Evaluation, Failure};
use navori_hooks::shell::capture::CaptureContext;
use navori_hooks::shell::prepare::{self, Limits, Request};
use navori_hooks::shell::subcommand::{self, Call, Capture, Input};

use crate::facts_cache::FactsCache;
use crate::hook::{Evaluator, Invocation, Recorder, Snapshot};
use crate::hook_facts::{collect_cached, shell_pwd};
use crate::journal;
use crate::quality_gate::{on_path, resolve};

const ENGINES: &[Engine] = &[Engine::Claude, Engine::Codex];
/// `-mmin -2880`.
const WINDOW_MINUTES: i64 = 2880;

/// `strerror` of an I/O failure, as Bash prints it.
fn strerror(error: &io::Error) -> String {
    match error.kind() {
        io::ErrorKind::NotFound => "No such file or directory".to_owned(),
        io::ErrorKind::PermissionDenied => "Permission denied".to_owned(),
        io::ErrorKind::IsADirectory => "Is a directory".to_owned(),
        io::ErrorKind::NotADirectory => "Not a directory".to_owned(),
        io::ErrorKind::ReadOnlyFilesystem => "Read-only file system".to_owned(),
        _ => {
            let text = error.to_string();
            text.split(" (os error").next().unwrap_or(&text).to_owned()
        }
    }
}

struct SystemHost<'a> {
    env: &'a [(OsString, OsString)],
    cwd: &'a Path,
    pwd: &'a str,
    shadow: bool,
}

impl SystemHost<'_> {
    fn path(&self, path: &str) -> PathBuf {
        self.cwd.join(path)
    }

    /// Why `>path` would fail, without writing.
    fn predict_write(&self, path: &Path) -> Option<String> {
        match fs::metadata(path) {
            Ok(meta) if meta.is_dir() => return Some("Is a directory".to_owned()),
            Ok(meta) if meta.permissions().readonly() => {
                return Some("Permission denied".to_owned());
            }
            Ok(_) => return None,
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Some(strerror(&error)),
            Err(_) => {}
        }
        let parent = path.parent().unwrap_or(Path::new("/"));
        match fs::metadata(parent) {
            Ok(meta) if !meta.is_dir() => Some("Not a directory".to_owned()),
            Ok(meta) if meta.permissions().readonly() => Some("Permission denied".to_owned()),
            Ok(_) => None,
            Err(error) => Some(strerror(&error)),
        }
    }
}

/// BSD `find -mmin`: the age rounded up to the next full minute; GNU compares it exactly.
fn within_window(modified: SystemTime) -> bool {
    let age = match SystemTime::now().duration_since(modified) {
        Ok(age) => age.as_secs_f64(),
        Err(ahead) => -ahead.duration().as_secs_f64(),
    };
    let minutes = if cfg!(target_os = "linux") {
        age / 60.0
    } else {
        (age / 60.0).ceil()
    };
    minutes < WINDOW_MINUTES as f64
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

    fn open_error(&self, path: &str) -> Option<String> {
        fs::File::open(self.path(path)).err().map(|e| strerror(&e))
    }

    fn recent(&self, dir: &str, prefix: &str, suffix: &str) -> Result<Vec<String>, Failure> {
        let Ok(entries) = fs::read_dir(self.path(dir)) else {
            return Ok(Vec::new());
        };
        let mut found = Vec::new();
        for entry in entries.flatten() {
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| Failure("handoff name is not UTF-8".to_owned()))?;
            if name.len() < prefix.len() + suffix.len()
                || !name.starts_with(prefix)
                || !name.ends_with(suffix)
            {
                continue;
            }
            if name.contains('\n') {
                return Err(Failure("handoff name holds a newline".to_owned()));
            }
            // `find` without `-L` tests the entry itself.
            let recent = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .is_ok_and(within_window);
            if recent {
                found.push(format!("{dir}/{name}"));
            }
        }
        Ok(found)
    }

    fn tail(&self, path: &str, bytes: u64) -> Option<Vec<u8>> {
        let mut file = fs::File::open(self.path(path)).ok()?;
        let length = file.metadata().ok()?.len();
        file.seek(SeekFrom::Start(length.saturating_sub(bytes)))
            .ok()?;
        let mut out = Vec::new();
        file.read_to_end(&mut out).ok()?;
        Some(out)
    }

    fn toplevel(&self, dir: &str) -> Option<String> {
        let git = resolve(self.env, "git", self.pwd)?;
        let vars = subcommand::child_env(self.env, OsStr::new(self.pwd), None, &git, &[]);
        let args = ["-C", dir, "rev-parse", "--show-toplevel"].map(OsString::from);
        let finished = subcommand::run(&Call {
            program: &git,
            args: &args,
            cwd: self.cwd,
            env: &vars,
            input: Input::Bytes(&[]),
            capture: Capture::Separate,
            timeout: None,
        })
        .ok()?;
        (finished.status == 0)
            .then(|| String::from_utf8(subcommand::substitution(&finished.stdout).to_vec()).ok())
            .flatten()
    }

    fn capture_child(&self, child: &str, root: &str, rollout: &str, cwd: &str) {
        if self.shadow {
            return;
        }
        let Some(navori) = resolve(self.env, "navori", self.pwd) else {
            return;
        };
        let vars = subcommand::child_env(self.env, OsStr::new(self.pwd), None, &navori, &[]);
        let args = [
            "audit",
            "--capture-child",
            child,
            "--root-session",
            root,
            "--rollout",
            rollout,
            "--cwd",
            cwd,
        ]
        .map(OsString::from);
        let _ = subcommand::run(&Call {
            program: &navori,
            args: &args,
            cwd: self.cwd,
            env: &vars,
            input: Input::Bytes(&[]),
            capture: Capture::Discard,
            timeout: None,
        });
    }

    fn write(&self, path: &str, content: &[u8]) -> Option<String> {
        let path = self.path(path);
        if self.shadow {
            return self.predict_write(&path);
        }
        let written = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o666)
            .open(&path)
            .map_err(|e| strerror(&e));
        match written {
            // `printf` failing after the open prints to the silenced stderr.
            Ok(mut file) => {
                let _ = file.write_all(content);
                None
            }
            Err(error) => Some(error),
        }
    }
}

/// Registry adapter for subagent-stop-handoff.
///
/// # Errors
/// The ineligibility cause; the caller defers the call to the shell.
pub fn prepare<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    if !matches!(invocation.event.as_deref(), None | Some("PostToolUse")) {
        return Err("unsupported hook event".to_owned());
    }
    let mode = match invocation.args.as_slice() {
        [] => String::new(),
        [mode] if mode == "codex" => "codex".to_owned(),
        _ => return Err("unsupported hook arguments".to_owned()),
    };
    let request = Request {
        engine: invocation.engine,
        engines: ENGINES,
        event: None,
        args: &[],
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
            .map(|value| value.filter(|v| !v.is_empty()))
    };
    let pwd = shell_pwd(text("PWD")?, snapshot.cwd)?;
    let audits_root = match text("NAVORI_AUDITS_ROOT")? {
        Some(root) => Some(root),
        None => text("HOME")?.map(|home| format!("{home}/.navori/audits")),
    };
    let script = invocation
        .requested
        .to_str()
        .ok_or("hook path is not UTF-8")?
        .to_owned();
    let context = Context {
        profile: prepared.profile(),
        capture: CaptureContext {
            input_line: rendered.lines.input,
            ..prepared.capture()
        },
        rendered,
        script,
        mode,
        pwd: pwd.clone(),
        tmpdir: text("TMPDIR")?.unwrap_or_else(|| "/tmp".to_owned()),
        claude_project_dir: text("CLAUDE_PROJECT_DIR")?.unwrap_or_default(),
        audits_root,
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
            hook::evaluate(payload, &context, &host)
        },
    ))
}
