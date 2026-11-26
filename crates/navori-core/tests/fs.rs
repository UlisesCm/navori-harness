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

    let mut store = navori_core::backup::BackupStore::new(Ok(root.0.join("rust-store")), 4242);
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
        ("old-a-2026-01-01T00-00-00-000-p1-0", 40, 10),
        ("old-b-2026-01-01T00-00-00-000-p1-1", 31, 10),
        ("r1-2026-01-01T00-00-00-000-p1-2", 20, 300),
        ("r2-2026-01-01T00-00-00-000-p1-3", 10, 200),
        ("r3-2026-01-01T00-00-00-000-p1-4", 5, 60),
        ("r4-2026-01-01T00-00-00-000-p1-5", 1, 50),
    ];
    for (name, _, bytes) in dirs {
        fs::create_dir_all(store.join(name).join("nested"))?;
        fs::write(store.join(name).join("nested/file"), vec![b'x'; bytes])?;
    }
    std::os::unix::fs::symlink(
        outside,
        store.join("r3-2026-01-01T00-00-00-000-p1-4/outside"),
    )?;
    std::os::unix::fs::symlink(
        "r2-2026-01-01T00-00-00-000-p1-3",
        store.join("link-2026-01-01T00-00-00-000-p1-9"),
    )?;
    fs::write(store.join("stray"), "not a backup\n")?;
    // Not navori's: a directory the root happens to hold, old enough for the age pass.
    fs::create_dir_all(store.join("my-project/src"))?;
    fs::write(store.join("my-project/src/main.rs"), "fn main() {}\n")?;
    let old = now - std::time::Duration::from_secs(400 * DAY);
    fs::File::open(store.join("my-project"))?.set_modified(old)?;
    for (name, days, _) in dirs {
        let at = now - std::time::Duration::from_secs(days * DAY);
        fs::File::open(store.join(name))?.set_modified(at)?;
    }
    Ok(())
}

/// The snapshot the purge must keep: the oldest recent one, first in line for the size pass.
const KEEP: &str = "r1-2026-01-01T00-00-00-000-p1-2";

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
         const pruned = purgeOldBackups({{ retentionDays: 30, maxTotalBytes: 400, keep: process.env.KEEP }});\n\
         console.log(JSON.stringify(pruned.map((p) => p.split('/').at(-1))));",
        backup_ts()
    );
    let out = Command::new("node")
        .args(["--input-type=module", "--no-warnings", "-e", &script])
        .env("NAVORI_BACKUP_ROOT", &node)
        .env("KEEP", node.join(KEEP))
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
        Some(&rust.join(KEEP)),
    )
    .map_err(|e| e.message)?;
    let pruned: Vec<String> = pruned
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .collect();
    // Age first, then oldest-first past the kept snapshot (r1, the oldest recent one); the
    // foreign directory and the kept snapshot survive both passes.
    assert_eq!(json_list(&pruned), node_pruned);
    assert_eq!(
        &pruned[..2],
        [
            "old-a-2026-01-01T00-00-00-000-p1-0",
            "old-b-2026-01-01T00-00-00-000-p1-1"
        ]
    );
    assert!(
        !pruned.iter().any(|p| p == KEEP || p == "my-project"),
        "{pruned:?}"
    );
    assert!(
        pruned.len() > 2,
        "the size pass pruned past the kept snapshot: {pruned:?}"
    );
    assert!(rust.join(KEEP).is_dir() && rust.join("my-project/src/main.rs").is_file());
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
        None,
    )
    .map_err(|e| e.message)?;
    assert_eq!(missing, Vec::<std::path::PathBuf>::new());
    Ok(())
}

// --- commit ---------------------------------------------------------------------------------

use navori_core::backup::BackupStore;
use navori_core::commit::{CommitError, CommitInput, commit_writes};
use navori_core::markers::InjectStatus;
use navori_core::render::collect::PendingWrite;
use navori_core::render::context::Lang;
use navori_core::render::retirements::PendingRemoval;

fn execute_plan_ts() -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/cli/src/engines/shared/execute-plan.ts");
    format!(
        "file://{}",
        fs::canonicalize(&path).unwrap_or(path).display()
    )
}

