//! Eligibility rules and probe contracts hashed with the handler (0057 D8/T26).
//! Planning rejects unsupported metadata/environment before any probe or stdin read.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::fmt;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use super::{CaptureContext, Extractor, Locale, Profile, ShellDialect, evaluate_with_capture};
use crate::runner::{Engine, Evaluation, Failure};

/// One explicit reason to defer before stdin, never a policy permit verdict.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ineligible(pub String);
impl fmt::Display for Ineligible {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Ineligible {}

/// Complete caller snapshot. Integrity/registration remain external requirements.
pub struct Request<'a> {
    /// Claude and Pi are the only accredited hosts.
    pub engine: Engine,
    /// Verified event, or None for this hook's accredited PreToolUse script entry.
    pub event: Option<&'a str>,
    /// Hook-specific arguments; no argument-bearing registration is accredited yet.
    pub args: &'a [OsString],
    /// Exact path the legacy Bash invocation would print in diagnostics.
    pub script: &'a Path,
    /// Already verified script bytes, never a payload or stdin stream.
    pub source: &'a [u8],
    /// Full environment snapshot used unchanged by all probes.
    pub env: &'a [(OsString, OsString)],
}

/// Probe limits are part of eligibility semantics, not mutable process-global configuration.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub total: Duration,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            total: Duration::from_millis(250),
        }
    }
}
/// Combined stdout/stderr maximum for each probe.
pub const MAX_OUTPUT: usize = 64 * 1024;

/// Closed tool vocabulary for the constant command-v probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Tool {
    Jq,
    Node,
    Sed,
    Grep,
    Tr,
    Cat,
    Locale,
    Uname,
}
impl Tool {
    /// The fixed command names in discovery order.
    pub const ALL: [Self; 8] = [
        Self::Jq,
        Self::Node,
        Self::Sed,
        Self::Grep,
        Self::Tr,
        Self::Cat,
        Self::Locale,
        Self::Uname,
    ];
    /// Literal name, never interpolated from user data.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Jq => "jq",
            Self::Node => "node",
            Self::Sed => "sed",
            Self::Grep => "grep",
            Self::Tr => "tr",
            Self::Cat => "cat",
            Self::Locale => "locale",
            Self::Uname => "uname",
        }
    }
}

/// Raw successful/failed process observations. A failed observation is never tool absence.
#[derive(Debug, Default)]
pub struct Output {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}
impl Output {
    fn bytes(&self) -> Result<&[u8], Ineligible> {
        if self.code != Some(0) || !self.stderr.is_empty() {
            return Err(Ineligible("probe failed or emitted diagnostics".into()));
        }
        Ok(&self.stdout)
    }
}

/// Resolved legacy command-v facts; None represents only an observed status1/empty lookup.
pub struct Discovery {
    pub shell: ShellDialect,
    pub tools: BTreeMap<Tool, Option<PathBuf>>,
}

/// All raw facts needed for selection, collected without reading the hook payload.
pub struct Facts {
    pub bootstrap: Output,
    pub system: Output,
    pub charmap: Output,
    pub text: Output,
    pub jq: Option<Output>,
    pub node: Option<Output>,
}

/// Validated metadata, source locations and budget; only plan can construct it.
pub struct Plan<'a> {
    request: Request<'a>,
    utf8: bool,
    input_line: usize,
    fallback_line: usize,
    limits: Limits,
}

/// Constant Bash discovery program. Exported functions/startup options are rejected by plan.
pub const DISCOVERY: &str = r#"printf '%s\0' "$BASH_VERSION"
for _nv_tool in jq node sed grep tr cat locale uname; do
  _nv_path=$(command -v "$_nv_tool"); _nv_status=$?
  printf '%s\0%s\0%s\0' "$_nv_tool" "$_nv_status" "$_nv_path"
done
"#;
/// Fixed synthetic text probes; argv contains only controlled data and discovered paths.
pub const TEXT: &str = r#"printf '%s' "$1" | "$2" -nE '^[[:space:]]$'
printf '\0'
printf '%s' "$1" | "$3" -nE 's/^([[:space:]])$/S/p'
printf '\0'
printf 'a\nb' | "$4" '\n' ' '
printf '\0'
printf 'x\000y\n' | "$5"
printf '\0%s' "${#1}"
"#;

