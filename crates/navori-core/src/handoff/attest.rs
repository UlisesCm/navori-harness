//! `attestHandoff` (`lib/handoff/actor-provenance.ts`, spec 0060 T10): the designated producer
//! attests the current delivery from its native context and the CLI records
//! `ownership_<feature>.json`. [`plan_attest`] decides everything before the first write and
//! answers either the TS's error message or the one record to write.

use std::path::Path;
use std::time::Duration;

use sha2::{Digest, Sha256};

use super::Unmodeled;
use super::implementation;
use super::native_actor::native_actor;
use super::ownership::{NativeActor, Ownership, has_parallel_authority, read_ownership};
use crate::content_identity::{self, CONTENT_MAX_BYTES, CONTENT_TIMEOUT, Failure, hex};
use crate::js_json::{JsObject, JsValue};
use crate::process::{Env, ProcessRunner, Request};
use crate::state_files::{Refusal, StateRoot, artifact_path, resolve_state_root};

/// `PROGRESS_DIRS` (`primitives/progress-dirs.ts`).
const PROGRESS_DIRS: [&str; 4] = [
    ".claude/progress/",
    ".codex/progress/",
    ".navori/state/",
    "progress/",
];

fn under_progress(path: &str) -> bool {
    PROGRESS_DIRS.iter().any(|d| path.starts_with(d))
}

/// What `attestHandoff` does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Attest {
    /// `{ status: "error", message }`.
    Error(String),
    /// Write `ownership_<feature>.json` with this text, then `{ status: "attested" }`.
    Write(String),
}

/// The inputs of [`plan_attest`].
pub struct AttestInput<'a> {
    /// `process.cwd()`.
    pub process_cwd: &'a str,
    /// The root `resolveReceiptOptions` resolved.
    pub root: &'a StateRoot,
    pub feature: &'a str,
    pub target: &'a str,
    pub env: &'a Env,
    pub runner: &'a dyn ProcessRunner,
}

/// `isDerivedHandoffPath(path)` (`lib/handoff/parallel.ts`): generated categories only.
#[must_use]
pub fn is_derived_handoff_path(path: &str) -> bool {
    if matches!(
        path,
        "AGENTS.md" | "CLAUDE.md" | ".pi/navori.json" | ".codex/orchestrator.md"
    ) {
        return true;
    }
    const PREFIXES: [&str; 8] = [
        ".claude/agents/",
        ".claude/context/",
        ".claude/skills/",
        ".claude/hooks/",
        ".codex/agents/",
        ".codex/hooks/",
        ".agents/skills/",
        ".pi/agents/",
    ];
    if PREFIXES.iter().any(|p| path.starts_with(p)) {
        return true;
    }
    // `/^packages\/cli\/src\/engines\/__tests__\/__golden__\/[\w-]+\.snap$/`.
    path.strip_prefix("packages/cli/src/engines/__tests__/__golden__/")
        .and_then(|rest| rest.strip_suffix(".snap"))
        .is_some_and(|name| {
            !name.is_empty()
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        })
}

fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

/// `ContentIdentityFailure`'s text.
fn reason(failure: Failure) -> &'static str {
    match failure {
        Failure::NotACheckout => "not-a-checkout",
        Failure::UnsafePath => "unsafe-path",
        Failure::UnmergedIndex => "unmerged-index",
        Failure::GitFailed => "git-failed",
        Failure::TooLarge => "too-large",
        Failure::Timeout => "timeout",
    }
}

/// `realpathSync(path)` or `None`.
fn real(path: &str) -> Option<String> {
    std::fs::canonicalize(path)
        .ok()
        .and_then(|p| p.to_str().map(str::to_owned))
}

