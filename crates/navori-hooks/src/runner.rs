//! Buffered hook evaluation and controlled failures (spec 0057 D6 / R12).
//!
//! Integrity runs before stdin is read. A hook returns buffers rather than writers, so a panic
//! cannot publish a partial verdict. The CLI/wrapper owns the final write and broken-pipe policy.

use std::cell::{Cell, RefCell};
use std::fmt;
use std::io::{self, Read, Write};
use std::panic::{self, AssertUnwindSafe};
use std::sync::Once;

use navori_core::js_json::{JsObject, JsValue};

thread_local! {
    static CAPTURING: Cell<bool> = const { Cell::new(false) };
    static PANIC_MESSAGE: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Host whose hook protocol receives the result.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Engine {
    /// Claude PreToolUse needs an `ask` JSON verdict on controlled failures.
    Claude,
    /// Codex does not support `ask`; exit 2 blocks the call.
    Codex,
    /// Pi enforced hooks block on exit 2.
    Pi,
}

/// Immutable metadata of the selected hook. Routing supplies this from the manifest.
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
    /// Engine invoking the hook.
    pub engine: Engine,
    /// Manifest hook id, used in failure diagnostics.
    pub hook: &'a str,
    /// Whether this hook decides if an action may proceed.
    pub gating: bool,
}

/// A hook may return only a shell verdict. Deferral belongs to the integrity preflight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// Exit 0.
    Permit,
    /// Exit 1.
    Error,
    /// Exit 2.
    Block,
}

impl Verdict {
    const fn code(self) -> u8 {
        match self {
            Self::Permit => 0,
            Self::Error => 1,
            Self::Block => 2,
        }
    }
}

/// Complete output of a successful evaluation, accumulated without writing to the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Evaluation {
    /// Exit 0, 1 or 2; arbitrary process codes cannot cross this boundary.
    pub verdict: Verdict,
    /// Exact stdout bytes, including any final newline required by the hook.
    pub stdout: Vec<u8>,
    /// Exact stderr bytes.
    pub stderr: Vec<u8>,
}

/// An expected evaluation or input failure, without embedding the input payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure(pub String);

impl fmt::Display for Failure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Failure {}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Self {
        Self(format!("input I/O error: {error}"))
    }
}

/// Terminal buffered result. Only `run` can construct its exit code (0, 1, 2 or 3).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Response {
    code: u8,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl Response {
    /// The protocol exit code. A 3 always means stdin was not read.
    #[must_use]
    pub const fn code(&self) -> u8 {
        self.code
    }

    /// All stdout, ready for the final write.
    #[must_use]
    pub fn stdout(&self) -> &[u8] {
        &self.stdout
    }

    /// All stderr, ready for the final write.
    #[must_use]
    pub fn stderr(&self) -> &[u8] {
        &self.stderr
    }
}

/// Scope the process panic hook to this thread's evaluation and preserve nested captures.
struct Capture {
    previous_active: bool,
    previous_message: Option<String>,
}

impl Capture {
    fn start() -> Self {
        static INSTALL: Once = Once::new();
        INSTALL.call_once(|| {
            let previous = panic::take_hook();
            panic::set_hook(Box::new(move |info| {
                if CAPTURING.get() {
                    let message = info
                        .payload()
                        .downcast_ref::<String>()
                        .cloned()
                        .or_else(|| {
                            info.payload()
                                .downcast_ref::<&str>()
                                .map(|s| (*s).to_owned())
                        })
                        .unwrap_or_else(|| "non-string panic".to_owned());
                    PANIC_MESSAGE.with_borrow_mut(|slot| *slot = Some(message));
                } else {
                    previous(info);
                }
            }));
        });
        Self {
            previous_active: CAPTURING.replace(true),
            previous_message: PANIC_MESSAGE.with_borrow_mut(Option::take),
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        CAPTURING.set(self.previous_active);
        PANIC_MESSAGE.with_borrow_mut(|slot| *slot = self.previous_message.take());
    }
}

/// Evaluate a hook without publishing output.
///
/// `integrity` returning false yields exit 3 before touching stdin. An integrity error or panic
/// is a controlled failure, as are an input error and a handler error or panic. Invalid UTF-8
/// and truncated JSON are passed unchanged to the handler, which reproduces its shell verdict.
pub fn run<R, I, H>(context: Context<'_>, input: &mut R, integrity: I, handler: H) -> Response
where
    R: Read,
    I: FnOnce() -> Result<bool, Failure>,
    H: FnOnce(&[u8]) -> Result<Evaluation, Failure>,
{
    let _capture = Capture::start();
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        if !integrity()? {
            return Ok(Response {
                code: 3,
                stdout: Vec::new(),
                stderr: Vec::new(),
            });
        }
        let mut payload = Vec::new();
        input.read_to_end(&mut payload)?;
        let output = handler(&payload)?;
        Ok::<Response, Failure>(Response {
            code: output.verdict.code(),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }));
    match result {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => safe_failure(context, &error.to_string()),
        Err(_) => {
            let message = PANIC_MESSAGE
                .with_borrow_mut(Option::take)
                .unwrap_or_else(|| "unknown panic".to_owned());
            safe_failure(context, &format!("panic: {message}"))
        }
    }
}

fn safe_failure(context: Context<'_>, cause: &str) -> Response {
    let reason = format!(
        "navori: {} could not evaluate this call ({}); confirm it manually",
        context.hook, cause
    );
    if context.gating && context.engine == Engine::Claude {
        let mut verdict = JsObject::new();
        verdict.insert("hookEventName", JsValue::string("PreToolUse"));
        verdict.insert("permissionDecision", JsValue::string("ask"));
        verdict.insert("permissionDecisionReason", JsValue::string(&reason));
        let mut root = JsObject::new();
        root.insert("hookSpecificOutput", JsValue::Object(verdict));
        let mut stdout = JsValue::Object(root).stringify(None).unwrap_or_else(|| {
            // Objects always serialize; retain a safe static verdict if the serializer changes.
            r#"{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"navori: hook evaluation failed; confirm it manually"}}"#.to_owned()
        });
        stdout.push('\n');
        Response {
            code: 0,
            stdout: stdout.into_bytes(),
            stderr: Vec::new(),
        }
    } else {
        Response {
            code: if context.gating { 2 } else { 1 },
            stdout: Vec::new(),
            stderr: format!("{reason}\n").into_bytes(),
        }
    }
}

/// Publish a complete response and return only a protocol exit code.
///
/// Once a writer fails it is impossible to retract its partial bytes or reliably emit an `ask`.
/// A gating hook therefore exits 2, including Claude; advisory hooks exit 1. The outer wrapper
/// captures stdout and preserves this blocking code. Writer panics follow the same contract.
pub fn emit<W: Write, E: Write>(
    context: Context<'_>,
    response: &Response,
    stdout: &mut W,
    stderr: &mut E,
) -> u8 {
    let _capture = Capture::start();
    let result = panic::catch_unwind(AssertUnwindSafe(|| {
        stdout.write_all(response.stdout())?;
        stdout.flush()?;
        stderr.write_all(response.stderr())?;
        stderr.flush()
    }));
    if matches!(result, Ok(Ok(()))) {
        return response.code();
    }
    // A diagnostic channel may be broken too; never panic while reporting that failure.
    let _ = panic::catch_unwind(AssertUnwindSafe(|| {
        stderr.write_all(b"navori: could not publish hook result\n")
    }));
    if context.gating { 2 } else { 1 }
}