/// `(rel, content, status, chmodExec)` of each pending write, CLAUDE.md first so `writeLast`
/// has something to move; then the removals as `(rel, recursive)`.
type Plan = (
    Vec<(&'static str, &'static str, InjectStatus, bool)>,
    Vec<(&'static str, bool)>,
);

fn commit_plan() -> Plan {
    (
        vec![
            ("CLAUDE.md", "# new\n", InjectStatus::Updated, false),
            (
                ".claude/settings.json",
                "{\"v\":2}\n",
                InjectStatus::Updated,
                false,
            ),
            (
                ".claude/hooks/guard.sh",
                "#!/bin/sh\n",
                InjectStatus::Created,
                true,
            ),
        ],
        vec![
            (".claude/scripts/old.sh", false),
            (".claude/progress", true),
            (".claude/gone.md", false),
        ],
    )
}

/// The repo the plan runs over: existing CLAUDE.md, settings and a retired script, plus an
/// ephemeral directory the plan removes but the backup must skip.
fn commit_fixture(repo: &Path) -> TestResult {
    fs::create_dir_all(repo.join(".claude/scripts"))?;
    fs::create_dir_all(repo.join(".claude/progress"))?;
    fs::write(repo.join("CLAUDE.md"), "# old\n")?;
    fs::write(repo.join(".claude/settings.json"), "{\"v\":1}\n")?;
    fs::write(repo.join(".claude/scripts/old.sh"), "old\n")?;
    fs::write(repo.join(".claude/progress/notes.md"), "scratch\n")?;
    Ok(())
}

/// `commitWrites` in Node over `repo`: `{ written, backup: [files], error }` as one JSON line.
fn node_commit(
    repo: &Path,
    store: &Path,
    lang: &str,
    label: Option<&str>,
) -> Result<String, Box<dyn Error>> {
    let (pending, removals) = commit_plan();
    let pending: Vec<String> = pending
        .iter()
        .map(|(rel, content, status, exec)| {
            format!(
                "{{\"relPath\":{rel:?},\"content\":{content:?},\"status\":{:?},\"chmodExec\":{exec}}}",
                status.as_str()
            )
        })
        .collect();
    let removals: Vec<String> = removals
        .iter()
        .map(|(rel, recursive)| format!("{{\"relPath\":{rel:?},\"recursive\":{recursive}}}"))
        .collect();
    let script = format!(
        "const {{ commitWrites }} = await import({:?});\n\
         const {{ join }} = await import('node:path');\n\
         const cwd = process.env.REPO;\n\
         const pending = JSON.parse(process.env.PENDING).map((p) => ({{ ...p, path: join(cwd, p.relPath) }}));\n\
         const removals = JSON.parse(process.env.REMOVALS).map((r) => ({{ path: join(cwd, r.relPath), recursive: r.recursive }}));\n\
         const claudeMd = join(cwd, 'CLAUDE.md');\n\
         try {{\n\
           const out = commitWrites({{ pending, removals, cwd, writeLast: (p) => p.path === claudeMd, removalsBestEffort: true, lang: process.env.LANG_ID, engineLabel: process.env.LABEL || undefined }});\n\
           console.log(JSON.stringify({{ written: out.written.map((w) => [w.path, w.status]), backup: out.backupPath !== null }}));\n\
         }} catch (error) {{ console.log(JSON.stringify({{ error: error.message, backup: error.backupPath !== null }})); }}",
        execute_plan_ts()
    );
    let out = Command::new("node")
        .args(["--input-type=module", "--no-warnings", "-e", &script])
        .env("REPO", repo)
        .env("PENDING", format!("[{}]", pending.join(",")))
        .env("REMOVALS", format!("[{}]", removals.join(",")))
        .env("LANG_ID", lang)
        .env("LABEL", label.unwrap_or_default())
        .env("NAVORI_BACKUP_ROOT", store)
        .output()?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned().into());
    }
    Ok(String::from_utf8(out.stdout)?.trim_end().to_owned())
}

