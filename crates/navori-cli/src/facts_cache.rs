//! Host-fact cache for the eligibility planner (spec 0057 R17).
//!
//! Probing the host costs one process per fact (~150–250 ms on macOS). The cache keeps the raw
//! probe outputs of an eligible host and replays them while nothing they depend on changed:
//! the resolved Bash and every discovered tool (same `PATH` resolution, same inode, size and
//! timestamps), the `PATH` and locale variables, and a 24 h age bound. Replayed facts still go
//! through the pure planner, so the cache can only skip processes, never validation.
//!
//! Storage is project-local under `.navori/state/rust-facts/`: a private directory (0700) of
//! private files (0600) written with exclusive create + rename. Symlinked or group/other-writable
//! locations are ignored and never written. Any doubt is a miss, and a miss probes the host.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use navori_hooks::hooks::subagent_no_background::prepare::{Discovery, Facts, Output, Tool};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// Replayed facts never outlive this age, even when no stamp changed.
pub const MAX_AGE_MS: u64 = 24 * 60 * 60 * 1000;
/// A cache entry is a few KiB; anything larger is not ours.
const MAX_ENTRY_BYTES: u64 = 256 * 1024;
const SCHEMA: u64 = 1;

/// Project-local cache directory.
pub struct FactsCache {
    root: PathBuf,
}

/// Facts read back from a valid entry, with the tool stamps they were observed with.
pub struct Cached {
    /// Raw probe outputs, replayed into the planner.
    pub facts: Facts,
    /// Tool name → stamp of its canonical path, or `None` when the tool was absent.
    pub tools: BTreeMap<String, Option<String>>,
}

impl FactsCache {
    /// Cache owned by the project at `root` (the directory holding `.navori/`).
    #[must_use]
    pub fn in_project(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
        }
    }

    fn directory(&self) -> PathBuf {
        self.root.join(".navori/state/rust-facts")
    }

    /// The `.navori` and `.navori/state` ancestors must be real directories, never symlinks.
    fn ancestors_are_real(&self) -> bool {
        [".navori", ".navori/state"].iter().all(|part| {
            fs::symlink_metadata(self.root.join(part)).is_ok_and(|meta| meta.file_type().is_dir())
        })
    }

    /// Read a fresh, private entry for `key`; any anomaly is a miss.
    #[must_use]
    pub fn load(&self, key: &str, now_ms: u64) -> Option<Cached> {
        let text = self.read_entry(&format!("{key}.json"))?;
        decode(&serde_json::from_str(&text).ok()?, key, now_ms)
    }

    /// The text of the private entry `file`; any anomaly (a symlinked ancestor, a loose mode, a
    /// swapped or oversized file) is a miss.
    fn read_entry(&self, file: &str) -> Option<String> {
        if !self.ancestors_are_real() {
            return None;
        }
        let directory = self.directory();
        if !private(&fs::symlink_metadata(&directory).ok()?, true) {
            return None;
        }
        let path = directory.join(file);
        let before = fs::symlink_metadata(&path).ok()?;
        if !before.file_type().is_file() || !private(&before, false) {
            return None;
        }
        let mut file = File::open(&path).ok()?;
        let opened = file.metadata().ok()?;
        // The opened file must be the one inspected, and small.
        if (opened.dev(), opened.ino()) != (before.dev(), before.ino())
            || opened.len() > MAX_ENTRY_BYTES
        {
            return None;
        }
        let mut text = String::new();
        file.read_to_string(&mut text).ok()?;
        Some(text)
    }

    /// The version a `navori` binary printed, replayed while that exact binary (the `key` of
    /// [`navori_cli_key`]) stays unchanged and the entry is fresh (0059 D30).
    #[must_use]
    pub fn load_navori_cli(&self, key: &str, now_ms: u64) -> Option<String> {
        let value: Value = serde_json::from_str(&self.read_entry(&navori_cli_file(key))?).ok()?;
        if value.get("schema")?.as_u64()? != SCHEMA || value.get("key")?.as_str()? != key {
            return None;
        }
        let created = value.get("createdMs")?.as_u64()?;
        if created > now_ms || now_ms - created > MAX_AGE_MS {
            return None;
        }
        Some(value.get("version")?.as_str()?.to_owned())
    }

    /// Persist the version a `navori` binary printed. Best effort, like [`FactsCache::store`].
    pub fn store_navori_cli(&self, key: &str, version: &str, now_ms: u64) {
        let body = json!({
            "schema": SCHEMA,
            "key": key,
            "createdMs": now_ms,
            "version": version,
        })
        .to_string();
        self.write_entry(&navori_cli_file(key), &body);
    }

    /// Persist an eligible host's facts. Best effort: failures leave no partial entry.
    pub fn store(
        &self,
        key: &str,
        facts: &Facts,
        tools: &BTreeMap<String, Option<String>>,
        now_ms: u64,
    ) {
        let body = encode(key, facts, tools, now_ms).to_string();
        self.write_entry(&format!("{key}.json"), &body);
    }

    /// Create the private directory when needed and write `file` with exclusive create + rename.
    /// Best effort: a failure leaves no partial entry.
    fn write_entry(&self, file: &str, body: &str) {
        let directory = self.directory();
        if fs::create_dir_all(directory.parent().unwrap_or(&self.root)).is_err()
            || !self.ancestors_are_real()
        {
            return;
        }
        if !directory.exists() && DirBuilder::new().mode(0o700).create(&directory).is_err() {
            return;
        }
        if !fs::symlink_metadata(&directory).is_ok_and(|meta| private(&meta, true)) {
            return;
        }
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.subsec_nanos());
        let temporary = directory.join(format!(".{file}.{}.{nanos}.tmp", std::process::id()));
        let written = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)
            .and_then(|mut file| file.write_all(body.as_bytes()));
        if written.is_err() || fs::rename(&temporary, directory.join(file)).is_err() {
            let _ = fs::remove_file(&temporary);
        }
    }
}

