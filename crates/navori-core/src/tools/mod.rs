//! `navori tools notice` and `navori tools session-context`, without the network (spec 0059 D34).

pub mod cache;
pub mod notice;

use std::path::Path;

use crate::config::{self, Config};
use crate::process::Env;
use crate::workspace::dominio;
use crate::workspace::registry::Stop;

use notice::{Plugins, Update};

/// What a ported command prints: stdout and the stderr lines (each without its newline).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Printed {
    pub stdout: String,
    pub stderr: Vec<String>,
    /// Exit 1 instead of 0.
    pub failed: bool,
}

/// `readConfig(<cwd>/navori.config.json)`.
///
/// # Errors
/// [`Stop::Throw`] when it cannot be read; [`Stop::Delegate`] for a config only the TS reads.
fn read_config(cwd: &Path) -> Result<Config, Stop> {
    let bytes = std::fs::read(cwd.join("navori.config.json")).map_err(|_| Stop::Throw)?;
    config::read(&bytes).map_err(|_| Stop::Delegate("config outside the ported model"))
}

/// The config, its notices and the plugins they loaded; `Err(Stop::Throw)` is a TS throw.
fn notices(
    env: &Env,
    cwd: &Path,
    spawn_worker: &dyn Fn(&str, &str),
) -> Result<(String, Vec<String>), Stop> {
    let config = read_config(cwd)?;
    let mut plugins = Plugins::default();
    // An unusable `HOME` is a throw inside `prepareToolNotices`, which answers `[]`.
    let updates: Vec<Update> = match notice::precheck(env, Some(&config), &[], &mut plugins) {
        Err(Stop::Throw) => Vec::new(),
        Err(stop) => return Err(stop),
        Ok(()) => notice::prepare(env, cwd, &config, &mut plugins, spawn_worker)?,
    };
    Ok((
        notice::output(config.lang(), &updates),
        config.warnings.clone(),
    ))
}

/// `tools notice [--ack <pairs>]`. It never fails: a TS throw prints nothing.
///
/// # Errors
/// [`Stop::Delegate`], before anything is written or printed.
pub fn notice_command(
    env: &Env,
    cwd: &Path,
    ack: Option<&str>,
    spawn_worker: &dyn Fn(&str, &str),
) -> Result<Printed, Stop> {
    if let Some(ack) = ack {
        let pairs: Vec<&str> = ack.split(',').filter(|p| !p.is_empty()).collect();
        let ids: Vec<&str> = pairs
            .iter()
            .map(|p| p.split('@').next().unwrap_or_default())
            .collect();
        let mut plugins = Plugins::default();
        match notice::precheck(env, None, &ids, &mut plugins) {
            Err(Stop::Throw) => return Ok(Printed::default()),
            other => other?,
        }
        notice::ack(env, &pairs, &mut plugins)?;
        return Ok(Printed::default());
    }
    match notices(env, cwd, spawn_worker) {
        Ok((stdout, stderr)) => Ok(Printed {
            stdout,
            stderr,
            failed: false,
        }),
        Err(Stop::Throw) => Ok(Printed::default()),
        Err(stop) => Err(stop),
    }
}

/// `sessionContextOutput(toolNoticeOutput, dominioInjectText, reserve)` for `tools
/// session-context`. `reserve` is `None` without `--notice-reserve` and `Some(None)` for a value
/// that is not a safe integer.
///
/// The Dominio section is read first: it is pure, and a branch only the TS reproduces must be
/// found before the notice section writes. The TS computes the notice first; with no writes on
/// the Dominio side the outcome is the same.
///
/// # Errors
/// [`Stop::Delegate`], before anything is written or printed.
pub fn session_context(
    env: &Env,
    cwd: &Path,
    reserve: Option<Option<u64>>,
    spawn_worker: &dyn Fn(&str, &str),
) -> Result<Printed, Stop> {
    let failed = |stderr: Vec<String>| Printed {
        stdout: String::new(),
        stderr,
        failed: true,
    };
    let cwd_text = cwd
        .to_str()
        .ok_or(Stop::Delegate("working directory is not UTF-8"))?;
    let dominio = match dominio::inject_text(env, cwd_text) {
        Err(Stop::Delegate(why)) => return Err(Stop::Delegate(why)),
        other => other,
    };
    let opted_out = env
        .iter()
        .rev()
        .find(|(key, _)| key == "NAVORI_NO_UPDATE_NOTIFIER")
        .is_some_and(|(_, value)| value == "1");
    let (notice, warnings) = if opted_out {
        (String::new(), Vec::new())
    } else {
        match notices(env, cwd, spawn_worker) {
            Ok(found) => found,
            Err(Stop::Throw) => return Ok(failed(Vec::new())),
            Err(stop) => return Err(stop),
        }
    };
    let Ok(dominio) = dominio else {
        return Ok(failed(warnings));
    };
    let sections = [notice.as_str(), dominio.as_str()];
    if sections
        .iter()
        .any(|text| text.contains("#section ") || text.contains("#end navori-"))
    {
        return Ok(failed(warnings));
    }
    let reserve = match reserve {
        Some(None) => return Ok(failed(warnings)),
        Some(Some(bytes)) => Some(bytes),
        None => None,
    };
    let stdout = format!(
        "#navori-session-context v1{}\n#section notice\n{notice}#section dominio\n{dominio}#end navori-session-context\n",
        if reserve.is_some() {
            " notice-reserve"
        } else {
            ""
        }
    );
    if let Some(reserve) = reserve
        && !notice.is_empty()
    {
        // `/^#navori-tool-notice v1 ack=([A-Za-z0-9._@,-]+)\n([\s\S]+)\n$/`
        let framed = notice.strip_prefix(notice::SENTINEL).and_then(|rest| {
            let (ack, body) = rest.split_once('\n')?;
            let body = body.strip_suffix('\n')?;
            let ack_ok = !ack.is_empty()
                && ack
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._@,-".contains(&b));
            (ack_ok && !body.is_empty()).then_some((ack, body))
        });
        let Some((ack, body)) = framed else {
            return Ok(failed(warnings));
        };
        // `Buffer.byteLength(body) + 1 <= reserve`: the body plus its emission newline fits.
        if (body.len() as u64) < reserve {
            let pairs: Vec<&str> = ack.split(',').filter(|p| !p.is_empty()).collect();
            let mut plugins = Plugins::default();
            notice::ack(env, &pairs, &mut plugins)?;
        }
    }
    Ok(Printed {
        stdout,
        stderr: warnings,
        failed: false,
    })
}
