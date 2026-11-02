//! The version notices against the real TS (spec 0062 T9, R85): `update-notice.ts` (the daily
//! "a newer navori is available" line and its registry worker) and the network worker of
//! `tool-version-notice.ts`. Both sides start from the same state files in their own `HOME`, see
//! the same clock and the same registry answer (Rust through [`RecordedHttp`], the TS through a
//! stubbed `fetch`), and must leave the same files, print the same text and ask the same URLs.

mod support;

use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use navori_core::http::{HttpFailure, HttpResponse, RecordedHttp};
use navori_core::tools::notice::{Plugins, run_tool_version_worker};
use navori_core::tools::update_notice::{REGISTRY, run_update_notice, run_update_worker};
use serde_json::{Value, json};
use support::{Shared, cli_module, first_difference};

type TestResult = Result<(), Box<dyn std::error::Error>>;

const NOW: f64 = 1_790_000_000_000.0;
const TOKEN: &str = "11111111-1111-4111-8111-111111111111";
const INSTALLED: &str = "0.12.3";
const ENGRAM: &str = "https://api.github.com/repos/Gentleman-Programming/engram/releases/latest";

fn prelude() -> String {
    format!(
        "const u = await import({:?}); const t = await import({:?});\n\
         const fs = await import('node:fs'); const path = await import('node:path');",
        cli_module("lib/primitives/update-notice.ts"),
        cli_module("lib/primitives/tool-version-notice.ts"),
    )
}

/// One request: `HOME`, the clock, the registry answer, then the worker or the notice. The answer
/// is `{ status, body }`, `"error"` (a rejected fetch) or `"timeout"` (the abort signal fired).
static NODE: Shared = Shared::new(
    prelude,
    "process.env.HOME = request.home; delete process.env.CI; delete process.env.NAVORI_NO_UPDATE_NOTIFIER;\n\
     Date.now = () => request.now;\n\
     const calls = [];\n\
     globalThis.fetch = async (url, init) => {\n\
       calls.push({ url: String(url), headers: init?.headers ?? {} });\n\
       const a = request.answers[String(url)];\n\
       if (a === undefined || a === 'error') throw new TypeError('fetch failed');\n\
       if (a === 'timeout') throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');\n\
       return new Response(a.body, { status: a.status });\n\
     };\n\
     let stderr = '';\n\
     if (request.run === 'update-worker') await u.runUpdateNoticeWorker(request.token);\n\
     else if (request.run === 'tool-worker') await t.runToolVersionWorker(request.token);\n\
     else {\n\
       const write = process.stderr.write;\n\
       for (const s of [process.stdout, process.stderr]) Object.defineProperty(s, 'isTTY', { value: true, configurable: true });\n\
       process.stderr.write = (text) => { stderr += text; return true; };\n\
       try { u.runUpdateNotice(request.installed, request.argv); }\n\
       finally { process.stderr.write = write; for (const s of [process.stdout, process.stderr]) delete s.isTTY; }\n\
     }\n\
     return { stderr, calls };",
);

static SEQ: AtomicUsize = AtomicUsize::new(0);

/// A fresh directory under the system temp dir, removed on drop.
struct Temp(PathBuf);

