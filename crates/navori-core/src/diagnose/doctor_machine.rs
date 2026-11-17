//! `doctor`'s machine scans (spec 0060 T23 slice 3c, R73, R76): facts about the developer's
//! machine (binaries on `PATH`, their versions and capabilities, disk usage, the audit root, the
//! user-level `CLAUDE.md`, the workspace registry and the global `navori`), never about the repo
//! alone, so none of them flips the health verdict.
//!
//! Every child process goes through the injected [`ProcessRunner`], with the `execFileSync`
//! contract the TS relies on: the process's environment and working directory, an empty stdin, a
//! non-zero exit, a kill or more than `maxBuffer` bytes on stdout read as a throw, and stdout
//! decoded as UTF-8 with replacement characters. What the CLI knows and the core does not (the
//! process's uid, its working directory, the backup root and the running CLI's version) is
//! injected too.
//!
//! Where the TS result depends on something this port does not model (a manifest the loader
//! delegates, a state file or JSON outside the model, a home directory Node would read from the
//! password database, a sibling config that `readConfig` rejects or warns about, a path that is
//! not UTF-8), the scan returns [`Unmodeled`] and the CLI delegates to the TS.

use std::cmp::Ordering;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

use crate::config::{self, Config};
use crate::diagnose::doctor_assets::SESSION_CONTEXT_DELIVERY_BUDGET_CHARS;
use crate::diagnose::health::configured_engines;
use crate::integrity::is_js_whitespace;
use crate::js_json::JsValue;
use crate::js_re;
use crate::process::{Env, ProcessRunner, Request, has_binary};
use crate::semver;
use crate::tools::cache::machine_eligible;
use crate::tools::notice::{self, Plugins, meets_notify_level};
use crate::workspace::patterns::Unmodeled;
use crate::workspace::registry::{self, Stop, Workspace};

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/// The process `doctor` runs in: its environment, its working directory (where `PATH`'s relative
/// entries and relative registry paths resolve) and the transport for child processes.
#[derive(Clone, Copy)]
pub struct Host<'a> {
    /// `process.env`.
    pub env: &'a Env,
    /// `process.cwd()`.
    pub process_cwd: &'a Path,
    /// Runs every child process.
    pub runner: &'a dyn ProcessRunner,
}

impl Host<'_> {
    /// `hasBinary(name)`.
    fn has_binary(&self, name: &str) -> bool {
        has_binary(self.env, self.process_cwd, name)
    }

    /// `execFileSync(program, args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"],
    /// timeout })`: stdout, or `None` where the TS call throws.
    fn exec(&self, program: &str, args: &[&str], timeout: Duration) -> Option<String> {
        let output = self
            .runner
            .run(&Request {
                program,
                args,
                cwd: self.process_cwd,
                env: self.env,
                input: None,
                timeout,
            })
            .ok()?;
        if output.status.code() != Some(0) || output.stdout.len() > MAX_BUFFER {
            return None;
        }
        Some(String::from_utf8_lossy(&output.stdout).into_owned())
    }

    /// `process.env[name]`; a value that is not UTF-8 is [`Unmodeled`].
    fn var(&self, name: &str) -> Result<Option<&str>, Unmodeled> {
        self.env
            .iter()
            .rev()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.to_str().ok_or(Unmodeled))
            .transpose()
    }

    /// `process.cwd()` as text.
    fn cwd_text(&self) -> Result<&str, Unmodeled> {
        self.process_cwd.to_str().ok_or(Unmodeled)
    }

    /// `safeHomedir()`: `Ok(None)` where it throws (a relative `HOME`).
    fn home(&self) -> Result<Option<String>, Unmodeled> {
        match registry::home(self.env) {
            Ok(home) => home
                .into_os_string()
                .into_string()
                .map(Some)
                .map_err(|_| Unmodeled),
            Err(Stop::Throw) => Ok(None),
            Err(Stop::Delegate(_)) => Err(Unmodeled),
        }
    }
}

/// `execFileSync`'s default `maxBuffer`.
const MAX_BUFFER: usize = 1024 * 1024;
/// The interactive `--version` and capability probe limit (#268).
const PROBE_TIMEOUT: Duration = Duration::from_millis(5000);
/// `runGlobalNavoriVersion`'s limit.
const GLOBAL_CLI_TIMEOUT: Duration = Duration::from_millis(3000);
/// `du` runs without a limit in the TS; a day stands in for "never".
const DU_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

/// Any registry or manifest stop: a TS throw these scans do not catch, or a delegated branch.
const fn unmodeled(_: Stop) -> Unmodeled {
    Unmodeled
}

/// `value[key]` on a plain object.
fn get<'a>(value: &'a JsValue, key: &str) -> Option<&'a JsValue> {
    match value {
        JsValue::Object(object) => object.get(key),
        _ => None,
    }
}

/// JS truthiness of a JSON value (`undefined` for an absent key).
fn truthy(value: Option<&JsValue>) -> bool {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => false,
        Some(JsValue::Bool(flag)) => *flag,
        Some(JsValue::Number(number)) => *number != 0.0 && !number.is_nan(),
        Some(JsValue::String(text)) => !text.units().is_empty(),
        Some(JsValue::Array(_) | JsValue::Object(_)) => true,
    }
}

/// A string-typed field: absent, `undefined` and `null` are `None`, any other type is
/// [`Unmodeled`].
fn text(value: Option<&JsValue>) -> Result<Option<String>, Unmodeled> {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => Ok(None),
        Some(JsValue::String(text)) => text.to_rust().map(Some).ok_or(Unmodeled),
        Some(_) => Err(Unmodeled),
    }
}

/// An array of strings; absent is empty, anything else is [`Unmodeled`].
fn texts(value: Option<&JsValue>) -> Result<Vec<String>, Unmodeled> {
    match value {
        None | Some(JsValue::Undefined | JsValue::Null) => Ok(Vec::new()),
        Some(JsValue::Array(items)) => items
            .iter()
            .map(|item| text(Some(item))?.ok_or(Unmodeled))
            .collect(),
        Some(_) => Err(Unmodeled),
    }
}

/// Array `.sort()` with no comparator: UTF-16 code-unit order.
fn js_sort(items: &mut [String]) {
    items.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `path.join(base, name)` for an absolute, normalized `base`.
fn join_text(base: &str, name: &str) -> String {
    if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

/// The first `\d+\.\d+\.\d+` of `text`.
fn first_version(text: &str) -> Option<String> {
    static VERSION: LazyLock<Option<Regex>> =
        LazyLock::new(|| Regex::new("[0-9]+\\.[0-9]+\\.[0-9]+").ok());
    VERSION
        .as_ref()
        .and_then(|re| re.find(text))
        .map(|found| found.as_str().to_owned())
}

/// `currentPlatform()`: the OS as a key of an `externalTool.install` matrix.
const fn current_platform() -> Option<&'static str> {
    if cfg!(target_os = "macos") {
        Some("darwin")
    } else if cfg!(target_os = "linux") {
        Some("linux")
    } else if cfg!(windows) {
        Some("win32")
    } else {
        None
    }
}

/// `(platform ? tool.install?.[platform] : undefined) ?? null`.
fn install_command(tool: &JsValue) -> Result<Option<String>, Unmodeled> {
    let Some(platform) = current_platform() else {
        return Ok(None);
    };
    match get(tool, "install") {
        None | Some(JsValue::Undefined | JsValue::Null) => Ok(None),
        Some(install @ JsValue::Object(_)) => text(get(install, platform)),
        Some(_) => Err(Unmodeled),
    }
}

/// `loadPlugin(id).manifest.externalTool` with a truthy `checkBinary`: `(tool, binary)`, or
/// `None` when the plugin is unknown or declares no binary to check.
fn checked_tool(plugins: &mut Plugins, id: &str) -> Result<Option<(JsValue, String)>, Unmodeled> {
    let Some(tool) = plugins.tool(id).map_err(unmodeled)? else {
        return Ok(None);
    };
    if matches!(tool, JsValue::Undefined | JsValue::Null) {
        return Ok(None);
    }
    match text(get(&tool, "checkBinary"))? {
        Some(binary) if !binary.is_empty() => Ok(Some((tool, binary))),
        _ => Ok(None),
    }
}

// ---------------------------------------------------------------------------------------------
// External tools: presence, versions, capabilities and releases
// ---------------------------------------------------------------------------------------------

/// `MissingExternalTool`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingExternalTool {
    /// The plugin that declares the tool.
    pub plugin_id: String,
    /// `externalTool.checkBinary`.
    pub binary: String,
    /// The install command for this platform.
    pub install: Option<String>,
    /// `externalTool.postInstall`.
    pub post_install: Option<String>,
    /// `externalTool.installDocs`.
    pub install_docs: Option<String>,
}