/// The same commit in Rust, its outcome in [`node_commit`]'s shape, plus the recorded ops.
fn rust_commit(
    repo: &Path,
    store: &Path,
    lang: Lang,
    label: Option<&str>,
) -> Result<(String, Vec<Op>), Box<dyn Error>> {
    let (plan, removals) = commit_plan();
    let mut pending: Vec<PendingWrite> = plan
        .iter()
        .map(|(rel, content, status, exec)| PendingWrite {
            rel_path: (*rel).to_owned(),
            content: (*content).to_owned(),
            status: *status,
            chmod_exec: *exec,
        })
        .collect();
    let removals: Vec<PendingRemoval> = removals
        .iter()
        .map(|(rel, recursive)| PendingRemoval {
            rel_path: (*rel).to_owned(),
            recursive: *recursive,
        })
        .collect();
    let last = |w: &PendingWrite| w.rel_path == "CLAUDE.md";
    let mut fs = FaultFs::new(RealFs::default(), None);
    let mut store = BackupStore::new(Ok(store.to_path_buf()), 1);
    let now = navori_core::backup::local_now();
    let input = CommitInput {
        cwd: repo,
        backup_exclude: &[],
        dry_run: false,
        write_last: Some(&last),
        engine_label: label,
        removals_best_effort: true,
        lang,
        now: &now,
    };
    let line = match commit_writes(&mut fs, &mut store, &mut pending, &removals, &input) {
        Ok(done) => {
            let written: Vec<String> = done
                .written
                .iter()
                .map(|(p, s)| format!("[{p:?},{s:?}]"))
                .collect();
            format!(
                "{{\"written\":[{}],\"backup\":{}}}",
                written.join(","),
                done.backup_path.is_some()
            )
        }
        Err(CommitError::Write {
            message,
            backup_path,
        }) => format!(
            "{{\"error\":{message:?},\"backup\":{}}}",
            backup_path.is_some()
        ),
        Err(CommitError::Backup(error)) => return Err(error.message.into()),
    };
    Ok((line, fs.trace))
}

/// The only backup directory under `store`.
fn only_backup(store: &Path) -> Result<PathBuf, Box<dyn Error>> {
    let mut dirs = fs::read_dir(store)?;
    let dir = dirs.next().ok_or("no backup")??.path();
    assert!(
        dirs.next().is_none(),
        "more than one backup in {}",
        store.display()
    );
    Ok(dir)
}

// Covers: R44
#[test]
fn the_backup_of_a_file_precedes_its_first_rename_or_remove_and_no_destruction_no_backup()
-> TestResult {
    let root = TempDir::new("commit")?;
    let (rust_repo, node_repo) = (root.0.join("rust/repo"), root.0.join("node/repo"));
    let (rust_store, node_store) = (root.0.join("rust/store"), root.0.join("node/store"));
    commit_fixture(&rust_repo)?;
    commit_fixture(&node_repo)?;

    let node = node_commit(&node_repo, &node_store, "en", None)?;
    let (rust, trace) = rust_commit(&rust_repo, &rust_store, Lang::En, None)?;
    assert_eq!(rust, node);
    assert_eq!(tree(&rust_repo)?, tree(&node_repo)?);
    assert_eq!(
        tree(&only_backup(&rust_store)?)?,
        tree(&only_backup(&node_store)?)?
    );
    assert_eq!(mode(&rust_repo.join(".claude/hooks/guard.sh"))?, 0o755);

    // Each backed-up file is copied before anything replaces or deletes it.
    for (at, op) in trace.iter().enumerate() {
        let Op::Copy { from, .. } = op else { continue };
        let first_touch = trace.iter().position(|o| match o {
            Op::Rename { to, .. } => to == from,
            Op::Remove { path, .. } => path == from,
            _ => false,
        });
        assert!(first_touch.is_none_or(|touch| at < touch), "{from:?}");
    }
    let copied = trace
        .iter()
        .filter(|o| matches!(o, Op::Copy { .. }))
        .count();
    assert_eq!(copied, 3, "CLAUDE.md, settings.json and the retired script");

    // A first render destroys nothing: no backup directory at all.
    let fresh = root.0.join("fresh");
    fs::create_dir(&fresh)?;
    let mut pending = vec![PendingWrite {
        rel_path: "CLAUDE.md".to_owned(),
        content: "# new\n".to_owned(),
        status: InjectStatus::Created,
        chmod_exec: false,
    }];
    let mut fs = FaultFs::new(RealFs::default(), None);
    let store = root.0.join("fresh-store");
    let now = navori_core::backup::local_now();
    let done = commit_writes(
        &mut fs,
        &mut BackupStore::new(Ok(store.clone()), 1),
        &mut pending,
        &[],
        &CommitInput {
            cwd: &fresh,
            backup_exclude: &[],
            dry_run: false,
            write_last: None,
            engine_label: None,
            removals_best_effort: true,
            lang: Lang::Es,
            now: &now,
        },
    )
    .map_err(|e| format!("{e:?}"))?;
    assert_eq!(done.backup_path, None);
    assert_eq!(done.real_writes, 1);
    assert!(!store.exists());
    assert!(!fs.trace.iter().any(|o| matches!(o, Op::Copy { .. })));
    Ok(())
}

