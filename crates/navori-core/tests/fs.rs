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

// --- backup ---------------------------------------------------------------------------------

/// Set in the child run of [`zone_child`]: epoch milliseconds, comma-separated.
const CHILD_EPOCHS: &str = "NAVORI_FS_TEST_CHILD_EPOCHS";

fn backup_ts() -> String {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/cli/src/lib/render/backup.ts");
    format!(
        "file://{}",
        fs::canonicalize(&path).unwrap_or(path).display()
    )
}

fn json_list<S: AsRef<str>>(items: &[S]) -> String {
    let quoted: Vec<String> = items.iter().map(|p| format!("{:?}", p.as_ref())).collect();
    format!("[{}]", quoted.join(","))
}

/// The child half of the zone test: each epoch as `timestamp()` prints it in the system zone of
/// this process (`TZ` set by the parent); a no-op in a normal run.
#[test]
fn zone_child() -> TestResult {
    let Some(epochs) = std::env::var_os(CHILD_EPOCHS) else {
        return Ok(());
    };
    let zone = jiff::tz::TimeZone::system();
    for epoch in epochs.to_string_lossy().split(',') {
        let at = jiff::Timestamp::from_millisecond(epoch.parse()?)?.to_zoned(zone.clone());
        println!("ZONE {}", navori_core::backup::timestamp(&at, 7));
    }
    Ok(())
}

// Covers: R44
#[test]
fn backup_names_use_the_local_time_node_reads_from_tz() -> TestResult {
    // Plain, DST edges (Mexico City until 2022, Sao Paulo, Lord Howe's half hour), half-hour
    // offsets, a leap day and millisecond padding.
    let epochs =
        "0,1667109599999,1667109600000,1554001199000,1582934400007,1704067199999,1712500000123";
    for tz in [
        "UTC",
        "America/Mexico_City",
        "America/Sao_Paulo",
        "Asia/Kolkata",
        "Australia/Lord_Howe",
        "Pacific/Chatham",
    ] {
        let child = Command::new(std::env::current_exe()?)
            .args(["zone_child", "--exact", "--nocapture", "--test-threads=1"])
            .env(CHILD_EPOCHS, epochs)
            .env("TZ", tz)
            .output()?;
        let rust: Vec<String> = String::from_utf8(child.stdout)?
            .lines()
            // The first line may share its row with libtest's `test zone_child ... `.
            .filter_map(|l| l.split("ZONE ").nth(1).map(str::to_owned))
            .collect();
        let script = "const pad = (n, w = 2) => String(n).padStart(w, '0');\n\
             for (const ms of process.env.EPOCHS.split(',')) {\n\
               const d = new Date(Number(ms));\n\
               console.log(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +\n\
                 `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}` +\n\
                 `-${pad(d.getMilliseconds(), 3)}-p7`);\n\
             }";
        let node = Command::new("node")
            .args(["-e", script])
            .env("EPOCHS", epochs)
            .env("TZ", tz)
            .output()?;
        let node: Vec<String> = String::from_utf8(node.stdout)?
            .lines()
            .map(str::to_owned)
            .collect();
        assert_eq!(rust.len(), 7, "{tz}: {rust:?}");
        assert_eq!(rust, node, "{tz}");
    }
    Ok(())
}

/// A repo with nested files, a symlink to a file and one to a directory (both followed by
/// `statSync`), a dangling link, an excluded subtree and a mode to keep.
fn backup_fixture(repo: &Path) -> TestResult {
    fs::create_dir_all(repo.join("dir/sub"))?;
    fs::create_dir_all(repo.join(".claude/worktrees/w"))?;
    fs::write(repo.join("a.txt"), "a\n")?;
    fs::set_permissions(repo.join("a.txt"), fs::Permissions::from_mode(0o755))?;
    fs::write(repo.join("dir/b.txt"), "b\n")?;
    fs::write(repo.join("dir/sub/c.txt"), "c\n")?;
    fs::write(repo.join(".claude/settings.json"), "{}\n")?;
    fs::write(repo.join(".claude/worktrees/w/big"), "x\n")?;
    std::os::unix::fs::symlink("../a.txt", repo.join("dir/link-file"))?;
    std::os::unix::fs::symlink("sub", repo.join("dir/link-dir"))?;
    std::os::unix::fs::symlink("nowhere", repo.join("broken"))?;
    Ok(())
}

/// A file of a [`tree`]: relative path, mode and bytes.
type Entry = (String, u32, Vec<u8>);

