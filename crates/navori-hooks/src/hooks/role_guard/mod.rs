//! The Codex role containment (spec 0060 T13, R70).
//!
//! `role-guard.sh` is the Codex stand-in for Claude's per-agent `tools:` allowlist: a subagent
//! may not dispatch another one, and every `apply_patch` path of a role other than `implementer`
//! and `scribe` must land, physically, under the prefixes its role is granted (`nv_role_prefixes`,
//! compiled by the renderer) or in an OS temp root. A reviewer's write outside the repo is
//! accepted only for its bound review output, which the script's own Node program checks; the host
//! runs that same program. Every fact is read-only, so shadow evaluates the whole hook.

use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};
use crate::shell::capture::{self, CaptureContext};
use crate::shell::payload::{self, Extractor, Profile};
use crate::shell::role_case::RoleCase;

/// Hosts that register this hook.
pub const ENGINES: &[Engine] = &[Engine::Codex];

/// `nv_payload_fields`, in its declared order.
const FIELDS: [&str; 10] = [
    "agent_id",
    "agent_type",
    "cwd",
    "hook_event_name",
    "tool_input.agent_type",
    "tool_input.command",
    "tool_input.file_path",
    "tool_input.notebook_path",
    "tool_input.subagent_type",
    "tool_name",
];
const AGENT_ID: usize = 0;
const AGENT_TYPE: usize = 1;
const CWD: usize = 2;
const COMMAND: usize = 5;
const TOOL_NAME: usize = 9;
const BLOCK_END: &str = "# navori:managed end id=\"role-guard-base\"";

/// What the renderer wrote into the script, and the binding program it carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    /// `nv_role_prefixes`.
    pub policy: RoleCase,
    /// The `node -` program of `nv_review_edit_binding`, as its heredoc feeds it.
    pub binding: String,
}

impl Rendered {
    /// Read the policy and the binding program; only comments may follow the managed block.
    ///
    /// # Errors
    /// The reason the script is not one the native hook reproduces.
    pub fn from_script(source: &str) -> Result<Self, String> {
        if let Some(end) = source.find(BLOCK_END)
            && source[end + BLOCK_END.len()..].lines().any(|line| {
                let line = line.trim_start_matches([' ', '\t']);
                !line.is_empty() && !line.starts_with('#')
            })
        {
            return Err("the user section holds commands".to_owned());
        }
        let opener = "  node - \"$@\" <<'NV_REVIEW_EDIT_BINDING'";
        let (_, after) = source
            .split_once(&format!("{opener}\n"))
            .ok_or("the binding program is missing")?;
        if after.contains(opener) {
            return Err("the binding program is ambiguous".to_owned());
        }
        let (binding, _) = after
            .split_once("\nNV_REVIEW_EDIT_BINDING\n")
            .ok_or("the binding program is not terminated")?;
        Ok(Self {
            policy: RoleCase::from_script(source, "nv_role_prefixes")?,
            binding: format!("{binding}\n"),
        })
    }
}

/// What the script reads outside its payload and text.
pub trait Host {
    /// `[ -e path ]`.
    fn exists(&self, path: &str) -> bool;
    /// `[ -L path ]`.
    fn is_symlink(&self, path: &str) -> bool;
    /// `[ -d path ]`.
    fn is_dir(&self, path: &str) -> bool;
    /// `$(cd -P dir 2>/dev/null && pwd -P)`, `None` when the `cd` fails.
    fn physical(&self, dir: &str) -> Option<String>;
    /// `$(readlink path)`, `None` when it fails.
    fn readlink(&self, path: &str) -> Option<String>;
    /// `$(git args 2>/dev/null)` from the hook's directory: stdout without trailing newlines
    /// when git exits 0, `None` otherwise.
    ///
    /// # Errors
    /// An answer the port cannot reproduce.
    fn git(&self, args: &[&str]) -> Result<Option<String>, Failure>;
    /// `$TMPDIR`, `None` when unset.
    fn tmpdir(&self) -> Option<String>;
    /// `command -v node` and then `node - args… <<program`: `(exit 0, stdout)` without trailing
    /// newlines; `None` when node is not on `PATH`.
    ///
    /// # Errors
    /// A run the port cannot reproduce.
    fn bind(&self, program: &str, args: &[&str]) -> Result<Option<(bool, String)>, Failure>;
}

