//! Port of `lib/diagnose/distribution.ts` (spec 0060 T23, R73): is the harness on disk the one
//! git shares? Four read-only git questions (working tree ↔ HEAD, HEAD ↔ upstream, working tree
//! ↔ base, base → HEAD), no network, through a [`ProcessRunner`] (D42).
//!
//! A git answer that is not UTF-8 or exceeds the TS `maxBuffer`, and JSON the parser cannot
//! classify, are [`Unmodeled`]: the caller delegates.

use std::path::Path;
use std::time::Duration;

use crate::diagnose::health::{Unmodeled, configured_engines};
use crate::js_json::{self, JsObject, JsValue};
use crate::posix::js_trim;
use crate::process::{Env, ProcessRunner, Request};
use crate::render::ignore_files::engine_owned_paths;

/// The config file itself: rendered output does not own it, git still shares it.
const CONFIG_FILE: &str = "navori.config.json";

/// Where the `$navori.version` stamp of a rendered harness lives.
const SETTINGS_FILE: &str = ".claude/settings.json";

/// `execFileSync`'s `maxBuffer` in the TS.
const MAX_BUFFER: usize = 16 * 1024 * 1024;

/// `unpushed`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unpushed {
    /// Local commits touching harness paths the upstream lacks.
    pub commits: u64,
    /// The upstream ref.
    pub upstream: String,
}

/// `BaseDivergence`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BaseDivergence {
    /// The compared ref (`origin/main`).
    pub base_ref: String,
    /// Harness files differing between the working tree and the ref.
    pub files: usize,
    /// `$navori.version` of the harness on disk.
    pub local_version: Option<String>,
    /// `$navori.version` the base publishes.
    pub base_version: Option<String>,
    /// Commits touching harness paths the base has and HEAD lacks.
    pub behind: u64,
}

/// `DistributionReport`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DistributionReport {
    /// Tracked harness paths with uncommitted changes, sorted.
    pub uncommitted: Vec<String>,
    /// `None` without an upstream or with nothing unpushed.
    pub unpushed: Option<Unpushed>,
    /// `None` when the base matches, is HEAD with the same version, or does not resolve.
    pub base: Option<BaseDivergence>,
}

#[expect(
    clippy::cast_precision_loss,
    reason = "git counts are far below 2^53, as JS numbers"
)]
fn number(n: u64) -> JsValue {
    JsValue::Number(n as f64)
}

fn text_or_null(value: Option<&String>) -> JsValue {
    value.map_or(JsValue::Null, |v| JsValue::string(v))
}

impl DistributionReport {
    /// The report as `JSON.stringify` sees it, keys in the TS order.
    #[must_use]
    pub fn to_json(&self) -> JsValue {
        let mut out = JsObject::new();
        out.insert(
            "uncommitted",
            JsValue::Array(
                self.uncommitted
                    .iter()
                    .map(|p| JsValue::string(p))
                    .collect(),
            ),
        );
        out.insert(
            "unpushed",
            self.unpushed.as_ref().map_or(JsValue::Null, |u| {
                let mut object = JsObject::new();
                object.insert("commits", number(u.commits));
                object.insert("upstream", JsValue::string(&u.upstream));
                JsValue::Object(object)
            }),
        );
        out.insert(
            "base",
            self.base.as_ref().map_or(JsValue::Null, |b| {
                let mut object = JsObject::new();
                object.insert("ref", JsValue::string(&b.base_ref));
                object.insert("files", number(b.files as u64));
                object.insert("localVersion", text_or_null(b.local_version.as_ref()));
                object.insert("baseVersion", text_or_null(b.base_version.as_ref()));
                object.insert("behind", number(b.behind));
                JsValue::Object(object)
            }),
        );
        JsValue::Object(out)
    }
}

/// `git -C <cwd> …` with the TS semantics: `None` when git failed, was absent or printed nothing.
struct Git<'a> {
    cwd: &'a Path,
    cwd_text: &'a str,
    runner: &'a dyn ProcessRunner,
    env: &'a Env,
}