/// Reject unsupported metadata, modifiers and locale names before any process is launched.
pub fn plan(request: Request<'_>, limits: Limits) -> Result<Plan<'_>, Ineligible> {
    if request.engine == Engine::Codex
        || !matches!(request.event, None | Some("PreToolUse"))
        || !request.args.is_empty()
    {
        return Err(Ineligible(
            "unsupported engine, event or hook arguments".into(),
        ));
    }
    if limits.total.is_zero() || limits.total > Duration::from_millis(500) {
        return Err(Ineligible("unsupported probe budget".into()));
    }
    let mut names = BTreeSet::new();
    for (key, value) in request.env {
        if !names.insert(key) {
            return Err(Ineligible("duplicate environment key".into()));
        }
        let name = key.as_encoded_bytes();
        if matches!(
            name,
            b"BASH_ENV"
                | b"ENV"
                | b"SHELLOPTS"
                | b"BASHOPTS"
                | b"BASH_COMPAT"
                | b"IFS"
                | b"POSIXLY_CORRECT"
                | b"GLOBIGNORE"
                | b"CDPATH"
                | b"LANGUAGE"
                | b"GREP_OPTIONS"
                | b"GREP_COLOR"
                | b"GREP_COLORS"
                | b"payload"
                | b"nv_payload_fields"
        ) || name.starts_with(b"BASH_FUNC_")
            || name.starts_with(b"NODE_")
            || name.starts_with(b"_nv_pf_")
            || name.starts_with(b"LD_")
            || name.starts_with(b"DYLD_")
            || value.as_encoded_bytes().starts_with(b"()")
            || name.is_empty()
            || name.contains(&b'=')
            || name.contains(&0)
            || value.as_encoded_bytes().contains(&0)
        {
            return Err(Ineligible(
                "environment modifies legacy runtime behavior".into(),
            ));
        }
    }
    if env_value(request.env, "PATH").is_none() {
        return Err(Ineligible("PATH snapshot is missing".into()));
    }
    let known = |value: &OsStr| {
        matches!(
            value.to_str(),
            Some("" | "C" | "POSIX" | "en_US.UTF-8" | "en_US.utf8" | "C.UTF-8" | "C.utf8")
        )
    };
    for (key, value) in request.env {
        if (key == "LANG" || key.as_encoded_bytes().starts_with(b"LC_")) && !known(value) {
            return Err(Ineligible("unsupported locale".into()));
        }
    }
    let effective = ["LC_ALL", "LC_CTYPE", "LANG"]
        .into_iter()
        .filter_map(|key| env_value(request.env, key))
        .find(|value| !value.is_empty());
    let utf8 = effective.is_some_and(|value| !matches!(value.to_str(), Some("C" | "POSIX")));
    let input_line = source_line(request.source, b"payload=${payload-$(cat)}")?;
    let fallback_line = source_line(
        request.source,
        br#"    printf -v "${_pf_spec%%=*}" '%s' "$(payload_field "${_pf_spec#*=}")""#,
    )?;
    Ok(Plan {
        request,
        utf8,
        input_line,
        fallback_line,
        limits,
    })
}

/// Find an exact singleton contractual source line; ambiguity is never guessed away.
fn source_line(source: &[u8], needle: &[u8]) -> Result<usize, Ineligible> {
    let mut matches = source
        .split(|byte| *byte == b'\n')
        .enumerate()
        .filter(|(_, line)| *line == needle);
    let line = matches
        .next()
        .ok_or_else(|| Ineligible("missing capture source contract".into()))?
        .0
        + 1;
    if matches.next().is_some() {
        return Err(Ineligible("ambiguous capture source contract".into()));
    }
    Ok(line)
}

/// Snapshot lookup with legacy last-assignment environment semantics.
pub fn env_value<'a>(env: &'a [(OsString, OsString)], key: &str) -> Option<&'a OsStr> {
    env.iter()
        .rev()
        .find(|(name, _)| name == key)
        .map(|(_, value)| value.as_os_str())
}

impl<'a> Plan<'a> {
    /// Validated total wall-clock budget for collection.
    pub const fn limits(&self) -> Limits {
        self.limits
    }
    /// Exact immutable caller snapshot, passed unchanged to every child.
    pub fn environment(&self) -> &[(OsString, OsString)] {
        self.request.env
    }

    /// Interpret only the fixed discovery protocol, preserving non-UTF8 path bytes.
    pub fn discover(&self, output: &Output) -> Result<Discovery, Ineligible> {
        let bytes = output.bytes()?;
        let fields: Vec<&[u8]> = bytes.split(|byte| *byte == 0).collect();
        if fields.len() != 26 || fields.last() != Some(&b"".as_slice()) {
            return Err(Ineligible("invalid discovery protocol".into()));
        }
        let shell = if fields[0].starts_with(b"3.2.") {
            ShellDialect::Bash3
        } else if fields[0].starts_with(b"5.") {
            ShellDialect::Bash5
        } else {
            return Err(Ineligible("unsupported Bash version".into()));
        };
        let mut tools = BTreeMap::new();
        for (index, tool) in Tool::ALL.into_iter().enumerate() {
            let offset = 1 + index * 3;
            if fields[offset] != tool.name().as_bytes() {
                return Err(Ineligible("invalid discovery tool".into()));
            }
            let path = match (fields[offset + 1], fields[offset + 2]) {
                (b"1", b"") => None,
                (b"0", path) if !path.is_empty() => {
                    Some(PathBuf::from(OsString::from_vec(path.to_vec())))
                }
                _ => return Err(Ineligible("tool discovery failed, not absent".into())),
            };
            if path.is_none() && !matches!(tool, Tool::Jq | Tool::Node) {
                return Err(Ineligible("required legacy text tool is absent".into()));
            }
            tools.insert(tool, path);
        }
        Ok(Discovery { shell, tools })
    }

