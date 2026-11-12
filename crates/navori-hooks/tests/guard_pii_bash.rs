//! The PII-egress Bash lane (`guard_destructive::pii_bash`) and its core (`shell::pii_egress`)
//! against the real partials `_partials/pii-egress*.sh`, sourced under the guard's own
//! `set -euo pipefail` with `/usr/bin/grep` (GNU) and a cleared environment.
//!
//! The identifier never reaches the output of these tests: assertions name only the index of a
//! case, and every identifier is the fictitious `dev.fixture@example.test` or a variation of it.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use navori_hooks::hooks::guard_destructive::pii_bash::{check, eligible, gate};
use navori_hooks::runner::{self, Context, Engine, Evaluation, Verdict};
use navori_hooks::shell::Locale;
use navori_hooks::shell::inert::{self, Rules};
use navori_hooks::shell::pii_egress::{
    Code, EmailRead, HostGrep, Matcher, Secret, Unverifiable, is_local, read_user_email, stderr,
};
use navori_hooks::shell::subcommand::{Call, Capture, Input};
use serde_json::Value;

type TestResult = Result<(), Box<dyn Error>>;

const ID: &str = "dev.fixture@example.test";
const MIN_CASES: usize = 2000;

/// One call of the lane: the command, the `git config user.email` of the repository (none: not
/// configured) and `NAVORI_PERSONAL_IDS` (none: unset).
#[derive(Debug, Clone)]
struct Case {
    cmd: String,
    email: Option<Vec<u8>>,
    ids: Option<String>,
}

fn case(cmd: &str, email: Option<&[u8]>, ids: Option<&str>) -> Case {
    Case {
        cmd: cmd.to_owned(),
        email: email.map(<[u8]>::to_vec),
        ids: ids.map(str::to_owned),
    }
}

fn with_ids(cmd: &str) -> Case {
    case(cmd, None, Some(ID))
}

fn locale_name(locale: Locale) -> &'static str {
    match locale {
        Locale::C => "C",
        _ => "C.UTF-8",
    }
}

fn partials() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/core/core-assets/hooks/_partials")
}

fn configure_email(command: &mut Command, email: Option<&[u8]>) {
    match email {
        Some(bytes) => command
            .env("GIT_CONFIG_COUNT", "1")
            .env("GIT_CONFIG_KEY_0", "user.email")
            .env("GIT_CONFIG_VALUE_0", OsStr::from_bytes(bytes)),
        None => command.env("GIT_CONFIG_COUNT", "0"),
    };
}

struct Scratch(PathBuf);