impl Git<'_> {
    /// `gitRaw`: stdout verbatim.
    fn raw(&self, args: &[&str]) -> Result<Option<String>, Unmodeled> {
        let mut argv = vec!["-C", self.cwd_text];
        argv.extend_from_slice(args);
        let request = Request {
            program: "git",
            args: &argv,
            cwd: self.cwd,
            env: self.env,
            input: None,
            // `execFileSync` without a timeout; the bound only guards a hung child.
            timeout: Duration::from_secs(60 * 60),
        };
        let Ok(output) = self.runner.run(&request) else {
            return Ok(None);
        };
        if output.status.code() != Some(0) {
            return Ok(None);
        }
        if output.stdout.len() > MAX_BUFFER {
            return Err(Unmodeled);
        }
        let text = String::from_utf8(output.stdout).map_err(|_| Unmodeled)?;
        Ok((!text.is_empty()).then_some(text))
    }

    /// `git`: [`Self::raw`] trimmed, `None` when nothing is left.
    fn trimmed(&self, args: &[&str]) -> Result<Option<String>, Unmodeled> {
        Ok(self
            .raw(args)?
            .map(|text| js_trim(&text).to_owned())
            .filter(|text| !text.is_empty()))
    }

    fn with_paths<'p>(&self, head: &[&'p str], paths: &'p [String]) -> Vec<&'p str> {
        let mut args = head.to_vec();
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
        args
    }
}

/// `Number(text)` for git's counts: plain digits, else `NaN` (`None`). `Number(null)` is 0.
fn count(text: Option<&str>) -> Option<u64> {
    match text {
        None => Some(0),
        Some(t) if !t.is_empty() && t.bytes().all(|b| b.is_ascii_digit()) => t.parse().ok(),
        Some(_) => None,
    }
}

/// JS default `sort()`: UTF-16 code-unit order.
fn sort_utf16(items: &mut [String]) {
    items.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
}

/// `JSON.parse(text)` as a classified answer: `Ok(None)` when JS rejects it for sure (a leading
/// BOM), `Err` when Rust cannot tell.
fn parse_json(text: &str) -> Result<Option<JsValue>, Unmodeled> {
    if text.starts_with('\u{feff}') {
        return Ok(None);
    }
    js_json::parse(text).map(Some).ok_or(Unmodeled)
}

/// `parseHarnessVersion(raw)`.
///
/// # Errors
/// JSON Rust cannot classify.
pub fn parse_harness_version(raw: &str) -> Result<Option<String>, Unmodeled> {
    let Some(JsValue::Object(object)) = parse_json(raw)? else {
        return Ok(None);
    };
    Ok(match object.get("harnessVersion") {
        Some(JsValue::String(text)) => text.to_rust().filter(|v| !v.is_empty()),
        _ => None,
    })
}

/// `readNavoriOwnership(raw)?.version ?? null`.
fn ownership_version(raw: &str) -> Result<Option<String>, Unmodeled> {
    let Some(JsValue::Object(object)) = parse_json(raw)? else {
        return Ok(None);
    };
    let Some(JsValue::Object(navori)) = object.get("$navori") else {
        return Ok(None);
    };
    Ok(match navori.get("version") {
        Some(JsValue::String(text)) => text.to_rust().filter(|v| !v.is_empty()),
        _ => None,
    })
}

/// `localHarnessVersion(cwd)`: the registry's `harnessVersion`, else the settings stamp.
///
/// # Errors
/// Text that is not UTF-8 or JSON Rust cannot classify.
pub fn local_harness_version(cwd: &Path) -> Result<Option<String>, Unmodeled> {
    if let Ok(bytes) = std::fs::read(cwd.join(CONFIG_FILE)) {
        let text = String::from_utf8(bytes).map_err(|_| Unmodeled)?;
        if let Some(version) = parse_harness_version(&text)? {
            return Ok(Some(version));
        }
    }
    let path = cwd.join(SETTINGS_FILE);
    if !path.exists() {
        return Ok(None);
    }
    match std::fs::read(&path) {
        Ok(bytes) => ownership_version(&String::from_utf8(bytes).map_err(|_| Unmodeled)?),
        Err(_) => Ok(None),
    }
}

