//! The master-plan SessionStart line (spec 0060 T9, R70, R72).
//!
//! `master-plan-context.sh` prints one advisory line: what `navori master status --line` says
//! when it says one usable line, else a pointer to the active stage's `STATUS.md` read from the
//! first line of `INDEX.md`, else a pointer to `INDEX.md`. Every branch is read-only, so the
//! whole decision also runs in shadow. The facts come from a [`Host`]; anything Bash would
//! answer with its own diagnostics (a failed `cd`, an unreadable index, a NUL in a capture or
//! in the payload) or that depends on how the locale reads non-ASCII text is a [`Failure`],
//! which defers the call to the shell. No other answer depends on the locale, so the hook needs
//! no tool or locale probe.

pub mod rendered;

use std::ffi::OsString;

pub use rendered::Rendered;

use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};

/// Hosts that register this hook (Pi's extension has its own control).
pub const ENGINES: &[Engine] = &[Engine::Claude, Engine::Codex];

const OFFER: &str = "En tu primera respuesta de la sesión, ofrece continuar con el plan maestro en una sola línea, sin interrumpir lo que el usuario pidió.";
const ACTIVE: &str = "Etapa activa: ";
const STATUS: &str = "/STATUS.md";

/// The audit phase the script declares; it takes no mode argument.
#[must_use]
pub fn phase(_: &[OsString]) -> Option<&'static str> {
    Some("SessionStart")
}

/// What the script reads outside its own text.
pub trait Host {
    /// `$(git rev-parse --show-toplevel 2>/dev/null)` from the hook's directory: its stdout
    /// when git exits 0, `None` otherwise.
    ///
    /// # Errors
    /// An answer the port cannot reproduce (a NUL byte in the capture).
    fn toplevel(&self) -> Result<Option<Vec<u8>>, Failure>;
    /// `command -v navori`.
    fn on_path(&self, name: &str) -> bool;
    /// `$(cd "$project_dir" && navori master status --line 2>/dev/null)`: `$?` and the raw
    /// stdout, before the substitution strips trailing newlines.
    ///
    /// # Errors
    /// A `cd` that would fail (Bash reports it on stderr) or a call that cannot be reproduced.
    fn status_line(&self, project_dir: &str) -> Result<(i32, Vec<u8>), Failure>;
    /// `[ -r path ]` then `IFS= read -r first_line < path`: the bytes before the first newline,
    /// `None` when the file is not readable.
    ///
    /// # Errors
    /// A read Bash reports on stderr (a directory, an I/O error).
    fn first_line(&self, path: &str) -> Result<Option<Vec<u8>>, Failure>;
}

/// The invocation facts collected before stdin.
#[derive(Debug, Clone)]
pub struct Context {
    /// The engine whose copy runs (`$0` under `.codex/hooks/` is Codex).
    pub engine: Engine,
    /// Values the renderer wrote into the script.
    pub rendered: Rendered,
    /// `$PWD`.
    pub pwd: String,
    /// `CLAUDE_PROJECT_DIR` when set and non-empty.
    pub project_dir: Option<String>,
}

/// `$(…)`: the capture without its trailing newlines; a NUL is not reproduced.
fn substitution(mut bytes: Vec<u8>) -> Result<Vec<u8>, Failure> {
    if bytes.contains(&0) {
        return Err(Failure(
            "a command substitution printed a NUL byte".to_owned(),
        ));
    }
    while bytes.last() == Some(&b'\n') {
        bytes.pop();
    }
    Ok(bytes)
}

/// `[ "${#line}" -le budget ]`. `${#line}` counts bytes under `LC_ALL=C` and characters under a
/// UTF-8 locale; only a line whose two counts fall on both sides of the budget depends on which.
fn fits(line: &[u8], budget: usize) -> Result<bool, Failure> {
    if line.len() <= budget {
        return Ok(true);
    }
    let chars = std::str::from_utf8(line)
        .map_err(|_| Failure("the status line is not UTF-8".to_owned()))?
        .chars()
        .count();
    if chars > budget {
        Ok(false)
    } else {
        Err(Failure(
            "the status line length depends on the locale".to_owned(),
        ))
    }
}

