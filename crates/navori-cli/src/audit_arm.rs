//! `navori audit --arm [--host H] [--cwd D] [--json]` and `navori audit --disarm [--cwd D]
//! [--json]`, native (`commands/audit.ts:934-981`). The primitives live in
//! [`navori_core::audit_private`] and [`navori_core::audit_arm`]; this file is argv, the repo
//! name and the output.
//!
//! Fail-closed: anything citty might read differently (`--no-arm`, `--arm=false`, repeated or
//! unknown flags, empty values), anything the port does not model (`HOME` unset or not UTF-8,
//! a non-UTF-8 cwd, colored output) and any I/O failure the TS would report differently returns
//! `None` before the first byte or the first write, and the TS runs it.

use std::ffi::OsString;
use std::path::Path;
use std::process::ExitCode;

use lexopt::Arg;
use navori_core::audit_arm::{armed_payload, iso_now, report_lang};
use navori_core::audit_private::{
    AuditPathError, Reason, Refusal, Store, audits_root, repo_audit_dir,
};
use navori_core::js_json::{JsObject, JsValue};
use navori_core::posix;
use navori_core::render::context::Lang;

use crate::clack::{Clack, Symbol, plain_output};
use crate::js_path::js_resolve;

/// Same bound the TS reads the `.armed` file with.
const ARMED_MAX_BYTES: u64 = 2048;

/// `PROJECT_ROOT_MARKERS`.
const PROJECT_ROOT_MARKERS: [&str; 2] = ["navori.config.json", ".git"];

#[derive(Debug, PartialEq, Eq)]
struct Options {
    arm: bool,
    host: Option<String>,
    cwd: Option<String>,
    json: bool,
}

/// A value citty cannot read differently: non-empty, UTF-8, not an option, no newline.
fn value(parser: &mut lexopt::Parser) -> Option<String> {
    let text = parser.value().ok()?.into_string().ok()?;
    (!text.is_empty() && !text.starts_with('-') && !text.contains(['\n', '\r'])).then_some(text)
}

/// The accepted shapes, or `None` for any other.
fn parse(rest: &[OsString]) -> Option<Options> {
    if rest.iter().any(|arg| arg == "--") {
        return None;
    }
    let mut arm = None;
    let mut disarm = false;
    let mut host = None;
    let mut cwd = None;
    let mut json = false;
    let mut parser = lexopt::Parser::from_args(rest.iter().cloned());
    while let Some(arg) = parser.next().ok()? {
        match arg {
            Arg::Long("arm") if arm.is_none() && !disarm => arm = Some(true),
            Arg::Long("disarm") if arm.is_none() && !disarm => disarm = true,
            Arg::Long("json") if !json => json = true,
            Arg::Long("host") if host.is_none() => host = Some(value(&mut parser)?),
            Arg::Long("cwd") if cwd.is_none() => cwd = Some(value(&mut parser)?),
            _ => return None,
        }
    }
    let is_arm = arm.is_some();
    if is_arm == disarm || (disarm && host.is_some()) {
        return None;
    }
    Some(Options {
        arm: is_arm,
        host,
        cwd,
        json,
    })
}