/// `scanDistribution(cwd, config)`: `None` when there is nothing to say.
///
/// # Errors
/// Unusable engines, a non-UTF-8 path or answer, or JSON Rust cannot classify.
pub fn scan_distribution(
    cwd: &Path,
    config: &JsValue,
    runner: &dyn ProcessRunner,
    env: &Env,
) -> Result<Option<DistributionReport>, Unmodeled> {
    let JsValue::Object(root) = config else {
        return Err(Unmodeled);
    };
    match root.get("gitignoreHarness") {
        None | Some(JsValue::Undefined) => {}
        Some(JsValue::String(mode)) if mode.is("off") => {}
        Some(JsValue::String(_)) => return Ok(None),
        Some(_) => return Err(Unmodeled),
    }
    let git = Git {
        cwd,
        cwd_text: cwd.to_str().ok_or(Unmodeled)?,
        runner,
        env,
    };
    if git
        .trimmed(&["rev-parse", "--is-inside-work-tree"])?
        .as_deref()
        != Some("true")
    {
        return Ok(None);
    }
    let paths = harness_paths(&git, config)?;
    if paths.is_empty() {
        return Ok(None);
    }
    let uncommitted = uncommitted_paths(&git, &paths)?;
    let unpushed = unpushed_commits(&git, &paths)?;
    let base = base_divergence(&git, root, &paths)?;
    if uncommitted.is_empty() && unpushed.is_none() && base.is_none() {
        return Ok(None);
    }
    Ok(Some(DistributionReport {
        uncommitted,
        unpushed,
        base,
    }))
}

/// `harnessPaths`: the config file and every engine-owned path git tracks, sorted.
fn harness_paths(git: &Git<'_>, config: &JsValue) -> Result<Vec<String>, Unmodeled> {
    let mut candidates = vec![CONFIG_FILE.to_owned()];
    for engine in configured_engines(config).ok_or(Unmodeled)? {
        for path in engine_owned_paths(&engine) {
            if !candidates.contains(&path) {
                candidates.push(path);
            }
        }
    }
    let mut tracked = Vec::new();
    for path in candidates {
        if git.trimmed(&["ls-files", "--", &path])?.is_some() {
            tracked.push(path);
        }
    }
    sort_utf16(&mut tracked);
    Ok(tracked)
}

/// `uncommittedPaths`: porcelain v1 rows, rename destinations, quotes stripped, sorted.
fn uncommitted_paths(git: &Git<'_>, paths: &[String]) -> Result<Vec<String>, Unmodeled> {
    let Some(out) = git.raw(&git.with_paths(&["status", "--porcelain"], paths))? else {
        return Ok(Vec::new());
    };
    let mut found: Vec<String> = Vec::new();
    for line in out.split('\n') {
        let rest: String = line.chars().skip(3).collect();
        let rest = js_trim(&rest);
        if rest.is_empty() {
            continue;
        }
        let path = rest.rfind(" -> ").map_or(rest, |arrow| &rest[arrow + 4..]);
        // `unquote`: `slice(1, -1)` when it starts and ends with a quote.
        let path = if path.starts_with('"') && path.ends_with('"') {
            path.get(1..path.len().saturating_sub(1).max(1))
                .unwrap_or("")
        } else {
            path
        };
        if !found.iter().any(|f| f == path) {
            found.push(path.to_owned());
        }
    }
    sort_utf16(&mut found);
    Ok(found)
}

/// `unpushedCommits`: `None` without an upstream or when nothing is unpushed.
fn unpushed_commits(git: &Git<'_>, paths: &[String]) -> Result<Option<Unpushed>, Unmodeled> {
    let Some(upstream) =
        git.trimmed(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])?
    else {
        return Ok(None);
    };
    let counted = git.trimmed(&git.with_paths(&["rev-list", "--count", "@{u}..HEAD"], paths))?;
    Ok(match count(counted.as_deref()) {
        Some(commits) if commits > 0 => Some(Unpushed { commits, upstream }),
        _ => None,
    })
}