impl Scratch {
    fn new(tag: &str) -> Result<Self, Box<dyn Error>> {
        let dir = std::env::temp_dir().join(format!("navori-pii-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// A `grep` in front of the real one in `PATH`: it logs every call (argv and the hash of stdin, in
/// hex) to `PII_GREP_LOG` and then runs `/usr/bin/grep` on the same stdin and arguments.
const LOGGING_GREP: &str = r#"#!/bin/bash
tmp=$(mktemp)
cat >"$tmp"
{
  printf '%s\0' "$@" | od -An -v -tx1 | tr -d ' \n'
  printf ' %s\n' "$(sha256sum <"$tmp" | cut -d' ' -f1)"
} >>"$PII_GREP_LOG"
/usr/bin/grep "$@" <"$tmp"
rc=$?
rm -f "$tmp"
exit "$rc"
"#;

/// A directory with a `grep` in it, and the log that `grep` writes when it is the logging one.
struct Shim {
    dir: PathBuf,
    log: PathBuf,
}

impl Shim {
    fn grep(&self) -> PathBuf {
        self.dir.join("grep")
    }
}

/// Install `body` as `grep` in a fresh directory under `scratch`.
fn shim(scratch: &Path, name: &str, body: &str) -> Result<Shim, Box<dyn Error>> {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch.join(format!("shim-{name}"));
    fs::create_dir_all(&dir)?;
    let program = dir.join("grep");
    fs::write(&program, body)?;
    fs::set_permissions(&program, fs::Permissions::from_mode(0o755))?;
    let log = dir.join("calls.log");
    fs::write(&log, "")?;
    Ok(Shim { dir, log })
}

/// The program `grep` of the hermetic host: the shim when there is one, else `/usr/bin/grep`.
fn grep_program(shim: Option<&Shim>) -> PathBuf {
    shim.map_or_else(|| PathBuf::from("/usr/bin/grep"), Shim::grep)
}

/// The native side's `HostGrep` environment: the one the shell child runs under.
fn host_env(locale: Locale, dir: &Path, shim: Option<&Shim>) -> Vec<(OsString, OsString)> {
    let mut command = Command::new("true");
    hermetic(&mut command, locale, dir, shim);
    command
        .get_envs()
        .filter_map(|(name, value)| Some((name.to_owned(), value?.to_owned())))
        .collect()
}

/// Every field travels as hex (`-` when empty), one case per line, and is decoded under
/// `LC_ALL=C`: no locale decides where a field ends (bash 5.2 `read -d ''` in UTF-8 eats the NUL
/// after an incomplete sequence). The case's locale is restored only around the lane. The
/// sentinel proves the loop ran to the end.
const SCRIPT: &str = r#"
set -euo pipefail
block() { exit 1; }
source "$1/inert-skeleton.sh"
source "$1/pii-egress.sh"
source "$1/pii-egress-bash.sh"
_case_locale=$LC_ALL
LC_ALL=C
unhex() {
  local hex=$1 chunk piece i out=''
  if [ "$hex" = - ]; then hex=''; fi
  # In chunks: one loop over a long field is quadratic in bash.
  while [ -n "$hex" ]; do
    chunk=${hex:0:512}
    hex=${hex:512}
    piece=''
    for ((i = 0; i < ${#chunk}; i += 2)); do piece+="\\x${chunk:i:2}"; done
    printf -v piece '%b' "$piece"
    out+=$piece
  done
  printf -v "$2" '%s' "$out"
}
exec 3<&0 0</dev/null
while IFS=' ' read -r -u 3 hcmd hasmail hemail hasids hids; do
  unhex "$hcmd" cmd
  unhex "$hemail" email
  unhex "$hids" ids
  if [ "$hasmail" = 1 ]; then
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.email GIT_CONFIG_VALUE_0="$email"
  else
    export GIT_CONFIG_COUNT=0
    unset GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
  fi
  # Not exported: a real hook gets it in the environment, but one past MAX_ARG_STRLEN could
  # never be set there, and the children would not start.
  if [ "$hasids" = 1 ]; then NAVORI_PERSONAL_IDS=$ids; else unset NAVORI_PERSONAL_IDS; fi
  LC_ALL=$_case_locale
  set +e
  ( set -e; navori_inert_skeleton; navori_pii_bash_lane ) 2>&1
  rc=$?
  set -e
  LC_ALL=C
  printf '\0%s\0' "$rc"
done
printf 'SENTINEL\0'
"#;

fn hex(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "-".to_owned();
    }
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// The hermetic environment of the host, plus the logging `grep` first in `PATH` when given.
fn hermetic(command: &mut Command, locale: Locale, dir: &Path, shim: Option<&Shim>) {
    let path = shim.map_or_else(
        || "/usr/bin:/bin".to_owned(),
        |shim| format!("{}:/usr/bin:/bin", shim.dir.display()),
    );
    command
        .env_clear()
        .env("PATH", path)
        .env("LC_ALL", locale_name(locale))
        .env("HOME", dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CEILING_DIRECTORIES", dir.parent().unwrap_or(dir))
        .current_dir(dir);
    if let Some(shim) = shim {
        command.env("PII_GREP_LOG", &shim.log);
    }
}

/// What the real partials say for every case: `(stderr and stdout, exit status)`.
fn shell_verdicts(
    cases: &[Case],
    locale: Locale,
    dir: &Path,
    shim: Option<&Shim>,
) -> Result<Vec<(String, u8)>, Box<dyn Error>> {
    let mut input = String::new();
    for case in cases {
        input.push_str(&format!(
            "{} {} {} {} {}\n",
            hex(case.cmd.as_bytes()),
            u8::from(case.email.is_some()),
            hex(case.email.as_deref().unwrap_or_default()),
            u8::from(case.ids.is_some()),
            hex(case.ids.as_deref().unwrap_or_default().as_bytes()),
        ));
    }
    let mut shell = Command::new("bash");
    shell
        .args(["-c", SCRIPT, "pii"])
        .arg(partials())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hermetic(&mut shell, locale, dir, shim);
    let mut child = shell.spawn()?;
    let mut stdin = child.stdin.take().ok_or("stdin")?;
    // The cases can outgrow the pipe while bash is still writing its answers.
    let writer = thread::spawn(move || stdin.write_all(input.as_bytes()));
    let output = child.wait_with_output()?;
    writer.join().map_err(|_| "writer panicked")??;
    if !output.status.success() {
        return Err(format!("the harness shell exited with {:?}", output.status.code()).into());
    }
    // Per case: its output, NUL, its status, NUL; then the sentinel, NUL.
    let tokens: Vec<&[u8]> = output.stdout.split(|&b| b == 0).collect();
    let end = cases.len() * 2;
    if tokens.len() != end + 2 || tokens[end] != b"SENTINEL" || !tokens[end + 1].is_empty() {
        return Err("the shell did not answer every case".into());
    }
    let mut verdicts = Vec::new();
    for pair in tokens[..end].chunks(2) {
        let status = String::from_utf8(pair[1].to_vec())?.parse::<u8>()?;
        verdicts.push((String::from_utf8(pair[0].to_vec())?, status));
    }
    Ok(verdicts)
}

/// The native verdict of one case, exactly as `guard-destructive` will compose it, with the
/// host's `grep` (or the shim) behind the matcher.
fn native_code(
    case: &Case,
    locale: Locale,
    dir: &Path,
    shim: Option<&Shim>,
) -> Result<Code, Box<dyn Error>> {
    if !gate(&case.cmd, locale) {
        return Ok(Code::Clean);
    }
    let program = grep_program(shim);
    let env = host_env(locale, dir, shim);
    let mut matcher = HostGrep::new(Some(&program), dir, &env);
    native_with(case, locale, dir, shim, &mut matcher)
}

fn native_with(
    case: &Case,
    locale: Locale,
    dir: &Path,
    shim: Option<&Shim>,
    matcher: &mut dyn Matcher,
) -> Result<Code, Box<dyn Error>> {
    let rules = Rules::get(locale)?;
    let skeleton = inert::skeleton(&case.cmd, rules)?;
    let ids = case.ids.as_deref().map(Secret::new);
    check(
        &case.cmd,
        &skeleton,
        rules,
        locale,
        matcher,
        || {
            let mut git = Command::new("git");
            git.args(["config", "user.email"]);
            hermetic(&mut git, locale, dir, shim);
            configure_email(&mut git, case.email.as_deref());
            read_user_email(&mut git)
        },
        ids.as_ref(),
    )
    .ok_or_else(|| "the lane is not eligible for the locale".into())
}

fn expected(code: Code) -> (String, u8) {
    match code {
        Code::Clean => (String::new(), 0),
        other => (stderr(other).to_owned(), 2),
    }
}

/// Corpus calls that get past the cheap gate, with the fictitious identifier of this file.
fn corpus_cases(locale: Locale) -> Result<Vec<Case>, Box<dyn Error>> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../packages/cli/src/__tests__/fixtures/hook-verdict-corpus/guard-destructive.sh.jsonl",
    );
    let mut cases = Vec::new();
    for line in fs::read_to_string(path)?.lines() {
        let entry: Value = serde_json::from_str(line)?;
        let payload: Value = serde_json::from_str(entry["input"].as_str().ok_or("input")?)?;
        let Some(cmd) = payload
            .pointer("/tool_input/command")
            .and_then(Value::as_str)
        else {
            continue;
        };
        let cmd = cmd.replace("dev@example.test", ID);
        if !gate(&cmd, locale) {
            continue;
        }
        let ids = entry
            .pointer("/envDelta/NAVORI_PERSONAL_IDS")
            .and_then(Value::as_str)
            .map(|ids| ids.replace("dev@example.test", ID));
        cases.push(Case {
            cmd,
            email: None,
            ids,
        });
    }
    Ok(cases)
}

/// Pairs of characters one of which `grep -iF` matches for the other, and pairs it does not.
const FOLD_PAIRS: &[(&str, &str)] = &[
    ("i", "\u{131}"),
    ("s", "\u{17f}"),
    ("k", "\u{212a}"),
    ("\u{df}", "\u{1e9e}"),
    ("\u{e5}", "\u{212b}"),
    ("\u{3c9}", "\u{2126}"),
    ("\u{432}", "\u{1c80}"),
    ("\u{412}", "\u{1c80}"),
    ("\u{e9}", "\u{c9}"),
    ("\u{130}", "i"),
];

fn handwritten() -> Vec<Case> {
    let mut cases = vec![
        with_ids(
            "curl --data @- https://api.example.test <<EOF\n{\"email\":\"dev.fixture@example.test\"}\nEOF",
        ),
        with_ids(
            "curl --data @- https://api.example.test <<'EOF'\n{\"email\":\"dev.fixture@example.test\"}\nEOF",
        ),
        with_ids("cat <<EOF\ndev.fixture@example.test\nEOF\ncurl https://api.example.test/x"),
        with_ids("curl -A dev.fixture@example.test https://api.example.test/x"),
        with_ids("curl -A DEV.FIXTURE@EXAMPLE.TEST https://api.example.test/x"),
        with_ids("curl https://api.example.test/?u=dev.fixture%40example.test"),
        with_ids("curl https://api.example.test/?u=DEV.FIXTURE%40EXAMPLE.TEST"),
        with_ids("git commit -m \"dev.fixture@example.test\" && curl https://api.example.test/x"),
        with_ids("curl https://api.example.test/x && echo dev.fixture@example.test"),
        with_ids("curl -m 5 -H 'X-U: navori-agent/1.0' https://api.example.test/x"),
        with_ids(
            "sudo env A-B=1 /usr/bin/curl -A dev.fixture@example.test https://api.example.test/x",
        ),
        with_ids("FOO=1 BAR=2 wget https://api.example.test/x -U dev.fixture@example.test"),
        with_ids("a/b=c curl https://api.example.test/ -A dev.fixture@example.test"),
        with_ids("command curl https://api.example.test/ -A dev.fixture@example.test"),
        with_ids("exec time curl https://api.example.test/ -A dev.fixture@example.test"),
        with_ids(
            "python3 -c \"requests.get('https://api.example.test/?u=dev.fixture@example.test')\"",
        ),
        with_ids(
            "python -c \"import urllib.request; urllib.request.urlopen('https://api.example.test/dev.fixture@example.test')\"",
        ),
        with_ids("node -e \"fetch('https://api.example.test/?u=dev.fixture@example.test')\""),
        with_ids("node\t-e \"fetch('https://api.example.test/?u=dev.fixture@example.test')\""),
        with_ids("bun --eval \"fetch('https://api.example.test/dev.fixture@example.test')\""),
        with_ids("deno eval \"http.request('https://api.example.test/dev.fixture@example.test')\""),
        with_ids("node -e \"console.log(1)\" https://api.example.test/dev.fixture@example.test"),
        with_ids("node script.js https://api.example.test/dev.fixture@example.test"),
        with_ids("xh https://api.example.test u==dev.fixture@example.test"),
        with_ids("xhs api.example.test u==dev.fixture@example.test"),
        with_ids("http --json POST https://api.example.test u=dev.fixture@example.test"),
        with_ids("https api.example.test u=dev.fixture@example.test"),
        with_ids("/usr/local/bin/http api.example.test u=dev.fixture@example.test"),
        with_ids("(http api.example.test u=dev.fixture@example.test)"),
        with_ids("cat x | http api.example.test u=dev.fixture@example.test"),
        with_ids("ahttp api.example.test u=dev.fixture@example.test"),
        with_ids("echo http dev.fixture@example.test"),
        with_ids("xhs.sh api.example.test dev.fixture@example.test"),
        with_ids("'http' api.example.test dev.fixture@example.test"),
        with_ids("curl http://LOCALHOST/ -A dev.fixture@example.test"),
        with_ids("curl http://localhost/ -A dev.fixture@example.test"),
        with_ids("curl \"http://[::1]:8080/\" -A dev.fixture@example.test"),
        with_ids("curl http://user@api.example.test/ -A dev.fixture@example.test"),
        with_ids("curl http://localhost@api.example.test/ -A dev.fixture@example.test"),
        with_ids("curl http://api.example.test@localhost/ -A dev.fixture@example.test"),
        with_ids("curl http://172.15.0.1/ -A dev.fixture@example.test"),
        with_ids("curl http://172.16.0.1/ -A dev.fixture@example.test"),
        with_ids("curl http://172.31.255.1/ -A dev.fixture@example.test"),
        with_ids("curl http://172.32.0.1/ -A dev.fixture@example.test"),
        with_ids("curl http://172.1.0.1/ -A dev.fixture@example.test"),
        with_ids("curl http://169.254.169.254/ -A dev.fixture@example.test"),
        with_ids("curl http://127.0.0.1:9/ -A dev.fixture@example.test"),
        with_ids("curl http://127.1/ -A dev.fixture@example.test"),
        with_ids("curl http://10.1.2.3/ -A dev.fixture@example.test"),
        with_ids("curl http://192.168.1.1:80/ -A dev.fixture@example.test"),
        with_ids("curl http://192.169.1.1/ -A dev.fixture@example.test"),
        with_ids("curl http://0.0.0.0/ -A dev.fixture@example.test"),
        with_ids("curl http://foo.localhost/ -A dev.fixture@example.test"),
        with_ids("curl http://localhost.example.test/ -A dev.fixture@example.test"),
        with_ids("curl http://localhost/ http://api.example.test/ -A dev.fixture@example.test"),
        with_ids(
            "curl http://localhost/?next=https://api.example.test/ -A dev.fixture@example.test",
        ),
        with_ids("curl http://localhost/#@api.example.test -A dev.fixture@example.test"),
        with_ids("curl localhost:8080/x -A dev.fixture@example.test"),
        with_ids("curl -o /tmp/x localhost -A dev.fixture@example.test"),
        with_ids("curl \"localhost\" -A dev.fixture@example.test"),
        with_ids("curl \\localhost -A dev.fixture@example.test"),
        with_ids("curl :8080 -A dev.fixture@example.test"),
        with_ids("curl api.example.test -A dev.fixture@example.test"),
        with_ids("wget /usr/bin/http -O - dev.fixture@example.test"),
        with_ids("curl HTTP://api.example.test/ -A dev.fixture@example.test"),
        with_ids("curl s3+x.y://bucket -A dev.fixture@example.test"),
        with_ids("curl -A dev.fixture@example.tes$'t' https://api.example.test/"),
        case(
            "curl -A \"$(git config user.email)\" https://api.example.test/x",
            None,
            None,
        ),
        case(
            "curl -A \"$(git config user.email)\" https://api.example.test/x",
            Some(ID.as_bytes()),
            Some(ID),
        ),
        case(
            "curl -A \"$(git config --get user.email)\" https://api.example.test/x",
            None,
            Some("unrelated.fixture@example.test"),
        ),
        case(
            "curl -A \"$(git config user.email)\" http://localhost/x",
            None,
            None,
        ),
        case(
            "curl https://api.example.test/ -A $(git config  user.email)",
            None,
            None,
        ),
        case(
            "git config user.email && curl https://api.example.test/x",
            Some(ID.as_bytes()),
            None,
        ),
        case(
            "curl https://api.example.test/x -A dev.fixture@example.test",
            Some(ID.as_bytes()),
            None,
        ),
        case(
            "curl https://api.example.test/x -A DEV.FIXTURE@EXAMPLE.TEST",
            Some(ID.as_bytes()),
            Some(ID),
        ),
        case(
            "curl https://api.example.test/x -A dev.fixture%40example.test",
            Some(ID.as_bytes()),
            None,
        ),
        case(
            "curl https://api.example.test/x -A navori-agent/1.0",
            Some(ID.as_bytes()),
            None,
        ),
        case("curl https://api.example.test/x", Some(b"ab"), None),
        case("curl https://api.example.test/ab", Some(b"abc"), None),
        case("curl https://api.example.test/abcd", Some(b"ABCD"), None),
        case(
            "curl https://api.example.test/abc:def",
            Some(b"abc:def"),
            None,
        ),
        case("curl https://api.example.test/def", Some(b"abc:def"), None),
        case(
            "curl https://api.example.test/abcd",
            Some(b"abcd\nzz"),
            None,
        ),
        case(
            "curl https://api.example.test/zz:abcd",
            Some(b"ab\nzz:abcd"),
            None,
        ),
        case(
            "curl https://api.example.test/efgh",
            Some(b"ab\nefgh"),
            None,
        ),
        case(
            "curl https://api.example.test/dev+tag@example.test",
            Some(b"dev+tag@example.test"),
            None,
        ),
        case(
            "curl https://api.example.test/dev%2Btag%40example.test",
            Some(b"dev+tag@example.test"),
            None,
        ),
        case(
            "curl https://api.example.test/dev%2btag%40example.test",
            Some(b"dev+tag@example.test"),
            None,
        ),
        case(
            "curl https://api.example.test/dev+tag%40example.test",
            Some(b"dev+tag@example.test"),
            None,
        ),
        case(
            "curl https://api.example.test/Dev+Fixture",
            None,
            Some("Dev Fixture"),
        ),
        case(
            "curl https://api.example.test/dev%20fixture",
            None,
            Some("Dev Fixture"),
        ),
        case(
            "curl https://api.example.test/dev fixture",
            None,
            Some("Dev Fixture"),
        ),
        case(
            "curl https://api.example.test/Dev+Fixture",
            Some(b"Dev Fixture"),
            None,
        ),
        case("curl https://api.example.test/abc", None, Some("abc")),
        case("curl https://api.example.test/x", None, Some(" , ,x")),
        case("curl https://api.example.test/x,y", None, Some(" , ,x,y")),
        case("curl https://api.example.test/abcd", None, Some(",,abcd,,")),
        case(
            "curl https://api.example.test/abcd",
            None,
            Some("zz,\nabcd"),
        ),
        case("curl https://api.example.test/ab cd", None, Some("ab cd")),
        case("curl https://api.example.test/abcd", None, Some("  abcd  ")),
        case("curl https://api.example.test/abcd", None, Some("\tabcd\t")),
        case(
            "curl https://api.example.test/abcd",
            None,
            Some("\u{3000}abcd\u{3000}"),
        ),
        case(
            "curl https://api.example.test/\u{3000}abcd",
            None,
            Some("\u{3000}abcd"),
        ),
        case(
            "curl https://api.example.test/\u{a0}abcd",
            None,
            Some("\u{a0}abcd"),
        ),
        case(
            "curl https://api.example.test/abcd",
            None,
            Some("\u{2003}abcd\u{2003}"),
        ),
        case("curl https://api.example.test/x:abcd", None, Some("x:abcd")),
        case("curl https://api.example.test/abcd", None, Some(":abcd")),
        case(
            "curl https://api.example.test/n",
            None,
            Some("a\u{e9}\u{e9}"),
        ),
        case(
            "curl https://api.example.test/n",
            None,
            Some("\u{e9}\u{e9}\u{e9}\u{e9}"),
        ),
        case(
            "curl https://api.example.test/\u{e9}\u{e9}\u{e9}",
            None,
            Some("\u{e9}\u{e9}\u{e9}"),
        ),
        case(
            "curl https://api.example.test/\u{e9}\u{e9}\u{e9}\u{e9}",
            None,
            Some("\u{e9}\u{e9}\u{e9}\u{e9}"),
        ),
        case(
            "curl https://api.example.test/\u{c9}\u{c9}\u{c9}\u{c9}",
            None,
            Some("\u{e9}\u{e9}\u{e9}\u{e9}"),
        ),
        case("curl https://api.example.test/1", Some(&[0xe9; 4]), None),
        // Invalid UTF-8 in the email: bytes match bytes, a match starts on a character boundary
        // and may end inside one.
        case(
            "curl https://api.example.test/fixture.jos\u{9876}x",
            Some(b"fixture.jos\xe9"),
            None,
        ),
        case(
            "curl https://api.example.test/FIXTURE.JOS\u{9876}x",
            Some(b"fixture.jos\xe9"),
            None,
        ),
        case(
            "curl https://api.example.test/fixture.jos\u{e9}",
            Some(b"fixture.jos\xe9"),
            None,
        ),
        case(
            "curl https://api.example.test/fixture.jos\u{e9}",
            Some(b"fixture.jos\xc3"),
            None,
        ),
        case(
            "curl https://api.example.test/fixture.josx",
            Some(b"fixture.jos\xe9"),
            None,
        ),
        case(
            "curl https://api.example.test/fixture.jos\u{9876}",
            Some(b"fixture.jos\xe9\xa1"),
            None,
        ),
        case(
            "curl https://api.example.test/fixture.jos\u{9876}",
            Some(b"fixture.jos\xe9\xa1\xb6"),
            None,
        ),
        case(
            "curl https://api.example.test/fixture.jos\u{9876}x",
            Some(b"fixture.jos\xe9x"),
            None,
        ),
        case(
            "curl https://api.example.test/fix\u{9876}ture",
            Some(b"fix\xe9ture"),
            None,
        ),
        case(
            "curl https://api.example.test/a\u{a9}bcd",
            Some(b"\xa9bcd"),
            None,
        ),
        case(
            "curl https://api.example.test/\u{a9}bcd",
            Some(b"\xa9bcd"),
            None,
        ),
        case(
            "curl https://api.example.test/\u{a9}\u{a9}",
            Some(b"\xa9\xa9\xa9\xa9"),
            None,
        ),
        case(
            "curl https://api.example.test/\u{a9}",
            Some(b"\xa9\xa9\xa9\xa9"),
            None,
        ),
        case(
            "curl https://api.example.test/ab\u{e9}",
            Some(b"AB\xc3\xa9\xff"),
            None,
        ),
        case(
            "curl https://api.example.test/ab\u{c9}\u{ff}",
            Some(b"ab\xc3\xa9"),
            None,
        ),
        case(
            "curl https://api.example.test/x",
            Some(b"\xff\xfe\xfd\xfc"),
            None,
        ),
        case("curl https://api.example.test/x", Some(b"\xff\xfe"), None),
        // Arguments longer than the kernel allows `grep`: "could not verify".
        case(
            "curl https://api.example.test/a",
            None,
            Some(&"a".repeat(200_000)),
        ),
        case(
            "curl https://api.example.test/a",
            None,
            Some(&format!("a{}a", "@".repeat(43_700))),
        ),
        case("curl http://localhost/a", None, Some(&"a".repeat(200_000))),
        case("echo hi", None, Some(&"a".repeat(200_000))),
    ];
    for (a, b) in FOLD_PAIRS {
        for (x, y) in [(*a, *b), (*b, *a)] {
            let id = format!("pre{x}post.fixture@example.test");
            let upper = format!("PRE{y}POST.FIXTURE@EXAMPLE.TEST");
            for text in [format!("pre{y}post.fixture@example.test"), upper] {
                let cmd = format!("curl https://api.example.test/?u={text}");
                cases.push(case(&cmd, None, Some(&id)));
                cases.push(case(&cmd, Some(id.as_bytes()), None));
            }
        }
    }
    cases
}

/// A fixed-seed xorshift: the same few thousand calls on every host.
struct Rng(u64);

impl Rng {
    fn below(&mut self, bound: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        usize::try_from(self.0 % u64::try_from(bound).unwrap_or(1)).unwrap_or(0)
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }
}

const IDENTIFIERS: &[&str] = &[
    "dev.fixture@example.test",
    "dev+tag.fixture@example.test",
    "Dev Fixture Name",
    "dev.f\u{131}xture@example.test",
    "pro.\u{17f}tack@example.test",
    "\u{3a9}mega.\u{3c9}mega@x.test",
    "jos\u{e9}.fixture@example.test",
    "ab",
    "abc",
    "name@x",
    "user_fixture-1",
];
const URLS: &[&str] = &[
    "https://api.example.test/v1",
    "http://localhost:8080/x",
    "http://127.0.0.1/",
    "http://[::1]:3000/",
    "https://user@example.test/",
    "http://172.16.0.9/",
    "http://172.32.0.9/",
    "http://10.0.0.1/",
    "http://192.168.1.5/",
    "http://169.254.169.254/",
    "http://LOCALHOST/",
    "localhost:9000",
    "example.test",
    "http://foo.localhost/",
    "https://example.test/?u=@x",
];
const TOOLS: &[&str] = &[
    "curl",
    "wget",
    "sudo env A=1 /usr/bin/curl",
    "http",
    "xh",
    "xhs",
    "env X=1 curl -s",
    "node -e",
    "python3 -c",
    "echo",
    "git commit -m",
    "time curl",
];

fn form(id: &str, kind: usize) -> String {
    match kind {
        0 | 6 => id.to_owned(),
        1 => id.to_ascii_uppercase(),
        2 => id
            .replace('@', "%40")
            .replace('+', "%2B")
            .replace(' ', "%20"),
        3 => id.replace(' ', "+"),
        4 => id.to_lowercase(),
        5 => id.replace('i', "\u{131}").replace('s', "\u{17f}"),
        _ => "unrelated.fixture@example.test".to_owned(),
    }
}

fn generated(count: usize) -> Vec<Case> {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    (0..count)
        .map(|_| {
            let id = *rng.pick(IDENTIFIERS);
            let text = form(id, rng.below(8));
            let url = *rng.pick(URLS);
            let tool = *rng.pick(TOOLS);
            let cmd = match rng.below(12) {
                0 => format!("{tool} {url} -A {text}"),
                1 => format!("{tool} -H \"X-U: {text}\" {url}"),
                2 => format!("{tool} \"{url}?q={text}\""),
                3 => format!("{tool} {url} && echo {text}"),
                4 => format!("echo {text} && {tool} {url}"),
                5 => format!("{tool} {url} --data @- <<EOF\n{text}\nEOF"),
                6 => format!("{tool} {url} --data @- <<'EOF'\n{text}\nEOF\nls"),
                7 => format!("node -e \"fetch('{url}', {{headers: '{text}'}})\""),
                8 => format!("python3 -c \"requests.get('{url}', headers='{text}')\""),
                9 => format!("{tool} {url} -A \"$(git config user.email)\""),
                10 => format!("git status; {tool} {url}?{text} | head"),
                _ => format!("ls {text}"),
            };
            let email = match rng.below(4) {
                0 => Some(id.as_bytes().to_vec()),
                1 => Some(
                    IDENTIFIERS[rng.below(IDENTIFIERS.len())]
                        .as_bytes()
                        .to_vec(),
                ),
                _ => None,
            };
            let ids = match rng.below(6) {
                0 => Some(id.to_owned()),
                1 => Some(format!("x, {id} ,y")),
                2 => Some(format!(" {id}\t")),
                3 => Some("unrelated.fixture@example.test".to_owned()),
                4 => Some(format!(
                    "{id},{}",
                    IDENTIFIERS[rng.below(IDENTIFIERS.len())]
                )),
                _ => None,
            };
            Case { cmd, email, ids }
        })
        .collect()
}

fn all_cases(locale: Locale) -> Result<Vec<Case>, Box<dyn Error>> {
    let mut cases = handwritten();
    cases.extend(corpus_cases(locale)?);
    let generated = generated(MIN_CASES);
    cases.extend(generated);
    Ok(cases)
}

fn differential(locale: Locale) -> TestResult {
    let scratch = Scratch::new(locale_name(locale))?;
    let cases = all_cases(locale)?;
    assert!(cases.len() >= MIN_CASES);
    let shell = shell_verdicts(&cases, locale, &scratch.0, None)?;
    let mut codes: BTreeMap<String, usize> = BTreeMap::new();
    let mut diverging = Vec::new();
    for (index, (case, real)) in cases.iter().zip(&shell).enumerate() {
        let code = native_code(case, locale, &scratch.0, None)?;
        *codes.entry(format!("{code:?}")).or_default() += 1;
        if &expected(code) != real {
            diverging.push(index);
        }
    }
    println!(
        "differential {}: {} cases, codes {codes:?}, {} diverging",
        locale_name(locale),
        cases.len(),
        diverging.len()
    );
    assert!(
        diverging.is_empty(),
        "cases {diverging:?} diverge from the shell"
    );
    for code in ["Clean", "GitEmail", "PersonalIds", "Unverified"] {
        assert!(codes.contains_key(code), "no case reaches {code}");
    }
    Ok(())
}

#[test]
fn differential_c() -> TestResult {
    differential(Locale::C)
}

#[test]
fn differential_c_utf8() -> TestResult {
    differential(Locale::GnuUtf8)
}

fn contains_ci(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window.eq_ignore_ascii_case(needle))
}

/// Whether `shown` holds the secret or its `%40` form (secrets under 8 bytes are too common to
/// tell a leak from a coincidence).
fn leaks(shown: &[u8], secret: &[u8]) -> bool {
    let encoded = String::from_utf8_lossy(secret).replace('@', "%40");
    secret.len() >= 8 && (contains_ci(shown, secret) || contains_ci(shown, encoded.as_bytes()))
}

/// Everything a caller or a log can see of one verdict: its `Debug`, its message, and the
/// `Debug` of every type that ever holds the secrets, a [`Call`] with them in its argv,
/// environment and stdin included.
fn shown(code: Code, secrets: &[Vec<u8>]) -> Vec<u8> {
    let mut shown = format!("{code:?}|{}|{:?}", stderr(code), Unverifiable).into_bytes();
    for secret in secrets {
        shown.extend(format!("{:?}", Secret::new(secret.clone())).bytes());
        shown.extend(format!("{:?}", EmailRead::Present(Secret::new(secret.clone()))).bytes());
        let args = [OsString::from("-e"), OsStr::from_bytes(secret).to_owned()];
        let env = [(OsString::from("X"), OsStr::from_bytes(secret).to_owned())];
        let call = Call {
            program: Path::new("/usr/bin/grep"),
            args: &args,
            cwd: Path::new("/"),
            env: &env,
            input: Input::Bytes(secret),
            capture: Capture::Discard,
            timeout: None,
        };
        shown.extend(format!("{call:?}").bytes());
    }
    shown.extend(format!("{:?}{:?}", EmailRead::Absent, EmailRead::Unreadable).bytes());
    shown
}

fn secrets_of(case: &Case) -> Vec<Vec<u8>> {
    let mut secrets: Vec<Vec<u8>> = case
        .ids
        .iter()
        .flat_map(|ids| ids.split([',', '\n']))
        .map(|id| id.trim().as_bytes().to_vec())
        .collect();
    secrets.extend(case.email.clone());
    secrets
}

#[test]
fn never_echo() -> TestResult {
    let mut checked = 0;
    for locale in [Locale::C, Locale::GnuUtf8] {
        let scratch = Scratch::new("echo")?;
        for case in handwritten().into_iter().chain(corpus_cases(locale)?) {
            let code = native_code(&case, locale, &scratch.0, None)?;
            let secrets = secrets_of(&case);
            let shown = shown(code, &secrets);
            for secret in secrets.iter().filter(|secret| secret.len() >= 8) {
                assert!(
                    !leaks(&shown, secret),
                    "the identifier of a case reaches a message ({})",
                    locale_name(locale)
                );
                checked += 1;
            }
            // The lane is deterministic, so a second pass over the same call agrees.
            assert_eq!(code, native_code(&case, locale, &scratch.0, None)?);
        }
        assert_eq!(format!("{:?}", Secret::new("x")), "Secret(<redacted>)");
    }
    assert!(checked > 100, "the check did not run");
    Ok(())
}

/// One request to an external host, with the fictitious identifier configured as both sources.
fn request() -> Case {
    case(
        "curl https://api.example.test/x",
        Some(ID.as_bytes()),
        Some(ID),
    )
}

/// The verdict of [`request`] with `program` behind the matcher, and what was shown of it.
fn through(
    program: Option<&Path>,
    scratch: &Scratch,
    shim: Option<&Shim>,
) -> Result<Code, Box<dyn Error>> {
    let locale = Locale::GnuUtf8;
    let env = host_env(locale, &scratch.0, shim);
    let mut matcher = HostGrep::new(program, &scratch.0, &env);
    let case = request();
    let code = native_with(&case, locale, &scratch.0, shim, &mut matcher)?;
    let shown = shown(code, &secrets_of(&case));
    assert!(
        !leaks(&shown, ID.as_bytes()),
        "a failure path echoes the identifier"
    );
    Ok(code)
}

#[test]
fn a_grep_that_cannot_answer_is_unverifiable() -> TestResult {
    let scratch = Scratch::new("fail")?;
    // No `grep` resolved, and a path that is not a program.
    assert_eq!(through(None, &scratch, None)?, Code::Unverified);
    assert_eq!(
        through(Some(Path::new("/nonexistent/navori-grep")), &scratch, None)?,
        Code::Unverified
    );
    // Whatever the child says, every status but 0 and 1 is "could not verify"; and a shim that
    // writes the argv to both streams shows the lane keeps them out of its answer.
    let echo = "#!/bin/sh\nprintf '%s\\n' \"$@\"\nprintf '%s\\n' \"$@\" >&2\n";
    for (name, tail, expected) in [
        ("rc0", "exit 0", Code::GitEmail),
        ("rc1", "exit 1", Code::Clean),
        ("rc2", "exit 2", Code::Unverified),
        ("rc3", "exit 3", Code::Unverified),
        ("rc127", "exit 127", Code::Unverified),
        ("rc255", "exit 255", Code::Unverified),
        ("signal", "kill -KILL $$", Code::Unverified),
    ] {
        let shim = shim(&scratch.0, name, &format!("{echo}{tail}\n"))?;
        let program = shim.grep();
        assert_eq!(
            through(Some(&program), &scratch, Some(&shim))?,
            expected,
            "grep that ends with {name}"
        );
    }
    Ok(())
}

#[test]
fn grep_output_goes_nowhere() -> TestResult {
    let scratch = Scratch::new("streams")?;
    // Read the links before any redirection: a `>>` on `readlink` itself shows up in `/proc/$$`.
    let body = "#!/bin/sh\nout=$(readlink /proc/$$/fd/1)\nerr=$(readlink /proc/$$/fd/2)\nprintf '%s\\n%s\\n' \"$out\" \"$err\" >>\"$PII_GREP_LOG\"\nexit 1\n";
    let shim = shim(&scratch.0, "streams", body)?;
    let program = shim.grep();
    assert_eq!(through(Some(&program), &scratch, Some(&shim))?, Code::Clean);
    let log = fs::read_to_string(&shim.log)?;
    assert!(!log.is_empty());
    assert!(
        log.lines().all(|line| line == "/dev/null"),
        "grep streams: {log:?}"
    );
    Ok(())
}

/// Whether process `pid` still exists (a reaped child has no `/proc` entry).
fn alive(pid: &str) -> bool {
    Path::new("/proc").join(pid).exists()
}

#[test]
fn a_grep_that_sleeps_is_cut_off_and_reaped() -> TestResult {
    let scratch = Scratch::new("sleep")?;
    let shim = shim(
        &scratch.0,
        "sleep",
        "#!/bin/sh\necho $$ >\"$PII_GREP_LOG\"\nexec sleep 30\n",
    )?;
    let program = shim.grep();
    let started = Instant::now();
    let code = through(Some(&program), &scratch, Some(&shim))?;
    let took = started.elapsed();
    assert_eq!(code, Code::Unverified);
    assert!(took < Duration::from_secs(6), "the bound did not hold");
    assert!(
        took >= Duration::from_secs(3),
        "the bound is the cap, not less"
    );
    let pid = fs::read_to_string(&shim.log)?;
    assert!(!pid.trim().is_empty());
    assert!(!alive(pid.trim()), "the child outlived the lane");
    Ok(())
}

#[test]
fn the_bound_is_cumulative_over_the_calls_of_one_evaluation() -> TestResult {
    let scratch = Scratch::new("budget")?;
    // Each call is within any per-call bound; three of them (the identifier and its two forms)
    // together are not.
    let shim = shim(
        &scratch.0,
        "budget",
        "#!/bin/sh\necho $$ >>\"$PII_GREP_LOG\"\nsleep 1.5\nexit 1\n",
    )?;
    let program = shim.grep();
    let locale = Locale::GnuUtf8;
    let env = host_env(locale, &scratch.0, Some(&shim));
    let mut matcher = HostGrep::new(Some(&program), &scratch.0, &env);
    let started = Instant::now();
    let results = [
        matcher.has(b"abcd", "x"),
        matcher.has(b"abcd", "x"),
        matcher.has(b"abcd", "x"),
        matcher.has(b"abcd", "x"),
    ];
    let took = started.elapsed();
    assert_eq!(
        results,
        [Ok(false), Ok(false), Err(Unverifiable), Err(Unverifiable)]
    );
    assert!(took < Duration::from_secs(6), "the bound did not hold");
    let pids = fs::read_to_string(&shim.log)?;
    assert_eq!(pids.lines().count(), 3, "the spent bound launches nothing");
    assert!(pids.lines().all(|pid| !alive(pid)));
    Ok(())
}

#[test]
fn an_argument_too_long_for_exec_is_unverifiable() -> TestResult {
    let scratch = Scratch::new("e2big")?;
    let locale = Locale::C;
    let env = host_env(locale, &scratch.0, None);
    let program = PathBuf::from("/usr/bin/grep");
    // Far above any `MAX_ARG_STRLEN`: the spawn fails and nothing is guessed.
    let big = "a".repeat(4 << 20);
    let long = case("curl https://api.example.test/a", None, Some(&big));
    let mut matcher = HostGrep::new(Some(&program), &scratch.0, &env);
    assert_eq!(
        native_with(&long, locale, &scratch.0, None, &mut matcher)?,
        Code::Unverified
    );
    // The same lane, with a needle that fits, answers.
    let fits = case("curl https://api.example.test/aaaa", None, Some("AAAA"));
    let mut matcher = HostGrep::new(Some(&program), &scratch.0, &env);
    assert_eq!(
        native_with(&fits, locale, &scratch.0, None, &mut matcher)?,
        Code::PersonalIds
    );
    Ok(())
}

#[test]
fn nothing_to_look_for_never_starts_grep() -> TestResult {
    let scratch = Scratch::new("nogrep")?;
    let locale = Locale::GnuUtf8;
    let env = host_env(locale, &scratch.0, None);
    // An external request, and no identifier of four characters: Clean even with no `grep`.
    for (email, ids) in [
        (None, None),
        (Some(&b"ab"[..]), Some(" , ,x")),
        (None, Some(",,")),
    ] {
        let case = case("curl https://api.example.test/x", email, ids);
        let mut matcher = HostGrep::new(None, &scratch.0, &env);
        assert_eq!(
            native_with(&case, locale, &scratch.0, None, &mut matcher)?,
            Code::Clean
        );
    }
    // Identifiers, but a command that is no request, or one to a local host: no `grep` either.
    let shim = shim(
        &scratch.0,
        "never",
        "#!/bin/sh\necho called >>\"$PII_GREP_LOG\"\n",
    )?;
    let program = shim.grep();
    let env = host_env(locale, &scratch.0, Some(&shim));
    for cmd in [
        "echo hi",
        "ls dev.fixture@example.test",
        "curl http://localhost/x",
        "git status",
    ] {
        let case = case(cmd, Some(ID.as_bytes()), Some(ID));
        let mut matcher = HostGrep::new(Some(&program), &scratch.0, &env);
        assert_eq!(
            native_with(&case, locale, &scratch.0, Some(&shim), &mut matcher)?,
            Code::Clean
        );
    }
    assert_eq!(fs::read_to_string(&shim.log)?, "");
    // The request with identifiers is what starts it.
    let mut matcher = HostGrep::new(Some(&program), &scratch.0, &env);
    let _ = native_with(&request(), locale, &scratch.0, Some(&shim), &mut matcher)?;
    assert!(!fs::read_to_string(&shim.log)?.is_empty());
    Ok(())
}

/// A matcher that records what it is asked and answers from a script.
struct Recorder {
    asked: Vec<Vec<u8>>,
    answers: Vec<Result<bool, Unverifiable>>,
}

impl Matcher for Recorder {
    fn has(&mut self, needle: &[u8], _text: &str) -> Result<bool, Unverifiable> {
        self.asked.push(needle.to_vec());
        if self.answers.is_empty() {
            Ok(false)
        } else {
            self.answers.remove(0)
        }
    }
}

#[test]
fn forms_are_asked_in_the_shell_order_with_no_shortcut() -> TestResult {
    let scratch = Scratch::new("forms")?;
    let locale = Locale::C;
    let ask = |ids: &str| -> Result<Vec<String>, Box<dyn Error>> {
        let mut recorder = Recorder {
            asked: Vec::new(),
            answers: Vec::new(),
        };
        let case = case("curl https://api.example.test/x", None, Some(ids));
        native_with(&case, locale, &scratch.0, None, &mut recorder)?;
        Ok(recorder
            .asked
            .iter()
            .map(|needle| String::from_utf8_lossy(needle).into_owned())
            .collect())
    };
    // A plain identifier: its two forms are equal to it and are asked all the same.
    assert_eq!(ask("abcd")?, ["abcd", "abcd", "abcd"]);
    assert_eq!(ask("a+b@c d")?, ["a+b@c d", "a%2Bb%40c%20d", "a+b@c+d"]);
    // Each entry in order, one hit stops the rest, a failure stops with it.
    assert_eq!(
        ask("abcd, efgh")?,
        ["abcd", "abcd", "abcd", "efgh", "efgh", "efgh"]
    );
    let mut recorder = Recorder {
        asked: Vec::new(),
        answers: vec![Ok(false), Ok(true)],
    };
    let two = case("curl https://api.example.test/x", None, Some("abcd,efgh"));
    assert_eq!(
        native_with(&two, locale, &scratch.0, None, &mut recorder)?,
        Code::PersonalIds
    );
    assert_eq!(recorder.asked.len(), 2);
    let mut recorder = Recorder {
        asked: Vec::new(),
        answers: vec![Err(Unverifiable)],
    };
    assert_eq!(
        native_with(&two, locale, &scratch.0, None, &mut recorder)?,
        Code::Unverified
    );
    assert_eq!(recorder.asked.len(), 1);
    Ok(())
}

#[test]
fn the_lane_is_not_eligible_under_the_bsd_locale() -> TestResult {
    assert!(eligible(Locale::C));
    assert!(eligible(Locale::GnuUtf8));
    assert!(!eligible(Locale::Utf8));
    let rules = Rules::get(Locale::Utf8)?;
    let cmd = "curl https://api.example.test/x";
    let skeleton = inert::skeleton(cmd, rules)?;
    let mut recorder = Recorder {
        asked: Vec::new(),
        answers: Vec::new(),
    };
    let ids = Secret::new(ID);
    let code = check(
        cmd,
        &skeleton,
        rules,
        Locale::Utf8,
        &mut recorder,
        || panic!("the email is not read for a lane that does not run"),
        Some(&ids),
    );
    assert_eq!(code, None);
    assert!(recorder.asked.is_empty());
    Ok(())
}

#[test]
fn folding_controls_follow_the_host_not_the_shell_script() -> TestResult {
    let scratch = Scratch::new("controls")?;
    let verdict = |locale: Locale, id: &str, text: &str| -> Result<Code, Box<dyn Error>> {
        let case = case(
            &format!("curl https://api.example.test/?u={text}"),
            None,
            Some(id),
        );
        native_code(&case, locale, &scratch.0, None)
    };
    let (lower, upper) = (
        "pr\u{e9}nom.fixture@example.test",
        "PR\u{c9}NOM.FIXTURE@EXAMPLE.TEST",
    );
    // é/É fold in a UTF-8 locale and are different bytes in C.
    assert_eq!(verdict(Locale::GnuUtf8, lower, upper)?, Code::PersonalIds);
    assert_eq!(verdict(Locale::GnuUtf8, upper, lower)?, Code::PersonalIds);
    assert_eq!(verdict(Locale::C, lower, upper)?, Code::Clean);
    // A/a fold in both.
    let (a, upper_a) = ("abcd.fixture@example.test", "ABCD.FIXTURE@EXAMPLE.TEST");
    assert_eq!(verdict(Locale::GnuUtf8, a, upper_a)?, Code::PersonalIds);
    assert_eq!(verdict(Locale::C, a, upper_a)?, Code::PersonalIds);
    Ok(())
}

/// `-qiF`, NUL, `-e`, NUL: the head of the argv of every `_pii_has`, in the shim's hex.
const PII_ARGV: &str = "2d716946002d6500";

/// The same `FOLD_PAIRS`, call by call, through a logging `grep` on each side: the shell and the
/// native lane must launch the same programs with the same argv and stdin, in the same order.
fn same_grep_calls(locale: Locale) -> TestResult {
    let scratch = Scratch::new(&format!("calls-{}", locale_name(locale)))?;
    let mut cases = handwritten();
    cases.extend(generated(200));
    let theirs = shim(&scratch.0, "shell", LOGGING_GREP)?;
    let ours = shim(&scratch.0, "native", LOGGING_GREP)?;
    let shell = shell_verdicts(&cases, locale, &scratch.0, Some(&theirs))?;
    let mut diverging = Vec::new();
    for (index, (case, real)) in cases.iter().zip(&shell).enumerate() {
        if expected(native_code(case, locale, &scratch.0, Some(&ours))?) != *real {
            diverging.push(index);
        }
    }
    assert!(diverging.is_empty(), "cases {diverging:?} diverge");
    // The inert skeleton calls `grep` too, for its own purposes; the lane's are `-qiF -e`.
    let pii_only = |log: &Path| -> Result<Vec<String>, Box<dyn Error>> {
        Ok(fs::read_to_string(log)?
            .lines()
            .filter(|line| line.starts_with(PII_ARGV))
            .map(str::to_owned)
            .collect())
    };
    let shell_calls = pii_only(&theirs.log)?;
    let native_calls = pii_only(&ours.log)?;
    // A measured floor (438 calls on this corpus): the shim is in `PATH` and the corpus still
    // reaches `_pii_has`; the call-by-call comparison below is the parity check.
    assert!(
        shell_calls.len() >= 400,
        "the shim saw too few `_pii_has` calls: {}",
        shell_calls.len()
    );
    let first = shell_calls
        .iter()
        .zip(&native_calls)
        .position(|(left, right)| left != right);
    assert_eq!(first, None, "the calls differ at this one");
    assert_eq!(shell_calls.len(), native_calls.len());
    Ok(())
}

#[test]
fn grep_calls_match_the_shell_in_c() -> TestResult {
    same_grep_calls(Locale::C)
}

#[test]
fn grep_calls_match_the_shell_in_c_utf8() -> TestResult {
    same_grep_calls(Locale::GnuUtf8)
}

const ISOLATED: &str = r#"
set -euo pipefail
block() { exit 1; }
source "$1/inert-skeleton.sh"
source "$1/pii-egress.sh"
source "$1/pii-egress-bash.sh"
cmd=$2
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.email GIT_CONFIG_VALUE_0="$PII_TEST_EMAIL"
unset PII_TEST_EMAIL NAVORI_PERSONAL_IDS
set +e
( set -e; navori_inert_skeleton; navori_pii_bash_lane ) 2>&1
rc=$?
printf '\0%s' "$rc"
"#;

/// One invocation of the shell for one case: the email in an environment variable and the command
/// as an argument, so no stdin framing can touch an incomplete UTF-8 sequence.
fn shell_isolated(
    cmd: &str,
    email: &[u8],
    locale: Locale,
    dir: &Path,
) -> Result<(String, u8), Box<dyn Error>> {
    let mut shell = Command::new("bash");
    shell
        .args(["-c", ISOLATED, "pii"])
        .arg(partials())
        .arg(cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hermetic(&mut shell, locale, dir, None);
    shell.env("PII_TEST_EMAIL", OsStr::from_bytes(email));
    let output = shell.output()?;
    if !output.status.success() {
        return Err("the isolated shell failed".into());
    }
    let at = output
        .stdout
        .iter()
        .rposition(|&b| b == 0)
        .ok_or("no status")?;
    let status = String::from_utf8(output.stdout[at + 1..].to_vec())?.parse::<u8>()?;
    Ok((String::from_utf8(output.stdout[..at].to_vec())?, status))
}

/// An email that is not valid UTF-8 (a byte, or a sequence that stops short) against a text that
/// holds the character it starts: what each locale says, written down, not taken from the shell.
/// `(text, email, in C.UTF-8, in C)`.
const INCOMPLETE: &[(&str, &[u8], Code, Code)] = &[
    (
        "fixture.jos\u{9876}x",
        b"fixture.jos\xe9",
        Code::GitEmail,
        Code::GitEmail,
    ),
    (
        "FIXTURE.JOS\u{9876}x",
        b"fixture.jos\xe9",
        Code::GitEmail,
        Code::GitEmail,
    ),
    (
        "fixture.jos\u{e9}",
        b"fixture.jos\xe9",
        Code::Clean,
        Code::Clean,
    ),
    (
        "fixture.jos\u{e9}",
        b"fixture.jos\xc3",
        Code::GitEmail,
        Code::GitEmail,
    ),
    ("fixture.josx", b"fixture.jos\xe9", Code::Clean, Code::Clean),
    (
        "fixture.jos\u{9876}",
        b"fixture.jos\xe9\xa1",
        Code::GitEmail,
        Code::GitEmail,
    ),
    (
        "fixture.jos\u{9876}",
        b"fixture.jos\xe9\xa1\xb6",
        Code::GitEmail,
        Code::GitEmail,
    ),
    (
        "fixture.jos\u{9876}x",
        b"fixture.jos\xe9x",
        Code::Clean,
        Code::Clean,
    ),
    ("fix\u{9876}ture", b"fix\xe9ture", Code::Clean, Code::Clean),
];

#[test]
fn an_incomplete_utf8_email_is_decided_one_invocation_at_a_time() -> TestResult {
    let scratch = Scratch::new("incomplete")?;
    let mut wrong = Vec::new();
    for locale in [Locale::GnuUtf8, Locale::C] {
        for (index, (text, email, in_utf8, in_c)) in INCOMPLETE.iter().enumerate() {
            let want = if locale == Locale::C { *in_c } else { *in_utf8 };
            let cmd = format!("curl https://api.example.test/{text}");
            let real = shell_isolated(&cmd, email, locale, &scratch.0)?;
            let ours = native_code(&case(&cmd, Some(email), None), locale, &scratch.0, None)?;
            if real != expected(want) || expected(ours) != real {
                wrong.push((locale_name(locale), index, want, ours));
            }
        }
    }
    assert!(
        wrong.is_empty(),
        "unexpected verdicts (locale, case, expected, native): {wrong:?}"
    );
    Ok(())
}

/// The text of `_pii_has` and `_pii_hits`, which the native lane reproduces call for call.
const PII_HAS: &str = r#"_pii_has() {
  local _rc=0
  grep -qiF -e "$1" <<<"$2" >/dev/null 2>&1 || _rc=$?
  [ "$_rc" -le 1 ] || exit 1
  [ "$_rc" -eq 0 ]
}

# Does the text carry identifier $1 in any of its forms?
_pii_hits() {
  local _id="$1" _t="$2" _enc
  _pii_has "$_id" "$_t" && return 0
  _enc="${_id//@/%40}"
  _enc="${_enc//+/%2B}"
  _enc="${_enc// /%20}"
  _pii_has "$_enc" "$_t" && return 0
  _enc="${_id// /+}"
  _pii_has "$_enc" "$_t" && return 0
  return 1
}
"#;

#[test]
fn pii_has_spelling() -> TestResult {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for path in [
        "packages/core/core-assets/hooks/_partials/pii-egress.sh",
        ".claude/hooks/guard-destructive.sh",
        ".pi/navori/hooks/guard-destructive.sh",
    ] {
        let text = fs::read_to_string(root.join(path))?;
        assert!(
            text.contains(PII_HAS),
            "{path} spells _pii_has or _pii_hits differently from the native lane"
        );
    }
    Ok(())
}

#[test]
fn panic_in_the_lane_is_unverified_and_silent() -> TestResult {
    let locale = Locale::GnuUtf8;
    let rules = Rules::get(locale)?;
    let cmd = "curl https://api.example.test/x";
    let skeleton = inert::skeleton(cmd, rules)?;
    let context = Context {
        engine: Engine::Claude,
        hook: "guard-destructive",
        gating: true,
    };
    let ids = Secret::new(ID);
    // The lane panics reading the email, or asking `grep`, with a message that holds the id.
    for (in_matcher, message) in [
        (false, format!("boom {ID}")),
        (false, "boom".to_owned()),
        (true, format!("boom {ID}")),
    ] {
        let seen = Cell::new(None);
        let mut payload: &[u8] = b"";
        let response = runner::run(
            context,
            &mut payload,
            || Ok(true),
            |_| {
                let mut panicking = Panicking(message.clone());
                let mut quiet = Recorder {
                    asked: Vec::new(),
                    answers: Vec::new(),
                };
                let matcher: &mut dyn Matcher = if in_matcher {
                    &mut panicking
                } else {
                    &mut quiet
                };
                let code = check(
                    cmd,
                    &skeleton,
                    rules,
                    locale,
                    matcher,
                    || -> EmailRead {
                        if in_matcher {
                            EmailRead::Absent
                        } else {
                            panic!("{message}")
                        }
                    },
                    Some(&ids),
                );
                seen.set(code);
                let code = code.unwrap_or(Code::Unverified);
                Ok(Evaluation {
                    verdict: Verdict::Block,
                    stdout: Vec::new(),
                    stderr: stderr(code).as_bytes().to_vec(),
                    audit: None,
                })
            },
        );
        assert_eq!(seen.get(), Some(Code::Unverified));
        assert_eq!(response.code(), 2);
        assert_eq!(response.stderr(), stderr(Code::Unverified).as_bytes());
        assert!(!contains_ci(response.stdout(), ID.as_bytes()));
        assert!(!contains_ci(response.stderr(), ID.as_bytes()));
    }
    Ok(())
}

/// A matcher that panics with a message of its own.
struct Panicking(String);

impl Matcher for Panicking {
    fn has(&mut self, _needle: &[u8], _text: &str) -> Result<bool, Unverifiable> {
        panic!("{}", self.0)
    }
}

#[test]
fn panic_in_the_lane_never_becomes_an_error_outside_a_capture() -> TestResult {
    // Outside `runner::run` the default hook would print the message, so this one has none.
    let locale = Locale::C;
    let rules = Rules::get(locale)?;
    let mut recorder = Recorder {
        asked: Vec::new(),
        answers: Vec::new(),
    };
    let code = check(
        "curl https://api.example.test/x",
        "curl https://api.example.test/x\n",
        rules,
        locale,
        &mut recorder,
        || -> EmailRead { std::panic::resume_unwind(Box::new(())) },
        None,
    );
    assert_eq!(code, Some(Code::Unverified));
    Ok(())
}

fn shell_email(script: &str) -> EmailRead {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", script]).env_clear();
    read_user_email(&mut command)
}

#[test]
fn read_user_email_follows_the_shell() -> TestResult {
    let scratch = Scratch::new("email")?;
    let present = |bytes: &[u8]| EmailRead::Present(Secret::new(bytes));
    // The value of `git config user.email`, from the environment, in a directory with no repo.
    for value in [&b"dev.fixture@example.test"[..], b"jos\xe9@example.test"] {
        let mut git = Command::new("git");
        git.args(["config", "user.email"]);
        hermetic(&mut git, Locale::GnuUtf8, &scratch.0, None);
        configure_email(&mut git, Some(value));
        assert_eq!(read_user_email(&mut git), present(value));
    }
    let mut git = Command::new("git");
    git.args(["config", "user.email"]);
    hermetic(&mut git, Locale::GnuUtf8, &scratch.0, None);
    configure_email(&mut git, None);
    assert_eq!(read_user_email(&mut git), EmailRead::Absent);
    // The exit status is ignored: a program that writes and fails keeps its output.
    assert_eq!(shell_email("printf a@b.cc; exit 1"), present(b"a@b.cc"));
    // Every trailing newline goes, the inner ones stay.
    assert_eq!(shell_email("printf 'a@b.cc\\n\\n\\n'"), present(b"a@b.cc"));
    assert_eq!(shell_email("printf 'a\\nb@c.dd\\n'"), present(b"a\nb@c.dd"));
    assert_eq!(shell_email("printf '\\n\\n'"), EmailRead::Absent);
    assert_eq!(shell_email("exit 3"), EmailRead::Absent);
    // A program that cannot be started is an absent email, not an error.
    let mut missing = Command::new("/nonexistent/navori-git");
    assert_eq!(read_user_email(&mut missing), EmailRead::Absent);
    // Bytes that are not UTF-8 are kept.
    assert_eq!(shell_email("printf 'jos\\351'"), present(b"jos\xe9"));
    // A NUL cannot be kept: bash would drop it and warn.
    assert_eq!(shell_email("printf 'ab\\000cd'"), EmailRead::Unreadable);
    // Stdin is null and stderr is not part of the value.
    assert_eq!(
        shell_email("if read x; then printf bad; fi"),
        EmailRead::Absent
    );
    assert_eq!(shell_email("echo err >&2; printf ok.ok"), present(b"ok.ok"));
    Ok(())
}

#[test]
fn local_hosts_follow_the_partial() {
    for host in [
        "",
        "[::1]",
        "[::1]:80",
        "localhost",
        "localhost:80/x",
        "a.localhost",
        ".localhost",
        "0.0.0.0",
        "127.0.0.1",
        "127.1",
        "10.1.2.3",
        "192.168.0.1:9",
        "172.16.0.1",
        "172.31.9.9",
        "u@127.0.0.1",
        "u@h@localhost/x",
        "localhost/a?b@evil.test",
        "localhost#@x",
    ] {
        assert!(is_local(host), "host {host:?} should be local");
    }
    for host in [
        "LOCALHOST",
        "api.example.test",
        "172.15.0.1",
        "172.32.0.1",
        "172.1.0.1",
        "127",
        "10",
        "192.169.0.1",
        "169.254.169.254",
        ":8080",
        "[::2]",
        "x@api.example.test",
        "1.2.3.4",
        "localhost.example.test",
        "evil.test/localhost",
        "evil.test?@localhost",
        "172.16",
    ] {
        assert!(!is_local(host), "host {host:?} should be external");
    }
}