/// File of the `navori` version entry for `key`; the prefix keeps it apart from the facts entries.
fn navori_cli_file(key: &str) -> String {
    format!("navori-cli-{key}.json")
}

/// Cache key of the `navori` the `PATH` resolves: its canonical path and its [`stamp`] (device,
/// inode, size and timestamps), so the version probe repeats only when the binary changes. `None`
/// when the binary cannot be identified.
#[must_use]
pub fn navori_cli_key(binary: &Path) -> Option<String> {
    let canonical = binary.canonicalize().ok()?;
    let mut hash = Sha256::new();
    hash.update(b"navori-rust navori-cli v1\0");
    hash.update(canonical.as_os_str().as_bytes());
    hash.update(b"\0");
    hash.update(stamp(&canonical)?.as_bytes());
    Some(
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

/// Owned by nobody else's write: no group/other write bit, and the expected file type.
fn private(meta: &fs::Metadata, directory: bool) -> bool {
    let kind = if directory {
        meta.file_type().is_dir()
    } else {
        meta.file_type().is_file()
    };
    kind && meta.permissions().mode() & 0o022 == 0
}

/// Identity of an executable: device, inode, size and both timestamps with nanoseconds.
#[must_use]
pub fn stamp(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    Some(format!(
        "{}:{}:{}:{}.{}:{}.{}",
        meta.dev(),
        meta.ino(),
        meta.len(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec()
    ))
}

/// Cache key over everything the probes see that the tool stamps do not: the resolved Bash and
/// its stamp, `PATH`, the locale variables and `POSIXLY_CORRECT`. `None` disables the cache
/// (relative `PATH` entries depend on the working directory).
#[must_use]
pub fn key(bash: &Path, env: &[(OsString, OsString)]) -> Option<String> {
    let path = env_last(env, "PATH")?;
    if std::env::split_paths(path).any(|entry| !entry.is_absolute()) {
        return None;
    }
    let mut hash = Sha256::new();
    hash.update(b"navori-rust-facts v1\0");
    hash.update(bash.as_os_str().as_bytes());
    hash.update(b"\0");
    hash.update(stamp(bash)?.as_bytes());
    hash.update(b"\0");
    let mut relevant: BTreeMap<&[u8], &[u8]> = BTreeMap::new();
    for (name, value) in env {
        let name = name.as_bytes();
        if name == b"PATH"
            || name == b"LANG"
            || name == b"POSIXLY_CORRECT"
            || name.starts_with(b"LC_")
        {
            relevant.insert(name, value.as_bytes());
        }
    }
    for (name, value) in relevant {
        hash.update(name);
        hash.update(b"=");
        hash.update(value);
        hash.update(b"\0");
    }
    Some(
        hash.finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
    )
}

fn env_last<'a>(env: &'a [(OsString, OsString)], name: &str) -> Option<&'a OsStr> {
    env.iter()
        .rev()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_os_str())
}