/// Every file under `dir`, sorted.
fn tree(dir: &Path) -> Result<Vec<Entry>, Box<dyn Error>> {
    fn walk(base: &Path, dir: &Path, out: &mut Vec<Entry>) -> TestResult {
        for entry in fs::read_dir(dir)? {
            let path = entry?.path();
            let meta = fs::symlink_metadata(&path)?;
            if meta.is_dir() {
                walk(base, &path, out)?;
            } else {
                let rel = path.strip_prefix(base)?.to_string_lossy().into_owned();
                out.push((rel, meta.permissions().mode() & 0o7777, fs::read(&path)?));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    walk(dir, dir, &mut out)?;
    out.sort();
    Ok(out)
}

// Covers: R44
#[test]
fn a_backup_copies_what_create_backup_copies() -> TestResult {
    let root = TempDir::new("backup")?;
    let repo = root.0.join("my repo");
    backup_fixture(&repo)?;
    let paths = ["a.txt", "dir", ".claude", "nope", "broken"];
    let exclude = [".claude/worktrees/", ".navori/state/"];

    let script = format!(
        "const {{ createBackup }} = await import({:?});\n\
         const h = createBackup(process.env.REPO, JSON.parse(process.env.PATHS), {{ exclude: JSON.parse(process.env.EXCLUDE) }});\n\
         console.log(JSON.stringify(h.files));",
        backup_ts()
    );
    let out = Command::new("node")
        .args(["--input-type=module", "--no-warnings", "-e", &script])
        .env("REPO", &repo)
        .env("PATHS", json_list(&paths))
        .env("EXCLUDE", json_list(&exclude))
        .env("NAVORI_BACKUP_ROOT", root.0.join("node-store"))
        .output()?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned().into());
    }
    let node_files = String::from_utf8(out.stdout)?.trim_end().to_owned();

    let mut store = navori_core::backup::BackupStore::new(root.0.join("rust-store"), 4242);
    let paths: Vec<String> = paths.iter().map(|p| (*p).to_owned()).collect();
    let now = navori_core::backup::local_now();
    let handle = store
        .create(&mut RealFs::default(), &repo, &paths, &exclude, &now)
        .map_err(|e| e.message)?;
    let name = handle
        .path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let shape = regex::Regex::new(r"^my-repo-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-p4242-0$")?;
    assert!(shape.is_match(&name), "{name}");
    assert_eq!(json_list(&handle.files), node_files);
    let node_dir = fs::read_dir(root.0.join("node-store"))?
        .next()
        .ok_or("no node backup")??
        .path();
    assert_eq!(tree(&handle.path)?, tree(&node_dir)?);
    // A second backup in the same process takes the next sequence number.
    let again = store
        .create(&mut RealFs::default(), &repo, &[], &exclude, &now)
        .map_err(|e| e.message)?;
    assert!(again.path.to_string_lossy().ends_with("-p4242-1"));
    assert_eq!(again.files, Vec::<String>::new());
    Ok(())
}

// --- purge ----------------------------------------------------------------------------------

const DAY: u64 = 24 * 60 * 60;

/// A backup store: two backups past 30 days, four recent ones of 300, 200, 100 and 50 bytes (one
/// with a nested directory and a symlink to a file outside, followed when sized), a stray file
/// and a symlink to a backup, which `statSync` sees as a second backup with its mtime.
fn purge_fixture(store: &Path, outside: &Path) -> TestResult {
    let now = std::time::SystemTime::now();
    let dirs: [(&str, u64, usize); 6] = [
        ("old-a", 40, 10),
        ("old-b", 31, 10),
        ("r1", 20, 300),
        ("r2", 10, 200),
        ("r3", 5, 60),
        ("r4", 1, 50),
    ];
    for (name, _, bytes) in dirs {
        fs::create_dir_all(store.join(name).join("nested"))?;
        fs::write(store.join(name).join("nested/file"), vec![b'x'; bytes])?;
    }
    std::os::unix::fs::symlink(outside, store.join("r3/outside"))?;
    std::os::unix::fs::symlink("r2", store.join("link-to-r2"))?;
    fs::write(store.join("stray"), "not a backup\n")?;
    for (name, days, _) in dirs {
        let at = now - std::time::Duration::from_secs(days * DAY);
        fs::File::open(store.join(name))?.set_modified(at)?;
    }
    Ok(())
}

fn names(dir: &Path) -> Result<Vec<String>, Box<dyn Error>> {
    let mut out: Vec<String> = fs::read_dir(dir)?
        .map(|e| e.map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect::<Result<_, _>>()?;
    out.sort();
    Ok(out)
}

// Covers: R45
#[test]
fn purge_drops_30_day_old_backups_then_oldest_first_down_to_the_cap() -> TestResult {
    let root = TempDir::new("purge")?;
    let outside = root.0.join("outside");
    fs::write(&outside, vec![b'y'; 40])?;
    let (rust, node) = (root.0.join("rust"), root.0.join("node"));
    purge_fixture(&rust, &outside)?;
    purge_fixture(&node, &outside)?;

    let script = format!(
        "const {{ purgeOldBackups }} = await import({:?});\n\
         const pruned = purgeOldBackups({{ retentionDays: 30, maxTotalBytes: 400 }});\n\
         console.log(JSON.stringify(pruned.map((p) => p.split('/').at(-1))));",
        backup_ts()
    );
    let out = Command::new("node")
        .args(["--input-type=module", "--no-warnings", "-e", &script])
        .env("NAVORI_BACKUP_ROOT", &node)
        .output()?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned().into());
    }
    let node_pruned = String::from_utf8(out.stdout)?.trim_end().to_owned();

    #[allow(
        clippy::cast_precision_loss,
        reason = "`Date.now()` is a JS number of milliseconds"
    )]
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis() as f64;
    let pruned = navori_core::backup::purge_old_backups(
        &mut RealFs::default(),
        &rust,
        now_ms,
        navori_core::backup::RETENTION_DAYS,
        400,
    )
    .map_err(|e| e.message)?;
    let pruned: Vec<String> = pruned
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    // Age first, then r1 (oldest) and the link (r2's mtime, sorted before it by name).
    assert_eq!(json_list(&pruned), node_pruned);
    assert_eq!(pruned, ["old-a", "old-b", "r1", "link-to-r2"]);
    assert_eq!(names(&rust)?, names(&node)?);
    assert_eq!(
        fs::read(&outside)?.len(),
        40,
        "a followed symlink is never deleted through"
    );
    // A missing store is not an error.
    let missing = navori_core::backup::purge_old_backups(
        &mut RealFs::default(),
        &root.0.join("absent"),
        now_ms,
        30.0,
        0,
    )
    .map_err(|e| e.message)?;
    assert_eq!(missing, Vec::<std::path::PathBuf>::new());
    Ok(())
}
