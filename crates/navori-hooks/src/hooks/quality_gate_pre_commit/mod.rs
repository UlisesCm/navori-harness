//! quality-gate-pre-commit.sh (spec 0059 T7): the rendered script end to end, as a pure decision.
//!
//! The decision stops at the first branch with effects (D40) and hands it to the caller as a
//! [`Step`]: running `qualityGate.fast` ([`Step::Gate`]) or the destination's gate through
//! `navori gate foreign` ([`Step::Foreign`]). [`after_gate`] and [`after_foreign`] read the
//! outcome the way the script does. Host facts arrive through [`Repo`] and [`Gate`].

pub mod rendered;

pub use rendered::Rendered;

use crate::runner::{AuditLabel, Engine, Evaluation, Failure, Verdict};
use crate::shell::Locale;
use crate::shell::capture::{self, CaptureContext, ShellDialect};
use crate::shell::gate_ask::{ask_answer, can_ask};
use crate::shell::gate_trigger::{Trigger, is_scan_trigger};
use crate::shell::hook_input::{self, Host};
use crate::shell::landing::Facts;
use crate::shell::payload::{self, Extractor, Profile};
use crate::shell::ratchet;
use crate::shell::repo::Repo;

/// Hosts that register quality-gate-pre-commit.
pub const ENGINES: &[Engine] = &[Engine::Claude, Engine::Codex, Engine::Pi];

/// `nv_payload_fields` of quality-gate-pre-commit.sh, in the script's order.
const FIELDS: [&str; 10] = [
    "agent_type",
    "cwd",
    "hook_event_name",
    "permission_mode",
    "tool_input.agent_type",
    "tool_input.command",
    "tool_input.file_path",
    "tool_input.notebook_path",
    "tool_input.subagent_type",
    "tool_name",
];
const CWD: usize = 1;
const EVENT: usize = 2;
const MODE: usize = 3;
const COMMAND: usize = 5;

const DEFAULT_SKIP: &str = "el comando no es un commit";
const FOREIGN_REPO: &str = "foreign-repo";

/// Host facts the script reads after stdin that are not repository facts.
pub trait Gate {
    /// `command -v name` along `PATH` from `dir`: any non-directory file found, or, for a name
    /// with a `/`, an executable regular file. Builtins, keywords and functions are the
    /// caller's business.
    fn on_path(&self, name: &str, dir: &str) -> bool;
    /// `navori_gate_probe_hit` with the shell at `dir`: a cached green `fast` for these bytes.
    fn probe_hit(&self, dir: &str) -> bool;
    /// Bytes of a file, `None` when it cannot be read.
    fn read(&self, path: &str) -> Option<Vec<u8>>;
    /// Why `cd dir` fails (`strerror` text), `None` when it succeeds.
    ///
    /// # Errors
    /// A failure whose Bash message is not modeled.
    fn cd_error(&self, dir: &str) -> Result<Option<&'static str>, String>;
}

/// Everything fixed before stdin.
#[derive(Debug, Clone)]
pub struct Context<'a> {
    /// Host of this invocation.
    pub engine: Engine,
    /// Accredited extraction and locale profile.
    pub profile: Profile,
    /// Script identity and source lines of the Bash 5 NUL warnings.
    pub capture: CaptureContext<'a>,
    /// Values the renderer wrote into the script.
    pub rendered: Rendered,
    /// Environment facts; `project_dir` and `cwd` are filled in from the payload.
    pub host: Host,
    /// `$0`: the script path exactly as invoked.
    pub script: String,
}

/// The exit trap's state (`navori_audit_*`), carried across an effect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Trap {
    ran_gate: bool,
    skip_reason: &'static str,
    ask_reason: Option<String>,
    block_reason: Option<String>,
    allow_reason: Option<&'static str>,
}

impl Default for Trap {
    fn default() -> Self {
        Self {
            ran_gate: false,
            skip_reason: DEFAULT_SKIP,
            ask_reason: None,
            block_reason: None,
            allow_reason: None,
        }
    }
}

/// Output produced before an effect, plus what reading its outcome needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    /// stdout so far.
    pub stdout: Vec<u8>,
    /// stderr so far.
    pub stderr: Vec<u8>,
    trap: Trap,
    engine: Engine,
    can_ask: bool,
}

