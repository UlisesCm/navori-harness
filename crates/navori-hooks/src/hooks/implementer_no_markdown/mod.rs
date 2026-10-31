//! The implementer's Markdown guard (spec 0060 T12, R70).
//!
//! `implementer-no-markdown.sh` blocks the `implementer` from writing `.md`/`.mdx` outside the
//! AI-doctrine prefixes: an edit tool on such a path, and the Bash write forms of R4 over the
//! command text. The rules run here; the facts come from a [`Host`]: `git` and the file system
//! for the registered-worktree rule, `command -v`, and the three fixed analyzer programs of the
//! interpreter rule, which the host runs exactly as the script does (they only read their
//! stdin). Nothing the hook does writes, so shadow evaluates it whole. What Rust cannot answer
//! the way Bash would is a [`Failure`], which defers the call to the shell.

pub mod rendered;

use std::sync::LazyLock;

use regex::Regex;

pub use rendered::Rendered;

use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};
use crate::shell::Locale;
use crate::shell::capture::{self, CaptureContext};
use crate::shell::payload::{self, Profile};

/// Hosts that register this hook; Pi runs the same script through its tool-call bridge.
pub const ENGINES: &[Engine] = &[Engine::Claude, Engine::Codex, Engine::Pi];

/// `nv_payload_fields`, in its declared order.
const FIELDS: [&str; 9] = [
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
const AGENT_TYPE: usize = 0;
const CWD: usize = 1;
const COMMAND: usize = 4;
const FILE_PATH: usize = 5;
const NOTEBOOK_PATH: usize = 6;
const TOOL_NAME: usize = 8;

/// `navori_doctrine_prefixes`: the closed AI-doctrine list (spec 0052, R49).
const DOCTRINE: [&str; 13] = [
    "packages/core/core-assets/agents/",
    "packages/core/core-assets/skills/",
    "packages/core/core-assets/managed/",
    "packages/core/core-assets/hooks/",
    ".claude/agents/",
    ".claude/skills/",
    ".claude/context/",
    ".claude/hooks/",
    ".codex/agents/",
    ".codex/hooks/",
    ".codex/orchestrator.md",
    ".agents/skills/",
    ".pi/navori/",
];

/// `grep` reads its input whole only up to the pipe buffer; past it, `printf … | grep -q` may
/// fail with SIGPIPE under `pipefail`. Longer commands defer.
const PIPE_SAFE: usize = 64 * 1024;

/// The analyzer programs of the interpreter rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Analyzer {
    /// `node -e "$navori_json_analyzer"`.
    Json,
    /// `node -e "$navori_node_write_analyzer"`.
    NodeWrite,
    /// `python3 -I -S -c "$navori_python_dest_analyzer"`.
    Python,
}

/// What the script reads outside its payload and its own text.
pub trait Host {
    /// `command -v name`.
    fn on_path(&self, name: &str) -> bool;
    /// `$(git args 2>/dev/null)` run from the hook's directory: stdout without trailing
    /// newlines when git exits 0, `None` otherwise (also when git is not on `PATH`).
    ///
    /// # Errors
    /// An answer the port cannot reproduce (a NUL byte, non-UTF-8 output).
    fn git(&self, args: &[&str]) -> Result<Option<String>, Failure>;
    /// `[ -L path ]`.
    fn is_symlink(&self, path: &str) -> bool;
    /// `[ -d path ]`.
    fn is_dir(&self, path: &str) -> bool;
    /// `$(printf '%s' "$cmd" | <program> 2>/dev/null)`: stdout without trailing newlines when
    /// the program exits 0, `None` otherwise.
    ///
    /// # Errors
    /// A run the port cannot reproduce.
    fn analyze(
        &self,
        analyzer: Analyzer,
        program: &str,
        input: &[u8],
    ) -> Result<Option<String>, Failure>;
}

/// The invocation facts collected before stdin.
#[derive(Debug, Clone)]
pub struct Context<'a> {
    /// The engine whose copy runs (`nv_engine`, from `$0`).
    pub engine: Engine,
    /// Accredited extraction and locale profile.
    pub profile: Profile,
    /// Script identity and the source lines of the Bash 5 NUL warnings.
    pub capture: CaptureContext<'a>,
    /// The analyzer programs the script carries.
    pub rendered: Rendered,
    /// `CLAUDE_PROJECT_DIR` (`nv_project_dir` under Claude), `None` when unset or empty.
    pub claude_project_dir: Option<String>,
}