/// `scanMissingExternalTools(config)`: enabled plugins whose `checkBinary` is not on `PATH`.
///
/// # Errors
/// [`Unmodeled`] for a manifest only the TS loads.
pub fn scan_missing_external_tools(
    host: &Host<'_>,
    config: &Config,
    plugins: &mut Plugins,
) -> Result<Vec<MissingExternalTool>, Unmodeled> {
    let mut missing = Vec::new();
    for id in notice::enabled(config) {
        let Some((tool, binary)) = checked_tool(plugins, &id)? else {
            continue;
        };
        if host.has_binary(&binary) {
            continue;
        }
        missing.push(MissingExternalTool {
            plugin_id: id,
            binary,
            install: install_command(&tool)?,
            post_install: text(get(&tool, "postInstall"))?,
            install_docs: text(get(&tool, "installDocs"))?,
        });
    }
    Ok(missing)
}

/// `InstalledToolVersion`: an enabled plugin's tool on `PATH` with a parseable `--version`.
#[derive(Debug, Clone, PartialEq)]
pub struct InstalledToolVersion {
    /// The plugin id.
    pub plugin_id: String,
    /// `externalTool.checkBinary`.
    pub binary: String,
    /// `externalTool`.
    pub tool: JsValue,
    /// The first `x.y.z` of `--version`.
    pub installed_version: String,
    /// The install command for this platform.
    pub install: Option<String>,
}

/// `probeEnabledToolVersions(config, wants)` without a budget: `wants` is asked before
/// `hasBinary`, and an absent binary or a failing or unparseable `--version` stays silent.
///
/// # Errors
/// [`Unmodeled`] for a manifest only the TS loads, or from `wants`.
pub fn probe_enabled_tool_versions(
    host: &Host<'_>,
    config: &Config,
    plugins: &mut Plugins,
    wants: &mut dyn FnMut(&JsValue, &str) -> Result<bool, Unmodeled>,
) -> Result<Vec<InstalledToolVersion>, Unmodeled> {
    let mut found = Vec::new();
    for id in notice::enabled(config) {
        let Some((tool, binary)) = checked_tool(plugins, &id)? else {
            continue;
        };
        if !wants(&tool, &id)? || !host.has_binary(&binary) {
            continue;
        }
        let Some(raw) = host.exec(&binary, &["--version"], PROBE_TIMEOUT) else {
            continue;
        };
        let Some(installed_version) = first_version(&raw) else {
            continue;
        };
        found.push(InstalledToolVersion {
            plugin_id: id,
            binary,
            install: install_command(&tool)?,
            tool,
            installed_version,
        });
    }
    Ok(found)
}

/// `PinnedVersionDrift`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinnedVersionDrift {
    /// The plugin id.
    pub plugin_id: String,
    /// `externalTool.checkBinary`.
    pub binary: String,
    /// What `--version` reported.
    pub installed_version: String,
    /// `externalTool.pinnedVersion`.
    pub pinned_version: String,
    /// The install command for this platform.
    pub install: Option<String>,
}

/// `scanPinnedVersionDrift(config)`: installed tools whose version differs from the manifest pin.
///
/// # Errors
/// As [`probe_enabled_tool_versions`].
pub fn scan_pinned_version_drift(
    host: &Host<'_>,
    config: &Config,
    plugins: &mut Plugins,
) -> Result<Vec<PinnedVersionDrift>, Unmodeled> {
    let mut wants = |tool: &JsValue, _: &str| Ok(truthy(get(tool, "pinnedVersion")));
    let mut drifts = Vec::new();
    for found in probe_enabled_tool_versions(host, config, plugins, &mut wants)? {
        let Some(pinned_version) = text(get(&found.tool, "pinnedVersion"))? else {
            continue;
        };
        if pinned_version.is_empty() || found.installed_version == pinned_version {
            continue;
        }
        drifts.push(PinnedVersionDrift {
            plugin_id: found.plugin_id,
            binary: found.binary,
            installed_version: found.installed_version,
            pinned_version,
            install: found.install,
        });
    }
    Ok(drifts)
}

/// `VersionAdvisoryHit`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VersionAdvisoryHit {
    /// The plugin id.
    pub plugin_id: String,
    /// `externalTool.checkBinary`.
    pub binary: String,
    /// What `--version` reported.
    pub installed_version: String,
    /// Exclusive floor: the first release without the problem.
    pub below: String,
    /// `reason.es`.
    pub reason_es: String,
    /// `reason.en`.
    pub reason_en: String,
    /// `ref`.
    pub reference: Option<String>,
}

/// `scanVersionAdvisories(config)`: every advisory whose exclusive floor the installed version is
/// below.
///
/// # Errors
/// As [`probe_enabled_tool_versions`]; [`Unmodeled`] for an advisory outside the schema.
pub fn scan_version_advisories(
    host: &Host<'_>,
    config: &Config,
    plugins: &mut Plugins,
) -> Result<Vec<VersionAdvisoryHit>, Unmodeled> {
    let mut wants = |tool: &JsValue, _: &str| {
        Ok(matches!(get(tool, "versionAdvisory"), Some(JsValue::Array(items)) if !items.is_empty()))
    };
    let mut hits = Vec::new();
    for found in probe_enabled_tool_versions(host, config, plugins, &mut wants)? {
        let Some(JsValue::Array(advisories)) = get(&found.tool, "versionAdvisory") else {
            continue;
        };
        for advisory in advisories {
            let below = text(get(advisory, "below"))?.ok_or(Unmodeled)?;
            if semver::compare(Some(&found.installed_version), Some(&below)) != Some(Ordering::Less)
            {
                continue;
            }
            let reason = get(advisory, "reason").ok_or(Unmodeled)?;
            hits.push(VersionAdvisoryHit {
                plugin_id: found.plugin_id.clone(),
                binary: found.binary.clone(),
                installed_version: found.installed_version.clone(),
                below,
                reason_es: text(get(reason, "es"))?.ok_or(Unmodeled)?,
                reason_en: text(get(reason, "en"))?.ok_or(Unmodeled)?,
                reference: text(get(advisory, "ref"))?,
            });
        }
    }
    Ok(hits)
}

/// `ExternalToolCapabilityGap`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalToolCapabilityGap {
    /// The plugin id.
    pub plugin_id: String,
    /// `externalTool.checkBinary`.
    pub binary: String,
    /// `capabilityProbe.mustContain` entries absent from the probe's output.
    pub missing: Vec<String>,
    /// `capabilityProbe.minVersion` (display-only).
    pub min_version: String,
    /// The install command for this platform.
    pub install: Option<String>,
}

/// One plugin of `scanExternalToolCapabilities`: run `capabilityProbe` when the binary is present
/// and report the needles its stdout lacks. A failing probe stays silent.
///
/// # Errors
/// [`Unmodeled`] for a probe outside the schema.
pub fn capability_gap(
    host: &Host<'_>,
    plugin_id: &str,
    tool: &JsValue,
    binary: &str,
) -> Result<Option<ExternalToolCapabilityGap>, Unmodeled> {
    let probe = match get(tool, "capabilityProbe") {
        None | Some(JsValue::Undefined | JsValue::Null) => return Ok(None),
        Some(probe) => probe,
    };
    if !host.has_binary(binary) {
        return Ok(None);
    }
    let args = texts(get(probe, "args"))?;
    let must_contain = texts(get(probe, "mustContain"))?;
    let min_version = text(get(probe, "minVersion"))?.ok_or(Unmodeled)?;
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let Some(out) = host.exec(binary, &args, PROBE_TIMEOUT) else {
        return Ok(None);
    };
    let missing: Vec<String> = must_contain
        .into_iter()
        .filter(|needle| !out.contains(needle.as_str()))
        .collect();
    if missing.is_empty() {
        return Ok(None);
    }
    Ok(Some(ExternalToolCapabilityGap {
        plugin_id: plugin_id.to_owned(),
        binary: binary.to_owned(),
        missing,
        min_version,
        install: install_command(tool)?,
    }))
}

/// `scanExternalToolCapabilities(config)`.
///
/// # Errors
/// [`Unmodeled`] for a manifest only the TS loads or a probe outside the schema.
pub fn scan_external_tool_capabilities(
    host: &Host<'_>,
    config: &Config,
    plugins: &mut Plugins,
) -> Result<Vec<ExternalToolCapabilityGap>, Unmodeled> {
    let mut gaps = Vec::new();
    for id in notice::enabled(config) {
        let Some((tool, binary)) = checked_tool(plugins, &id)? else {
            continue;
        };
        gaps.extend(capability_gap(host, &id, &tool, &binary)?);
    }
    Ok(gaps)
}