// Covers: R46
#[test]
fn a_failure_keeps_the_original_leaves_no_temporary_and_reports_the_ts_message() -> TestResult {
    for (lang, lang_id, label) in [(Lang::En, "en", Some("Claude")), (Lang::Es, "es", None)] {
        let root = TempDir::new("commit-fail")?;
        let mut lines = Vec::new();
        for side in ["rust", "node"] {
            let repo = root.0.join(side).join("repo");
            commit_fixture(&repo)?;
            // The hook's directory is taken by a file: mkdir fails after settings.json is written.
            fs::write(repo.join(".claude/hooks"), "in the way\n")?;
            let store = root.0.join(side).join("store");
            let line = if side == "rust" {
                rust_commit(&repo, &store, lang, label)?.0
            } else {
                node_commit(&repo, &store, lang_id, label)?
            };
            let backup = only_backup(&store)?.display().to_string();
            lines.push(
                line.replace(&backup, "<backup>")
                    .replace(&repo.display().to_string(), "<repo>"),
            );
            assert_eq!(fs::read_to_string(repo.join("CLAUDE.md"))?, "# old\n");
            assert_eq!(
                fs::read_to_string(repo.join(".claude/settings.json"))?,
                "{\"v\":2}\n"
            );
            assert_eq!(temporaries(&repo)?, Vec::<String>::new());
            assert_eq!(temporaries(&repo.join(".claude"))?, Vec::<String>::new());
        }
        assert!(lines[0].contains("<backup>"), "{}", lines[0]);
        assert_eq!(lines[0], lines[1], "{lang_id}");
    }
    Ok(())
}

// Covers: R46
#[test]
fn injected_failures_after_the_backup_keep_every_unwritten_original() -> TestResult {
    const EIO: i32 = 5;
    // Writes run settings.json, guard.sh, then CLAUDE.md (written last).
    for (kind, nth, completed, failing) in [
        (Kind::Create, 0, "none", ".claude/settings.json"),
        (
            Kind::Write,
            1,
            ".claude/settings.json",
            ".claude/hooks/guard.sh",
        ),
        (
            Kind::Rename,
            2,
            ".claude/settings.json, .claude/hooks/guard.sh",
            "CLAUDE.md",
        ),
    ] {
        let root = TempDir::new("commit-fault")?;
        let repo = root.0.join("repo");
        commit_fixture(&repo)?;
        let (plan, _) = commit_plan();
        let mut pending: Vec<PendingWrite> = plan
            .iter()
            .map(|(rel, content, status, exec)| PendingWrite {
                rel_path: (*rel).to_owned(),
                content: (*content).to_owned(),
                status: *status,
                chmod_exec: *exec,
            })
            .collect();
        let last = |w: &PendingWrite| w.rel_path == "CLAUDE.md";
        let mut fs = FaultFs::new(RealFs::default(), Some((kind, nth, EIO)));
        let store = root.0.join("store");
        let now = navori_core::backup::local_now();
        let result = commit_writes(
            &mut fs,
            &mut BackupStore::new(Ok(store.clone()), 1),
            &mut pending,
            &[],
            &CommitInput {
                cwd: &repo,
                backup_exclude: &[],
                dry_run: false,
                write_last: Some(&last),
                engine_label: None,
                removals_best_effort: true,
                lang: Lang::En,
                now: &now,
            },
        );
        let Err(CommitError::Write {
            message,
            backup_path: Some(backup),
        }) = result
        else {
            return Err(format!("{kind:?}: {result:?}").into());
        };
        let unfinished: Vec<&str> = [
            ".claude/settings.json",
            ".claude/hooks/guard.sh",
            "CLAUDE.md",
        ]
        .into_iter()
        .filter(|p| !completed.contains(p))
        .collect();
        let prefix = format!(
            "The render failed writing {}: EIO: i/o error, ",
            repo.join(failing).display()
        );
        let suffix = format!(
            ". Completed: {completed}; unfinished: {}. Backup available (pre-write) at: {}",
            unfinished.join(", "),
            backup.display()
        );
        assert!(message.starts_with(&prefix), "{kind:?}: {message}");
        assert!(message.ends_with(&suffix), "{kind:?}: {message}");
        // What was not reached keeps its bytes, and the backup holds every original.
        assert_eq!(
            fs::read_to_string(repo.join("CLAUDE.md"))?,
            "# old\n",
            "{kind:?}"
        );
        assert_eq!(fs::read_to_string(backup.join("CLAUDE.md"))?, "# old\n");
        assert_eq!(
            fs::read_to_string(backup.join(".claude/settings.json"))?,
            "{\"v\":1}\n"
        );
        for dir in [repo.clone(), repo.join(".claude")] {
            assert_eq!(temporaries(&dir)?, Vec::<String>::new(), "{kind:?}");
        }
    }
    Ok(())
}