/// The cheap, fork-free tests of the script plus the payload, before any host fact.
struct Call<'a, 'b> {
    context: &'a Context<'b>,
    host: &'a dyn Host,
    cwd: String,
}

impl Call<'_, '_> {
    /// `nv_project_dir`: `$CLAUDE_PROJECT_DIR` under Claude; under Codex and Pi the toplevel of
    /// `${nv_cwd:-.}`, else that directory.
    fn project_dir(&self) -> Result<String, Failure> {
        if self.context.engine == Engine::Claude {
            return Ok(self.context.claude_project_dir.clone().unwrap_or_default());
        }
        let dir = if self.cwd.is_empty() {
            "."
        } else {
            self.cwd.as_str()
        };
        Ok(self
            .host
            .git(&["-C", dir, "rev-parse", "--show-toplevel"])?
            .unwrap_or_else(|| dir.to_owned()))
    }

    /// `$(git -C "$(payload_field cwd)" rev-parse --show-toplevel 2>/dev/null || true)`.
    fn cwd_toplevel(&self) -> Result<String, Failure> {
        Ok(self
            .host
            .git(&["-C", &self.cwd, "rev-parse", "--show-toplevel"])?
            .unwrap_or_default())
    }

    /// `nv_sibling_rel`: `p` inside another registered worktree of the session's repository.
    fn sibling_rel(&self, p: &str) -> Result<Option<String>, Failure> {
        if !p.starts_with('/') {
            return Ok(None);
        }
        let mut cursor = String::new();
        for part in p[1..].split('/') {
            cursor.push('/');
            cursor.push_str(part);
            if self.host.is_symlink(&cursor) {
                return Ok(None);
            }
        }
        let mut dir = &p[..p.rfind('/').unwrap_or(0)];
        while !dir.is_empty() && !self.host.is_dir(dir) {
            dir = &dir[..dir.rfind('/').unwrap_or(0)];
        }
        if dir.is_empty() {
            return Ok(None);
        }
        let git = |args: &[&str]| -> Result<Option<String>, Failure> {
            let mut full = vec!["-c", "core.fsmonitor=false"];
            full.extend_from_slice(args);
            Ok(self.host.git(&full)?.filter(|out| !out.is_empty()))
        };
        let Some(top) = git(&["-C", dir, "rev-parse", "--show-toplevel"])? else {
            return Ok(None);
        };
        let Some(rel) = p
            .strip_prefix(&format!("{top}/"))
            .filter(|rel| !rel.is_empty())
        else {
            return Ok(None);
        };
        let common_args = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
        let Some(common) = git(&[&["-C", top.as_str()][..], &common_args[..]].concat())? else {
            return Ok(None);
        };
        for session in [self.project_dir()?, self.cwd_toplevel()?] {
            if session.is_empty() {
                continue;
            }
            let Some(theirs) = git(&[&["-C", session.as_str()][..], &common_args[..]].concat())?
            else {
                continue;
            };
            if theirs != common {
                continue;
            }
            // `worktree list` may print nothing and still succeed.
            let mut full = vec!["-c", "core.fsmonitor=false"];
            full.extend_from_slice(&["-C", &session, "worktree", "list", "--porcelain"]);
            let Some(list) = self.host.git(&full)? else {
                continue;
            };
            let listed = |line: &str| list.split('\n').any(|l| l == line);
            if listed(&format!("worktree {top}"))
                && listed(&format!(
                    "worktree {}",
                    session.strip_suffix('/').unwrap_or(&session)
                ))
            {
                return Ok(Some(rel.to_owned()));
            }
        }
        Ok(None)
    }

    /// `is_doctrine_path`: relative under a prefix, or absolute inside the session's root or a
    /// registered sibling worktree; never with a `..` segment.
    fn is_doctrine_path(&self, p: &str) -> Result<bool, Failure> {
        if p == ".." || p.starts_with("../") || p.ends_with("/..") || p.contains("/../") {
            return Ok(false);
        }
        if !p.starts_with('/') {
            return Ok(rel_is_doctrine(p.strip_prefix("./").unwrap_or(p)));
        }
        for candidate in [self.project_dir()?, self.cwd_toplevel()?] {
            let root = candidate.strip_suffix('/').unwrap_or(&candidate);
            if root.is_empty() {
                continue;
            }
            if let Some(rel) = p.strip_prefix(&format!("{root}/")) {
                if !rel.is_empty() && rel_is_doctrine(rel) {
                    return Ok(true);
                }
                break;
            }
        }
        Ok(self
            .sibling_rel(p)?
            .is_some_and(|rel| rel_is_doctrine(&rel)))
    }
}