/// `projectRootFromCwd`: cut at `/.claude/worktrees`, then walk up to a root marker.
fn project_root(base: &str, cwd: &str) -> Option<String> {
    if cwd.contains(['\\', '\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    let marker = "/.claude/worktrees";
    let mut cut = cwd;
    let mut from = 0;
    while let Some(at) = cwd[from..].find(marker) {
        let start = from + at;
        let after = start + marker.len();
        if after == cwd.len() || cwd[after..].starts_with('/') {
            cut = &cwd[..start];
            break;
        }
        from = start + 1;
    }
    let clean = js_resolve(&[base, cut]);
    let mut dir = clean.clone();
    loop {
        if PROJECT_ROOT_MARKERS
            .iter()
            .any(|name| Path::new(&posix::join(&[&dir, name])).exists())
        {
            return Some(dir);
        }
        let parent = posix::dirname(&dir).to_owned();
        if parent == dir {
            return Some(clean);
        }
        dir = parent;
    }
}

fn json_line(entries: &[(&str, JsValue)]) -> Option<String> {
    let mut object = JsObject::new();
    for (key, entry) in entries {
        object.insert(*key, entry.clone());
    }
    Some(format!("{}\n", JsValue::Object(object).stringify(None)?))
}

fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

/// `privateResultOrExit` for a refusal: the JSON line or the clack cancel (plus the repair hint
/// for a permission-only fault), exit 2. `None` to delegate what the port cannot judge.
fn refuse(
    clack: &mut Clack,
    refusal: Refusal,
    json: bool,
    env: &[(OsString, OsString)],
) -> Option<()> {
    if matches!(refusal.reason, Reason::Unsupported | Reason::Io) && !refusal.partial {
        return None;
    }
    let repair = if refusal.permission_only {
        audits_root(env).ok().and_then(|root| {
            let root = root.to_str()?.to_owned();
            let quoted = shell_quote(&root);
            let command = format!(
                "find {quoted} -type d -exec chmod 700 {{}} + && find {quoted} -type f -exec chmod 600 {{}} +"
            );
            let overridden = env
                .iter()
                .rev()
                .find(|(key, _)| key == "NAVORI_AUDITS_ROOT")
                .and_then(|(_, value)| value.to_str())
                .is_some_and(|value| !posix::js_trim(value).is_empty());
            Some((root, command, overridden))
        })
    } else {
        None
    };
    let reason = refusal.reason.as_str();
    if json {
        let mut entries = vec![
            ("ok", JsValue::Bool(false)),
            ("error", JsValue::string("unsafe-audit-target")),
            ("reason", JsValue::string(reason)),
        ];
        if let Some((root, command, _)) = &repair {
            let mut hint = JsObject::new();
            hint.insert("root", JsValue::string(root));
            hint.insert("command", JsValue::string(command));
            entries.push(("repair", JsValue::Object(hint)));
        }
        clack.out.stdout.push_str(&json_line(&entries)?);
    } else {
        clack.cancel(&format!("unsafe-audit-target: {reason}"));
        if let Some((root, command, overridden)) = &repair {
            let note = if *overridden {
                " (NAVORI_AUDITS_ROOT override: verify this path first)"
            } else {
                ""
            };
            clack.log(
                Symbol::Bar,
                &format!("audit root {root}{note} is too open; to repair it run: {command}"),
            );
        }
    }
    clack.out.code = 2;
    Some(())
}

/// Runs `audit …`, or hands it to the TS.
pub fn run(call: &crate::NativeCall<'_>) -> crate::Outcome {
    crate::outcome(run_args(call.args))
}

fn run_args(args: &[OsString]) -> Option<ExitCode> {
    let options = parse(args.get(1..)?)?;
    if !plain_output() {
        return None;
    }
    let process_cwd = std::env::current_dir()
        .ok()?
        .into_os_string()
        .into_string()
        .ok()?;
    let given = options.cwd.as_deref().unwrap_or(&process_cwd);
    let cwd = js_resolve(&[&process_cwd, given]);
    let es = report_lang(Path::new(&cwd)) == Lang::Es;
    let env: Vec<(OsString, OsString)> = std::env::vars_os().collect();

    let mut clack = Clack::default();
    if !options.json {
        clack.intro("navori audit");
    }
    let repo = posix::basename(&project_root(&process_cwd, &cwd)?).to_owned();
    let dir = match repo_audit_dir(&env, &repo) {
        Ok(dir) => dir,
        Err(AuditPathError::Unmodeled) => return None,
        Err(error) => {
            let message = error.message()?;
            if options.json {
                let code = error.code()?;
                clack.out.stdout.push_str(&json_line(&[
                    ("ok", JsValue::Bool(false)),
                    ("error", JsValue::string(code)),
                    ("message", JsValue::string(&message)),
                ])?);
            } else {
                clack.cancel(&message);
            }
            clack.out.code = 1;
            return Some(clack.out.emit());
        }
    };
    let armed = dir.join(".armed");
    let root = audits_root(&env).ok()?;
    if options.arm {
        arm(&mut clack, &root, &armed, &dir, &cwd, &options, es, &env)?;
    } else {
        disarm(&mut clack, &root, &armed, options.json, es, &env)?;
    }
    Some(clack.out.emit())
}

fn is_host(host: &str) -> bool {
    matches!(host, "claude" | "codex" | "pi")
}

#[allow(
    clippy::too_many_arguments,
    reason = "one call site, the shared state of a run"
)]
fn arm(
    clack: &mut Clack,
    root: &Path,
    armed: &Path,
    dir: &Path,
    cwd: &str,
    options: &Options,
    es: bool,
    env: &[(OsString, OsString)],
) -> Option<()> {
    let host = options.host.as_deref();
    if let Some(host) = host
        && !is_host(host)
    {
        // Only plain words: citty keeps them as typed, and the message quotes them verbatim.
        if !host.starts_with(|c: char| c.is_ascii_alphabetic())
            || !host
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
        {
            return None;
        }
        let message = if es {
            format!("--host acepta 'claude', 'codex' o 'pi', recibí '{host}'.")
        } else {
            format!("--host accepts 'claude', 'codex' or 'pi', got '{host}'.")
        };
        if options.json {
            clack.out.stdout.push_str(&json_line(&[
                ("ok", JsValue::Bool(false)),
                ("error", JsValue::string("invalid-host")),
                ("message", JsValue::string(&message)),
            ])?);
        } else {
            clack.cancel(&message);
        }
        clack.out.code = 2;
        return Some(());
    }
    let store = match Store::new(root) {
        Ok(store) => store,
        Err(refusal) => return refuse(clack, refusal, options.json, env),
    };
    if let Err(refusal) = store.ensure_directory(dir) {
        return refuse(clack, refusal, options.json, env);
    }
    if armed.exists() {
        if let Err(refusal) = store.read_file(armed, ARMED_MAX_BYTES) {
            return refuse(clack, refusal, options.json, env);
        }
        clack.outro(if es {
            "ya estaba armado: una vez, próximo mensaje/sesión; --disarm cancela"
        } else {
            "already armed: once, next message/session; --disarm cancels"
        });
        return Some(());
    }
    let payload = armed_payload(&iso_now(), cwd, host)?;
    if let Err(refusal) = store.create_file(armed, payload.as_bytes()) {
        return refuse(clack, refusal, options.json, env);
    }
    clack.outro(if es {
        "armado: audit-mode una sesión, próximo mensaje/apertura; navori audit --disarm cancela"
    } else {
        "armed: audit-mode one session, next message/opening; navori audit --disarm cancels"
    });
    Some(())
}