/// `ToolUpdate`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolUpdate {
    /// The plugin id.
    pub plugin_id: String,
    /// `externalTool.checkBinary`.
    pub binary: String,
    /// What `--version` reported.
    pub installed_version: String,
    /// The cached latest release.
    pub latest_version: String,
}

/// A fresh cached release the refresh could not parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnparseableRelease {
    /// The plugin id.
    pub plugin_id: String,
    /// `latestRelease.source`.
    pub source: String,
    /// `latestRelease.id`.
    pub id: String,
}

/// `scanToolUpdates(config)`'s result.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ToolUpdates {
    /// Installed tools behind their cached latest release by the manifest's `notify` level.
    pub updates: Vec<ToolUpdate>,
    /// Enabled plugins whose fresh cached release is `unparseable`.
    pub unparseable: Vec<UnparseableRelease>,
}

/// `scanToolUpdates(config)` as `doctor` calls it: cache only, no dedupe, no probe budget.
///
/// # Errors
/// [`Unmodeled`] for a manifest or a state file only the TS reads, or an unusable `HOME`.
pub fn scan_tool_updates(
    host: &Host<'_>,
    config: &Config,
    plugins: &mut Plugins,
) -> Result<ToolUpdates, Unmodeled> {
    if !machine_eligible(host.env) {
        return Ok(ToolUpdates::default());
    }
    let latest = notice::cached_latest(host.env, plugins).map_err(unmodeled)?;
    let enabled = notice::enabled(config);
    let unparseable = latest
        .iter()
        .filter(|entry| entry.version.is_none() && enabled.contains(&entry.plugin_id))
        .map(|entry| UnparseableRelease {
            plugin_id: entry.plugin_id.clone(),
            source: entry.release.source.clone(),
            id: entry.release.id.clone(),
        })
        .collect();
    let fresh = |id: &str| latest.iter().find(|entry| entry.plugin_id == id);
    let mut wants = |_: &JsValue, id: &str| Ok(fresh(id).is_some_and(|e| e.version.is_some()));
    let mut updates = Vec::new();
    for found in probe_enabled_tool_versions(host, config, plugins, &mut wants)? {
        let Some(entry) = fresh(&found.plugin_id) else {
            continue;
        };
        let Some(version) = &entry.version else {
            continue;
        };
        if !meets_notify_level(&found.installed_version, version, &entry.release.notify) {
            continue;
        }
        updates.push(ToolUpdate {
            plugin_id: found.plugin_id,
            binary: found.binary,
            installed_version: found.installed_version,
            latest_version: version.clone(),
        });
    }
    Ok(ToolUpdates {
        updates,
        unparseable,
    })
}

/// `MissingOptionalTool`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MissingOptionalTool {
    /// The skill the tool sharpens.
    pub id: &'static str,
    /// Any of these on `PATH` counts as installed.
    pub binaries: &'static [&'static str],
    /// The install command.
    pub install: &'static str,
}

/// `scanMissingOptionalTools()`: `ast-grep` for `locate-code` (never its `sg` alias, #495).
#[must_use]
pub fn scan_missing_optional_tools(host: &Host<'_>) -> Vec<MissingOptionalTool> {
    const BINARIES: &[&str] = &["ast-grep"];
    if BINARIES.iter().any(|binary| host.has_binary(binary)) {
        return Vec::new();
    }
    vec![MissingOptionalTool {
        id: "locate-code",
        binaries: BINARIES,
        install: "npm install --global @ast-grep/cli",
    }]
}

// ---------------------------------------------------------------------------------------------
// Disk usage, audit root and the user-level CLAUDE.md
// ---------------------------------------------------------------------------------------------

/// `DiskUsageTarget`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiskUsageTarget {
    /// `~/.navori/backups` (or `NAVORI_BACKUP_ROOT`).
    Backups,
    /// `<cwd>/.claude/worktrees`.
    Worktrees,
}

/// `DiskUsageIssue`.
#[derive(Debug, Clone, PartialEq)]
pub struct DiskUsageIssue {
    /// Which directory crossed its threshold.
    pub target: DiskUsageTarget,
    /// The measured directory.
    pub path: PathBuf,
    /// Allocated bytes, as `du -sk` reports them times 1024.
    pub bytes: f64,
    /// The threshold it crossed.
    pub threshold_bytes: f64,
}

/// `DEFAULT_BACKUPS_THRESHOLD_BYTES`: 1 GiB.
pub const DEFAULT_BACKUPS_THRESHOLD_BYTES: f64 = 1024.0 * 1024.0 * 1024.0;
/// `DEFAULT_WORKTREES_THRESHOLD_BYTES`: 2 GiB.
pub const DEFAULT_WORKTREES_THRESHOLD_BYTES: f64 = 2.0 * 1024.0 * 1024.0 * 1024.0;

/// `Number.parseInt(text, 10)`: optional sign, then the leading ASCII digits; `None` for `NaN`.
fn parse_int(text: &str) -> Option<f64> {
    let text = text.trim_start_matches(is_js_whitespace);
    let (negative, rest) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let end = rest
        .bytes()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(rest.len());
    let value = rest[..end].parse::<f64>().ok()?;
    Some(if negative { -value } else { value })
}

/// `duBytes(path)`: `None` when `du` fails or its first field is not a non-negative integer.
fn du_bytes(host: &Host<'_>, path: &str) -> Option<f64> {
    let out = host.exec("du", &["-sk", path], DU_TIMEOUT)?;
    let first = out
        .trim_matches(is_js_whitespace)
        .split(is_js_whitespace)
        .next()
        .unwrap_or_default();
    let kib = parse_int(first)?;
    (kib.is_finite() && kib >= 0.0).then_some(kib * 1024.0)
}

/// `scanDiskUsage(cwd)` with the default thresholds; `backup_root` is `backupRoot()`.
///
/// # Errors
/// [`Unmodeled`] for a measured path that is not UTF-8.
pub fn scan_disk_usage(
    host: &Host<'_>,
    cwd: &Path,
    backup_root: &Path,
) -> Result<Vec<DiskUsageIssue>, Unmodeled> {
    let targets = [
        (
            DiskUsageTarget::Backups,
            backup_root.to_path_buf(),
            DEFAULT_BACKUPS_THRESHOLD_BYTES,
        ),
        (
            DiskUsageTarget::Worktrees,
            cwd.join(".claude").join("worktrees"),
            DEFAULT_WORKTREES_THRESHOLD_BYTES,
        ),
    ];
    let mut issues = Vec::new();
    for (target, path, threshold_bytes) in targets {
        if !path.exists() {
            continue;
        }
        let Some(bytes) = du_bytes(host, path.to_str().ok_or(Unmodeled)?) else {
            continue;
        };
        if bytes <= threshold_bytes {
            continue;
        }
        issues.push(DiskUsageIssue {
            target,
            path,
            bytes,
            threshold_bytes,
        });
    }
    Ok(issues)
}

/// The audit root and its repo directories open to group or other.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuditRootOpen {
    /// `auditsRoot()`.
    pub root: PathBuf,
    /// The open directories, the root first, then its children in `readdir` order.
    pub paths: Vec<PathBuf>,
}

/// `auditsRoot()`: `Ok(None)` where it throws (a relative override, a relative `HOME`).
fn audits_root(host: &Host<'_>) -> Result<Option<PathBuf>, Unmodeled> {
    let trimmed = host
        .var("NAVORI_AUDITS_ROOT")?
        .map(|v| v.trim_matches(is_js_whitespace));
    if let Some(override_root) = trimmed.filter(|v| !v.is_empty()) {
        if !override_root.starts_with('/') {
            return Ok(None);
        }
        return Ok(Some(PathBuf::from(registry::resolve("/", override_root))));
    }
    Ok(host
        .home()?
        .map(|home| PathBuf::from(home).join(".navori").join("audits")))
}

/// `scanAuditRootPermissions()`: lstat only. `uid` is `process.getuid()`.
///
/// # Errors
/// [`Unmodeled`] for an environment value that is not UTF-8 or a `HOME` Node reads elsewhere.
pub fn scan_audit_root_permissions(
    host: &Host<'_>,
    uid: u32,
) -> Result<Option<AuditRootOpen>, Unmodeled> {
    use std::os::unix::fs::MetadataExt as _;
    let Some(base) = audits_root(host)? else {
        return Ok(None);
    };
    let mut open = Vec::new();
    let mut inspect = |path: &Path| -> bool {
        let Ok(meta) = std::fs::symlink_metadata(path) else {
            return false;
        };
        if meta.is_dir() && meta.uid() == uid && meta.mode() & 0o077 != 0 {
            open.push(path.to_path_buf());
        }
        meta.is_dir()
    };
    if !inspect(&base) {
        return Ok(None);
    }
    if let Ok(read) = std::fs::read_dir(&base) {
        let mut entries: Vec<_> = read.filter_map(Result::ok).collect();
        entries.sort_by(|a, b| {
            a.file_name()
                .as_encoded_bytes()
                .cmp(b.file_name().as_encoded_bytes())
        });
        for entry in entries {
            if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                inspect(&base.join(entry.file_name()));
            }
        }
    }
    Ok((!open.is_empty()).then_some(AuditRootOpen {
        root: base,
        paths: open,
    }))
}