/// `is_md_path`: `*.md` or `*.mdx`, any case.
fn is_md_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".md") || lower.ends_with(".mdx")
}

/// `nv_rel_is_doctrine`.
fn rel_is_doctrine(rel: &str) -> bool {
    DOCTRINE.iter().any(|prefix| {
        if prefix.ends_with('/') {
            rel.strip_prefix(prefix)
                .is_some_and(|rest| !rest.is_empty())
        } else {
            rel == *prefix
        }
    })
}

/// `nv_edited_paths`: under Codex the `apply_patch` file headers of the command, else the
/// file and notebook paths.
fn edited_paths(engine: Engine, values: &[String]) -> Vec<String> {
    if engine == Engine::Codex {
        let headers = ["Add File", "Update File", "Delete File", "Move to"];
        return values[COMMAND]
            .split('\n')
            .filter_map(|line| {
                let rest = line.strip_prefix("*** ")?;
                headers
                    .iter()
                    .find_map(|header| rest.strip_prefix(header)?.strip_prefix(": "))
                    .map(str::to_owned)
            })
            .filter(|path| !path.is_empty())
            .collect();
    }
    [&values[FILE_PATH], &values[NOTEBOOK_PATH]]
        .into_iter()
        .filter(|path| !path.is_empty())
        .cloned()
        .collect()
}