impl Temp {
    fn new() -> std::io::Result<Self> {
        let dir = std::env::temp_dir().join(format!(
            "navori-notices-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir)?;
        Ok(Self(dir))
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Every file under `dir`, relative path to text, with random tokens masked.
fn snapshot(dir: &Path) -> Value {
    let uuid =
        regex::Regex::new("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")
            .ok();
    let mut files = serde_json::Map::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        let Ok(entries) = fs::read_dir(&next) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if let (Ok(rel), Ok(text)) = (path.strip_prefix(dir), fs::read_to_string(&path))
            {
                let masked = uuid.as_ref().map_or(text.clone(), |re| {
                    re.replace_all(&text, "@UUID@").into_owned()
                });
                files.insert(rel.display().to_string(), Value::String(masked));
            }
        }
    }
    Value::Object(files)
}

/// Two `HOME`s with the same seeded files under `~/.navori/<state>`.
fn homes(state: &str, seed: &[(&str, &str)]) -> std::io::Result<(Temp, Temp)> {
    let pair = (Temp::new()?, Temp::new()?);
    for home in [&pair.0, &pair.1] {
        let dir = home.0.join(".navori").join(state);
        fs::create_dir_all(&dir)?;
        for (name, text) in seed {
            fs::write(dir.join(name), text)?;
        }
    }
    Ok(pair)
}

fn env(home: &Path) -> Vec<(OsString, OsString)> {
    vec![
        ("HOME".into(), home.as_os_str().to_owned()),
        ("PATH".into(), std::env::var_os("PATH").unwrap_or_default()),
    ]
}

/// The registry answers of a case: the recorded client for Rust and the stub table for the TS.
fn answers(url: &str, answer: &Value) -> (RecordedHttp, Value) {
    let recorded = match answer.as_str() {
        Some("timeout") => Err(HttpFailure::Timeout),
        Some(_) => Err(HttpFailure::Error),
        None => Ok(HttpResponse {
            status: u16::try_from(answer["status"].as_u64().unwrap_or(0)).unwrap_or(0),
            body: answer["body"]
                .as_str()
                .unwrap_or_default()
                .as_bytes()
                .to_vec(),
        }),
    };
    (
        RecordedHttp::new(vec![(url.to_owned(), recorded)]),
        json!({ url: answer }),
    )
}

/// The requests Rust sent, shaped like the TS's `{ url, headers }` (a missing `init.headers` is
/// `{}`).
fn asked(http: &RecordedHttp) -> Value {
    Value::Array(
        http.calls()
            .into_iter()
            .map(|(url, headers)| {
                let headers: serde_json::Map<String, Value> = headers
                    .into_iter()
                    .map(|(name, value)| (name, Value::String(value)))
                    .collect();
                json!({ "url": url, "headers": headers })
            })
            .collect(),
    )
}

fn assert_same(case: &str, ts: &Value, rust: &Value) -> TestResult {
    if ts != rust {
        return Err(format!("{case}: {}", first_difference(ts, rust)).into());
    }
    Ok(())
}

/// The four registry answers of R85, plus a body the TS cannot read.
fn registry_answers() -> Vec<(&'static str, Value)> {
    vec![
        (
            "nueva",
            json!({ "status": 200, "body": "{\"name\":\"navori\",\"version\":\"0.13.1\"}" }),
        ),
        (
            "igual",
            json!({ "status": 200, "body": "{\"name\":\"navori\",\"version\":\"0.12.3\"}" }),
        ),
        ("error", json!("error")),
        ("tiempo agotado", json!("timeout")),
        ("no json", json!({ "status": 200, "body": "<html>" })),
        (
            "503",
            json!({ "status": 503, "body": "{\"version\":\"9.9.9\"}" }),
        ),
    ]
}

// Covers: R85
#[test]
fn el_aviso_coincide_con_el_ts_en_version_nueva_igual_error_y_tiempo_agotado() -> TestResult {
    for lang in ["es", "en"] {
        for (case, answer) in registry_answers() {
            let label = format!("{lang}/{case}");
            let attempt = format!("{{\"at\":{NOW},\"token\":\"{TOKEN}\"}}");
            let (ts, rust) = homes("update-notice", &[("attempt.json", &attempt)])?;
            let repo = Temp::new()?;
            fs::write(
                repo.0.join("navori.config.json"),
                format!("{{\"language\":\"{lang}\"}}"),
            )?;
            let cwd = repo.0.display().to_string();
            let (http, table) = answers(REGISTRY, &answer);

            // The worker claims the reservation and asks the registry.
            let ts_worker = NODE.ask(&json!({
                "home": ts.0, "now": NOW + 1_000.0, "answers": table,
                "run": "update-worker", "token": TOKEN,
            }))?;
            run_update_worker(&env(&rust.0), Some(TOKEN), &http, &|| NOW + 1_000.0);
            assert_same(&label, &snapshot(&ts.0), &snapshot(&rust.0))?;
            assert_same(&label, &ts_worker["calls"], &asked(&http))?;

            // The next command, a minute later, prints the notice when the answer was newer; a
            // day later it also reserves a new attempt.
            for later in [60_000.0, 86_400_000.0 + 2_000.0] {
                let argv = ["render", "--cwd", cwd.as_str()];
                let ts_run = NODE.ask(&json!({
                    "home": ts.0, "now": NOW + later, "answers": {},
                    "run": "notice", "installed": INSTALLED, "argv": argv,
                }))?;
                let spawned = std::cell::RefCell::new(Vec::new());
                let text = run_update_notice(
                    &env(&rust.0),
                    Path::new("/"),
                    INSTALLED,
                    &argv,
                    true,
                    true,
                    NOW + later,
                    &|flag, _| spawned.borrow_mut().push(flag.to_owned()),
                );
                let label = format!("{label} +{later}ms");
                assert_same(&label, &ts_run["stderr"], &json!(text.unwrap_or_default()))?;
                assert_same(&label, &snapshot(&ts.0), &snapshot(&rust.0))?;
            }
        }
    }
    Ok(())
}

// Covers: R85
#[test]
fn el_worker_de_herramientas_coincide_con_el_ts() -> TestResult {
    let cases = [
        (
            "release nueva",
            json!({ "status": 200, "body": "{\"tag_name\":\"v1.20.0\",\"prerelease\":false,\"draft\":false}" }),
        ),
        (
            "tag ilegible",
            json!({ "status": 200, "body": "{\"tag_name\":\"nightly\",\"prerelease\":false,\"draft\":false}" }),
        ),
        (
            "prerelease",
            json!({ "status": 200, "body": "{\"tag_name\":\"v2.0.0\",\"prerelease\":true,\"draft\":false}" }),
        ),
        ("error", json!("error")),
        ("tiempo agotado", json!("timeout")),
        ("lista", json!({ "status": 200, "body": "[1]" })),
    ];
    for (case, answer) in cases {
        let attempts = format!(
            "{{\"engram\":{{\"at\":{NOW},\"token\":\"{TOKEN}\"}},\"gh\":{{\"at\":{NOW},\"token\":\"{TOKEN}\"}}}}"
        );
        // A prior cache entry the merge must keep (and rewrite in place) when nothing new arrives.
        let latest = format!(
            "{{\"tools\":{{\"engram\":{{\"at\":{},\"source\":\"github\",\"id\":\"Gentleman-Programming/engram\",\"status\":\"ok\",\"version\":\"1.10.0\"}}}}}}",
            NOW - 1_000.0
        );
        let (ts, rust) = homes(
            "tool-versions",
            &[("attempts.json", &attempts), ("latest.json", &latest)],
        )?;
        let (http, table) = answers(ENGRAM, &answer);
        let ts_run = NODE.ask(&json!({
            "home": ts.0, "now": NOW + 1_000.0, "answers": table,
            "run": "tool-worker", "token": TOKEN,
        }))?;
        run_tool_version_worker(
            &env(&rust.0),
            Some(TOKEN),
            &http,
            &mut Plugins::default(),
            &|| NOW + 1_000.0,
            &|| Duration::ZERO,
        );
        assert_same(case, &snapshot(&ts.0), &snapshot(&rust.0))?;
        assert_same(case, &ts_run["calls"], &asked(&http))?;
    }
    Ok(())
}
