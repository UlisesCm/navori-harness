//! `js_json` against Node (D14): proptest generates documents, one persistent Node process answers
//! `JSON.stringify(JSON.parse(x))` and its indented variant, and Rust must match byte for byte.

use std::fmt::Write as _;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use navori_core::js_json::{JsObject, JsString, JsValue};
use proptest::prelude::*;
use proptest::test_runner::TestCaseError;

/// Reads one JSON string literal per line (the document text, ASCII only), answers one JSON line
/// `{"compact": ..., "indent": ...}`.
const NODE_SCRIPT: &str = r"
const rl = require('node:readline').createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const value = JSON.parse(JSON.parse(line));
  process.stdout.write(
    JSON.stringify({ compact: JSON.stringify(value), indent: JSON.stringify(value, null, 2) }) + '\n',
  );
});
";

struct Node {
    // Held so the child is reaped with the process; stdin closing makes it exit.
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

struct Answer {
    compact: String,
    indent: String,
}

impl Node {
    fn start() -> Result<Self, String> {
        let mut child = Command::new("node")
            .args(["-e", NODE_SCRIPT])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| format!("cannot start node: {e}"))?;
        let stdin = child.stdin.take().ok_or("node has no stdin")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("node has no stdout")?);
        Ok(Self {
            _child: child,
            stdin,
            stdout,
        })
    }

    fn ask(&mut self, document: &str) -> Result<Answer, String> {
        let request = serde_json::to_string(document).map_err(|e| e.to_string())?;
        writeln!(self.stdin, "{request}").map_err(|e| format!("write to node: {e}"))?;
        self.stdin
            .flush()
            .map_err(|e| format!("flush to node: {e}"))?;
        let mut line = String::new();
        let read = self
            .stdout
            .read_line(&mut line)
            .map_err(|e| format!("read from node: {e}"))?;
        if read == 0 {
            return Err("node closed its stdout".to_owned());
        }
        let reply: serde_json::Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        let field = |name: &str| {
            reply[name]
                .as_str()
                .map(str::to_owned)
                .ok_or(format!("node reply without `{name}`: {line}"))
        };
        Ok(Answer {
            compact: field("compact")?,
            indent: field("indent")?,
        })
    }
}

fn node() -> &'static Mutex<Result<Node, String>> {
    static NODE: OnceLock<Mutex<Result<Node, String>>> = OnceLock::new();
    NODE.get_or_init(|| Mutex::new(Node::start()))
}

fn ask_node(document: &str) -> Result<Answer, String> {
    let mut guard = node()
        .lock()
        .map_err(|_| "node mutex poisoned".to_owned())?;
    match guard.as_mut() {
        Ok(node) => node.ask(document),
        Err(error) => Err(error.clone()),
    }
}

/// JSON text of a string using only ASCII: every other UTF-16 unit as `\uXXXX`.
fn write_literal(text: &JsString, out: &mut String) {
    out.push('"');
    for unit in text.units() {
        match unit {
            0x22 => out.push_str("\\\""),
            0x5c => out.push_str("\\\\"),
            0x20..=0x7e => out.push(char::from(u8::try_from(*unit).unwrap_or(b'?'))),
            other => {
                // Writing to a String cannot fail.
                let _ = write!(out, "\\u{other:04x}");
            }
        }
    }
    out.push('"');
}

/// The document text of a generated value, numbers with enough digits to round-trip.
fn to_document(value: &JsValue, out: &mut String) {
    match value {
        // Generators never produce `undefined`: it has no JSON text.
        JsValue::Undefined | JsValue::Null => out.push_str("null"),
        JsValue::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JsValue::Number(n) => {
            let _ = write!(out, "{n}");
        }
        JsValue::String(s) => write_literal(s, out),
        JsValue::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                to_document(item, out);
            }
            out.push(']');
        }
        JsValue::Object(object) => {
            out.push('{');
            for (i, (key, member)) in object.entries().iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_literal(key, out);
                out.push(':');
                to_document(member, out);
            }
            out.push('}');
        }
    }
}

