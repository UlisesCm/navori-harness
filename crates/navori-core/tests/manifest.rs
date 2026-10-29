//! Schema of `crates/ported.json` (D4) and `crates/ported-history.jsonl` (D1).

use std::collections::BTreeSet;
use std::error::Error;

use navori_core::manifest::{Manifest, parse_history};

const HASH: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

fn hook(blocks_hash: &str, impl_hash: &str) -> String {
    format!(
        r#"{{"schema":2,"commands":[],"hooks":{{"h":{{"mode":"shadow","gating":true,
        "blocks":{{"b":"{blocks_hash}"}},"deps":{{"s.sh":"{HASH}"}},"impl":"{impl_hash}"}}}}}}"#
    )
}

fn flags(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|n| (*n).to_owned()).collect()
}

fn path(tokens: &[&str]) -> Vec<String> {
    tokens.iter().map(|t| (*t).to_owned()).collect()
}

// Covers: R7
#[test]
fn the_committed_files_are_valid() -> Result<(), Box<dyn Error>> {
    Manifest::embedded()?;
    let history = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../ported-history.jsonl"
    ))?;
    parse_history(&history)?;
    Ok(())
}

// Covers: R7, R10
#[test]
fn rejects_entries_without_normalized_flags_or_complete_hashes() -> Result<(), Box<dyn Error>> {
    for bad_flag in ["--json", "-j", "no-color", "json=1", ""] {
        let text =
            format!(r#"{{"schema":2,"commands":[{{"path":["spec"],"flags":["{bad_flag}"]}}]}}"#);
        let e = Manifest::parse(&text).err().ok_or("accepted a bad flag")?;
        assert!(e.to_string().contains("not normalized"), "{bad_flag}: {e}");
    }
    for bad_hash in [
        "sha256:abc",
        "sha1:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef",
        "sha256:9f2c4e…",
    ] {
        for text in [hook(bad_hash, HASH), hook(HASH, bad_hash)] {
            let e = Manifest::parse(&text).err().ok_or("accepted a bad hash")?;
            assert!(e.to_string().contains("sha256:<64 hex>"), "{bad_hash}: {e}");
        }
    }
    Manifest::parse(&hook(HASH, HASH))?;
    Ok(())
}

// Covers: R7
#[test]
fn rejects_structural_violations() {
    for text in [
        r#"{"schema":1,"commands":[]}"#,
        r#"{"schema":3,"commands":[]}"#,
        r#"{"schema":2,"commands":[{"path":[]}]}"#,
        r#"{"schema":2,"commands":[{"path":["a"]},{"path":["a"]}]}"#,
        r#"{"schema":2,"commands":[{"path":["a"],"extra":1}]}"#,
        r#"{"schema":2,"commands":[{"path":["a"],"when":{"engines":[]}}]}"#,
        r#"{"schema":2,"commands":[],"hooks":{"h":{"mode":"live","gating":false,"blocks":{},"impl":""}}}"#,
    ] {
        assert!(Manifest::parse(text).is_err(), "accepted {text}");
    }
    let no_blocks = format!(
        r#"{{"schema":2,"commands":[],"hooks":{{"h":{{"mode":"active","gating":false,"blocks":{{}},"impl":"{HASH}"}}}}}}"#
    );
    assert!(Manifest::parse(&no_blocks).is_err());
}

// Covers: R7, R11
#[test]
fn validates_divergences() -> Result<(), Box<dyn Error>> {
    let with = |category: &str, requirement: &str| {
        format!(
            r#"{{"schema":2,"commands":[],"hooks":{{"h":{{"mode":"shadow","gating":true,
            "blocks":{{"b":"{HASH}"}},"impl":"{HASH}","divergences":[{{"case":"c#1",
            "category":"{category}","reason":"zsh parse error","requirement":"{requirement}"}}]}}}}}}"#
        )
    };
    Manifest::parse(&with("shell-runtime", "R11"))?;
    Manifest::parse(&with("fail-closed", "R12"))?;
    assert!(Manifest::parse(&with("other", "R11")).is_err());
    assert!(Manifest::parse(&with("shell-runtime", "11")).is_err());
    Ok(())
}

// Covers: R7
#[test]
fn selection_uses_path_and_flag_containment() -> Result<(), Box<dyn Error>> {
    let m = Manifest::parse(
        r#"{"schema":2,"commands":[{"path":["spec","check"],"flags":["json"]},{"path":["--version"]}]}"#,
    )?;
    let spec = path(&["spec", "check"]);
    assert!(m.select(&spec, &flags(&[])).is_some());
    assert!(m.select(&spec, &flags(&["json"])).is_some());
    assert!(m.select(&spec, &flags(&["json", "verbose"])).is_none());
    assert!(m.select(&path(&["spec"]), &flags(&[])).is_none());
    assert!(
        m.select(&path(&["spec", "check", "tasks"]), &flags(&[]))
            .is_some()
    );
    // An empty flag list admits only the invocation without flags.
    assert!(m.select(&path(&["--version"]), &flags(&["json"])).is_none());
    assert!(m.select(&path(&["--version"]), &flags(&[])).is_some());
    Ok(())
}

