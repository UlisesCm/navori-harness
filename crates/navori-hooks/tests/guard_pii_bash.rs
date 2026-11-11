//! The PII-egress Bash lane (`guard_destructive::pii_bash`) and its core (`shell::pii_egress`)
//! against the real partials `_partials/pii-egress*.sh`, sourced under the guard's own
//! `set -euo pipefail` with `/usr/bin/grep` (GNU) and a cleared environment.
//!
//! The identifier never reaches the output of these tests: assertions name only the index of a
//! case, and every identifier is the fictitious `dev.fixture@example.test` or a variation of it.

use std::cell::Cell;
use std::collections::BTreeMap;
use std::error::Error;
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;

use navori_hooks::hooks::guard_destructive::pii_bash::{check, gate};
use navori_hooks::runner::{self, Context, Engine, Evaluation, Verdict};
use navori_hooks::shell::Locale;
use navori_hooks::shell::inert::{self, Rules};
use navori_hooks::shell::pii_egress::{
    Code, EmailRead, Folding, Secret, is_local, read_user_email, stderr,
};
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

/// The environment `git config user.email` and the shell see: nothing from the host.
fn hermetic(command: &mut Command, locale: Locale, dir: &Path) {
    command
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("LC_ALL", locale_name(locale))
        .env("HOME", dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CEILING_DIRECTORIES", dir.parent().unwrap_or(dir))
        .current_dir(dir);
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

const SCRIPT: &str = r#"
set -euo pipefail
block() { exit 1; }
source "$1/inert-skeleton.sh"
source "$1/pii-egress.sh"
source "$1/pii-egress-bash.sh"
exec 3<&0 0</dev/null
while IFS= read -r -u 3 -d '' cmd; do
  IFS= read -r -u 3 -d '' hasmail
  IFS= read -r -u 3 -d '' email
  IFS= read -r -u 3 -d '' hasids
  IFS= read -r -u 3 -d '' ids
  if [ "$hasmail" = 1 ]; then
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=user.email GIT_CONFIG_VALUE_0="$email"
  else
    export GIT_CONFIG_COUNT=0
    unset GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0
  fi
  # Not exported: a real hook gets it in the environment, but one past MAX_ARG_STRLEN could
  # never be set there, and the children would not start.
  if [ "$hasids" = 1 ]; then NAVORI_PERSONAL_IDS=$ids; else unset NAVORI_PERSONAL_IDS; fi
  set +e
  ( set -e; navori_inert_skeleton; navori_pii_bash_lane ) 2>&1
  rc=$?
  set -e
  printf '\0%s\0' "$rc"
done
"#;

/// What the real partials say for every case: `(stderr and stdout, exit status)`.
fn shell_verdicts(
    cases: &[Case],
    locale: Locale,
    dir: &Path,
) -> Result<Vec<(String, u8)>, Box<dyn Error>> {
    let mut input = Vec::new();
    for case in cases {
        for field in [
            case.cmd.as_bytes(),
            if case.email.is_some() { b"1" } else { b"0" },
            case.email.as_deref().unwrap_or_default(),
            if case.ids.is_some() { b"1" } else { b"0" },
            case.ids.as_deref().unwrap_or_default().as_bytes(),
        ] {
            input.extend_from_slice(field);
            input.push(0);
        }
    }
    let mut shell = Command::new("bash");
    shell
        .args(["-c", SCRIPT, "pii"])
        .arg(partials())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hermetic(&mut shell, locale, dir);
    let mut child = shell.spawn()?;
    let mut stdin = child.stdin.take().ok_or("stdin")?;
    // The cases can outgrow the pipe while bash is still writing its answers.
    let writer = thread::spawn(move || stdin.write_all(&input));
    let output = child.wait_with_output()?;
    writer.join().map_err(|_| "writer panicked")??;
    // Per case: its output, NUL, its status, NUL.
    let mut tokens = output.stdout.split(|&b| b == 0);
    let mut verdicts = Vec::new();
    while let (Some(text), Some(status)) = (tokens.next(), tokens.next()) {
        let status = String::from_utf8(status.to_vec())?.parse::<u8>()?;
        verdicts.push((String::from_utf8(text.to_vec())?, status));
    }
    if verdicts.len() != cases.len() {
        return Err("the shell did not answer every case".into());
    }
    Ok(verdicts)
}

/// The native verdict of one case, exactly as `guard-destructive` will compose it.
fn native_code(case: &Case, locale: Locale, dir: &Path) -> Result<Code, Box<dyn Error>> {
    if !gate(&case.cmd, locale) {
        return Ok(Code::Clean);
    }
    let rules = Rules::get(locale)?;
    let skeleton = inert::skeleton(&case.cmd, rules)?;
    let folding = Folding::for_locale(locale).ok_or("no folding for the locale")?;
    let ids = case.ids.as_deref().map(Secret::new);
    Ok(check(
        &case.cmd,
        &skeleton,
        rules,
        locale,
        &folding,
        || {
            let mut git = Command::new("git");
            git.args(["config", "user.email"]);
            hermetic(&mut git, locale, dir);
            configure_email(&mut git, case.email.as_deref());
            read_user_email(&mut git)
        },
        ids.as_ref(),
    ))
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
    let shell = shell_verdicts(&cases, locale, &scratch.0)?;
    let mut codes: BTreeMap<String, usize> = BTreeMap::new();
    let mut diverging = Vec::new();
    for (index, (case, real)) in cases.iter().zip(&shell).enumerate() {
        let code = native_code(case, locale, &scratch.0)?;
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

#[test]
fn never_echo() -> TestResult {
    let mut checked = 0;
    for locale in [Locale::C, Locale::GnuUtf8] {
        let scratch = Scratch::new("echo")?;
        for case in handwritten().into_iter().chain(corpus_cases(locale)?) {
            let code = native_code(&case, locale, &scratch.0)?;
            let mut secrets: Vec<Vec<u8>> = case
                .ids
                .iter()
                .flat_map(|ids| ids.split([',', '\n']))
                .map(|id| id.trim().as_bytes().to_vec())
                .collect();
            secrets.extend(case.email.clone());
            let mut shown = format!("{code:?}|{}", stderr(code)).into_bytes();
            for secret in &secrets {
                shown.extend(format!("{:?}", Secret::new(secret.clone())).bytes());
                shown.extend(
                    format!("{:?}", EmailRead::Present(Secret::new(secret.clone()))).bytes(),
                );
            }
            shown.extend(format!("{:?}{:?}", EmailRead::Absent, EmailRead::Unreadable).bytes());
            for secret in secrets.iter().filter(|secret| secret.len() >= 8) {
                let encoded = String::from_utf8_lossy(secret).replace('@', "%40");
                assert!(
                    !contains_ci(&shown, secret) && !contains_ci(&shown, encoded.as_bytes()),
                    "the identifier of a case reaches a message ({})",
                    locale_name(locale)
                );
                checked += 1;
            }
            // The lane is deterministic, so a second pass over the same call agrees.
            assert_eq!(code, native_code(&case, locale, &scratch.0)?);
        }
        assert_eq!(format!("{:?}", Secret::new("x")), "Secret(<redacted>)");
    }
    assert!(checked > 100, "the check did not run");
    Ok(())
}

#[test]
fn panic_in_the_lane_is_unverified_and_silent() -> TestResult {
    let locale = Locale::GnuUtf8;
    let rules = Rules::get(locale)?;
    let folding = Folding::for_locale(locale).ok_or("folding")?;
    let cmd = "curl https://api.example.test/x";
    let skeleton = inert::skeleton(cmd, rules)?;
    let context = Context {
        engine: Engine::Claude,
        hook: "guard-destructive",
        gating: true,
    };
    let ids = Secret::new(ID);
    for message in [format!("boom {ID}"), "boom".to_owned()] {
        let seen = Cell::new(None);
        let mut payload: &[u8] = b"";
        let response = runner::run(
            context,
            &mut payload,
            || Ok(true),
            |_| {
                let code = check(
                    cmd,
                    &skeleton,
                    rules,
                    locale,
                    &folding,
                    || -> EmailRead { panic!("{message}") },
                    Some(&ids),
                );
                seen.set(Some(code));
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

#[test]
fn panic_in_the_lane_never_becomes_an_error_outside_a_capture() {
    // Outside `runner::run` the default hook would print the message, so this one has none.
    let locale = Locale::C;
    let Some(folding) = Folding::for_locale(locale) else {
        return;
    };
    let Ok(rules) = Rules::get(locale) else {
        return;
    };
    let code = check(
        "curl https://api.example.test/x",
        "curl https://api.example.test/x\n",
        rules,
        locale,
        &folding,
        || -> EmailRead { std::panic::resume_unwind(Box::new(())) },
        None,
    );
    assert_eq!(code, Code::Unverified);
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
        hermetic(&mut git, Locale::GnuUtf8, &scratch.0);
        configure_email(&mut git, Some(value));
        assert_eq!(read_user_email(&mut git), present(value));
    }
    let mut git = Command::new("git");
    git.args(["config", "user.email"]);
    hermetic(&mut git, Locale::GnuUtf8, &scratch.0);
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