/// `GlobalClaudeMdIssue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalClaudeMdIssue {
    /// The measured file, the home directory shortened to `~`.
    pub path: String,
    /// Size in UTF-16 code units.
    pub chars: usize,
    /// The threshold it crossed.
    pub threshold_chars: usize,
}

/// `GLOBAL_CLAUDE_MD_SOFT_CAP_CHARS`.
pub const GLOBAL_CLAUDE_MD_SOFT_CAP_CHARS: usize = SESSION_CONTEXT_DELIVERY_BUDGET_CHARS / 4;

/// `claudeUserDir()`: `Ok(None)` where it throws.
fn claude_user_dir(host: &Host<'_>) -> Result<Option<String>, Unmodeled> {
    if let Some(dir) = host.var("CLAUDE_CONFIG_DIR")? {
        let trimmed = dir.trim_matches(is_js_whitespace);
        if !trimmed.is_empty() {
            return Ok(Some(registry::resolve(host.cwd_text()?, trimmed)));
        }
    }
    Ok(host
        .home()?
        .map(|home| registry::resolve("/", &join_text(&home, ".claude"))))
}

/// `scanGlobalClaudeMd(thresholdChars)`: the user-level `CLAUDE.md` when it exceeds the threshold.
///
/// # Errors
/// [`Unmodeled`] for an environment value that is not UTF-8 or a `HOME` Node reads elsewhere.
pub fn scan_global_claude_md(
    host: &Host<'_>,
    threshold_chars: usize,
) -> Result<Option<GlobalClaudeMdIssue>, Unmodeled> {
    let Some(dir) = claude_user_dir(host)? else {
        return Ok(None);
    };
    let file = join_text(&dir, "CLAUDE.md");
    let Ok(bytes) = std::fs::read(&file) else {
        return Ok(None);
    };
    let chars = String::from_utf8_lossy(&bytes).encode_utf16().count();
    if chars <= threshold_chars {
        return Ok(None);
    }
    let path = match host.home()? {
        Some(home) => match file.strip_prefix(&format!("{home}/")) {
            Some(rest) => format!("~/{rest}"),
            None => file,
        },
        None => file,
    };
    Ok(Some(GlobalClaudeMdIssue {
        path,
        chars,
        threshold_chars,
    }))
}

// ---------------------------------------------------------------------------------------------
// Workspace registry
// ---------------------------------------------------------------------------------------------

/// `WorkspaceLinkIssue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkspaceLinkIssue {
    /// The declared workspace is not in this machine's registry (or does not load).
    WorkspaceMissing {
        /// The declared workspace.
        workspace: String,
    },
    /// The declared workspace lists neither this checkout nor this repo's name.
    RepoNotRegistered {
        /// The declared workspace.
        workspace: String,
    },
    /// The declared workspace lists this repo's name under another path.
    PathMismatch {
        /// The declared workspace.
        workspace: String,
        /// The repo's name.
        repo_name: String,
        /// The path the registry holds.
        registered_path: String,
    },
    /// No workspace is declared, yet one lists this repo's name under another path.
    UndeclaredPathMismatch {
        /// The workspace that lists it.
        workspace: String,
        /// The repo's name.
        repo_name: String,
        /// The path the registry holds.
        registered_path: String,
    },
}

/// `config[key]` as a string; a falsy one is `None`.
fn config_text(config: &Config, key: &str) -> Result<Option<String>, Unmodeled> {
    Ok(text(get(&config.data, key))?.filter(|value| !value.is_empty()))
}

/// `loadWorkspace(name)` where a throw means `None`.
fn load_tolerant(host: &Host<'_>, name: &str) -> Result<Option<Workspace>, Unmodeled> {
    match registry::load(host.env, name) {
        Ok(workspace) => Ok(workspace),
        Err(Stop::Throw) => Ok(None),
        Err(Stop::Delegate(_)) => Err(Unmodeled),
    }
}

/// `canonicalPath(input)`, relative inputs read from the process's working directory.
fn canonical(host: &Host<'_>, input: &str) -> Result<String, Unmodeled> {
    registry::canonical(host.cwd_text()?, input).map_err(unmodeled)
}

/// `ws.repos` as `(name, path)`.
fn repos(workspace: &Workspace) -> impl Iterator<Item = (&String, &String)> {
    workspace.repo_names.iter().zip(&workspace.repo_paths)
}

/// Whether any repo of `workspace` canonicalizes to `here`.
fn lists_path(host: &Host<'_>, workspace: &Workspace, here: &str) -> Result<bool, Unmodeled> {
    for path in &workspace.repo_paths {
        if canonical(host, path)? == here {
            return Ok(true);
        }
    }
    Ok(false)
}

/// `scanWorkspaceLink(cwd, config)`.
///
/// # Errors
/// [`Unmodeled`] for a registry branch only the TS reads, or a path that is not UTF-8.
pub fn scan_workspace_link(
    host: &Host<'_>,
    cwd: &Path,
    config: &Config,
) -> Result<Option<WorkspaceLinkIssue>, Unmodeled> {
    let here = canonical(host, cwd.to_str().ok_or(Unmodeled)?)?;
    let repo_name = text(get(&config.data, "name"))?;
    let Some(name) = config_text(config, "workspace")? else {
        return scan_undeclared_workspace_link(host, &here, repo_name.as_deref());
    };
    let Some(workspace) = load_tolerant(host, &name)? else {
        return Ok(Some(WorkspaceLinkIssue::WorkspaceMissing {
            workspace: name,
        }));
    };
    if lists_path(host, &workspace, &here)? {
        return Ok(None);
    }
    if let Some((by_name, path)) =
        repos(&workspace).find(|(n, _)| Some(n.as_str()) == repo_name.as_deref())
    {
        return Ok(Some(WorkspaceLinkIssue::PathMismatch {
            workspace: name,
            repo_name: by_name.clone(),
            registered_path: path.clone(),
        }));
    }
    Ok(Some(WorkspaceLinkIssue::RepoNotRegistered {
        workspace: name,
    }))
}

/// `scanUndeclaredWorkspaceLink(cwd, config)`.
fn scan_undeclared_workspace_link(
    host: &Host<'_>,
    here: &str,
    repo_name: Option<&str>,
) -> Result<Option<WorkspaceLinkIssue>, Unmodeled> {
    for name in registry::list(host.env).map_err(unmodeled)? {
        let Some(workspace) = load_tolerant(host, &name)? else {
            continue;
        };
        if lists_path(host, &workspace, here)? {
            continue;
        }
        if let Some((by_name, path)) =
            repos(&workspace).find(|(n, _)| Some(n.as_str()) == repo_name)
        {
            return Ok(Some(WorkspaceLinkIssue::UndeclaredPathMismatch {
                workspace: name,
                repo_name: by_name.clone(),
                registered_path: path.clone(),
            }));
        }
    }
    Ok(None)
}

/// `WorkspaceDeadReposIssue`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceDeadReposIssue {
    /// The workspace.
    pub workspace: String,
    /// Its other repos whose registered path is gone, as `(name, path)`.
    pub repos: Vec<(String, String)>,
}

/// `scanWorkspaceDeadRepos(cwd, config)`.
///
/// # Errors
/// [`Unmodeled`] for a registry branch only the TS reads, or a path that is not UTF-8.
pub fn scan_workspace_dead_repos(
    host: &Host<'_>,
    cwd: &Path,
    config: &Config,
) -> Result<Vec<WorkspaceDeadReposIssue>, Unmodeled> {
    let here = canonical(host, cwd.to_str().ok_or(Unmodeled)?)?;
    let repo_name = text(get(&config.data, "name"))?;
    let declared = text(get(&config.data, "workspace"))?;
    let mut issues = Vec::new();
    for name in registry::list(host.env).map_err(unmodeled)? {
        let Some(workspace) = load_tolerant(host, &name)? else {
            continue;
        };
        let mut member = declared.as_deref() == Some(name.as_str());
        for (repo, path) in repos(&workspace) {
            if member {
                break;
            }
            member = Some(repo.as_str()) == repo_name.as_deref() || canonical(host, path)? == here;
        }
        if !member {
            continue;
        }
        let mut dead = Vec::new();
        for (repo, path) in repos(&workspace) {
            if Some(repo.as_str()) == repo_name.as_deref()
                || canonical(host, path)? == here
                || host.process_cwd.join(path).exists()
            {
                continue;
            }
            dead.push((repo.clone(), path.clone()));
        }
        if !dead.is_empty() {
            issues.push(WorkspaceDeadReposIssue {
                workspace: name,
                repos: dead,
            });
        }
    }
    Ok(issues)
}