fn disarm(
    clack: &mut Clack,
    root: &Path,
    armed: &Path,
    json: bool,
    es: bool,
    env: &[(OsString, OsString)],
) -> Option<()> {
    let store = match Store::new(root) {
        Ok(store) => store,
        Err(refusal) => return refuse(clack, refusal, json, env),
    };
    match store.remove_file(armed) {
        Ok(()) => clack.outro(if es { "desarmado" } else { "disarmed" }),
        Err(refusal) if refusal.reason == Reason::Missing => {
            clack.outro(if es {
                "no había nada armado"
            } else {
                "nothing was armed"
            });
        }
        Err(refusal) => return refuse(clack, refusal, json, env),
    }
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(items: &[&str]) -> Vec<OsString> {
        items.iter().map(OsString::from).collect()
    }

    #[test]
    fn accepts_only_the_modeled_shapes() {
        let arm = parse(&argv(&["--arm", "--host=pi", "--cwd", "/x", "--json"]))
            .unwrap_or_else(|| unreachable!("modeled shape"));
        assert!(arm.arm && arm.json);
        assert_eq!(arm.host.as_deref(), Some("pi"));
        assert_eq!(arm.cwd.as_deref(), Some("/x"));
        assert!(parse(&argv(&["--disarm"])).is_some_and(|o| !o.arm));
        for delegated in [
            &[][..],
            &["--no-arm"],
            &["--arm=false"],
            &["--arm", "--arm"],
            &["--arm", "--disarm"],
            &["--disarm", "--host", "pi"],
            &["--arm", "--host"],
            &["--arm", "--host="],
            &["--arm", "--host", "--json"],
            &["--arm", "--json", "--json"],
            &["--arm", "--cwd", "a", "--cwd", "b"],
            &["--arm", "--start", "x"],
            &["--arm", "extra"],
            &["--arm", "--json=false"],
            &["--arm", "--"],
        ] {
            assert_eq!(parse(&argv(delegated)), None, "{delegated:?}");
        }
    }

    #[test]
    fn worktree_cwd_is_cut_before_the_marker_walk() {
        let dir = std::env::temp_dir().join(format!("navori-arm-root-{}", std::process::id()));
        let repo = dir.join("repo");
        let _ = std::fs::create_dir_all(repo.join(".git"));
        let tree = format!("{}/.claude/worktrees/agent-1/sub", repo.display());
        let found = project_root("/", &tree);
        assert_eq!(found.as_deref(), repo.to_str());
        let _ = std::fs::remove_dir_all(dir);
    }
}