/// The invocation facts collected before stdin.
#[derive(Debug, Clone)]
pub struct Context<'a> {
    /// Accredited extraction and locale profile; the extractor also says whether jq or node is
    /// on `PATH`.
    pub profile: Profile,
    /// Script identity and the source lines of the Bash 5 NUL warnings.
    pub capture: CaptureContext<'a>,
    /// The policy and binding program the script carries.
    pub rendered: Rendered,
}

/// `nv_normalize`: drop `.` and empty segments and fold `..`, for an absolute path.
fn normalize(path: &str) -> String {
    let mut out = String::new();
    for segment in path.strip_prefix('/').unwrap_or(path).split('/') {
        match segment {
            "" | "." => {}
            ".." => out.truncate(out.rfind('/').unwrap_or(0)),
            segment => {
                out.push('/');
                out.push_str(segment);
            }
        }
    }
    if out.is_empty() { "/".to_owned() } else { out }
}

/// `${d%/*}` with `[ -n "$d" ] || d=/`.
fn parent(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(at) => &path[..at],
    }
}

fn basename(path: &str) -> &str {
    path.rsplit_once('/').map_or(path, |(_, name)| name)
}

struct Walk<'a> {
    host: &'a dyn Host,
}

impl Walk<'_> {
    /// `nv_realdir`: the nearest existing ancestor resolved with `cd -P`, the missing tail kept.
    fn realdir(&self, path: &str) -> String {
        let mut d = path.to_owned();
        let mut suffix = String::new();
        while !self.host.exists(&d) && !self.host.is_symlink(&d) && d != "/" {
            suffix = format!("/{}{suffix}", basename(&d));
            d = match d.rfind('/') {
                Some(0) | None => "/".to_owned(),
                Some(at) => d[..at].to_owned(),
            };
        }
        let real = if self.host.is_dir(&d) {
            match self.host.physical(&d) {
                Some(real) => real,
                None => return String::new(),
            }
        } else {
            match self.host.physical(parent(&d)) {
                Some(real) => format!(
                    "{}/{}",
                    real.strip_suffix('/').unwrap_or(&real),
                    basename(&d)
                ),
                None => return String::new(),
            }
        };
        format!("{}{suffix}", real.strip_suffix('/').unwrap_or(&real))
    }

    /// `nv_realpath`: `nv_realdir` plus a bounded leaf symlink chain.
    fn realpath(&self, path: &str) -> String {
        let mut p = path.to_owned();
        let mut hops = 0;
        loop {
            p = self.realdir(&p);
            if p.is_empty() {
                return p;
            }
            if self.host.is_symlink(&p) && hops < 20 {
                let Some(target) = self.host.readlink(&p) else {
                    break;
                };
                p = if target.starts_with('/') {
                    normalize(&target)
                } else {
                    normalize(&format!("{}/{target}", &p[..p.rfind('/').unwrap_or(0)]))
                };
                hops += 1;
            } else {
                break;
            }
        }
        p
    }

    /// `nv_in_temp`: under the physical `/tmp`, `/var/tmp` or `$TMPDIR`.
    fn in_temp(&self, real: &str) -> bool {
        let roots = [
            "/tmp".to_owned(),
            "/var/tmp".to_owned(),
            self.host.tmpdir().unwrap_or_default(),
        ];
        roots.iter().filter(|root| !root.is_empty()).any(|root| {
            self.host.physical(root).is_some_and(|resolved| {
                real.starts_with(&format!(
                    "{}/",
                    resolved.strip_suffix('/').unwrap_or(&resolved)
                ))
            })
        })
    }

    /// `nv_containing_root`: the registered linked worktree nested under `root` that holds
    /// `real`, else `root`.
    fn containing_root(&self, real: &str, root: &str) -> Result<String, Failure> {
        let mut d = &real[..real.rfind('/').unwrap_or(0)];
        while !d.is_empty() && !self.host.is_dir(d) {
            d = &d[..d.rfind('/').unwrap_or(0)];
        }
        if d.is_empty() {
            return Ok(root.to_owned());
        }
        let git = |args: &[&str]| -> Result<Option<String>, Failure> {
            let mut full = vec!["-c", "core.fsmonitor=false"];
            full.extend_from_slice(args);
            self.host.git(&full)
        };
        let top = git(&["-C", d, "rev-parse", "--show-toplevel"])?
            .and_then(|top| self.host.physical(&top))
            .unwrap_or_default();
        let nested = top
            .strip_prefix(&format!("{root}/"))
            .is_some_and(|rest| !rest.is_empty())
            && real
                .strip_prefix(&format!("{top}/"))
                .is_some_and(|rest| !rest.is_empty());
        if !nested {
            return Ok(root.to_owned());
        }
        let abs = |dir: &str, what: &str| -> Result<Option<String>, Failure> {
            Ok(
                git(&["-C", dir, "rev-parse", "--path-format=absolute", what])?
                    .and_then(|path| self.host.physical(&path)),
            )
        };
        let (Some(common), Some(gitdir), Some(session)) = (
            abs(&top, "--git-common-dir")?,
            abs(&top, "--git-dir")?,
            abs(root, "--git-common-dir")?,
        ) else {
            return Ok(root.to_owned());
        };
        if common != session || gitdir == common {
            return Ok(root.to_owned());
        }
        let listed = git(&["-C", root, "worktree", "list", "--porcelain"])?.is_some_and(|list| {
            list.split('\n')
                .any(|line| line == format!("worktree {top}"))
        });
        Ok(if listed { top } else { root.to_owned() })
    }
}

