//! Helpers shared by the native commands: buffered output, citty usage, the config read and the
//! `JSON.stringify` builders.

use std::io::Write as _;
use std::path::Path;
use std::process::ExitCode;

use navori_core::config;
use navori_core::js_json::{JsObject, JsValue};

use crate::help::{CommandDef, Paint, Parent, citty_no_color, render_usage};

/// What the process prints, buffered so delegation can still happen after any computation.
#[derive(Debug, Default)]
pub(crate) struct Output {
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) code: u8,
}

impl Output {
    pub(crate) fn emit(self) -> ExitCode {
        // A closed stream is not an error of the command, as in Node without an `error` handler
        // on a pipe the reader already left.
        let _ = std::io::stdout().lock().write_all(self.stdout.as_bytes());
        let _ = std::io::stderr().lock().write_all(self.stderr.as_bytes());
        ExitCode::from(self.code)
    }

    /// `showUsage` (stdout, plus the blank line `console.log` adds) and, for a `CLIError`, its
    /// message on stderr.
    pub(crate) fn usage(cmd: &CommandDef, parent: Parent<'_>, error: Option<String>) -> Self {
        let paint = Paint {
            color: !citty_no_color(),
        };
        let mut out = Self {
            stdout: format!("{}\n\n", render_usage(cmd, parent, paint)),
            ..Self::default()
        };
        if let Some(message) = error {
            out.stderr = format!("{message}\n");
            out.code = 1;
        }
        out
    }
}

/// `readConfig` when `navori.config.json` exists: `Some(None)` when it does not, `None` when the
/// TS must handle it (unreadable, invalid, or outside what [`config::read`] models).
pub(crate) fn read_config(cwd: &str) -> Option<Option<config::Config>> {
    let path = format!("{cwd}/navori.config.json");
    if !Path::new(&path).exists() {
        return Some(None);
    }
    let bytes = std::fs::read(&path).ok()?;
    config::read(&bytes).ok().map(Some)
}

pub(crate) fn member<'a>(value: Option<&'a JsValue>, key: &str) -> Option<&'a JsValue> {
    match value {
        Some(JsValue::Object(object)) => object.get(key),
        _ => None,
    }
}

/// `config.sdd?.specsDir ?? "specs"`; `None` when it is not a plain string.
pub(crate) fn specs_dir(config: Option<&config::Config>) -> Option<String> {
    match member(member(config.map(|c| &c.data), "sdd"), "specsDir") {
        None | Some(JsValue::Undefined | JsValue::Null) => Some("specs".to_owned()),
        Some(JsValue::String(text)) => text.to_rust(),
        Some(_) => None,
    }
}

pub(crate) fn string(text: &str) -> JsValue {
    JsValue::string(text)
}

#[expect(
    clippy::cast_precision_loss,
    reason = "counts and line numbers are far below 2^53, as JS numbers"
)]
pub(crate) fn number(n: usize) -> JsValue {
    JsValue::Number(n as f64)
}

pub(crate) fn object(entries: Vec<(&str, JsValue)>) -> JsValue {
    let mut out = JsObject::new();
    for (key, value) in entries {
        out.insert(key, value);
    }
    JsValue::Object(out)
}

pub(crate) fn json_line(out: &mut Output, value: &JsValue) {
    out.stdout
        .push_str(&value.stringify(None).unwrap_or_default());
    out.stdout.push('\n');
}