/// Node's message for `readFileSync` of a missing file; anything else is [`Unmodeled`].
fn read_state(path: &str) -> Result<Result<Vec<u8>, String>, Unmodeled> {
    match std::fs::read(path) {
        Ok(bytes) => Ok(Ok(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Err(format!(
            "ENOENT: no such file or directory, open '{path}'"
        ))),
        Err(_) => Err(Unmodeled),
    }
}

/// `spawnSync("git", ["-c", "core.fsmonitor=false", ...args], { timeout: 2000 })`: stdout, or
/// `None` for a non-zero status.
fn git(input: &AttestInput<'_>, args: &[&str]) -> Result<Option<String>, Unmodeled> {
    let mut full = vec!["-c", "core.fsmonitor=false"];
    full.extend_from_slice(args);
    let output = input
        .runner
        .run(&Request {
            program: "git",
            args: &full,
            cwd: Path::new(&input.root.cwd),
            env: input.env,
            input: None,
            timeout: Duration::from_secs(2),
        })
        .map_err(|_| Unmodeled)?;
    if !output.status.success() {
        return Ok(None);
    }
    String::from_utf8(output.stdout)
        .map(Some)
        .map_err(|_| Unmodeled)
}

fn actor_js(a: &NativeActor) -> JsValue {
    let mut o = JsObject::new();
    for (k, v) in [
        ("host", &a.host),
        ("thread", &a.thread),
        ("root", &a.root),
        ("parent", &a.parent),
        ("role", &a.role),
        ("version", &a.version),
        ("sourceCwd", &a.source_cwd),
        ("sourceHash", &a.source_hash),
    ] {
        o.insert(k, JsValue::string(v));
    }
    JsValue::Object(o)
}

/// `attestHandoff(options)`, planned.
///
/// # Errors
/// [`Unmodeled`] where the TS's answer depends on something this port does not reproduce (a
/// handoff or workplan `JSON.parse` or zod rejects, a `source` workplan, Node's message for a
/// failed read, git output that is not UTF-8).
#[allow(
    clippy::too_many_lines,
    reason = "one linear port of attestHandoff, step by step"
)]
pub fn plan_attest(input: &AttestInput<'_>) -> Result<Attest, Unmodeled> {
    let error = |m: &str| Ok(Attest::Error(m.to_owned()));
    let root = input.root;
    if real(input.process_cwd).ok_or(Unmodeled)? != real(&root.cwd).ok_or(Unmodeled)? {
        return error("attest must run in the actual target checkout");
    }
    let actor = native_actor(Path::new(&root.cwd), input.env, input.runner)?;
    let Some(actor) = actor.filter(|a| a.role == "implementer" || a.role == "scribe") else {
        return error("native designated producer identity unavailable");
    };
    let root = match resolve_state_root(&root.cwd, &root.cwd, input.feature, Some(&root.dir)) {
        Ok(root) => root,
        Err(Refusal::Message(m)) => return Ok(Attest::Error(m)),
        Err(Refusal::Unmodeled) => return Err(Unmodeled),
    };
    if has_parallel_authority(&root.cwd, input.feature, Some(&root.dir))? {
        return error(
            "parallel authority requires finalize-parallel; serial attestation is unavailable",
        );
    }
    let path = |name: String| match artifact_path(&root, &name) {
        Ok(p) => Ok(Ok(p)),
        Err(Refusal::Message(m)) => Ok(Err(m)),
        Err(Refusal::Unmodeled) => Err(Unmodeled),
    };
    let impl_path = match path(format!("impl_{}.json", input.feature))? {
        Ok(p) => p,
        Err(m) => return Ok(Attest::Error(m)),
    };
    let raw = match read_state(&impl_path)? {
        Ok(raw) => raw,
        Err(m) => return Ok(Attest::Error(m)),
    };
    let text = String::from_utf8(raw.clone()).map_err(|_| Unmodeled)?;
    let value = crate::js_json::parse(&text).ok_or(Unmodeled)?;
    if super::ownership::has_lone_surrogate(&value) {
        return Err(Unmodeled);
    }
    let handoff = implementation::parse(&value).ok_or(Unmodeled)?;
    let plan_path = match path(format!("workplan_{}.json", input.feature))? {
        Ok(p) => p,
        Err(m) => return Ok(Attest::Error(m)),
    };
    let plan_raw = match read_state(&plan_path)? {
        Ok(raw) => raw,
        Err(m) => return Ok(Attest::Error(m)),
    };
    let plan_text = String::from_utf8(plan_raw).map_err(|_| Unmodeled)?;
    let plan_value = crate::js_json::parse(&plan_text).ok_or(Unmodeled)?;
    let plan = crate::plan::check::schema(&plan_value).ok_or(Unmodeled)?;
    if handoff.feature != input.feature
        || plan.feature != input.feature
        || real(&handoff.worktree).ok_or(Unmodeled)? != real(&root.cwd).ok_or(Unmodeled)?
    {
        return error("handoff/workplan target mismatch");
    }
    let mut allowed: Vec<&str> = Vec::new();
    for (p, _) in &plan.files {
        if !allowed.contains(&p.as_str()) {
            allowed.push(p);
        }
    }
    if handoff
        .files_touched
        .iter()
        .any(|f| !allowed.contains(&f.as_str()))
    {
        return error("producer files escape approved scope");
    }
    let identity = match content_identity::working_for(
        Path::new(&root.cwd),
        input.env,
        Some(input.target),
        CONTENT_TIMEOUT,
        CONTENT_MAX_BYTES,
    ) {
        Ok(identity) => identity,
        Err(failure) => {
            return Ok(Attest::Error(format!(
                "content identity {}",
                reason(failure)
            )));
        }
    };
    let since = identity.base.as_deref().unwrap_or(&identity.head);
    let changed = git(input, &["diff", "--name-only", since])?;
    let untracked = git(input, &["ls-files", "--others", "--exclude-standard"])?;
    let (Some(changed), Some(untracked)) = (changed, untracked) else {
        return error("diff escapes approved scope");
    };
    let joined = format!("{changed}\n{untracked}");
    let escapes = crate::posix::js_trim(&joined)
        .split('\n')
        .filter(|p| !p.is_empty() && !under_progress(p))
        .any(|p| !allowed.contains(&p));
    if escapes {
        return error("diff escapes approved scope");
    }
    let mut files = JsObject::new();
    let mut hashes: Vec<(String, String)> = Vec::new();
    for p in &allowed {
        if under_progress(p) {
            continue;
        }
        // `join(root.cwd, path)` concatenates even an absolute `path`.
        let full = crate::posix::join(&[&root.cwd, p]);
        let hash = if std::fs::metadata(&full).is_ok() {
            sha256(&std::fs::read(&full).map_err(|_| Unmodeled)?)
        } else {
            "missing".to_owned()
        };
        files.insert(*p, JsValue::string(&hash));
        hashes.push(((*p).to_owned(), hash));
    }
    let handoff_hash = sha256(&raw);
    let mut actors = vec![actor.clone()];
    if actor.role == "scribe" {
        let prior: Option<Ownership> = read_ownership(&root.cwd, input.feature, Some(&root.dir))?;
        let Some(prior) = prior.filter(|p| {
            p.handoff == handoff_hash
                && p.head == identity.head
                && p.base == identity.base
                && p.actors.iter().any(|a| a.role == "implementer")
        }) else {
            return error("scribe requires the designated implementer ownership");
        };
        let prose: Vec<&str> = handoff
            .markdown_requests
            .iter()
            .map(|r| r.path.as_str())
            .collect();
        // `Object.entries(files)`: the key order `JSON.stringify` writes.
        let ordered: Vec<String> = files
            .ordered()
            .iter()
            .filter_map(|(k, _)| k.to_rust())
            .collect();
        for p in ordered {
            let hash = hashes.iter().find(|(k, _)| *k == p).map(|(_, h)| h);
            if hash != prior.files.get(&p)
                && !prose.contains(&p.as_str())
                && !is_derived_handoff_path(&p)
            {
                return Ok(Attest::Error(format!(
                    "scribe changed non-prose ownership: {p}"
                )));
            }
        }
        actors = prior
            .actors
            .into_iter()
            .filter(|a| a.role != "scribe")
            .chain([actor])
            .collect();
    }
    let mut record = JsObject::new();
    record.insert("feature", JsValue::string(input.feature));
    record.insert("cwd", JsValue::string(&real(&root.cwd).ok_or(Unmodeled)?));
    record.insert("target", JsValue::string(input.target));
    record.insert("head", JsValue::string(&identity.head));
    record.insert(
        "base",
        identity
            .base
            .as_deref()
            .map_or(JsValue::Null, JsValue::string),
    );
    record.insert("fingerprint", JsValue::string(&identity.fingerprint));
    record.insert("handoff", JsValue::string(&handoff_hash));
    record.insert(
        "actors",
        JsValue::Array(actors.iter().map(actor_js).collect()),
    );
    record.insert("files", JsValue::Object(files));
    let text = JsValue::Object(record).stringify(None).ok_or(Unmodeled)?;
    Ok(Attest::Write(format!("{text}\n")))
}

#[cfg(test)]
mod tests {
    use super::is_derived_handoff_path;

    #[test]
    fn derived_paths_are_the_generated_categories() {
        assert!(is_derived_handoff_path("AGENTS.md"));
        assert!(is_derived_handoff_path(".claude/skills/x/SKILL.md"));
        assert!(is_derived_handoff_path(
            "packages/cli/src/engines/__tests__/__golden__/codex-x_1.snap"
        ));
        assert!(!is_derived_handoff_path("docs/AGENTS.md"));
        assert!(!is_derived_handoff_path(
            "packages/cli/src/engines/__tests__/__golden__/a.b.snap"
        ));
    }
}