/// `nv_edited_paths` under Codex: the `apply_patch` file headers.
fn edited_paths(command: &str) -> Vec<String> {
    let headers = ["Add File", "Update File", "Delete File", "Move to"];
    command
        .split('\n')
        .filter_map(|line| {
            let rest = line.strip_prefix("*** ")?;
            headers
                .iter()
                .find_map(|header| rest.strip_prefix(header)?.strip_prefix(": "))
                .map(str::to_owned)
        })
        .filter(|path| !path.is_empty())
        .collect()
}

/// Evaluate one call.
///
/// # Errors
/// An extraction failure, a field that is not valid UTF-8, or a host fact the port cannot
/// reproduce.
pub fn evaluate(
    payload: &[u8],
    context: &Context<'_>,
    host: &dyn Host,
) -> Result<Evaluation, Failure> {
    let captured = payload::capture(payload);
    let fields = payload::extract(&captured, &FIELDS, context.profile)?;
    for (index, value) in fields.values.iter().enumerate() {
        if fields.bytes.get(index).copied().unwrap_or_default() != value.len() {
            return Err(Failure("a payload field is not valid UTF-8".to_owned()));
        }
    }
    let stderr = capture::prepend(
        context.capture,
        payload.contains(&0),
        fields.nul_substitutions,
        Vec::new(),
    );
    let done = |verdict: Verdict, label: &'static str, reason: &str, extra: &str| {
        let mut err = stderr.clone();
        err.extend_from_slice(extra.as_bytes());
        Evaluation {
            verdict,
            stdout: Vec::new(),
            stderr: err,
            audit: Some(AuditLabel {
                verdict: label,
                reason: reason.to_owned(),
            }),
        }
    };
    let skip = |reason: &str| done(Verdict::Permit, "skip", reason, "");
    let block = |reason: String| {
        done(
            Verdict::Block,
            "block",
            &reason,
            &format!("[navori] BLOCKED by role-guard: {reason}\n"),
        )
    };
    if !captured
        .windows(b"\"agent_type\"".len())
        .any(|w| w == b"\"agent_type\"")
    {
        return Ok(skip("sin agent_type (hilo principal)"));
    }
    if matches!(context.profile.extractor, Extractor::Sed) {
        return Ok(skip("sin jq ni node: payload ilegible"));
    }
    let values = &fields.values;
    let role = values[AGENT_TYPE].as_str();
    if role.is_empty() {
        return Ok(skip("agent_type vacío (hilo principal)"));
    }
    let raw_tool = values[TOOL_NAME].as_str();
    if raw_tool.ends_with("spawn_agent") {
        return Ok(block(format!(
            "{role} no despacha subagentes (profundidad 1); el orquestador del hilo principal los lanza"
        )));
    }
    let tool = match raw_tool {
        "apply_patch" => "Edit",
        "spawn_agent" => "Agent",
        tool => tool,
    };
    if tool != "Edit" {
        return Ok(skip("tool_name no cubierto"));
    }
    if role == "implementer" || role == "scribe" {
        return Ok(skip("rol exento"));
    }
    // `nv_project_dir` under Codex: the toplevel of `${cwd:-.}`, else that directory.
    let payload_cwd = values[CWD].as_str();
    let dot = if payload_cwd.is_empty() {
        "."
    } else {
        payload_cwd
    };
    let project_dir = host
        .git(&["-C", dot, "rev-parse", "--show-toplevel"])?
        .unwrap_or_else(|| dot.to_owned());
    let cwd = if payload_cwd.is_empty() {
        if project_dir.is_empty() {
            "."
        } else {
            project_dir.as_str()
        }
    } else {
        payload_cwd
    };
    let base = if project_dir.is_empty() {
        cwd
    } else {
        project_dir.as_str()
    };
    let Some(root) = host.physical(base) else {
        return Ok(skip("raíz del repo ilegible"));
    };
    let granted = context.rendered.policy.lines(role);
    let allowed = granted.join("\n");
    // `$(printf '%s' "$allowed" | tr '\n' ' ')` with one trailing space dropped.
    let list = allowed.replace('\n', " ");
    let list = list.strip_suffix(' ').unwrap_or(&list).to_owned();
    let walk = Walk { host };
    let mut external: Vec<String> = Vec::new();
    for path in edited_paths(&values[COMMAND]) {
        let abs = if path.starts_with('/') {
            normalize(&path)
        } else {
            normalize(&format!("{cwd}/{path}"))
        };
        let real = walk.realpath(&abs);
        if real.is_empty() {
            return Ok(block(format!(
                "{role} no escribe '{path}' (ruta no resoluble; permitido: {list})"
            )));
        }
        if let Some(_inside) = real.strip_prefix(&format!("{root}/")) {
            let tree = walk.containing_root(&real, &root)?;
            let rel = real.strip_prefix(&format!("{tree}/")).unwrap_or(&real);
            let ok = granted.iter().filter(|p| !p.is_empty()).any(|prefix| {
                let prefix = prefix.strip_suffix('/').unwrap_or(prefix);
                rel == prefix || rel.starts_with(&format!("{prefix}/"))
            });
            if !ok {
                return Ok(block(format!(
                    "{role} no escribe '{path}' (permitido: {list})"
                )));
            }
        } else if real == root {
            return Ok(block(format!(
                "{role} no escribe '{path}' (permitido: {list})"
            )));
        } else if walk.in_temp(&real) {
            continue;
        } else if role == "reviewer" {
            external.push(if path.starts_with('/') {
                path.clone()
            } else {
                format!("{cwd}/{path}")
            });
        } else {
            return Ok(block(format!(
                "{role} no escribe '{path}' (fuera del repo; permitido: {list})"
            )));
        }
    }
    if !external.is_empty() {
        let mut args: Vec<&str> = vec![&root, &values[AGENT_ID], role, &allowed];
        args.extend(external.iter().map(String::as_str));
        let result = match host.bind(&context.rendered.binding, &args)? {
            Some(answer) => answer,
            None => (false, "node-unavailable".to_owned()),
        };
        if !result.0 {
            let why = if result.1.is_empty() {
                "role-prefix-denied"
            } else {
                &result.1
            };
            return Ok(block(format!(
                "{role} no escribe fuera del repo ({why}); run receipt review preflight before the full gate"
            )));
        }
        let mut ok = done(Verdict::Permit, "allow", "rutas dentro del rol", "");
        ok.stderr
            .extend_from_slice(b"[navori] role-guard: bound-review-output\n");
        return Ok(ok);
    }
    Ok(done(Verdict::Permit, "allow", "rutas dentro del rol", ""))
}

#[cfg(test)]
mod tests {
    use super::{edited_paths, normalize};

    // Covers: R70
    #[test]
    fn paths_normalize_like_the_script() {
        assert_eq!(normalize("/a/./b//c/../d"), "/a/b/d");
        assert_eq!(normalize("/.."), "/");
        assert_eq!(normalize("/a/b/../../.."), "/");
        assert_eq!(
            edited_paths("*** Add File: a\n*** Update File: b\nx"),
            ["a", "b"]
        );
    }
}
