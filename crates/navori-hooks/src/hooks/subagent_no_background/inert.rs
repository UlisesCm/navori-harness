//! subagent-no-background.sh's two shell-lane rules over the shared inert transforms.

use std::sync::LazyLock;

use regex::Regex;

use crate::runner::Failure;
use crate::shell::Locale;
use crate::shell::inert::{self, Rules};

pub(super) use crate::shell::inert::CMD_MAX;

struct Policy {
    background: Regex,
    detached: Regex,
}

impl Policy {
    fn new(locale: Locale) -> Result<Self, regex::Error> {
        Ok(Self {
            background: locale.ere(r"(^|[^&>|<\\])&([^&>]|$)")?,
            detached: locale.ere(
                r"^[[:space:]]*(((sudo|env|time|command|exec)[[:space:]]+)+)?(nohup|setsid|disown)([[:space:]]|$)",
            )?,
        })
    }
}

static UTF8: LazyLock<Result<Policy, regex::Error>> = LazyLock::new(|| Policy::new(Locale::Utf8));
static GNU_UTF8: LazyLock<Result<Policy, regex::Error>> =
    LazyLock::new(|| Policy::new(Locale::GnuUtf8));
static C: LazyLock<Result<Policy, regex::Error>> = LazyLock::new(|| Policy::new(Locale::C));

/// Apply the shared skeleton/live/segment transforms and this hook's two block rules.
pub(super) fn reason(cmd: &str, locale: Locale) -> Result<Option<String>, Failure> {
    let rules = Rules::get(locale).map_err(Failure)?;
    let policy = match locale {
        Locale::Utf8 => &UTF8,
        Locale::GnuUtf8 => &GNU_UTF8,
        Locale::C => &C,
    }
    .as_ref()
    .map_err(|e| Failure(format!("inert policy pattern: {e}")))?;
    let skeleton = match inert::skeleton(cmd, rules) {
        Ok(skeleton) => skeleton,
        Err(reason) => return Ok(Some(reason)),
    };
    let live = inert::live(cmd, &skeleton, rules);
    let flat = rules.remove_quotes(&live.replace('\n', " "));
    if policy.background.is_match(&flat) {
        return Ok(Some(
            "operador de shell & (segundo plano) dentro de un subagente".to_owned(),
        ));
    }
    let scan = inert::scan(&live, rules);
    if inert::segments(&scan, rules)
        .iter()
        .any(|segment| policy.detached.is_match(segment))
    {
        return Ok(Some(
            "nohup/setsid/disown dentro de un subagente".to_owned(),
        ));
    }
    Ok(None)
}
