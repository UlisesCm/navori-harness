//! The `Fs` layer against the real `writeFileAtomic` (spec 0058 T21, D24): the step order on disk,
//! the modes Node leaves under umask `022` and `077`, the messages of real failures and the
//! cleanup after an injected one.

use std::error::Error;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

use navori_core::fs::fault::{FaultFs, Kind};
use navori_core::fs::{Op, RealFs, write_file_atomic};

type TestResult = Result<(), Box<dyn Error>>;

/// Set in the child run of [`umask_child`]: the directory it writes into.
const CHILD_DIR: &str = "NAVORI_FS_TEST_CHILD_DIR";

struct TempDir(PathBuf);

impl TempDir {
    fn new(label: &str) -> Result<Self, Box<dyn Error>> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "navori-rust-fs-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path)?;
        Ok(Self(fs::canonicalize(path)?))
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // Read-only fixtures must be writable again before they can go.
        let _ = fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700));
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn atomic_ts() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/cli/src/lib/primitives/atomic.ts");
    format!(
        "file://{}",
        fs::canonicalize(&path).unwrap_or(path).display()
    )
}

/// `writeFileAtomic(dest, content)` in Node under `umask`: `ok`, or the thrown message.
fn node_write(dest: &Path, content: &str, umask: &str) -> Result<String, Box<dyn Error>> {
    let script = format!(
        "const {{ writeFileAtomic }} = await import({:?});\n\
         try {{ writeFileAtomic(process.env.NAVORI_DEST, process.env.NAVORI_CONTENT); console.log('ok'); }}\n\
         catch (error) {{ console.log(error.message); }}",
        atomic_ts()
    );
    let out = Command::new("sh")
        .args(["-c", &format!("umask {umask}; exec \"$0\" \"$@\""), "node"])
        .args(["--input-type=module", "--no-warnings", "-e", &script])
        .env("NAVORI_DEST", dest)
        .env("NAVORI_CONTENT", content)
        .output()?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned().into());
    }
    Ok(String::from_utf8(out.stdout)?.trim_end().to_owned())
}

/// The Rust side of [`node_write`], on [`RealFs`].
fn rust_write(dest: &Path, content: &str) -> String {
    match write_file_atomic(&mut RealFs::default(), dest, content) {
        Ok(()) => "ok".to_owned(),
        Err(error) => error.message,
    }
}

/// Masks the random part of a temporary's name.
fn mask(text: &str) -> String {
    let marker = ".navori.tmp.";
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find(marker) {
        let end = at + marker.len();
        out.push_str(&rest[..end]);
        out.push_str("<hex>");
        rest = rest.get(end + 12..).unwrap_or_default();
    }
    out.push_str(rest);
    out
}

/// Names of the leftover temporaries in `dir`.
fn temporaries(dir: &Path) -> Result<Vec<String>, Box<dyn Error>> {
    let mut found = Vec::new();
    for entry in fs::read_dir(dir)? {
        let name = entry?.file_name().to_string_lossy().into_owned();
        if name.contains(".navori.tmp.") {
            found.push(name);
        }
    }
    Ok(found)
}

fn mode(path: &Path) -> Result<u32, Box<dyn Error>> {
    Ok(fs::metadata(path)?.permissions().mode() & 0o7777)
}

/// The child half of the umask test: writes `new` and over `existing` under the umask its parent
/// set, recording the steps; a no-op in a normal run.
#[test]
fn umask_child() -> TestResult {
    let Some(dir) = std::env::var_os(CHILD_DIR).map(PathBuf::from) else {
        return Ok(());
    };
    for name in ["new", "existing"] {
        let dest = dir.join(name);
        let mut fs = FaultFs::new(RealFs::default(), None);
        write_file_atomic(&mut fs, &dest, "body\n").map_err(|e| e.message)?;
        let kinds: Vec<Kind> = fs.trace.iter().map(Kind::of).collect();
        if kinds
            != [
                Kind::Create,
                Kind::Write,
                Kind::Fsync,
                Kind::Close,
                Kind::Rename,
            ]
        {
            return Err(format!("{name}: steps {kinds:?}").into());
        }
        let Some(Op::Rename { from, to }) = fs.trace.last() else {
            return Err("no rename".into());
        };
        if from.parent() != Some(dir.as_path()) || *to != dest {
            return Err(format!("{name}: renamed {from:?} -> {to:?}").into());
        }
    }
    Ok(())
}