fn number() -> impl Strategy<Value = f64> {
    prop_oneof![
        proptest::num::f64::POSITIVE
            | proptest::num::f64::NEGATIVE
            | proptest::num::f64::NORMAL
            | proptest::num::f64::SUBNORMAL
            | proptest::num::f64::ZERO,
        (-100_000i64..100_000).prop_map(|i| i as f64),
        (-8i32..30).prop_map(|e| 10f64.powi(e)),
        (0u64..(1 << 53)).prop_map(|i| i as f64),
        Just(-0.0),
        Just(1.0),
        Just(1e21),
        Just(1e-7),
        Just(5e-324),
        Just(f64::MAX),
        Just(f64::MIN_POSITIVE),
    ]
}

fn js_string() -> impl Strategy<Value = JsString> {
    // Any u16 includes lone surrogates; the ASCII arm keeps escapes and plain text common.
    prop::collection::vec(
        prop_oneof![0u16..0x80, any::<u16>(), 0x2020u16..0x2030],
        0..10,
    )
    .prop_map(JsString::from_units)
}

fn key() -> impl Strategy<Value = JsString> {
    prop_oneof![
        // array indices, with and without leading zeros and around the 2^32 - 1 boundary
        "[0-9]{1,10}".prop_map(JsString::from),
        (0u64..5_000_000_000).prop_map(|n| JsString::from(n.to_string())),
        "[a-z]{1,3}".prop_map(JsString::from),
        js_string(),
    ]
}

fn value() -> impl Strategy<Value = JsValue> {
    let leaf = prop_oneof![
        Just(JsValue::Null),
        any::<bool>().prop_map(JsValue::Bool),
        number().prop_map(JsValue::Number),
        js_string().prop_map(JsValue::String),
    ];
    leaf.prop_recursive(4, 48, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(JsValue::Array),
            prop::collection::vec((key(), inner), 0..6).prop_map(|pairs| {
                let mut object = JsObject::new();
                for (k, v) in pairs {
                    object.insert(k, v);
                }
                JsValue::Object(object)
            }),
        ]
    })
}

fn fail(message: String) -> TestCaseError {
    TestCaseError::fail(message)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 512, failure_persistence: None, ..ProptestConfig::default() })]

    // Covers: R9
    #[test]
    fn js_json_coincide_con_json_stringify_en_valores_generados(generated in value()) {
        let mut document = String::new();
        to_document(&generated, &mut document);
        let node = ask_node(&document).map_err(fail)?;
        let compact = generated.stringify(None).ok_or_else(|| fail("no output".to_owned()))?;
        let indent = generated.stringify(Some(2)).ok_or_else(|| fail("no output".to_owned()))?;
        prop_assert_eq!(&compact, &node.compact, "compact, document: {}", document);
        prop_assert_eq!(&indent, &node.indent, "indent, document: {}", document);
    }
}

// Covers: R9
#[test]
fn js_json_coincide_con_node_en_casos_conocidos() -> Result<(), String> {
    let mut object = JsObject::new();
    for (key, member) in [
        ("b", JsValue::Number(1.0)),
        ("10", JsValue::Number(-0.0)),
        ("a", JsValue::Number(1e21)),
        ("2", JsValue::Number(1e-7)),
        ("01", JsValue::Number(5e-324)),
        ("4294967295", JsValue::Number(f64::MAX)),
        ("__proto__", JsValue::Null),
    ] {
        object.insert(key, member);
    }
    let known = [
        JsValue::Object(object),
        JsValue::Array(vec![
            JsValue::String(JsString::from_units(vec![
                0xd800, 0x2028, 0x2029, 0x7f, 0x1f,
            ])),
            JsValue::string("\u{1f600} \"quoted\" \\ back\nslash"),
            JsValue::Array(vec![]),
            JsValue::Object(JsObject::new()),
        ]),
        JsValue::Number(123_456_789_012_345_680_000.0),
    ];
    for generated in known {
        let mut document = String::new();
        to_document(&generated, &mut document);
        let node = ask_node(&document)?;
        assert_eq!(generated.stringify(None), Some(node.compact), "{document}");
        assert_eq!(
            generated.stringify(Some(2)),
            Some(node.indent),
            "{document}"
        );
    }
    Ok(())
}
