//! Spec 0057 D8: generated marker inputs and exact-byte hashes against Node's crypto.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use navori_core::integrity::{marker_hash, normalize_marker, script_hash};
use proptest::prelude::*;

struct Node {
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Node {
    fn start() -> Result<Self, String> {
        let mut child = Command::new("node")
            .args([
                "-e",
                r"
const crypto = require('node:crypto');
const rl = require('node:readline').createInterface({input: process.stdin, terminal: false});
rl.on('line', line => {
  const v = JSON.parse(line);
  const normalized = v.text.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
  const marker = crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 8);
  const file = 'sha256:' + crypto.createHash('sha256').update(v.script).update(v.dep).digest('hex');
  process.stdout.write(JSON.stringify({ normalized, marker, file }) + '\n');
});
",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().ok_or("missing stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("missing stdout")?);
        Ok(Self {
            _child: child,
            stdin,
            stdout,
        })
    }

    fn ask(&mut self, text: &str, script: &str, dep: &str) -> Result<serde_json::Value, String> {
        let request = serde_json::json!({"text": text, "script": script, "dep": dep});
        // Node 24 readline treats Unicode line/paragraph separators as record boundaries.
        // Escape the transport JSON; JSON.parse restores the exact input before hashing it.
        let request = request
            .to_string()
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029");
        writeln!(self.stdin, "{request}").map_err(|e| e.to_string())?;
        self.stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        if self
            .stdout
            .read_line(&mut line)
            .map_err(|e| e.to_string())?
            == 0
        {
            return Err("Node ended before answering".to_owned());
        }
        serde_json::from_str(&line).map_err(|e| e.to_string())
    }
}

fn ask(text: &str, script: &str, dep: &str) -> Result<serde_json::Value, String> {
    static NODE: OnceLock<Mutex<Result<Node, String>>> = OnceLock::new();
    let mut guard = NODE
        .get_or_init(|| Mutex::new(Node::start()))
        .lock()
        .map_err(|e| e.to_string())?;
    match guard.as_mut() {
        Ok(node) => node.ask(text, script, dep),
        Err(error) => Err(error.clone()),
    }
}

// Covers: R11, R13
#[test]
fn unicode_line_separators_cross_the_node_transport_unchanged() -> Result<(), String> {
    let text = "a\u{2028}b\u{2029}c\u{feff}";
    let answer = ask(text, "", "")?;
    assert_eq!(answer["normalized"].as_str(), Some("a\u{2028}b\u{2029}c"));
    assert_eq!(answer["marker"].as_str(), Some(marker_hash(text).as_str()));
    Ok(())
}

proptest! {
    // Covers: R11, R13
    #[test]
    fn integrity_and_marker_hashes_match_node(
        chars in prop::collection::vec(any::<char>(), 0..100),
        trailing in prop::collection::vec(prop::sample::select(vec![
            '\r', '\n', '\u{feff}', '\u{a0}', '\u{1680}', '\u{2007}', '\u{2028}', '\u{2029}',
            '\u{202f}', '\u{205f}', '\u{3000}', '\u{85}', '\u{180e}',
        ]), 0..12),
    ) {
        let text: String = chars.into_iter().chain(trailing).collect();
        let script = format!("#!/bin/sh\n# navori:native-hook v=1 file=sha256:{} impl=sha256:{}\n{}", "0".repeat(64), "a".repeat(64), text);
        let node = ask(&text, &script, &text).map_err(TestCaseError::fail)?;
        let normalized = normalize_marker(&text);
        let marker = marker_hash(&text);
        let file = script_hash(script.as_bytes(), &[text.as_bytes()]);
        prop_assert_eq!(Some(normalized.as_str()), node["normalized"].as_str());
        prop_assert_eq!(Some(marker.as_str()), node["marker"].as_str());
        prop_assert_eq!(file.as_deref(), node["file"].as_str());
    }
}
