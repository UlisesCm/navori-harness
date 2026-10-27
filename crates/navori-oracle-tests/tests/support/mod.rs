//! One persistent Node process per test binary that imports the real TS modules (Node 24 strips
//! types natively) and answers one JSON request per line with one JSON reply per line.

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde_json::Value;

/// Absolute path of a file under `packages/cli/src`, as a `file://` URL for `import()`.
#[must_use]
pub fn cli_module(relative: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/cli/src")
        .join(relative);
    let absolute = path.canonicalize().unwrap_or(path);
    format!("file://{}", absolute.display())
}

/// Running bridge. `handler` is the body of `async (request) => reply` in the generated script.
pub struct Bridge {
    // Held so the child lives as long as the bridge; closing stdin makes it exit.
    _child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Bridge {
    /// Starts `node` with `prelude` (imports) and a request handler body.
    ///
    /// # Errors
    /// Fails when `node` cannot be spawned.
    pub fn start(prelude: &str, handler: &str) -> Result<Self, String> {
        let script = format!(
            "{prelude}\nconst handle = async (request) => {{ {handler} }};\n\
             const rl = (await import('node:readline')).createInterface({{ input: process.stdin, terminal: false }});\n\
             for await (const line of rl) {{\n\
               let reply;\n\
               try {{ reply = {{ ok: await handle(JSON.parse(line)) }}; }}\n\
               catch (error) {{ reply = {{ error: String(error && error.message || error) }}; }}\n\
               process.stdout.write(JSON.stringify(reply) + '\\n');\n\
             }}\n"
        );
        let mut child = Command::new("node")
            .args(["--input-type=module", "--no-warnings", "-e", &script])
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

    /// Sends one request and returns the handler's value.
    ///
    /// # Errors
    /// Fails on transport errors or when the handler threw.
    pub fn ask(&mut self, request: &Value) -> Result<Value, String> {
        // Node's readline also breaks lines on U+2028/U+2029, which serde_json leaves raw; escape
        // them in the transport only, never in the data.
        let line = request
            .to_string()
            .replace('\u{2028}', "\\u2028")
            .replace('\u{2029}', "\\u2029");
        writeln!(self.stdin, "{line}").map_err(|e| format!("write to node: {e}"))?;
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
        let mut reply: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
        if let Some(error) = reply.get("error") {
            return Err(format!("node handler failed: {error}"));
        }
        Ok(reply["ok"].take())
    }
}

/// Process-wide bridge, created on first use.
pub struct Shared {
    cell: OnceLock<Mutex<Result<Bridge, String>>>,
    prelude: fn() -> String,
    handler: &'static str,
}

impl Shared {
    /// Declares a lazily started bridge.
    #[must_use]
    pub const fn new(prelude: fn() -> String, handler: &'static str) -> Self {
        Self {
            cell: OnceLock::new(),
            prelude,
            handler,
        }
    }

    /// Sends one request through the shared bridge.
    ///
    /// # Errors
    /// Fails when the bridge could not start or the request failed.
    pub fn ask(&self, request: &Value) -> Result<Value, String> {
        let mutex = self
            .cell
            .get_or_init(|| Mutex::new(Bridge::start(&(self.prelude)(), self.handler)));
        let mut guard = mutex.lock().map_err(|_| "node mutex poisoned".to_owned())?;
        match guard.as_mut() {
            Ok(bridge) => bridge.ask(request),
            Err(error) => Err(error.clone()),
        }
    }
}
