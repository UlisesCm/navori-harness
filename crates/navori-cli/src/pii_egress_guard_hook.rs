//! Registry adapter of pii-egress-guard (shadow port of the web half of #1445).
//!
//! Before stdin: the accredited extraction profile and the host facts the rule reads (`PWD`,
//! `command -v grep` and `git`, `NAVORI_PERSONAL_IDS`). After stdin the rule runs against a
//! [`HostProbe`]: `git config user.email` and the host's `grep`, as the script runs them.
//!
//! # Budget
//!
//! The shadow budget of this hook is 8.5 s from the start ([`crate::shadow::SHADOW_DEADLINES`]),
//! under the wiring's 10 s: the host kills a hook past it and a killed hook approves. Native
//! and shell run one after the other inside it, so the native side gets [`NATIVE_BUDGET`] and
//! the shell the 5.5 s that remain (its work is `jq`, one `git config` and at most three
//! `grep` calls over a short text). The probe bounds every child it starts by that instant,
//! `grep` and `git` alike: nothing native outlives it, an expired bound is a deny.
//!
//! # BSD locale
//!
//! Under the BSD locale (macOS, bash 3.2) the rule is not measured: `prepare` defers before
//! stdin and the shell answers alone, in shadow and after activation. Forcing
//! `NAVORI_HOOK_IMPL=rust` on such a host makes the wrapper exit 1 (not blocking), like every
//! other hook that defers.

use std::path::Path;
use std::time::Duration;

use navori_hooks::hooks::pii_egress_guard::{self as hook, Context};
use navori_hooks::runner::{Evaluation, Failure};
use navori_hooks::shell::Locale;
use navori_hooks::shell::pii_egress::{HostProbe, Pii};
use navori_hooks::shell::prepare::{self, Limits, Request};

use crate::facts_cache::FactsCache;
use crate::hook::{Evaluator, Invocation, Recorder, Snapshot};
use crate::hook_facts::{collect_cached, command_v, shell_pwd};
use crate::journal;

/// Time from the start of the hook that the native evaluation may use.
const NATIVE_BUDGET: Duration = Duration::from_secs(3);

/// Registry adapter for pii-egress-guard.
///
/// # Errors
/// The ineligibility cause; the caller defers the call to the shell.
pub fn prepare<'a>(
    invocation: &'a Invocation,
    snapshot: Snapshot<'a>,
) -> Result<Evaluator<'a>, String> {
    let request = Request {
        engine: invocation.engine,
        engines: hook::ENGINES,
        event: invocation.event.as_deref(),
        args: &invocation.args,
        script: &invocation.requested,
        source: snapshot.source,
        env: snapshot.env,
    };
    let cache = journal::project_root(invocation.engine, &invocation.engine_root)
        .map(FactsCache::in_project);
    let prepared = collect_cached(request, snapshot.cwd, Limits::default(), cache.as_ref())
        .map_err(|e| e.to_string())?;
    let profile = prepared.profile();
    if profile.locale == Locale::Utf8 {
        return Err("pii-egress lane not measured under the BSD locale".to_owned());
    }
    let inherited_pwd = prepare::env_value(snapshot.env, "PWD")
        .map(|value| value.to_str().map(str::to_owned).ok_or("PWD is not UTF-8"))
        .transpose()?;
    let pwd = shell_pwd(inherited_pwd, snapshot.cwd)?;
    let context = Context {
        profile,
        capture: prepared.capture(),
    };
    // `command -v` of the two programs the rule runs: stats along `PATH`, no fork.
    let pii = Pii::from_env(
        snapshot.env,
        command_v("grep", snapshot.env, snapshot.cwd),
        command_v("git", snapshot.env, snapshot.cwd),
    );
    // An instant past the clock's range cannot be waited for: fail closed at once.
    let until = snapshot
        .started
        .checked_add(NATIVE_BUDGET)
        .unwrap_or(snapshot.started);
    let env = snapshot.env;
    Ok(Box::new(
        move |payload: &[u8], _: &dyn Recorder| -> Result<Evaluation, Failure> {
            let probe = HostProbe {
                env,
                grep: pii.grep.as_deref(),
                git: pii.git.as_deref(),
                pwd: Path::new(&pwd),
                ids: pii.ids.as_ref(),
                until: Some(until),
            };
            Ok(hook::evaluate(payload, &context, &probe))
        },
    ))
}