/// The R4 Bash rules, each compiled for the three locales.
struct Rules {
    /// `grep -qiE` rules 1–4, in order, with the reason each blocks with.
    write: Vec<(Regex, &'static str)>,
    interpreter: Regex,
    md_literal: Regex,
    /// `WRITE_API|FILE_WRITE|OPEN_WRITE` with `[[:alnum:]]` as ASCII, and as Unicode.
    write_api: Regex,
    write_api_unicode: Regex,
}

const MD_EXT: &str = r"\.(md|mdx)";
const TAIL: &str = r"([[:space:]]|;|&|\||$)";

fn rules(locale: Locale) -> Result<Rules, regex::Error> {
    let write = [
        (
            format!(r">>?\|?[[:space:]]*[^[:space:];&|]*{MD_EXT}{TAIL}"),
            "redirección hacia un archivo .md/.mdx",
        ),
        (
            format!(
                r"(^|[;&|[:space:]])tee([[:space:]]+-[a-zA-Z]+)*[[:space:]]+[^[:space:];&|]*{MD_EXT}{TAIL}"
            ),
            "'tee' hacia un archivo .md/.mdx",
        ),
        (
            format!(
                r"(^|[;&|[:space:]])sed[[:space:]]+(-[a-zA-Z]*i[a-zA-Z]*[^[:space:]]*|--in-place)([[:space:]]|=).*{MD_EXT}{TAIL}"
            ),
            "'sed -i' sobre un archivo .md/.mdx",
        ),
        (
            format!(
                r"(^|[;&|[:space:]])perl[[:space:]]+-[a-zA-Z]*i[a-zA-Z]*[^[:space:]]*([[:space:]]|=).*{MD_EXT}{TAIL}"
            ),
            "'perl -i' sobre un archivo .md/.mdx",
        ),
        (
            format!(
                r"(^|[;&|[:space:]])(cp|mv)[[:space:]]+.*[[:space:]][^[:space:];&|]*{MD_EXT}{TAIL}"
            ),
            "'cp'/'mv' hacia un archivo .md/.mdx",
        ),
    ];
    let write_api = r#"(^|[^[:alnum:]_])(writeFile(Sync)?|appendFile(Sync)?|writeTextFile(Sync)?|write_text|write_bytes|copyFile(Sync)?|cpSync|renameSync)[[:space:]]*\(|shutil[[:space:]]*\.[[:space:]]*(copy|copy2|copyfile|copyfileobj|copytree|move)[[:space:]]*\(|os[[:space:]]*\.[[:space:]]*(rename|renames|replace)[[:space:]]*\(|\.[[:space:]]*(rename|replace)[[:space:]]*\([^,()]*\)|(File|Bun)[[:space:]]*\.[[:space:]]*(write|binwrite)[[:space:]]*\(|(^|[^[:alnum:]_])open[[:space:]]*\([^)]*,[[:space:]]*(mode[[:space:]]*=[[:space:]]*)?['"]([wax][bt+]*|r[bt]*\+|[+]?>>?)['"]"#;
    Ok(Rules {
        write: write
            .into_iter()
            .map(|(pattern, reason)| Ok((locale.ere(&pattern)?, reason)))
            .collect::<Result<_, regex::Error>>()?,
        interpreter: locale.ere(
            r"(^|[;&|[:space:]])([^[:space:];&|]*/)?(python([0-9]+(\.[0-9]+)*)?|node|ruby|perl|deno|bun)([[:space:]]|$)",
        )?,
        md_literal: locale.ere(&format!(r#"{MD_EXT}(['"]|[[:space:]]|$)"#))?,
        write_api: locale.ere(write_api)?,
        write_api_unicode: locale.ere(&write_api.replace("[:alnum:]", r"\p{Alphabetic}\p{Nd}"))?,
    })
}

fn compiled(locale: Locale) -> Result<&'static Rules, Failure> {
    const LOCALES: [Locale; 3] = [Locale::Utf8, Locale::GnuUtf8, Locale::C];
    static COMPILED: LazyLock<Vec<Result<Rules, regex::Error>>> =
        LazyLock::new(|| LOCALES.into_iter().map(rules).collect());
    let column = LOCALES.iter().position(|l| *l == locale).unwrap_or(0);
    COMPILED
        .get(column)
        .ok_or_else(|| Failure("rules missing".to_owned()))?
        .as_ref()
        .map_err(|error| Failure(format!("rule pattern: {error}")))
}

/// `printf '%s' "$text" | grep -qE pattern`: some line of `text` matches.
fn any_line(regex: &Regex, text: &str) -> bool {
    text.split('\n').any(|line| regex.is_match(line))
}

fn block_message(reason: &str) -> Vec<u8> {
    format!(
        "[navori] BLOCKED by implementer-no-markdown: {reason}\n[navori] the implementer writes Markdown only for AI doctrine (spec 0052, R49), with the edit tools, under: {}. Absolute paths are accepted inside registered worktrees of this repo. Anything else (progress/, specs/, docs/, README, handoffs, paths with '..', other repos, symlinks) goes in \"markdownRequests\", inside .navori/state/handoffs/impl_<feature>.json — the scribe applies it in this worktree. Bash never writes Markdown.\n",
        DOCTRINE.join(" ")
    )
    .into_bytes()
}

/// Evaluate one call.
///
/// # Errors
/// An extraction failure, text that is not valid UTF-8, a host fact the port cannot
/// reproduce, or a command whose matching would depend on how the locale folds non-ASCII text.
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
    let done = |verdict: Verdict, label: &'static str, reason: &str, extra: Vec<u8>| {
        let mut err = stderr.clone();
        err.extend(extra);
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
    let allow = |reason: &str| done(Verdict::Permit, "allow", reason, Vec::new());
    let skip = |reason: &str| done(Verdict::Permit, "skip", reason, Vec::new());
    let block = |reason: String| done(Verdict::Block, "block", &reason, block_message(&reason));

    // THE CHEAP GATE: the main thread carries no `agent_type` key at all.
    if !captured
        .windows(b"\"agent_type\"".len())
        .any(|w| w == b"\"agent_type\"")
    {
        return Ok(skip("sin agent_type (hilo principal)"));
    }
    let values = &fields.values;
    if values[AGENT_TYPE] != "implementer" {
        return Ok(skip("no es el implementer"));
    }
    let call = Call {
        context,
        host,
        cwd: values[CWD].clone(),
    };
    let raw_tool = values[TOOL_NAME].as_str();
    let tool = match (context.engine, raw_tool) {
        (Engine::Codex, "apply_patch") => "Edit",
        (Engine::Codex, "spawn_agent") => "Agent",
        (_, tool) => tool,
    };
    match tool {
        "Write" | "Edit" => {
            for path in edited_paths(context.engine, values) {
                if is_md_path(&path) && !call.is_doctrine_path(&path)? {
                    return Ok(block(format!("{tool} sobre '{path}'")));
                }
            }
            return Ok(allow("ruta no-md"));
        }
        "NotebookEdit" => {
            let path = &values[NOTEBOOK_PATH];
            if is_md_path(path) && !call.is_doctrine_path(path)? {
                return Ok(block(format!("NotebookEdit sobre '{path}'")));
            }
            return Ok(allow("ruta no-md"));
        }
        "Bash" => {}
        _ => return Ok(skip("tool_name no cubierto")),
    }
    let cmd = values[COMMAND].as_str();
    if cmd.is_empty() {
        return Ok(skip("sin comando que inspeccionar"));
    }
    if cmd.len() > PIPE_SAFE {
        return Err(Failure("the command outgrows the pipe buffer".to_owned()));
    }
    let rules = compiled(context.profile.locale)?;
    // `grep -i` on ASCII patterns: fold ASCII only, never Unicode (`ſ` is not `s` to grep).
    let folded = cmd.to_ascii_lowercase();
    for (regex, reason) in &rules.write {
        if any_line(regex, &folded) {
            return Ok(block((*reason).to_owned()));
        }
    }
    let flat = cmd.replace('\n', " ");
    let clues = any_line(&rules.interpreter, &flat)
        && any_line(&rules.md_literal, &flat.to_ascii_lowercase());
    let write = clues && any_line(&rules.write_api, &flat);
    // Under a UTF-8 locale `[[:alnum:]]` also holds non-ASCII letters; LC_ALL=C is exact.
    if clues
        && context.profile.locale != Locale::C
        && write != any_line(&rules.write_api_unicode, &flat)
    {
        return Err(Failure("[[:alnum:]] decides the write rule".to_owned()));
    }
    if !write {
        return Ok(allow("comando no cubierto por R4"));
    }
    let programs = &context.rendered;
    if host.on_path("node") {
        if host
            .analyze(Analyzer::Json, &programs.json, cmd.as_bytes())?
            .as_deref()
            == Some("ALLOW")
        {
            return Ok(allow("programa JSON estático reconocido"));
        }
        if host
            .analyze(Analyzer::NodeWrite, &programs.node_write, cmd.as_bytes())?
            .as_deref()
            == Some("ALLOW")
        {
            return Ok(allow("escritura JSON Node literal reconocida"));
        }
    }
    if host.on_path("python3")
        && host
            .analyze(Analyzer::Python, &programs.python, cmd.as_bytes())?
            .as_deref()
            == Some("ALLOW")
    {
        return Ok(allow("escritura Python con destinos literales no-md"));
    }
    Ok(block(
        "intérprete con operación de escritura y ruta .md/.mdx".to_owned(),
    ))
}

#[cfg(test)]
mod tests {
    use super::{Engine, compiled, edited_paths, is_md_path, rel_is_doctrine};
    use crate::shell::Locale;