/// The `STATUS.md` path of an `Etapa activa: <path>/STATUS.md` first line, when the script's
/// character check accepts it.
fn status_pointer(first_line: &[u8]) -> Result<Option<&str>, Failure> {
    if !first_line.is_ascii() {
        // Bracket ranges under a UTF-8 locale depend on the Bash version: the shell decides.
        return if first_line.starts_with(ACTIVE.as_bytes()) {
            Err(Failure("the INDEX.md pointer is not ASCII".to_owned()))
        } else {
            Ok(None)
        };
    }
    let line = std::str::from_utf8(first_line).map_err(|_| Failure("unreachable".to_owned()))?;
    if line.len() < ACTIVE.len() + STATUS.len() || !line.ends_with(STATUS) {
        return Ok(None);
    }
    let Some(path) = line.strip_prefix(ACTIVE) else {
        return Ok(None);
    };
    let plain = path
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b"._/-".contains(&b));
    Ok((!path.is_empty() && !path.starts_with('/') && plain).then_some(path))
}

/// Evaluate one SessionStart call.
///
/// # Errors
/// What the [`Host`] cannot reproduce, or a capture the port does not model.
pub fn evaluate(payload: &[u8], context: &Context, host: &dyn Host) -> Result<Evaluation, Failure> {
    // `payload=$(cat 2>/dev/null)`: read for the audit only; Bash 5 warns about a NUL in it.
    if payload.contains(&0) {
        return Err(Failure("the payload holds a NUL byte".to_owned()));
    }
    let done = |stdout: String, reason: &str| Evaluation {
        verdict: Verdict::Permit,
        stdout: stdout.into_bytes(),
        stderr: Vec::new(),
        audit: Some(AuditLabel {
            verdict: "allow",
            reason: reason.to_owned(),
        }),
    };
    let project_dir = if context.engine == Engine::Codex {
        match host.toplevel()? {
            Some(top) => String::from_utf8(substitution(top)?)
                .map_err(|_| Failure("the git toplevel is not UTF-8".to_owned()))?,
            None => context.pwd.clone(),
        }
    } else {
        context
            .project_dir
            .clone()
            .unwrap_or_else(|| context.pwd.clone())
    };
    let specs_dir = &context.rendered.specs_dir;
    let index_path = format!("{project_dir}/{specs_dir}/_master/INDEX.md");
    if host.on_path("navori") {
        let (code, out) = host.status_line(&project_dir)?;
        let line = substitution(out)?;
        if code == 0
            && !line.is_empty()
            && fits(&line, context.rendered.budget)?
            && !line.contains(&b'\n')
            && !line.contains(&b'\r')
        {
            let mut text = String::from_utf8(line)
                .map_err(|_| Failure("the status line is not UTF-8".to_owned()))?;
            text.push('\n');
            return Ok(done(text, "status-line"));
        }
    }
    let first_line = host.first_line(&index_path)?.unwrap_or_default();
    if first_line.contains(&0) {
        return Err(Failure("INDEX.md starts with a NUL byte".to_owned()));
    }
    if let Some(path) = status_pointer(&first_line)? {
        return Ok(done(
            format!("Plan maestro — consulta {path}. {OFFER}\n"),
            "status-pointer",
        ));
    }
    Ok(done(
        format!("Plan maestro — consulta {specs_dir}/_master/INDEX.md. {OFFER}\n"),
        "index-pointer",
    ))
}

#[cfg(test)]
mod tests {
    use super::{fits, status_pointer, substitution};

    // Covers: R70
    #[test]
    fn captures_and_pointers_read_like_the_script() -> Result<(), super::Failure> {
        assert_eq!(substitution(b"a\n\n".to_vec())?, b"a");
        assert!(substitution(b"a\0".to_vec()).is_err());
        assert!(fits("—x".as_bytes(), 4)?);
        assert!(!fits("—x".as_bytes(), 1)?);
        assert!(fits("—x".as_bytes(), 2).is_err());
        assert_eq!(
            status_pointer(b"Etapa activa: specs/_master/01-a/STATUS.md")?,
            Some("specs/_master/01-a/STATUS.md")
        );
        assert_eq!(status_pointer(b"Etapa activa: /STATUS.md")?, None);
        assert_eq!(status_pointer(b"Etapa activa: a b/STATUS.md")?, None);
        assert_eq!(status_pointer(b"Etapa activa: STATUS.md")?, None);
        assert_eq!(status_pointer(b"# Plan maestro")?, None);
        assert!(status_pointer("Etapa activa: é/STATUS.md".as_bytes()).is_err());
        Ok(())
    }
}