/// First executable `name` along an absolute `PATH`, as Bash's `command -v` would print it.
#[must_use]
pub fn lookup(path: &OsStr, name: &str) -> Option<PathBuf> {
    std::env::split_paths(path)
        .map(|directory| directory.join(name))
        .find(|candidate| {
            fs::metadata(candidate)
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
}

/// Stamps of every discovered tool, keyed by name; absent tools map to `None`.
#[must_use]
pub fn tool_stamps(discovery: &Discovery) -> Option<BTreeMap<String, Option<String>>> {
    Tool::ALL
        .iter()
        .map(|tool| {
            let found = discovery.tools.get(tool)?;
            let value = match found {
                Some(path) => Some(stamp(&path.canonicalize().ok()?)?),
                None => None,
            };
            Some((tool.name().to_owned(), value))
        })
        .collect()
}

/// Whether the host still resolves and identifies every tool as when the facts were cached.
#[must_use]
pub fn tools_unchanged(
    discovery: &Discovery,
    path: &OsStr,
    cached: &BTreeMap<String, Option<String>>,
) -> bool {
    tool_stamps(discovery).as_ref() == Some(cached)
        && Tool::ALL.iter().all(|tool| {
            discovery
                .tools
                .get(tool)
                .is_some_and(|found| found.as_deref() == lookup(path, tool.name()).as_deref())
        })
}

fn output_json(output: &Output) -> Value {
    json!({ "code": output.code, "stdout": output.stdout, "stderr": output.stderr })
}

fn output_from(value: &Value) -> Option<Output> {
    let bytes = |field: &str| -> Option<Vec<u8>> {
        value
            .get(field)?
            .as_array()?
            .iter()
            .map(|byte| u8::try_from(byte.as_u64()?).ok())
            .collect()
    };
    let code = match value.get("code")? {
        Value::Null => None,
        code => Some(i32::try_from(code.as_i64()?).ok()?),
    };
    Some(Output {
        code,
        stdout: bytes("stdout")?,
        stderr: bytes("stderr")?,
    })
}

fn encode(
    key: &str,
    facts: &Facts,
    tools: &BTreeMap<String, Option<String>>,
    now_ms: u64,
) -> Value {
    json!({
        "schema": SCHEMA,
        "key": key,
        "createdMs": now_ms,
        "tools": tools,
        "facts": {
            "bootstrap": output_json(&facts.bootstrap),
            "system": output_json(&facts.system),
            "charmap": output_json(&facts.charmap),
            "text": output_json(&facts.text),
            "jq": facts.jq.as_ref().map(output_json),
            "node": facts.node.as_ref().map(output_json),
        },
    })
}

fn decode(value: &Value, key: &str, now_ms: u64) -> Option<Cached> {
    if value.get("schema")?.as_u64()? != SCHEMA || value.get("key")?.as_str()? != key {
        return None;
    }
    let created = value.get("createdMs")?.as_u64()?;
    if created > now_ms || now_ms - created > MAX_AGE_MS {
        return None;
    }
    let facts = value.get("facts")?;
    let optional = |field: &str| -> Option<Option<Output>> {
        match facts.get(field)? {
            Value::Null => Some(None),
            output => output_from(output).map(Some),
        }
    };
    let tools = value
        .get("tools")?
        .as_object()?
        .iter()
        .map(|(name, stamp)| {
            let stamp = match stamp {
                Value::Null => None,
                Value::String(stamp) => Some(stamp.clone()),
                _ => return None,
            };
            Some((name.clone(), stamp))
        })
        .collect::<Option<BTreeMap<_, _>>>()?;
    Some(Cached {
        facts: Facts {
            bootstrap: output_from(facts.get("bootstrap")?)?,
            system: output_from(facts.get("system")?)?,
            charmap: output_from(facts.get("charmap")?)?,
            text: output_from(facts.get("text")?)?,
            jq: optional("jq")?,
            node: optional("node")?,
        },
        tools,
    })
}

/// Milliseconds since the epoch, or `None` when the clock is before it.
#[must_use]
pub fn now_ms() -> Option<u64> {
    u64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_millis(),
    )
    .ok()
}