    /// Select only existing accredited profiles after checking all original tool facts.
    pub fn prepare(&self, facts: &Facts) -> Result<Prepared<'a>, Ineligible> {
        let discovery = self.discover(&facts.bootstrap)?;
        let system = facts.system.bytes()?;
        let locale = if !self.utf8 {
            Locale::C
        } else {
            match system {
                b"Darwin\n" => Locale::Utf8,
                b"Linux\n" => Locale::GnuUtf8,
                _ => return Err(Ineligible("unsupported locale platform".into())),
            }
        };
        if !matches!(system, b"Darwin\n" | b"Linux\n") {
            return Err(Ineligible("unsupported platform".into()));
        }
        let charmap = facts.charmap.bytes()?;
        if (self.utf8 && charmap != b"UTF-8\n")
            || (!self.utf8 && !matches!(charmap, b"US-ASCII\n" | b"ANSI_X3.4-1968\n"))
        {
            return Err(Ineligible("locale charmap was not accredited".into()));
        }
        let jq = check_version(&discovery, Tool::Jq, facts.jq.as_ref(), |v| {
            matches!(v, b"jq-1.7\n" | b"jq-1.7.1-apple\n")
        })?;
        let node = check_version(&discovery, Tool::Node, facts.node.as_ref(), stable_node)?;
        if facts.text.bytes()? != expected_text(locale) {
            return Err(Ineligible(
                "legacy text behavior differs from accredited profile".into(),
            ));
        }
        let extractor = match (jq, node) {
            (true, true) => Extractor::JqAndNode,
            (true, false) => Extractor::JqOnly,
            (false, true) => Extractor::Node,
            (false, false) => Extractor::Sed,
        };
        Ok(Prepared {
            engine: self.request.engine,
            profile: Profile { extractor, locale },
            capture: CaptureContext {
                shell: discovery.shell,
                script: self.request.script,
                input_line: self.input_line,
                fallback_line: self.fallback_line,
            },
        })
    }
}

/// Only complete stable versions of the two accredited Node majors are known.
fn stable_node(version: &[u8]) -> bool {
    let Some(version) = version
        .strip_suffix(b"\n")
        .and_then(|v| v.strip_prefix(b"v"))
    else {
        return false;
    };
    let mut parts = version.split(|byte| *byte == b'.');
    let (Some(major), Some(minor), Some(patch), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return false;
    };
    let digits = |part: &[u8]| !part.is_empty() && part.iter().all(u8::is_ascii_digit);
    matches!(major, b"24" | b"26") && digits(minor) && digits(patch)
}

fn check_version(
    discovery: &Discovery,
    tool: Tool,
    fact: Option<&Output>,
    known: impl Fn(&[u8]) -> bool,
) -> Result<bool, Ineligible> {
    match (discovery.tools.get(&tool).and_then(Option::as_ref), fact) {
        (None, None) => Ok(false),
        (Some(_), Some(output)) if known(output.bytes()?) => Ok(true),
        _ => Err(Ineligible(format!(
            "{} is present but unaccredited, never absent",
            tool.name()
        ))),
    }
}

/// Synthetic membership data excludes LF (the line separator) and includes NEL/nonspace controls.
pub fn text_input() -> String {
    let mut text = String::new();
    for c in candidates() {
        text.push(c);
        text.push('\n');
    }
    text
}
fn candidates() -> impl Iterator<Item = char> {
    [
        '\t', '\u{b}', '\u{c}', '\r', ' ', '\u{85}', '\u{a0}', '\u{1680}', '\u{2000}', '\u{2001}',
        '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}', '\u{2008}',
        '\u{2009}', '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}', '\u{3000}', 'X',
    ]
    .into_iter()
}
fn expected_text(locale: Locale) -> Vec<u8> {
    let mut output = Vec::new();
    let mut count = 0;
    for (index, c) in candidates().enumerate() {
        if locale.whitespace(c) {
            output.extend_from_slice(format!("{}:{c}\n", index + 1).as_bytes());
            count += 1;
        }
    }
    output.push(0);
    output.extend_from_slice("S\n".repeat(count).as_bytes());
    output.push(0);
    output.extend_from_slice(b"a b\0x\0y\n\0");
    let input = text_input();
    let length = if locale == Locale::C {
        input.len()
    } else {
        input.chars().count()
    };
    output.extend_from_slice(length.to_string().as_bytes());
    output
}

/// Prepared evaluation remains a pure byte-input operation; construction does not activate hooks.
pub struct Prepared<'a> {
    profile: Profile,
    capture: CaptureContext<'a>,
    engine: Engine,
}
impl Prepared<'_> {
    /// Accredited immutable extraction/locale selection.
    pub const fn profile(&self) -> Profile {
        self.profile
    }
    /// Exact script identity and captured source locations for diagnostics.
    pub const fn capture(&self) -> CaptureContext<'_> {
        self.capture
    }
    /// Evaluate captured payload bytes without filesystem, subprocess or audit effects.
    pub fn evaluate(&self, payload: &[u8]) -> Result<Evaluation, Failure> {
        evaluate_with_capture(payload, self.engine, self.profile, self.capture)
    }
}
