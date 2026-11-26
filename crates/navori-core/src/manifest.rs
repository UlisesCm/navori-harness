//! Schema and validator of `crates/ported.json` (D4) and `crates/ported-history.jsonl` (D1).
//!
//! The manifest is the only authority on what `navori-rust` runs natively (R7): a command or
//! hook that is not listed is delegated to the TS CLI.

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fmt;

use serde::Deserialize;

/// The embedded `crates/ported.json` (what this build runs natively).
pub const EMBEDDED_MANIFEST: &str = include_str!("../../ported.json");

/// Schema version this validator accepts (2 added `requires`, D25).
pub const SCHEMA: u32 = 2;

/// A manifest or history entry that breaks the schema.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManifestError(String);

impl fmt::Display for ManifestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ManifestError {}

fn err<T>(message: String) -> Result<T, ManifestError> {
    Err(ManifestError(message))
}

/// Conditions read from the config; when unmet the native command re-delegates (D3).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct When {
    /// Engines the native implementation supports.
    #[serde(default)]
    pub engines: Option<Vec<String>>,
}

/// A natively implemented command.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    /// Command tokens, e.g. `["spec", "check"]` or `["--version"]`.
    pub path: Vec<String>,
    /// Normalized citty flag names (no dashes, `--no-x` counts as `x`).
    #[serde(default)]
    pub flags: Vec<String>,
    /// Alternative sets of flags, one of which the invocation must carry in full (D25, R48).
    /// `None` admits any subset of `flags`, including none.
    #[serde(default)]
    pub requires: Option<Vec<Vec<String>>>,
    /// Optional config conditions.
    #[serde(default)]
    pub when: Option<When>,
}

/// Whether a ported hook decides (`active`) or only observes (`shadow`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HookMode {
    /// The shell decides; Rust runs beside it (D9).
    Shadow,
    /// Rust decides.
    Active,
}

/// A corpus case Rust does not reproduce.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Divergence {
    /// Corpus case id.
    pub case: String,
    /// `shell-runtime` or `fail-closed`.
    pub category: String,
    /// Why the case diverges.
    pub reason: String,
    /// Requirement that justifies it, e.g. `R11`.
    pub requirement: String,
}

/// A ported hook.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hook {
    /// Shadow or active.
    pub mode: HookMode,
    /// Whether the hook decides that an action proceeds.
    pub gating: bool,
    /// `sha256:<64 hex>` per reproduced managed block.
    pub blocks: BTreeMap<String, String>,
    /// `sha256:<64 hex>` per sourced sibling script.
    #[serde(default)]
    pub deps: BTreeMap<String, String>,
    /// The build's `implHash`.
    pub r#impl: String,
    /// Cases Rust does not reproduce.
    #[serde(default)]
    pub divergences: Vec<Divergence>,
}

/// The parsed and validated `ported.json`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    /// Always [`SCHEMA`].
    pub schema: u32,
    /// Native commands.
    pub commands: Vec<Command>,
    /// Ported hooks by id.
    #[serde(default)]
    pub hooks: BTreeMap<String, Hook>,
}

impl Manifest {
    /// Parses and validates `text`.
    ///
    /// # Errors
    /// Returns the first schema violation, naming the offending entry.
    pub fn parse(text: &str) -> Result<Self, ManifestError> {
        let manifest: Self =
            serde_json::from_str(text).map_err(|e| ManifestError(format!("ported.json: {e}")))?;
        manifest.validate()?;
        Ok(manifest)
    }

    /// The manifest embedded in this build.
    ///
    /// # Errors
    /// Fails if the embedded file is invalid (caught by the crate's own tests).
    pub fn embedded() -> Result<Self, ManifestError> {
        Self::parse(EMBEDDED_MANIFEST)
    }

    /// Returns the first entry that selects an invocation by command path and flag set (D3), if
    /// any.
    ///
    /// The invocation is native only when its path starts with the entry's path, **its** flags are
    /// contained in the entry's list (an empty list admits only a flag-less invocation) and, when
    /// the entry has `requires`, it carries every flag of at least one alternative (D25).
    #[must_use]
    pub fn select(&self, path: &[String], flags: &BTreeSet<String>) -> Option<&Command> {
        self.commands.iter().find(|c| {
            path.starts_with(&c.path)
                && flags.iter().all(|flag| c.flags.contains(flag))
                && c.requires.as_ref().is_none_or(|alternatives| {
                    alternatives
                        .iter()
                        .any(|required| required.iter().all(|flag| flags.contains(flag)))
                })
        })
    }

    fn validate(&self) -> Result<(), ManifestError> {
        if self.schema != SCHEMA {
            return err(format!("ported.json: unsupported schema {}", self.schema));
        }
        let mut seen: BTreeSet<(&[String], Option<RequiresKey>)> = BTreeSet::new();
        for command in &self.commands {
            let name = command.path.join(" ");
            if command.path.is_empty() || command.path.iter().any(String::is_empty) {
                return err(format!("commands[{name}]: path needs non-empty tokens"));
            }
            validate_flags(&name, &command.flags)?;
            let requires = validate_requires(&name, command)?;
            if !seen.insert((&command.path, requires)) {
                return err(format!(
                    "commands[{name}]: duplicate path (entries of one path must differ in `requires`)"
                ));
            }
            if let Some(engines) = command.when.as_ref().and_then(|w| w.engines.as_ref())
                && (engines.is_empty() || engines.iter().any(String::is_empty))
            {
                return err(format!("commands[{name}]: when.engines needs engine names"));
            }
        }
        for (id, hook) in &self.hooks {
            validate_hook(id, hook)?;
        }
        Ok(())
    }
}

