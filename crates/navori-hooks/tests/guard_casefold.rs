//! `shell::case_fold` against the grep the shell hooks resolve: GNU `grep -xiF`, measured again for
//! every candidate in both directions, in `C.UTF-8` and in `C`. A host whose grep or glibc folds
//! differently fails here, and a table that drifted from the generator fails `rust-casefold-table
//! --check`.

use std::collections::BTreeSet;
use std::error::Error;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::thread;

use navori_hooks::shell::case_fold::COUNTERPARTS;

type TestResult = Result<(), Box<dyn Error>>;
/// A pattern character and the text characters `grep` matched for it.
type Measured = Vec<(char, BTreeSet<String>)>;

const GREP: &str = "/usr/bin/grep";
const WORKERS: usize = 8;

/// The text lines `grep -xiF -e pattern` matches among `texts`.
fn grep_matches(pattern: &str, texts: &str, locale: &str) -> Result<Vec<String>, Box<dyn Error>> {
    let mut child = Command::new(GREP)
        .args(["-xiF", "-e", pattern])
        .env_clear()
        .env("LC_ALL", locale)
        .env("PATH", "/usr/bin:/bin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    // 12 KB fits the pipe: no writer thread is needed.
    child
        .stdin
        .take()
        .ok_or("stdin")?
        .write_all(texts.as_bytes())?;
    let output = child.wait_with_output()?;
    if !matches!(output.status.code(), Some(0 | 1)) {
        return Err("grep failed".into());
    }
    Ok(String::from_utf8(output.stdout)?
        .lines()
        .map(str::to_owned)
        .collect())
}

fn require_gnu_grep() -> TestResult {
    let output = Command::new(GREP)
        .arg("--version")
        .env_clear()
        .output()
        .map_err(|_| "the differential needs /usr/bin/grep")?;
    let first = String::from_utf8_lossy(&output.stdout);
    if !first.lines().next().is_some_and(|l| l.contains("GNU grep")) {
        return Err("/usr/bin/grep is not GNU grep: the table was measured against it".into());
    }
    Ok(())
}

/// Run `measure` for every candidate over a small pool and collect `(pattern, matches)`.
fn measure_all(
    locale: &str,
    patterns: &[&(char, &str)],
    texts: &str,
) -> Result<Measured, Box<dyn Error>> {
    let next = Mutex::new(0usize);
    let found: Mutex<Measured> = Mutex::new(Vec::new());
    let failure: Mutex<Option<String>> = Mutex::new(None);
    thread::scope(|scope| {
        for _ in 0..WORKERS {
            scope.spawn(|| {
                loop {
                    let Ok(mut guard) = next.lock() else { return };
                    let index = *guard;
                    *guard += 1;
                    drop(guard);
                    let Some(&&(pattern, _)) = patterns.get(index) else {
                        return;
                    };
                    match grep_matches(&pattern.to_string(), texts, locale) {
                        Ok(lines) => {
                            if let Ok(mut all) = found.lock() {
                                all.push((pattern, lines.into_iter().collect()));
                            }
                        }
                        Err(error) => {
                            if let Ok(mut slot) = failure.lock() {
                                *slot = Some(error.to_string());
                            }
                            return;
                        }
                    }
                }
            });
        }
    });
    if let Ok(slot) = failure.lock()
        && let Some(message) = slot.as_ref()
    {
        return Err(message.clone().into());
    }
    let mut all = found.into_inner().map_err(|_| "poisoned")?;
    all.sort_by_key(|(pattern, _)| *pattern);
    Ok(all)
}

fn texts() -> String {
    let mut text: String = COUNTERPARTS.iter().map(|(c, _)| format!("{c}\n")).collect();
    text.push('\n');
    text
}

#[test]
fn table_is_sorted_and_complete() {
    assert_eq!(COUNTERPARTS.len(), 2990);
    assert!(
        COUNTERPARTS.windows(2).all(|pair| pair[0].0 < pair[1].0),
        "the table is searched by binary search"
    );
    assert!(
        COUNTERPARTS
            .iter()
            .all(|(pattern, set)| set.contains(*pattern)),
        "every pattern matches itself"
    );
}

#[test]
fn matches_gnu_grep_in_c_utf8() -> TestResult {
    require_gnu_grep()?;
    let texts = texts();
    let all: Vec<&(char, &str)> = COUNTERPARTS.iter().collect();
    let measured = measure_all("C.UTF-8", &all, &texts)?;
    assert_eq!(measured.len(), COUNTERPARTS.len());
    let mut asymmetric = Vec::new();
    for ((pattern, expected), (measured_pattern, lines)) in COUNTERPARTS.iter().zip(&measured) {
        assert_eq!(pattern, measured_pattern);
        let table: BTreeSet<String> = expected.chars().map(String::from).collect();
        assert!(
            &table == lines,
            "U+{:04X}: the table differs from grep",
            u32::from(*pattern)
        );
    }
    for (pattern, set) in &COUNTERPARTS {
        for text in set.chars() {
            let reverse = COUNTERPARTS
                .binary_search_by_key(&text, |&(key, _)| key)
                .ok()
                .and_then(|i| COUNTERPARTS.get(i))
                .is_some_and(|(_, other)| other.contains(*pattern));
            if !reverse {
                asymmetric.push((*pattern, text));
            }
        }
    }
    println!(
        "casefold: {} candidates, {} asymmetric pairs",
        COUNTERPARTS.len(),
        asymmetric.len()
    );
    assert_eq!(asymmetric.len(), 18);
    assert!(
        asymmetric
            .iter()
            .all(|(pattern, _)| ('\u{1c80}'..='\u{1c88}').contains(pattern)),
        "the asymmetric pairs are the Cyrillic variants U+1C80..U+1C88"
    );
    let set_of = |c: char| {
        COUNTERPARTS
            .iter()
            .find(|(key, _)| *key == c)
            .map_or("", |(_, set)| set)
    };
    assert!(set_of('i').contains('\u{131}') && set_of('\u{131}').contains('i'));
    assert!(set_of('s').contains('\u{17f}') && set_of('\u{17f}').contains('s'));
    for unfolded in ['\u{212a}', '\u{1e9e}', '\u{212b}', '\u{2126}'] {
        assert_eq!(set_of(unfolded), unfolded.to_string());
    }
    assert!(!set_of('k').contains('\u{212a}'));
    assert!(!set_of('\u{df}').contains('\u{1e9e}'));
    assert!(!set_of('\u{e5}').contains('\u{212b}'));
    assert!(!set_of('\u{3c9}').contains('\u{2126}'));
    Ok(())
}

#[test]
fn folds_only_ascii_in_c() -> TestResult {
    require_gnu_grep()?;
    let texts = texts();
    // Every ASCII candidate and a stride over the rest: the C locale reads bytes.
    let sample: Vec<&(char, &str)> = COUNTERPARTS
        .iter()
        .enumerate()
        .filter(|(index, (c, _))| c.is_ascii() || index % 29 == 0)
        .map(|(_, entry)| entry)
        .collect();
    let measured = measure_all("C", &sample, &texts)?;
    for (pattern, lines) in &measured {
        let expected: BTreeSet<String> = COUNTERPARTS
            .iter()
            .map(|(c, _)| c.to_string())
            .filter(|text| text.eq_ignore_ascii_case(&pattern.to_string()))
            .collect();
        assert!(
            lines == &expected,
            "U+{:04X}: grep in C folds more than ASCII",
            u32::from(*pattern)
        );
    }
    println!("casefold: C locale sample of {} patterns", measured.len());
    Ok(())
}