/// The `qualityGate.fast` run the script `eval`s.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GateRun {
    /// The command string `run_gate` receives.
    pub command: String,
    /// The shell's logical working directory (`$PWD` after the `cd`).
    pub pwd: String,
    /// `$OLDPWD` after the `cd`, `None` when no `cd` changed directory.
    pub oldpwd: Option<String>,
}

/// Where the decision stopped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// The script finished without effects.
    Done(Evaluation),
    /// Record `gate-started`, then run the gate (see [`after_gate`]).
    Gate(Pending, GateRun),
    /// Record `gate-started`, then run `navori gate foreign --cwd <root> 2>&1 </dev/null` from
    /// the hook's working directory (see [`after_foreign`]).
    Foreign(Pending, String),
}

/// The exit trap's audit category for the final status.
fn finish(stdout: Vec<u8>, stderr: Vec<u8>, status: u8, trap: Trap) -> Evaluation {
    let audit = if status != 0 {
        AuditLabel {
            verdict: "block",
            reason: trap
                .block_reason
                .unwrap_or_else(|| "el quality gate no paso o no pudo correr".to_owned()),
        }
    } else if let Some(reason) = trap.ask_reason {
        AuditLabel {
            verdict: "ask",
            reason,
        }
    } else if trap.ran_gate {
        AuditLabel {
            verdict: "allow",
            reason: trap
                .allow_reason
                .unwrap_or("gate ejecutado y verde")
                .to_owned(),
        }
    } else {
        AuditLabel {
            verdict: "skip",
            reason: trap.skip_reason.to_owned(),
        }
    };
    Evaluation {
        verdict: if status == 2 {
            Verdict::Block
        } else {
            Verdict::Permit
        },
        stdout,
        stderr,
        audit: Some(audit),
    }
}

fn line(out: &mut Vec<u8>, text: &str) {
    out.extend_from_slice(text.as_bytes());
    out.push(b'\n');
}

/// Bash builtins and reserved words `command -v` answers without `PATH`.
fn shell_word(name: &str, shell: ShellDialect) -> bool {
    const COMMON: &[&str] = &[
        ".", ":", "[", "alias", "bg", "bind", "break", "builtin", "caller", "cd", "command",
        "compgen", "complete", "continue", "declare", "dirs", "disown", "echo", "enable", "eval",
        "exec", "exit", "export", "false", "fc", "fg", "getopts", "hash", "help", "history",
        "jobs", "kill", "let", "local", "logout", "popd", "printf", "pushd", "pwd", "read",
        "readonly", "return", "set", "shift", "shopt", "source", "suspend", "test", "times",
        "trap", "true", "type", "typeset", "ulimit", "umask", "unalias", "unset", "wait", "!",
        "[[", "]]", "case", "do", "done", "elif", "else", "esac", "fi", "for", "function", "if",
        "in", "select", "then", "time", "until", "while", "{", "}",
    ];
    const BASH5: &[&str] = &["compopt", "mapfile", "readarray", "coproc"];
    COMMON.contains(&name) || (shell == ShellDialect::Bash5 && BASH5.contains(&name))
}