// Covers: R43
#[test]
fn every_rename_follows_fsync_and_modes_match_node_under_umask_022_and_077() -> TestResult {
    for umask in ["022", "077"] {
        let root = TempDir::new("umask")?;
        let (rust, node) = (root.0.join("rust"), root.0.join("node"));
        for side in [&rust, &node] {
            fs::create_dir(side)?;
            // An existing file keeps neither its mode nor its bytes: rename replaces it.
            fs::write(side.join("existing"), "old\n")?;
            fs::set_permissions(side.join("existing"), fs::Permissions::from_mode(0o755))?;
        }
        let child = Command::new("sh")
            .args(["-c", &format!("umask {umask}; exec \"$0\" \"$@\"")])
            .arg(std::env::current_exe()?)
            .args(["umask_child", "--exact", "--test-threads=1"])
            .env(CHILD_DIR, &rust)
            .output()?;
        if !child.status.success() {
            return Err(format!(
                "umask {umask}: child failed\n{}",
                String::from_utf8_lossy(&child.stdout)
            )
            .into());
        }
        for name in ["new", "existing"] {
            assert_eq!(node_write(&node.join(name), "body\n", umask)?, "ok");
            assert_eq!(
                (mode(&rust.join(name))?, fs::read(rust.join(name))?),
                (mode(&node.join(name))?, fs::read(node.join(name))?),
                "umask {umask}, {name}"
            );
        }
        assert_eq!(temporaries(&rust)?, Vec::<String>::new());
    }
    Ok(())
}

// Covers: R43
#[test]
fn real_failures_report_nodes_message_and_leave_no_temporary() -> TestResult {
    let root = TempDir::new("errors")?;
    let dir = &root.0;
    fs::write(dir.join("file"), "plain\n")?;
    fs::create_dir(dir.join("taken"))?;
    fs::create_dir(dir.join("locked"))?;
    fs::write(dir.join("locked/kept"), "mine\n")?;
    fs::set_permissions(dir.join("locked"), fs::Permissions::from_mode(0o555))?;
    let mut cases = vec![
        // ENOENT: the parent directory does not exist.
        dir.join("missing/x.json"),
        // EISDIR: the rename lands on a directory.
        dir.join("taken"),
        // ENOTDIR: a path component is a file (Node's own message, with the temporary).
        dir.join("file/x.json"),
    ];
    // EACCES, unless this user can write a read-only directory (root).
    if fs::write(dir.join("locked/probe"), "").is_err() {
        cases.push(dir.join("locked/kept"));
    }
    for dest in cases {
        let rust = rust_write(&dest, "new\n");
        let node = node_write(&dest, "new\n", "022")?;
        assert_ne!(rust, "ok", "{}", dest.display());
        assert_eq!(mask(&rust), mask(&node), "{}", dest.display());
        if let Some(parent) = dest.parent().filter(|p| p.is_dir()) {
            assert_eq!(temporaries(parent)?, Vec::<String>::new());
        }
    }
    assert_eq!(fs::read_to_string(dir.join("locked/kept"))?, "mine\n");
    Ok(())
}

// Covers: R43
#[test]
fn an_injected_failure_at_any_step_keeps_the_original_and_removes_the_temporary() -> TestResult {
    const EIO: i32 = 5;
    let root = TempDir::new("faults")?;
    let dest = root.0.join("CLAUDE.md");
    for (kind, expected) in [
        (Kind::Create, "EIO: i/o error, open '<tmp>'"),
        (Kind::Write, "EIO: i/o error, write"),
        (Kind::Fsync, "EIO: i/o error, fsync"),
        (Kind::Close, "EIO: i/o error, close"),
        (Kind::Rename, "EIO: i/o error, rename '<tmp>' -> '<dest>'"),
    ] {
        fs::write(&dest, "original\n")?;
        let mut fs = FaultFs::new(RealFs::default(), Some((kind, 0, EIO)));
        let Err(error) = write_file_atomic(&mut fs, &dest, "replacement\n") else {
            return Err(format!("{kind:?}: no failure").into());
        };
        let Some(Op::Create { path: tmp, .. }) = fs.trace.first().cloned() else {
            return Err(format!("{kind:?}: no create").into());
        };
        let expected = expected
            .replace("<tmp>", &tmp.display().to_string())
            .replace("<dest>", &dest.display().to_string());
        assert_eq!(error.message, expected, "{kind:?}");
        assert_eq!(fs::read_to_string(&dest)?, "original\n", "{kind:?}");
        assert_eq!(temporaries(&root.0)?, Vec::<String>::new(), "{kind:?}");
        assert_eq!(
            fs.trace.last(),
            Some(&Op::Remove {
                path: tmp,
                recursive: false
            }),
            "{kind:?}"
        );
    }
    Ok(())
}