/// `WorkspaceDriftItem`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceDriftItem {
    /// Config key, e.g. `branchBase` or `plugins.tgrep`.
    pub key: String,
    /// This repo's value (`—` when absent).
    pub local: String,
    /// The value it is expected to have.
    pub expected: String,
    /// Siblings declaring `expected`; 0 for a defaults comparison.
    pub agree: usize,
    /// Siblings compared; 0 for a defaults comparison.
    pub total: usize,
}

/// `WorkspaceDriftReport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceDriftReport {
    /// The declared workspace.
    pub workspace: String,
    /// Divergences from the manifest's `defaults`.
    pub vs_defaults: Vec<WorkspaceDriftItem>,
    /// Divergences from what most sibling repos declare.
    pub vs_siblings: Vec<WorkspaceDriftItem>,
    /// Sibling configs found and parsed.
    pub siblings_read: usize,
}

/// `UNDECLARED`.
const UNDECLARED: &str = "\u{2014}";
/// `DISABLED`.
const DISABLED: &str = "disabled";
/// `MIN_SIBLINGS`.
const MIN_SIBLINGS: usize = 2;

/// `configFacts(config)`: a `Map` in insertion order, `None` for an `undefined` value.
type Facts = Vec<(String, Option<String>)>;

fn fact<'a>(facts: &'a Facts, key: &str) -> &'a str {
    facts
        .iter()
        .find(|(k, _)| k == key)
        .and_then(|(_, v)| v.as_deref())
        .unwrap_or(UNDECLARED)
}

/// `[...engines].sort().join(",")`.
fn engines_fact(mut engines: Vec<String>) -> String {
    js_sort(&mut engines);
    engines.join(",")
}

fn config_facts(config: &Config) -> Result<Facts, Unmodeled> {
    let data = &config.data;
    let branch_base = text(get(data, "branchBase"))?;
    let pr_target = text(get(data, "prTarget"))?.or_else(|| branch_base.clone());
    let declared = |key: &str| {
        Some(
            if truthy(get(data, key)) {
                "declared"
            } else {
                UNDECLARED
            }
            .to_owned(),
        )
    };
    let mut facts: Facts = vec![
        ("branchBase".to_owned(), branch_base),
        ("prTarget".to_owned(), pr_target),
        ("commits".to_owned(), text(get(data, "commits"))?),
        ("language".to_owned(), text(get(data, "language"))?),
        (
            "engines".to_owned(),
            Some(engines_fact(texts(get(data, "engines"))?)),
        ),
        ("models".to_owned(), declared("models")),
        ("effort".to_owned(), declared("effort")),
    ];
    if let Some(JsValue::Object(plugins)) = get(data, "plugins") {
        for (id, entry) in plugins.ordered() {
            let id = id.to_rust().ok_or(Unmodeled)?;
            match get(entry, "enabled") {
                Some(JsValue::Bool(true)) => {
                    facts.push((format!("plugins.{id}"), Some("enabled".to_owned())))
                }
                Some(JsValue::Bool(false)) => {
                    facts.push((format!("plugins.{id}"), Some(DISABLED.to_owned())))
                }
                _ => {}
            }
        }
    }
    Ok(facts)
}

/// `readRepoConfig(repoPath)`: `None` without a config or where `readConfig` throws; a config
/// the port would not read the way the TS does (or one `readConfig` warns about on stderr) is
/// [`Unmodeled`].
fn read_repo_config(host: &Host<'_>, repo_path: &str) -> Result<Option<Config>, Unmodeled> {
    let path = host.process_cwd.join(repo_path).join("navori.config.json");
    if !path.exists() {
        return Ok(None);
    }
    let Ok(bytes) = std::fs::read(&path) else {
        return Ok(None);
    };
    match config::read(&bytes) {
        Ok(sibling) if sibling.warnings.is_empty() => Ok(Some(sibling)),
        Err(config::Delegate::RetiredKeys) => Ok(None),
        Ok(_) | Err(_) => Err(Unmodeled),
    }
}

fn drift_vs_defaults(facts: &Facts, workspace: &Workspace) -> Vec<WorkspaceDriftItem> {
    let defaults = &workspace.defaults;
    let mut expected: Vec<(String, Option<String>)> = vec![
        ("branchBase".to_owned(), defaults.branch_base.clone()),
        ("prTarget".to_owned(), defaults.pr_target.clone()),
        ("commits".to_owned(), defaults.commits.clone()),
        ("language".to_owned(), workspace.language.clone()),
        (
            "engines".to_owned(),
            defaults.engines.clone().map(engines_fact),
        ),
    ];
    for (id, enabled) in &defaults.plugins {
        if *enabled {
            expected.push((format!("plugins.{id}"), Some("enabled".to_owned())));
        }
    }
    expected
        .into_iter()
        .filter_map(|(key, expected)| {
            let expected = expected?;
            let local = fact(facts, &key);
            (local != expected).then(|| WorkspaceDriftItem {
                local: local.to_owned(),
                key,
                expected,
                agree: 0,
                total: 0,
            })
        })
        .collect()
}

fn drift_vs_siblings(facts: &Facts, siblings: &[Facts]) -> Vec<WorkspaceDriftItem> {
    if siblings.len() < MIN_SIBLINGS {
        return Vec::new();
    }
    let mut keys: Vec<String> = Vec::new();
    for sibling in siblings {
        for (key, _) in sibling {
            if !keys.contains(key) {
                keys.push(key.clone());
            }
        }
    }
    js_sort(&mut keys);
    let mut out = Vec::new();
    for key in keys {
        let mut tally: Vec<(&str, usize)> = Vec::new();
        for sibling in siblings {
            let value = fact(sibling, &key);
            match tally.iter_mut().find(|(v, _)| *v == value) {
                Some((_, count)) => *count += 1,
                None => tally.push((value, 1)),
            }
        }
        let mut expected = UNDECLARED;
        let mut agree = 0;
        for (value, count) in tally {
            if count > agree {
                expected = value;
                agree = count;
            }
        }
        if expected == UNDECLARED || agree * 2 <= siblings.len() {
            continue;
        }
        let local = fact(facts, &key);
        if local == expected || local == DISABLED || expected == DISABLED {
            continue;
        }
        out.push(WorkspaceDriftItem {
            local: local.to_owned(),
            expected: expected.to_owned(),
            key,
            agree,
            total: siblings.len(),
        });
    }
    out
}

/// `scanWorkspaceDrift(cwd, config)`.
///
/// # Errors
/// [`Unmodeled`] for a registry branch or a sibling config only the TS reads, or a path that is
/// not UTF-8.
pub fn scan_workspace_drift(
    host: &Host<'_>,
    cwd: &Path,
    config: &Config,
) -> Result<Option<WorkspaceDriftReport>, Unmodeled> {
    let Some(name) = config_text(config, "workspace")? else {
        return Ok(None);
    };
    let Some(workspace) = load_tolerant(host, &name)? else {
        return Ok(None);
    };
    let here = canonical(host, cwd.to_str().ok_or(Unmodeled)?)?;
    let mut siblings = Vec::new();
    for path in &workspace.repo_paths {
        if canonical(host, path)? == here {
            continue;
        }
        if let Some(sibling) = read_repo_config(host, path)? {
            siblings.push(config_facts(&sibling)?);
        }
    }
    let facts = config_facts(config)?;
    let vs_defaults = drift_vs_defaults(&facts, &workspace);
    let vs_siblings: Vec<WorkspaceDriftItem> = drift_vs_siblings(&facts, &siblings)
        .into_iter()
        .filter(|item| !vs_defaults.iter().any(|d| d.key == item.key))
        .collect();
    // `dropDerivedPrTarget`: keys are unique across both lists, so the origin tag is exact.
    let mut items: Vec<(bool, WorkspaceDriftItem)> = vs_defaults
        .into_iter()
        .map(|item| (true, item))
        .chain(vs_siblings.into_iter().map(|item| (false, item)))
        .collect();
    if let Some(branch) = items
        .iter()
        .find(|(_, i)| i.key == "branchBase")
        .map(|(_, i)| i.clone())
    {
        items.retain(|(_, i)| {
            i.key != "prTarget" || i.local != branch.local || i.expected != branch.expected
        });
    }
    if items.is_empty() {
        return Ok(None);
    }
    let (defaults, siblings_items): (Vec<_>, Vec<_>) = items.into_iter().partition(|(d, _)| *d);
    Ok(Some(WorkspaceDriftReport {
        workspace: name,
        vs_defaults: defaults.into_iter().map(|(_, i)| i).collect(),
        vs_siblings: siblings_items.into_iter().map(|(_, i)| i).collect(),
        siblings_read: siblings.len(),
    }))
}