fn validate_flags(name: &str, flags: &[String]) -> Result<(), ManifestError> {
    let mut seen = BTreeSet::new();
    for flag in flags {
        let normalized = !flag.is_empty()
            && !flag.starts_with('-')
            && !flag.starts_with("no-")
            && !flag.contains(['=', ' ']);
        if !normalized {
            return err(format!(
                "commands[{name}]: flag {flag:?} is not normalized (no dashes, no `no-` prefix, no value)"
            ));
        }
        if !seen.insert(flag) {
            return err(format!("commands[{name}]: duplicate flag {flag:?}"));
        }
    }
    Ok(())
}

/// `requires` as a set of flag sets, so that alternative and flag order do not count.
type RequiresKey<'a> = BTreeSet<BTreeSet<&'a str>>;

/// Validates `requires` and returns it as a set of flag sets, the key that tells apart the entries
/// of one path: every alternative is a non-empty set of declared flags, without repeats.
fn validate_requires<'a>(
    name: &str,
    command: &'a Command,
) -> Result<Option<RequiresKey<'a>>, ManifestError> {
    let Some(alternatives) = &command.requires else {
        return Ok(None);
    };
    if alternatives.is_empty() {
        return err(format!(
            "commands[{name}]: requires needs at least one alternative"
        ));
    }
    let mut key = BTreeSet::new();
    for required in alternatives {
        let set: BTreeSet<&str> = required.iter().map(String::as_str).collect();
        if set.is_empty() || set.len() != required.len() {
            return err(format!(
                "commands[{name}]: requires alternative {required:?} must be non-empty, without repeats"
            ));
        }
        if let Some(flag) = set
            .iter()
            .find(|flag| !command.flags.iter().any(|f| f == *flag))
        {
            return err(format!(
                "commands[{name}]: required flag {flag:?} is not in flags"
            ));
        }
        if !key.insert(set) {
            return err(format!(
                "commands[{name}]: duplicate requires alternative {required:?}"
            ));
        }
    }
    Ok(Some(key))
}

/// True for `sha256:` followed by exactly 64 lowercase hex digits.
fn is_sha256(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
    })
}

fn validate_hash(what: &str, value: &str) -> Result<(), ManifestError> {
    if is_sha256(value) {
        Ok(())
    } else {
        err(format!(
            "{what}: {value:?} is not a complete `sha256:<64 hex>` hash"
        ))
    }
}

fn validate_hook(id: &str, hook: &Hook) -> Result<(), ManifestError> {
    if hook.blocks.is_empty() {
        return err(format!("hooks[{id}]: blocks must not be empty"));
    }
    for (block, hash) in &hook.blocks {
        validate_hash(&format!("hooks[{id}].blocks[{block}]"), hash)?;
    }
    for (dep, hash) in &hook.deps {
        validate_hash(&format!("hooks[{id}].deps[{dep}]"), hash)?;
    }
    validate_hash(&format!("hooks[{id}].impl"), &hook.r#impl)?;
    for divergence in &hook.divergences {
        let at = format!("hooks[{id}].divergences[{}]", divergence.case);
        if !matches!(
            divergence.category.as_str(),
            "shell-runtime" | "fail-closed"
        ) {
            return err(format!("{at}: unknown category {:?}", divergence.category));
        }
        if divergence.case.is_empty() || divergence.reason.trim().is_empty() {
            return err(format!("{at}: case and reason are required"));
        }
        let requirement_ok = divergence
            .requirement
            .strip_prefix('R')
            .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()));
        if !requirement_ok {
            return err(format!(
                "{at}: requirement {:?} is not `R<n>`",
                divergence.requirement
            ));
        }
    }
    Ok(())
}

/// Operation recorded in `ported-history.jsonl`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryOp {
    /// An entry joined the manifest.
    Port,
    /// An entry left the manifest (the safety valve of D1).
    Unport,
    /// A hook moved from `shadow` to `active`.
    Activate,
}

/// One line of `ported-history.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HistoryEvent {
    /// `YYYY-MM-DD`.
    pub date: String,
    /// What happened.
    pub op: HistoryOp,
    /// Command path (space-joined) or hook id.
    pub id: String,
    /// Why.
    pub reason: String,
    /// Pull request number.
    pub pr: u64,
}

fn is_iso_date(value: &str) -> bool {
    let parts: Vec<&str> = value.split('-').collect();
    let [year, month, day] = parts.as_slice() else {
        return false;
    };
    let digits = |s: &str, len: usize| s.len() == len && s.bytes().all(|b| b.is_ascii_digit());
    digits(year, 4)
        && digits(month, 2)
        && digits(day, 2)
        && matches!(month.parse::<u8>(), Ok(1..=12))
        && matches!(day.parse::<u8>(), Ok(1..=31))
}

/// Parses and validates the JSONL history, one event per non-empty line.
///
/// # Errors
/// Returns the first invalid line, with its 1-based number.
pub fn parse_history(text: &str) -> Result<Vec<HistoryEvent>, ManifestError> {
    let mut events = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let at = format!("ported-history.jsonl:{}", index + 1);
        let event: HistoryEvent =
            serde_json::from_str(line).map_err(|e| ManifestError(format!("{at}: {e}")))?;
        if !is_iso_date(&event.date) {
            return err(format!("{at}: date {:?} is not YYYY-MM-DD", event.date));
        }
        if event.id.is_empty() || event.reason.trim().is_empty() {
            return err(format!("{at}: id and reason are required"));
        }
        if event.pr == 0 {
            return err(format!("{at}: pr must be a positive number"));
        }
        events.push(event);
    }
    Ok(events)
}