/// `resolveBaseRef`: `origin/<branchBase>`, `<branchBase>`, then `origin/HEAD`'s target.
fn resolve_base_ref(
    git: &Git<'_>,
    config: &crate::js_json::JsObject,
) -> Result<Option<String>, Unmodeled> {
    let mut candidates = Vec::new();
    match config.get("branchBase") {
        None | Some(JsValue::Undefined) => {}
        Some(JsValue::String(text)) => {
            let declared = text.to_rust().ok_or(Unmodeled)?;
            let declared = js_trim(&declared);
            if !declared.is_empty() {
                candidates.push(format!("origin/{declared}"));
                candidates.push(declared.to_owned());
            }
        }
        Some(_) => return Err(Unmodeled),
    }
    if let Some(origin_head) =
        git.trimmed(&["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])?
    {
        candidates.push(origin_head);
    }
    for candidate in candidates {
        let probe = format!("{candidate}^{{commit}}");
        if git
            .trimmed(&["rev-parse", "--verify", "--quiet", &probe])?
            .is_some()
        {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

/// `refHarnessVersion`: the ref's `harnessVersion`, else its settings stamp.
fn ref_harness_version(git: &Git<'_>, base_ref: &str) -> Result<Option<String>, Unmodeled> {
    let config = git.trimmed(&["show", &format!("{base_ref}:{CONFIG_FILE}")])?;
    if let Some(config) = config
        && let Some(version) = parse_harness_version(&config)?
    {
        return Ok(Some(version));
    }
    match git.trimmed(&["show", &format!("{base_ref}:{SETTINGS_FILE}")])? {
        Some(raw) => ownership_version(&raw),
        None => Ok(None),
    }
}

/// `baseDivergence`.
fn base_divergence(
    git: &Git<'_>,
    config: &crate::js_json::JsObject,
    paths: &[String],
) -> Result<Option<BaseDivergence>, Unmodeled> {
    let Some(base_ref) = resolve_base_ref(git, config)? else {
        return Ok(None);
    };
    let diff = git.trimmed(&git.with_paths(&["diff", "--name-only", &base_ref], paths))?;
    let files = diff.map_or(0, |d| d.split('\n').filter(|l| !l.is_empty()).count());
    let range = format!("HEAD..{base_ref}");
    let behind_raw = git.trimmed(&git.with_paths(&["rev-list", "--count", &range], paths))?;
    let behind = count(behind_raw.as_deref()).unwrap_or(0);
    if files == 0 && behind == 0 {
        return Ok(None);
    }
    let local_version = local_harness_version(git.cwd)?;
    let base_version = ref_harness_version(git, &base_ref)?;
    let same_commit =
        git.trimmed(&["rev-parse", "HEAD"])? == git.trimmed(&["rev-parse", &base_ref])?;
    if same_commit && local_version == base_version {
        return Ok(None);
    }
    Ok(Some(BaseDivergence {
        base_ref,
        files,
        local_version,
        base_version,
        behind,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Covers: R73
    #[test]
    fn counts_read_like_number_of_git_output() {
        assert_eq!(count(None), Some(0));
        assert_eq!(count(Some("007")), Some(7));
        assert_eq!(count(Some("x")), None);
    }

    // Covers: R73
    #[test]
    fn harness_versions_come_from_the_registry_or_the_stamp() -> Result<(), Unmodeled> {
        assert_eq!(
            parse_harness_version(r#"{"harnessVersion":"0.12.2"}"#)?,
            Some("0.12.2".to_owned())
        );
        assert_eq!(parse_harness_version(r#"{"harnessVersion":""}"#)?, None);
        assert_eq!(parse_harness_version("\u{feff}{}")?, None);
        assert_eq!(parse_harness_version("[1]")?, None);
        assert_eq!(
            ownership_version(r#"{"$navori":{"managed":true,"version":"0.9.0"}}"#)?,
            Some("0.9.0".to_owned())
        );
        assert_eq!(parse_harness_version("{").err(), Some(Unmodeled));
        Ok(())
    }

    // Covers: R73
    #[test]
    fn the_report_serializes_in_the_ts_key_order() {
        let report = DistributionReport {
            uncommitted: vec!["navori.config.json".to_owned()],
            unpushed: None,
            base: Some(BaseDivergence {
                base_ref: "main".to_owned(),
                files: 1,
                local_version: Some("0.12.3".to_owned()),
                base_version: None,
                behind: 0,
            }),
        };
        assert_eq!(
            report.to_json().stringify(None).as_deref(),
            Some(
                r#"{"uncommitted":["navori.config.json"],"unpushed":null,"base":{"ref":"main","files":1,"localVersion":"0.12.3","baseVersion":null,"behind":0}}"#
            )
        );
    }
}