/// Lexical `cd` result: Bash's logical `$PWD` for `dir` from `pwd`.
fn logical(pwd: &str, dir: &str) -> String {
    let joined = if dir.starts_with('/') {
        dir.to_owned()
    } else {
        format!("{pwd}/{dir}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

/// The evaluation state after stdin.
struct Run<'a, 'b> {
    context: &'a Context<'b>,
    repo: &'a dyn Repo,
    gate: &'a dyn Gate,
    host: Host,
    cmd: String,
    event: String,
    mode: String,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
    trap: Trap,
}

impl Run<'_, '_> {
    fn locale(&self) -> Locale {
        self.context.profile.locale
    }

    fn can_ask(&self) -> bool {
        let jq = matches!(
            self.context.profile.extractor,
            Extractor::JqAndNode | Extractor::JqOnly
        );
        can_ask(&self.context.script, jq, &self.event, &self.mode)
    }

    fn done(self, status: u8) -> Step {
        Step::Done(finish(self.stdout, self.stderr, status, self.trap))
    }

    fn pending(self) -> Pending {
        let can_ask = self.can_ask();
        Pending {
            stdout: self.stdout,
            stderr: self.stderr,
            trap: self.trap,
            engine: self.context.engine,
            can_ask,
        }
    }

    fn command_exists(&self, name: &str, dir: &str) -> bool {
        !name.is_empty()
            && (shell_word(name, self.context.capture.shell)
                || self.context.rendered.functions.iter().any(|f| f == name)
                || self.gate.on_path(name, dir))
    }

    /// The commit lands in another repository (#1095, #1097).
    fn foreign(mut self, root: String) -> Result<Step, Failure> {
        self.trap.skip_reason = FOREIGN_REPO;
        line(
            &mut self.stderr,
            &format!(
                "[navori] quality-gate NOT run on this repository: this commit lands in another repository ({root}), not the one this hook protects."
            ),
        );
        let commit = self.context.engine != Engine::Pi
            || is_scan_trigger(&self.cmd, Trigger::Commit, self.locale()).map_err(Failure)?;
        if !commit || !self.repo.is_file(&format!("{root}/navori.config.json")) {
            line(
                &mut self.stderr,
                "[navori] That repository's own gate is not run from here; run it there before relying on this commit.",
            );
            return Ok(self.done(0));
        }
        if !self.command_exists("navori", &self.host.pwd.clone()) {
            line(
                &mut self.stderr,
                "[navori] The destination's gate was NOT run: navori is not on PATH, so its registration cannot be checked. Run its gate there before relying on this commit.",
            );
            return Ok(self.done(0));
        }
        line(
            &mut self.stderr,
            &format!(
                "[navori] Evaluating the destination's qualityGate.fast: {root} (it runs on the tree as it is BEFORE this command, so changes made by the same command are not covered)."
            ),
        );
        Ok(Step::Foreign(self.pending(), root))
    }

    /// `detect_pm` from the shell's working directory.
    fn detect_pm(&self, here: &str) -> Result<Option<&'static str>, Failure> {
        let file = |name: &str| self.repo.is_file(&format!("{here}/{name}"));
        if file("package.json")
            && let Some(bytes) = self.gate.read(&format!("{here}/package.json"))
        {
            let text = String::from_utf8(bytes)
                .map_err(|_| Failure("package.json is not UTF-8".to_owned()))?;
            let pattern = self
                .locale()
                .ere(r#"^.*"packageManager"[[:space:]]*:[[:space:]]*"([a-z]*)@.*$"#)
                .map_err(|e| Failure(format!("packageManager pattern: {e}")))?;
            let found = text
                .split('\n')
                .find_map(|line| pattern.captures(line))
                .and_then(|captures| captures.get(1))
                .map(|m| m.as_str());
            if let Some(pm) = found
                && let Some(pm) = ["pnpm", "npm", "yarn", "bun"]
                    .into_iter()
                    .find(|p| *p == pm)
            {
                return Ok(Some(pm));
            }
        }
        Ok(if file("pnpm-lock.yaml") {
            Some("pnpm")
        } else if file("bun.lockb") || file("bun.lock") {
            Some("bun")
        } else if file("yarn.lock") {
            Some("yarn")
        } else if file("package-lock.json") {
            Some("npm")
        } else {
            None
        })
    }

    /// The gate block, from the `cd` on.
    fn own_gate(mut self) -> Result<Step, Failure> {
        let trigger = if self.context.engine == Engine::Pi {
            Trigger::CommitOrPush
        } else {
            Trigger::Commit
        };
        let regex = trigger.regex(self.locale()).map_err(Failure)?;
        let gate_root = Facts::new(&self.host, self.repo, self.locale(), regex).worktree(&self.cmd);
        let target = if gate_root.is_empty() {
            hook_input::project_dir(
                self.context.engine,
                self.host.claude_project_dir.as_deref(),
                &self.host.cwd,
                self.repo,
            )
        } else {
            gate_root
        };
        let pwd = self.host.pwd.clone();
        let (here, oldpwd) = if target.is_empty() {
            (pwd.clone(), None)
        } else {
            if target.starts_with('-') {
                return Err(Failure("cd target looks like an option".to_owned()));
            }
            let here = logical(&pwd, &target);
            if let Some(reason) = self.gate.cd_error(&here).map_err(Failure)? {
                line(
                    &mut self.stderr,
                    &format!(
                        "{}: line {}: cd: {target}: {reason}",
                        self.context.script, self.context.rendered.cd_line
                    ),
                );
                self.trap.block_reason = Some(format!(
                    "no se pudo entrar al arbol del commit '{target}'; el gate no corrio"
                ));
                return Ok(self.done(2));
            }
            (here, Some(pwd))
        };
        let cap = self
            .context
            .rendered
            .progress_cap
            .as_deref()
            .ok_or_else(|| Failure("the progress-ratchet partial is not inlined".to_owned()))?;
        if !self.cmd.is_empty()
            && let Some(message) = ratchet::lane(&here, cap, self.repo).map_err(Failure)?
        {
            self.stderr.extend_from_slice(message.as_bytes());
            self.trap.block_reason = Some("progress-ratchet".to_owned());
            return Ok(self.done(2));
        }
        if self.context.rendered.native_fast == "1" {
            self.trap.skip_reason = "native-hook";
            line(
                &mut self.stderr,
                "[navori] quality-gate skipped: qualityGate.nativeHooks is true, the native pre-commit runs it.",
            );
            return Ok(self.done(0));
        }
        if self.gate.probe_hit(&here) {
            self.trap.skip_reason =
                "gate omitido: resultado verde en cache para estos bytes (navori gate probe)";
            line(
                &mut self.stderr,
                "[navori] quality-gate skipped: a green fast result is cached for exactly these bytes (navori gate probe --clean).",
            );
            return Ok(self.done(0));
        }
        let gate = self.context.rendered.gate.clone();
        let gate_bin = gate.split(' ').next().unwrap_or_default().to_owned();
        let run = |command: String| GateRun {
            command,
            pwd: here.clone(),
            oldpwd: oldpwd.clone(),
        };
        if self.command_exists(&gate_bin, &here) {
            return Ok(self.start_gate(run(gate)));
        }
        let detected = self.detect_pm(&here)?;
        let is_pm = matches!(gate_bin.as_str(), "pnpm" | "npm" | "yarn" | "bun");
        if is_pm
            && let Some(pm) = detected
            && pm != gate_bin
            && self.command_exists(pm, &here)
        {
            line(
                &mut self.stderr,
                &format!(
                    "[navori] '{gate_bin}' is not on PATH; using the lockfile-detected package manager: '{pm}'."
                ),
            );
            let rest = gate.split_once(' ').map_or(gate.as_str(), |(_, rest)| rest);
            return Ok(self.start_gate(run(format!("{pm} {rest}"))));
        }
        line(
            &mut self.stderr,
            &format!(
                "[navori] quality-gate NOT run: '{gate_bin}' is not on PATH and no alternative package manager was detected that could run it."
            ),
        );
        if self.context.engine == Engine::Codex || !self.can_ask() {
            self.trap.block_reason = Some(format!(
                "quality gate sin veredicto y sin forma de preguntar: '{gate_bin}' no esta en PATH, commit bloqueado"
            ));
            line(
                &mut self.stderr,
                &format!(
                    "[navori] Commit BLOCKED to avoid skipping the gate silently. Install '{gate_bin}', or if you really want to skip it run the commit yourself outside the agent."
                ),
            );
            return Ok(self.done(2));
        }
        self.trap.ask_reason = Some(format!(
            "quality gate sin veredicto: '{gate_bin}' no esta en PATH y no hay gestor alterno"
        ));
        self.stdout.extend_from_slice(ask_answer(&format!(
            "[navori] The quality gate did not run: '{gate_bin}' (from qualityGate.fast) is not on PATH and no lockfile-detected package manager could run it, so there is no verdict. Approve to commit WITHOUT the quality gate, or deny and install '{gate_bin}'."
        )).as_bytes());
        Ok(self.done(0))
    }

    /// `run_gate`'s first two lines; the caller records `gate-started` and runs the command.
    fn start_gate(mut self, run: GateRun) -> Step {
        self.trap.ran_gate = true;
        line(
            &mut self.stderr,
            &format!("[navori] running quality-gate fast: {}", run.command),
        );
        Step::Gate(self.pending(), run)
    }
}

/// Evaluate one payload up to its first effect.
///
/// # Errors
/// An extraction failure, a command that is not valid UTF-8, or a branch whose shell output is
/// not modeled.
pub fn evaluate(
    payload: &[u8],
    context: &Context<'_>,
    repo: &dyn Repo,
    gate: &dyn Gate,
) -> Result<Step, Failure> {
    let captured = payload::capture(payload);
    let fields = payload::extract(&captured, &FIELDS, context.profile)?;
    let field = |index: usize| fields.values.get(index).cloned().unwrap_or_default();
    let cmd = field(COMMAND);
    if fields.bytes.get(COMMAND).copied().unwrap_or_default() != cmd.len() {
        return Err(Failure("command is not valid UTF-8".to_owned()));
    }
    let mut host = context.host.clone();
    host.cwd = field(CWD);
    let stderr = capture::prepend(
        context.capture,
        payload.contains(&0),
        fields.nul_substitutions,
        Vec::new(),
    );
    let mut run = Run {
        context,
        repo,
        gate,
        host,
        cmd,
        event: field(EVENT),
        mode: field(MODE),
        stdout: Vec::new(),
        stderr,
        trap: Trap::default(),
    };
    let trigger = if context.engine == Engine::Pi {
        Trigger::CommitOrPush
    } else {
        Trigger::Commit
    };
    let needed = if run.cmd.is_empty() {
        line(
            &mut run.stderr,
            "[navori] no command could be read from the tool input; running the quality gate anyway rather than skipping it silently.",
        );
        true
    } else {
        is_scan_trigger(&run.cmd, trigger, context.profile.locale).map_err(Failure)?
    };
    if !needed {
        return Ok(run.done(0));
    }
    if !run.cmd.is_empty() {
        let regex = trigger.regex(context.profile.locale).map_err(Failure)?;
        let root = Facts::new(&run.host, repo, context.profile.locale, regex)
            .foreign_root(&run.cmd)
            .map_err(Failure)?;
        if let Some(root) = root {
            return run.foreign(root);
        }
    }
    run.own_gate()
}

/// `run_gate` after `eval`: the gate's own output, then the failure lines on a non-zero status.
#[must_use]
pub fn after_gate(
    pending: Pending,
    run: &GateRun,
    status: i32,
    stdout: &[u8],
    stderr: &[u8],
) -> Evaluation {
    let Pending {
        stdout: mut out,
        stderr: mut err,
        mut trap,
        ..
    } = pending;
    out.extend_from_slice(stdout);
    err.extend_from_slice(stderr);
    if status == 0 {
        return finish(out, err, 0, trap);
    }
    trap.block_reason = Some(format!(
        "quality gate en rojo: '{}' fallo, commit abortado",
        run.command
    ));
    line(
        &mut err,
        "[navori] quality-gate fast failed. Commit aborted.",
    );
    line(
        &mut err,
        &format!("[navori] The gate ran in this working tree: {}", run.pwd),
    );
    line(
        &mut err,
        "[navori] Stop and report the failure. The fix goes back through implementer -> reviewer. Do not edit files to make the gate pass, and do not use --no-verify.",
    );
    finish(out, err, 2, trap)
}

/// How the script classifies `navori gate foreign` by its exit code and first output line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ForeignKind {
    Green,
    Refused,
    Old,
    Red,
    Other,
}

fn classify(rc: i32, out: &str, first: &str) -> ForeignKind {
    let word = format!("{rc}:{first}");
    let red = format!("navori gate foreign: exit {rc} ");
    if rc == 0 && first.starts_with("navori gate foreign: exit 0 ") {
        ForeignKind::Green
    } else if rc == 64 && first.starts_with("navori gate foreign: refused ") {
        ForeignKind::Refused
    } else if rc == 2 && first.starts_with("navori gate: unknown kind \"foreign\"") {
        ForeignKind::Old
    } else if rc == 127 && first.starts_with("navori gate foreign: exit 127 ") {
        ForeignKind::Other
    } else if word
        .match_indices(':')
        .any(|(at, _)| word[at + 1..].starts_with(&red))
    {
        ForeignKind::Red
    } else if rc == 1 && out.contains("Unknown command gate") {
        ForeignKind::Old
    } else {
        ForeignKind::Other
    }
}

/// The destination's gate outcome: `rc` and the merged output of `navori gate foreign`.
#[must_use]
pub fn after_foreign(pending: Pending, root: &str, rc: i32, output: &[u8]) -> Evaluation {
    let Pending {
        stdout: mut out,
        stderr: mut err,
        mut trap,
        engine,
        can_ask,
    } = pending;
    let raw = crate::shell::subcommand::substitution(output);
    let text = String::from_utf8_lossy(raw).into_owned();
    let first = text.split('\n').next().unwrap_or_default();
    let echo = |err: &mut Vec<u8>| {
        err.extend_from_slice(raw);
        err.push(b'\n');
    };
    match classify(rc, &text, first) {
        ForeignKind::Green => {
            trap.ran_gate = true;
            trap.allow_reason = Some("foreign-gate");
            line(
                &mut err,
                &format!("[navori] The destination's quality-gate fast passed: {root}"),
            );
            finish(out, err, 0, trap)
        }
        ForeignKind::Refused => {
            let why = first
                .strip_prefix("navori gate foreign: refused ")
                .unwrap_or(first);
            line(
                &mut err,
                &format!("[navori] The destination's gate was NOT run: {why}"),
            );
            line(
                &mut err,
                "[navori] Run it there before relying on this commit.",
            );
            finish(out, err, 0, trap)
        }
        ForeignKind::Old => {
            line(
                &mut err,
                "[navori] The destination's gate was NOT run: the navori on PATH has no 'gate foreign' (older than this hook); update the navori CLI. Run the destination's gate there before relying on this commit.",
            );
            finish(out, err, 0, trap)
        }
        ForeignKind::Red => {
            trap.ran_gate = true;
            trap.block_reason = Some("foreign-gate".to_owned());
            line(
                &mut err,
                &format!(
                    "[navori] quality-gate fast failed in the destination repository {root}. Commit aborted."
                ),
            );
            echo(&mut err);
            line(
                &mut err,
                "[navori] Stop and report the failure. Fix it in that repository through implementer -> reviewer. Do not edit files to make the gate pass, and do not use --no-verify.",
            );
            finish(out, err, 2, trap)
        }
        ForeignKind::Other => {
            trap.ran_gate = true;
            echo(&mut err);
            line(
                &mut err,
                &format!("[navori] The destination's quality gate produced no verdict ({root})."),
            );
            if engine == Engine::Codex || !can_ask {
                trap.block_reason = Some(
                    "quality gate del repo destino sin veredicto y sin forma de preguntar, commit bloqueado"
                        .to_owned(),
                );
                line(
                    &mut err,
                    "[navori] Commit BLOCKED to avoid skipping the destination's gate silently. Fix the cause, or if you really want to skip it run the commit yourself outside the agent.",
                );
                return finish(out, err, 2, trap);
            }
            trap.ask_reason = Some("quality gate del repo destino sin veredicto".to_owned());
            out.extend_from_slice(ask_answer(&format!(
                "[navori] The destination repository's quality gate gave no verdict ({root}). Approve to commit WITHOUT that gate, or deny and fix the cause."
            )).as_bytes());
            finish(out, err, 0, trap)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ForeignKind, classify, logical};

    // Covers: R50
    #[test]
    fn foreign_outcomes_follow_the_case_table() {
        let k = |rc, out: &str| classify(rc, out, out.split('\n').next().unwrap_or_default());
        assert_eq!(k(0, "navori gate foreign: exit 0 x"), ForeignKind::Green);
        assert_eq!(
            k(64, "navori gate foreign: refused why"),
            ForeignKind::Refused
        );
        assert_eq!(
            k(2, "navori gate: unknown kind \"foreign\" (x)"),
            ForeignKind::Old
        );
        assert_eq!(
            k(127, "navori gate foreign: exit 127 x"),
            ForeignKind::Other
        );
        assert_eq!(k(3, "navori gate foreign: exit 3 log"), ForeignKind::Red);
        assert_eq!(k(3, "a:navori gate foreign: exit 3 log"), ForeignKind::Red);
        assert_eq!(k(1, "x\nUnknown command gate"), ForeignKind::Old);
        assert_eq!(k(5, "boom"), ForeignKind::Other);
        assert_eq!(logical("/a/b", "../c/./d/"), "/a/c/d");
        assert_eq!(logical("/a", "/x//y"), "/x/y");
    }
}