// Covers: R48
#[test]
fn an_invocation_without_the_required_flags_is_delegated() -> Result<(), Box<dyn Error>> {
    let m = Manifest::parse(
        r#"{"schema":2,"commands":[
            {"path":["sync"],"flags":["apply","yes","accept-new","json"],
             "requires":[["apply"],["yes"]]},
            {"path":["sync"],"flags":["dry-run","json"],"requires":[["dry-run"]]},
            {"path":["remove"],"flags":["plugin","yes"],"requires":[["plugin","yes"]]}
        ]}"#,
    )?;
    let sync = path(&["sync"]);
    let selected = |p: &[String], f: &[&str]| {
        m.select(p, &flags(f))
            .map(|c| c.requires.clone().unwrap_or_default())
    };
    // Without any alternative the command would prompt: no entry selects it.
    assert_eq!(selected(&sync, &[]), None);
    assert_eq!(selected(&sync, &["json"]), None);
    assert_eq!(selected(&sync, &["accept-new"]), None);
    // One complete alternative is enough; the first matching entry wins.
    let apply_or_yes = vec![vec!["apply".to_owned()], vec!["yes".to_owned()]];
    assert_eq!(selected(&sync, &["apply"]), Some(apply_or_yes.clone()));
    assert_eq!(selected(&sync, &["yes", "accept-new"]), Some(apply_or_yes));
    assert_eq!(
        selected(&sync, &["dry-run", "json"]),
        Some(vec![vec!["dry-run".to_owned()]])
    );
    // Flags must still be contained in the entry that carries the alternative.
    assert_eq!(selected(&sync, &["apply", "dry-run"]), None);
    // Every flag of the alternative is required, not just one.
    let remove = path(&["remove"]);
    assert_eq!(selected(&remove, &["plugin"]), None);
    assert_eq!(selected(&remove, &["yes"]), None);
    assert!(selected(&remove, &["plugin", "yes"]).is_some());
    Ok(())
}

// Covers: R48
#[test]
fn requires_is_validated_and_tells_apart_entries_of_one_path() -> Result<(), Box<dyn Error>> {
    let entry =
        |requires: &str| format!(r#"{{"path":["sync"],"flags":["apply","yes"]{requires}}}"#);
    let manifest =
        |entries: &[String]| format!(r#"{{"schema":2,"commands":[{}]}}"#, entries.join(","));
    for (requires, message) in [
        (r#","requires":[]"#, "at least one alternative"),
        (r#","requires":[[]]"#, "must be non-empty"),
        (r#","requires":[["apply","apply"]]"#, "without repeats"),
        (r#","requires":[["force"]]"#, "not in flags"),
        (
            r#","requires":[["apply","yes"],["yes","apply"]]"#,
            "duplicate requires",
        ),
    ] {
        let e = Manifest::parse(&manifest(&[entry(requires)]))
            .err()
            .ok_or("accepted bad requires")?;
        assert!(e.to_string().contains(message), "{requires}: {e}");
    }
    // Entries of one path must differ in `requires`, compared as sets of sets.
    for pair in [
        [entry(""), entry("")],
        [
            entry(r#","requires":[["apply"],["yes"]]"#),
            entry(r#","requires":[["yes"],["apply"]]"#),
        ],
    ] {
        let e = Manifest::parse(&manifest(&pair))
            .err()
            .ok_or("accepted a duplicate path")?;
        assert!(e.to_string().contains("duplicate path"), "{e}");
    }
    Manifest::parse(&manifest(&[
        entry(""),
        entry(r#","requires":[["apply"]]"#),
        entry(r#","requires":[["apply","yes"]]"#),
    ]))?;
    Ok(())
}

// Covers: R10
#[test]
fn history_lines_are_validated() -> Result<(), Box<dyn Error>> {
    let good =
        r#"{"date":"2026-11-02","op":"unport","id":"render","reason":"parity gap","pr":123}"#;
    let events = parse_history(&format!("{good}\n{good}\n"))?;
    assert_eq!(events.len(), 2);
    assert!(parse_history("")?.is_empty());
    for bad in [
        r#"{"date":"2026-13-02","op":"port","id":"x","reason":"r","pr":1}"#,
        r#"{"date":"2026-1-02","op":"port","id":"x","reason":"r","pr":1}"#,
        r#"{"date":"2026-11-02","op":"remove","id":"x","reason":"r","pr":1}"#,
        r#"{"date":"2026-11-02","op":"port","id":"","reason":"r","pr":1}"#,
        r#"{"date":"2026-11-02","op":"port","id":"x","reason":" ","pr":1}"#,
        r#"{"date":"2026-11-02","op":"port","id":"x","reason":"r","pr":0}"#,
        r#"{"date":"2026-11-02","op":"port","id":"x","reason":"r"}"#,
        "not json",
        "",
    ] {
        let text = format!("{good}\n{bad}\n");
        let e = parse_history(&text).err().ok_or("accepted a bad line")?;
        assert!(
            e.to_string().contains("ported-history.jsonl:2"),
            "{bad}: {e}"
        );
    }
    Ok(())
}