    // Covers: R70
    #[test]
    fn paths_and_rules_read_like_the_script() -> Result<(), super::Failure> {
        assert!(is_md_path("NOTES.MD") && is_md_path("a.mdx") && !is_md_path("a.mdz"));
        assert!(rel_is_doctrine(".claude/agents/x.md") && !rel_is_doctrine(".claude/agents/"));
        assert!(rel_is_doctrine(".codex/orchestrator.md") && !rel_is_doctrine("docs/x.md"));
        let values: Vec<String> = [
            "",
            "",
            "",
            "",
            "*** Add File: a.md\n*** Move to: b.md\nx",
            "",
            "",
            "",
            "",
        ]
        .map(str::to_owned)
        .to_vec();
        assert_eq!(edited_paths(Engine::Codex, &values), ["a.md", "b.md"]);
        let rules = compiled(Locale::Utf8)?;
        let blocks = |cmd: &str| rules.write.iter().any(|(r, _)| r.is_match(cmd));
        assert!(blocks("echo x > notes.md"));
        assert!(blocks("cat a | tee -a notes.mdx"));
        assert!(blocks("sed -i '' s/a/b/ readme.md"));
        assert!(blocks("cp a.txt b.md"));
        assert!(!blocks("cat notes.md"));
        Ok(())
    }
}