// ---------------------------------------------------------------------------------------------
// Global CLI
// ---------------------------------------------------------------------------------------------

/// `StaleGlobalCli`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaleGlobalCli {
    /// What the `navori` on `PATH` reports.
    pub global: String,
    /// The running CLI's version.
    pub current: String,
}

/// `HOOK_SCRIPT_DIRS`.
const HOOK_SCRIPT_DIRS: [&str; 3] = [".claude/hooks", ".claude/scripts", ".codex/hooks"];

/// `renderedHooksCallNavori(cwd)`: a non-comment line of a rendered `.sh` hook runs
/// `navori <subcommand>`.
fn rendered_hooks_call_navori(cwd: &Path) -> bool {
    static COMMENT: LazyLock<Option<Regex>> =
        LazyLock::new(|| Regex::new(&format!("^{}*#", js_re::ws())).ok());
    static CALL: LazyLock<Option<Regex>> = LazyLock::new(|| {
        Regex::new(&format!(
            "(^|[{}{}])navori{}+[a-z]",
            js_re::WS_BODY,
            ";|&(`\"'",
            js_re::ws()
        ))
        .ok()
    });
    let (Some(comment), Some(call)) = (COMMENT.as_ref(), CALL.as_ref()) else {
        return false;
    };
    for dir in HOOK_SCRIPT_DIRS {
        let Ok(read) = std::fs::read_dir(cwd.join(dir)) else {
            continue;
        };
        for entry in read.filter_map(Result::ok) {
            let name = entry.file_name();
            if !entry.file_type().is_ok_and(|kind| kind.is_file())
                || !OsStr::as_encoded_bytes(&name).ends_with(b".sh")
            {
                continue;
            }
            let Ok(bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            let body = String::from_utf8_lossy(&bytes);
            if body
                .split('\n')
                .filter(|line| !comment.is_match(line))
                .any(|line| call.is_match(line))
            {
                return true;
            }
        }
    }
    false
}

/// `scanStaleGlobalCli(cwd, config)`: the `navori` on `PATH` is older than `current`, the running
/// CLI, while rendered hooks call it.
///
/// # Errors
/// [`Unmodeled`] for an `engines` value outside the schema.
pub fn scan_stale_global_cli(
    host: &Host<'_>,
    cwd: &Path,
    config: &Config,
    current: &str,
) -> Result<Option<StaleGlobalCli>, Unmodeled> {
    let engines = configured_engines(&config.data).ok_or(Unmodeled)?;
    if !engines.iter().any(|e| e == "claude" || e == "codex") || !rendered_hooks_call_navori(cwd) {
        return Ok(None);
    }
    let Some(raw) = host.exec("navori", &["--version"], GLOBAL_CLI_TIMEOUT) else {
        return Ok(None);
    };
    let Some(global) = first_version(&raw) else {
        return Ok(None);
    };
    if semver::compare(Some(&global), Some(current)) != Some(Ordering::Less) {
        return Ok(None);
    }
    Ok(Some(StaleGlobalCli {
        global,
        current: current.to_owned(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;
    use std::os::unix::fs::PermissionsExt as _;
    use std::os::unix::process::ExitStatusExt as _;
    use std::process::ExitStatus;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};

    use crate::js_json;
    use crate::process::{Failure, Output};
    use crate::tools::cache::now_ms;

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    /// A fresh directory; removed on drop.
    struct Temp(PathBuf);

    impl Temp {
        fn new(name: &str) -> Self {
            let n = NEXT.fetch_add(1, AtomicOrdering::Relaxed);
            let dir = std::env::temp_dir()
                .join(format!("navori-doctor-machine-{}-{n}", std::process::id()))
                .join(name);
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).ok();
            // The tests compare canonical paths: resolve `/tmp` → `/private/tmp` up front.
            Self(std::fs::canonicalize(&dir).unwrap_or(dir))
        }

        fn write(&self, rel: &str, text: &str) -> PathBuf {
            let path = self.0.join(rel);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            std::fs::write(&path, text).ok();
            path
        }

        /// An executable stub `bin/<name>`.
        fn binary(&self, name: &str) {
            let path = self.write(&format!("bin/{name}"), "#!/bin/sh\n");
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).ok();
        }

        fn text(&self) -> &str {
            self.0.to_str().unwrap_or_default()
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            if let Some(parent) = self.0.parent() {
                let _ = std::fs::remove_dir_all(parent);
            }
        }
    }

    /// Answers `<program> <args…>` from a table; anything else fails to start.
    struct Fake(Vec<(&'static str, Vec<String>, i32, String)>);

    impl Fake {
        fn none() -> Self {
            Self(Vec::new())
        }

        fn with(mut self, program: &'static str, args: &[&str], code: i32, stdout: &str) -> Self {
            self.0.push((
                program,
                args.iter().map(|a| (*a).to_owned()).collect(),
                code,
                stdout.to_owned(),
            ));
            self
        }
    }

    impl ProcessRunner for Fake {
        fn run(&self, request: &Request<'_>) -> Result<Output, Failure> {
            self.0
                .iter()
                .find(|(program, args, _, _)| {
                    *program == request.program
                        && args
                            .iter()
                            .map(String::as_str)
                            .eq(request.args.iter().copied())
                })
                .map(|(_, _, code, stdout)| Output {
                    status: ExitStatus::from_raw(code << 8),
                    stdout: stdout.as_bytes().to_vec(),
                })
                .ok_or_else(|| Failure::Spawn(std::io::Error::other("no answer")))
        }
    }

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    fn config(json: &str) -> Config {
        Config {
            data: js_json::parse(json).unwrap_or(JsValue::Null),
            warnings: Vec::new(),
        }
    }

    fn host<'a>(env: &'a Env, cwd: &'a Path, runner: &'a dyn ProcessRunner) -> Host<'a> {
        Host {
            env,
            process_cwd: cwd,
            runner,
        }
    }

    // Covers: R76
    #[test]
    fn has_binary_wants_an_executable_regular_file() {
        let t = Temp::new("which");
        t.binary("tool");
        t.write("bin/plain", "x");
        std::fs::create_dir_all(t.0.join("bin/dir")).ok();
        let e = env(&[("PATH", "::bin")]);
        let fake = Fake::none();
        let h = host(&e, &t.0, &fake);
        assert!(h.has_binary("tool"));
        assert!(!h.has_binary("plain"));
        assert!(!h.has_binary("dir"));
        assert!(!host(&env(&[]), &t.0, &fake).has_binary("tool"));
    }

    // Covers: R73, R76
    #[test]
    fn missing_external_tools_report_enabled_plugins_off_path() -> Result<(), Unmodeled> {
        let t = Temp::new("missing");
        t.binary("gh");
        let cfg = config(
            r#"{"plugins":{"engram":{"enabled":true},"gh":{"enabled":true},"tgrep":{"enabled":false},"nope":{"enabled":true}}}"#,
        );
        let e = env(&[("PATH", &format!("{}/bin", t.text()))]);
        let fake = Fake::none();
        let missing =
            scan_missing_external_tools(&host(&e, &t.0, &fake), &cfg, &mut Plugins::default())?;
        assert_eq!(missing.len(), 1);
        let engram = &missing[0];
        assert_eq!(
            (engram.plugin_id.as_str(), engram.binary.as_str()),
            ("engram", "engram")
        );
        assert_eq!(
            engram.post_install.as_deref(),
            Some(
                "claude plugin marketplace add Gentleman-Programming/engram && claude plugin install engram"
            )
        );
        assert_eq!(
            engram.install_docs.as_deref(),
            Some("https://github.com/Gentleman-Programming/engram")
        );
        assert_eq!(engram.install.is_some(), current_platform().is_some());
        Ok(())
    }

    // Covers: R73, R76
    #[test]
    fn pinned_versions_and_advisories_read_the_installed_version() -> Result<(), Unmodeled> {
        let t = Temp::new("versions");
        t.binary("codegraph");
        t.binary("engram");
        let cfg = config(r#"{"plugins":{"codegraph":{"enabled":true},"engram":{"enabled":true}}}"#);
        let e = env(&[("PATH", &format!("{}/bin", t.text()))]);
        let old = Fake::none()
            .with("codegraph", &["--version"], 0, "codegraph v1.5.2\n")
            .with("engram", &["--version"], 0, "engram 2.9.1 (abc)\n");
        let h = host(&e, &t.0, &old);
        let drift = scan_pinned_version_drift(&h, &cfg, &mut Plugins::default())?;
        assert_eq!(drift.len(), 1);
        assert_eq!(
            (
                drift[0].plugin_id.as_str(),
                drift[0].installed_version.as_str(),
                drift[0].pinned_version.as_str()
            ),
            ("codegraph", "1.5.2", "1.6.0")
        );
        let hits = scan_version_advisories(&h, &cfg, &mut Plugins::default())?;
        assert_eq!(hits.len(), 1);
        assert_eq!(
            (hits[0].installed_version.as_str(), hits[0].below.as_str()),
            ("2.9.1", "3.0.0")
        );
        assert_eq!(
            hits[0].reference.as_deref(),
            Some("https://github.com/Gentleman-Programming/engram/issues/1549")
        );
        assert!(
            hits[0]
                .reason_en
                .starts_with("`engram setup codex` < 3.0.0")
        );

        let current = Fake::none()
            .with("codegraph", &["--version"], 0, "1.6.0\n")
            .with("engram", &["--version"], 0, "3.0.0\n");
        let h = host(&e, &t.0, &current);
        assert!(scan_pinned_version_drift(&h, &cfg, &mut Plugins::default())?.is_empty());
        assert!(scan_version_advisories(&h, &cfg, &mut Plugins::default())?.is_empty());

        // A failing or unparseable `--version` stays silent.
        let broken = Fake::none()
            .with("codegraph", &["--version"], 1, "1.0.0\n")
            .with("engram", &["--version"], 0, "dev build\n");
        let h = host(&e, &t.0, &broken);
        assert!(scan_pinned_version_drift(&h, &cfg, &mut Plugins::default())?.is_empty());
        assert!(scan_version_advisories(&h, &cfg, &mut Plugins::default())?.is_empty());
        Ok(())
    }

    // Covers: R73, R76
    #[test]
    fn capability_probe_reports_absent_needles() -> Result<(), Unmodeled> {
        let t = Temp::new("capability");
        t.binary("tool");
        let tool = js_json::parse(
            r#"{"checkBinary":"tool","capabilityProbe":{"args":["--help"],"mustContain":["--json","--fast"],"minVersion":"2.0.0"}}"#,
        )
        .ok_or(Unmodeled)?;
        let e = env(&[("PATH", &format!("{}/bin", t.text()))]);
        let fake = Fake::none().with("tool", &["--help"], 0, "usage: tool [--json]\n");
        let gap = capability_gap(&host(&e, &t.0, &fake), "x", &tool, "tool")?.ok_or(Unmodeled)?;
        assert_eq!(gap.missing, vec!["--fast".to_owned()]);
        assert_eq!(gap.min_version, "2.0.0");
        let failing = Fake::none().with("tool", &["--help"], 2, "");
        assert_eq!(
            capability_gap(&host(&e, &t.0, &failing), "x", &tool, "tool")?,
            None
        );
        let full = Fake::none().with("tool", &["--help"], 0, "--json --fast");
        assert_eq!(
            capability_gap(&host(&e, &t.0, &full), "x", &tool, "tool")?,
            None
        );
        Ok(())
    }

    // Covers: R73, R76
    #[test]
    fn tool_updates_compare_the_cached_release() -> Result<(), Unmodeled> {
        let t = Temp::new("updates");
        t.binary("engram");
        let now = now_ms();
        t.write(
            "home/.navori/tool-versions/latest.json",
            &format!(
                r#"{{"tools":{{"engram":{{"at":{now},"source":"github","id":"Gentleman-Programming/engram","status":"ok","version":"3.5.0"}}}}}}"#
            ),
        );
        let cfg = config(r#"{"plugins":{"engram":{"enabled":true}}}"#);
        let home = format!("{}/home", t.text());
        let path = format!("{}/bin", t.text());
        let e = env(&[("PATH", &path), ("HOME", &home)]);
        let fake = Fake::none().with("engram", &["--version"], 0, "engram 3.4.9\n");
        let found = scan_tool_updates(&host(&e, &t.0, &fake), &cfg, &mut Plugins::default())?;
        assert_eq!(
            found.updates,
            vec![ToolUpdate {
                plugin_id: "engram".to_owned(),
                binary: "engram".to_owned(),
                installed_version: "3.4.9".to_owned(),
                latest_version: "3.5.0".to_owned(),
            }]
        );
        assert!(found.unparseable.is_empty());
        let ci = env(&[("PATH", &path), ("HOME", &home), ("CI", "true")]);
        assert_eq!(
            scan_tool_updates(&host(&ci, &t.0, &fake), &cfg, &mut Plugins::default())?,
            ToolUpdates::default()
        );

        t.write(
            "home/.navori/tool-versions/latest.json",
            &format!(
                r#"{{"tools":{{"engram":{{"at":{now},"source":"github","id":"Gentleman-Programming/engram","status":"unparseable","version":null}}}}}}"#
            ),
        );
        let found = scan_tool_updates(&host(&e, &t.0, &fake), &cfg, &mut Plugins::default())?;
        assert!(found.updates.is_empty());
        assert_eq!(
            found.unparseable,
            vec![UnparseableRelease {
                plugin_id: "engram".to_owned(),
                source: "github".to_owned(),
                id: "Gentleman-Programming/engram".to_owned(),
            }]
        );
        Ok(())
    }

    // Covers: R73
    #[test]
    fn optional_tools_never_trust_the_sg_alias() {
        let t = Temp::new("optional");
        t.binary("sg");
        let e = env(&[("PATH", &format!("{}/bin", t.text()))]);
        let fake = Fake::none();
        assert_eq!(scan_missing_optional_tools(&host(&e, &t.0, &fake)).len(), 1);
        t.binary("ast-grep");
        assert!(scan_missing_optional_tools(&host(&e, &t.0, &fake)).is_empty());
    }

    // Covers: R73, R76
    #[test]
    fn disk_usage_measures_existing_directories_with_du() -> Result<(), Unmodeled> {
        let t = Temp::new("disk");
        let backups = t.0.join("backups");
        let worktrees = t.0.join("repo/.claude/worktrees");
        std::fs::create_dir_all(&worktrees).ok();
        let wt = worktrees.to_str().ok_or(Unmodeled)?.to_owned();
        let e = env(&[]);
        let big = Fake::none().with("du", &["-sk", &wt], 0, &format!("2097153\t{wt}\n"));
        let issues = scan_disk_usage(&host(&e, &t.0, &big), &t.0.join("repo"), &backups)?;
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].target, DiskUsageTarget::Worktrees);
        assert!((issues[0].bytes - 2_097_153.0 * 1024.0).abs() < f64::EPSILON);
        let small = Fake::none().with("du", &["-sk", &wt], 0, "12\tx\n");
        assert!(scan_disk_usage(&host(&e, &t.0, &small), &t.0.join("repo"), &backups)?.is_empty());
        let garbage = Fake::none().with("du", &["-sk", &wt], 0, "x 9999999999\n");
        assert!(
            scan_disk_usage(&host(&e, &t.0, &garbage), &t.0.join("repo"), &backups)?.is_empty()
        );
        assert_eq!(parse_int("  -0012abc"), Some(-12.0));
        assert_eq!(parse_int("+"), None);
        Ok(())
    }

    // Covers: R73
    #[test]
    fn audit_root_lists_own_directories_open_to_others() -> Result<(), Unmodeled> {
        use std::os::unix::fs::MetadataExt as _;
        let t = Temp::new("audits");
        let root = t.0.join("audits");
        std::fs::create_dir_all(root.join("repo-a")).ok();
        std::fs::create_dir_all(root.join("repo-b")).ok();
        std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o700)).ok();
        std::fs::set_permissions(root.join("repo-a"), std::fs::Permissions::from_mode(0o755)).ok();
        std::fs::set_permissions(root.join("repo-b"), std::fs::Permissions::from_mode(0o700)).ok();
        let uid = std::fs::metadata(&root)
            .map(|m| m.uid())
            .map_err(|_| Unmodeled)?;
        let e = env(&[(
            "NAVORI_AUDITS_ROOT",
            &format!(" {} ", root.to_str().ok_or(Unmodeled)?),
        )]);
        let fake = Fake::none();
        let h = host(&e, &t.0, &fake);
        let open = scan_audit_root_permissions(&h, uid)?.ok_or(Unmodeled)?;
        assert_eq!(open.paths, vec![root.join("repo-a")]);
        assert_eq!(scan_audit_root_permissions(&h, uid.wrapping_add(1))?, None);
        let relative = env(&[("NAVORI_AUDITS_ROOT", "audits")]);
        assert_eq!(
            scan_audit_root_permissions(&host(&relative, &t.0, &fake), uid)?,
            None
        );
        Ok(())
    }

    // Covers: R73
    #[test]
    fn global_claude_md_reports_oversized_files_under_home_as_tilde() -> Result<(), Unmodeled> {
        let t = Temp::new("claude-md");
        t.write(
            "home/.claude/CLAUDE.md",
            &"é".repeat(GLOBAL_CLAUDE_MD_SOFT_CAP_CHARS + 1),
        );
        let home = format!("{}/home", t.text());
        let e = env(&[("HOME", &home)]);
        let fake = Fake::none();
        let issue = scan_global_claude_md(&host(&e, &t.0, &fake), GLOBAL_CLAUDE_MD_SOFT_CAP_CHARS)?
            .ok_or(Unmodeled)?;
        assert_eq!(issue.path, "~/.claude/CLAUDE.md");
        assert_eq!(issue.chars, GLOBAL_CLAUDE_MD_SOFT_CAP_CHARS + 1);
        assert_eq!(
            scan_global_claude_md(&host(&e, &t.0, &fake), usize::MAX)?,
            None
        );

        t.write("other/CLAUDE.md", "0123456789");
        let custom = env(&[("HOME", &home), ("CLAUDE_CONFIG_DIR", " other ")]);
        let issue = scan_global_claude_md(&host(&custom, &t.0, &fake), 5)?.ok_or(Unmodeled)?;
        assert_eq!(issue.path, format!("{}/other/CLAUDE.md", t.text()));
        Ok(())
    }

    /// Registers `workspace.json` for `name` under `<t>/home`.
    fn register(t: &Temp, name: &str, body: &str) {
        t.write(
            &format!("home/.navori/workspaces/{name}/workspace.json"),
            body,
        );
    }

    // Covers: R73
    #[test]
    fn workspace_link_and_dead_repos_read_the_registry() -> Result<(), Unmodeled> {
        let t = Temp::new("ws-link");
        std::fs::create_dir_all(t.0.join("repo")).ok();
        let home = format!("{}/home", t.text());
        let e = env(&[("HOME", &home)]);
        let fake = Fake::none();
        let h = host(&e, &t.0, &fake);
        let repo = t.0.join("repo");
        let declared = config(r#"{"name":"app","workspace":"acme"}"#);
        assert_eq!(
            scan_workspace_link(&h, &repo, &declared)?,
            Some(WorkspaceLinkIssue::WorkspaceMissing {
                workspace: "acme".to_owned()
            })
        );
        register(
            &t,
            "acme",
            r#"{"name":"acme","repos":[{"name":"app","path":"/elsewhere/app"},{"name":"api","path":"/gone/api"}]}"#,
        );
        assert_eq!(
            scan_workspace_link(&h, &repo, &declared)?,
            Some(WorkspaceLinkIssue::PathMismatch {
                workspace: "acme".to_owned(),
                repo_name: "app".to_owned(),
                registered_path: "/elsewhere/app".to_owned(),
            })
        );
        let undeclared = config(r#"{"name":"app"}"#);
        assert_eq!(
            scan_workspace_link(&h, &repo, &undeclared)?,
            Some(WorkspaceLinkIssue::UndeclaredPathMismatch {
                workspace: "acme".to_owned(),
                repo_name: "app".to_owned(),
                registered_path: "/elsewhere/app".to_owned(),
            })
        );
        let stranger = config(r#"{"name":"web","workspace":"acme"}"#);
        assert_eq!(
            scan_workspace_link(&h, &repo, &stranger)?,
            Some(WorkspaceLinkIssue::RepoNotRegistered {
                workspace: "acme".to_owned()
            })
        );
        assert_eq!(
            scan_workspace_dead_repos(&h, &repo, &declared)?,
            vec![WorkspaceDeadReposIssue {
                workspace: "acme".to_owned(),
                repos: vec![("api".to_owned(), "/gone/api".to_owned())],
            }]
        );
        register(
            &t,
            "acme",
            &format!(
                r#"{{"name":"acme","repos":[{{"name":"app","path":"{}"}}]}}"#,
                repo.to_str().ok_or(Unmodeled)?
            ),
        );
        assert_eq!(scan_workspace_link(&h, &repo, &declared)?, None);
        assert!(scan_workspace_dead_repos(&h, &repo, &declared)?.is_empty());
        Ok(())
    }

    // Covers: R73
    #[test]
    fn workspace_drift_compares_defaults_and_the_sibling_mode() -> Result<(), Unmodeled> {
        let t = Temp::new("ws-drift");
        let home = format!("{}/home", t.text());
        let e = env(&[("HOME", &home)]);
        let fake = Fake::none();
        let h = host(&e, &t.0, &fake);
        for (name, body) in [
            (
                "api",
                r#"{"name":"api","version":"1.0.0","preset":"custom","engines":["codex","claude"],"plugins":{"tgrep":{"enabled":true}}}"#,
            ),
            (
                "web",
                r#"{"name":"web","version":"1.0.0","preset":"custom","engines":["claude","codex"],"plugins":{"tgrep":{"enabled":true}}}"#,
            ),
            (
                "ops",
                r#"{"name":"ops","version":"1.0.0","preset":"custom","engines":["claude"],"plugins":{"tgrep":{"enabled":false}}}"#,
            ),
        ] {
            t.write(&format!("{name}/navori.config.json"), body);
        }
        std::fs::create_dir_all(t.0.join("app")).ok();
        register(
            &t,
            "acme",
            &format!(
                r#"{{"name":"acme","defaults":{{"branchBase":"develop","engines":["claude"]}},"repos":[{{"name":"app","path":"{0}/app"}},{{"name":"api","path":"{0}/api"}},{{"name":"web","path":"{0}/web"}},{{"name":"ops","path":"{0}/ops"}}]}}"#,
                t.text()
            ),
        );
        let local = config(
            r#"{"workspace":"acme","branchBase":"main","engines":["claude"],"commits":"conventional-es","language":"es"}"#,
        );
        let report = scan_workspace_drift(&h, &t.0.join("app"), &local)?.ok_or(Unmodeled)?;
        let item = |key: &str, local: &str, expected: &str, agree: usize, total: usize| {
            WorkspaceDriftItem {
                key: key.to_owned(),
                local: local.to_owned(),
                expected: expected.to_owned(),
                agree,
                total,
            }
        };
        assert_eq!(
            report,
            WorkspaceDriftReport {
                workspace: "acme".to_owned(),
                vs_defaults: vec![item("branchBase", "main", "develop", 0, 0)],
                vs_siblings: vec![
                    item("engines", "claude", "claude,codex", 2, 3),
                    item("plugins.tgrep", UNDECLARED, "enabled", 2, 3),
                ],
                siblings_read: 3,
            }
        );
        // An explicit opt-out is never sibling drift, and a `prTarget` row that only echoes the
        // `branchBase` one is dropped.
        let opted_out = config(
            r#"{"workspace":"acme","branchBase":"develop","engines":["codex","claude"],"commits":"conventional-es","language":"es","plugins":{"tgrep":{"enabled":false}}}"#,
        );
        let report = scan_workspace_drift(&h, &t.0.join("app"), &opted_out)?.ok_or(Unmodeled)?;
        assert_eq!(
            (report.vs_defaults, report.vs_siblings),
            (
                vec![item("engines", "claude,codex", "claude", 0, 0)],
                vec![item("branchBase", "develop", "main", 3, 3)]
            )
        );
        assert_eq!(
            scan_workspace_drift(&h, &t.0.join("app"), &config("{}"))?,
            None
        );
        Ok(())
    }

    // Covers: R73, R76
    #[test]
    fn stale_global_cli_needs_a_hook_that_calls_navori() -> Result<(), Unmodeled> {
        let t = Temp::new("stale");
        let cfg = config(r#"{"engines":["claude"]}"#);
        let e = env(&[]);
        let old = Fake::none().with("navori", &["--version"], 0, "navori 0.11.0\n");
        let h = host(&e, &t.0, &old);
        assert_eq!(scan_stale_global_cli(&h, &t.0, &cfg, "0.12.3")?, None);
        t.write(".claude/hooks/a.sh", "#!/bin/sh\n  # navori plan gate\n");
        assert_eq!(scan_stale_global_cli(&h, &t.0, &cfg, "0.12.3")?, None);
        t.write(".claude/hooks/b.sh", "#!/bin/sh\n(navori plan gate)\n");
        assert_eq!(
            scan_stale_global_cli(&h, &t.0, &cfg, "0.12.3")?,
            Some(StaleGlobalCli {
                global: "0.11.0".to_owned(),
                current: "0.12.3".to_owned(),
            })
        );
        assert_eq!(scan_stale_global_cli(&h, &t.0, &cfg, "0.11.0")?, None);
        let agents = config(r#"{"engines":["agents-md"]}"#);
        assert_eq!(scan_stale_global_cli(&h, &t.0, &agents, "0.12.3")?, None);
        Ok(())
    }
}
