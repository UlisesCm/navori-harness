//! Private audit-store primitives `navori audit --arm/--disarm` need: a port of the subset of
//! `packages/cli/src/lib/audit/paths.ts` they call (`auditsRoot`, `repoAuditDir`,
//! `ensurePrivateAuditDirectory`, `createPrivateAuditFile`, `readPrivateAuditFile`,
//! `removePrivateAuditFile`).
//!
//! Same checks, same refusal reasons. Not ported (no caller in `--arm/--disarm`): append,
//! replace, copy, the JSONL reader and the `ownedRoot: null` mode, so the owned root is always an
//! explicit argument here.
//!
//! `O_NOFOLLOW` is not exposed by `std` and the crate has no `libc`; [`NOFOLLOW`] carries the
//! per-platform value and, where it is unknown, every operation refuses with
//! [`Reason::Unsupported`], like the TS does without `constants.O_NOFOLLOW`.

use std::fs::{self, DirBuilder, File, Metadata, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, FileExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use crate::posix;
use crate::process::Env;

/// Env var that redirects the whole audit store.
const AUDITS_ROOT_ENV: &str = "NAVORI_AUDITS_ROOT";

/// `O_NOFOLLOW` per platform (Linux x86/generic `0o400000`, arm/powerpc `0o100000`, BSD/macOS
/// `0x100`); `None` where it is not known.
#[cfg(all(
    target_os = "linux",
    any(
        target_arch = "arm",
        target_arch = "aarch64",
        target_arch = "powerpc",
        target_arch = "powerpc64"
    )
))]
const NOFOLLOW: Option<i32> = Some(0o100_000);
#[cfg(all(
    target_os = "linux",
    not(any(
        target_arch = "arm",
        target_arch = "aarch64",
        target_arch = "powerpc",
        target_arch = "powerpc64"
    ))
))]
const NOFOLLOW: Option<i32> = Some(0o400_000);
#[cfg(any(
    target_os = "macos",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
))]
const NOFOLLOW: Option<i32> = Some(0x100);
#[cfg(not(any(
    target_os = "linux",
    target_os = "macos",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "netbsd"
)))]
const NOFOLLOW: Option<i32> = None;

/// Failure of [`audits_root`] / [`repo_audit_dir`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuditPathError {
    /// `NAVORI_AUDITS_ROOT` is set but not absolute (`invalid-audit-root`).
    InvalidAuditRoot,
    /// The repo name is not a single path segment (`invalid-repo-name`).
    InvalidRepoName(String),
    /// `HOME` is relative (`home-unresolved`).
    HomeUnresolved,
    /// The TS would resolve this through Node (`HOME` unset, empty or not UTF-8): the port does
    /// not model it, so the caller delegates.
    Unmodeled,
}

impl AuditPathError {
    /// The `NavoriError.code` the TS throws; `None` for [`AuditPathError::Unmodeled`].
    #[must_use]
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::InvalidAuditRoot => Some("invalid-audit-root"),
            Self::InvalidRepoName(_) => Some("invalid-repo-name"),
            Self::HomeUnresolved => Some("home-unresolved"),
            Self::Unmodeled => None,
        }
    }

    /// The TS error message; `None` for [`AuditPathError::Unmodeled`].
    #[must_use]
    pub fn message(&self) -> Option<String> {
        match self {
            Self::InvalidAuditRoot => Some("Audit root must be absolute.".to_owned()),
            Self::InvalidRepoName(name) => Some(format!(
                "Invalid repo name '{name}' for the audit store: expected a single path segment \
                 (no separators, not '.' or '..')."
            )),
            Self::HomeUnresolved => Some(
                "Could not determine home directory: HOME env var is empty or not absolute. \
                 Set HOME explicitly (e.g. 'HOME=/home/runner') before running navori."
                    .to_owned(),
            ),
            Self::Unmodeled => None,
        }
    }
}

fn var<'e>(env: &'e Env, name: &str) -> Option<&'e std::ffi::OsStr> {
    env.iter()
        .rev()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_os_str())
}

/// `auditsRoot()`: `$NAVORI_AUDITS_ROOT` (absolute, trimmed, normalised) else `~/.navori/audits`.
///
/// # Errors
/// [`AuditPathError`].
pub fn audits_root(env: &Env) -> Result<PathBuf, AuditPathError> {
    if let Some(raw) = var(env, AUDITS_ROOT_ENV) {
        let raw = raw.to_str().ok_or(AuditPathError::Unmodeled)?;
        let override_root = posix::js_trim(raw);
        if !override_root.is_empty() {
            if !override_root.starts_with('/') {
                return Err(AuditPathError::InvalidAuditRoot);
            }
            return Ok(PathBuf::from(posix::resolve("/", override_root)));
        }
    }
    let home = var(env, "HOME")
        .filter(|home| !home.is_empty())
        .and_then(std::ffi::OsStr::to_str)
        .ok_or(AuditPathError::Unmodeled)?;
    if !home.starts_with('/') {
        return Err(AuditPathError::HomeUnresolved);
    }
    Ok(PathBuf::from(posix::join(&[home, ".navori", "audits"])))
}

/// `repoAuditDir(repoName)`: `<audits root>/<repo>`; the name must be one path segment.
///
/// # Errors
/// [`AuditPathError::InvalidRepoName`] or whatever [`audits_root`] returns.
pub fn repo_audit_dir(env: &Env, repo_name: &str) -> Result<PathBuf, AuditPathError> {
    if repo_name.is_empty()
        || repo_name == "."
        || repo_name == ".."
        || repo_name.contains(['/', '\\'])
    {
        return Err(AuditPathError::InvalidRepoName(repo_name.to_owned()));
    }
    Ok(audits_root(env)?.join(repo_name))
}

/// Why a private operation refused (`PrivateAuditReason`, without the append-only ones).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// Wrong type, owner or permissions.
    Unsafe,
    /// An ancestor or the file changed identity during the operation.
    Changed,
    /// Nothing there.
    Missing,
    /// The target already exists.
    Exists,
    /// `write` stored fewer bytes than asked.
    ShortWrite,
    /// The file is larger than the caller's bound.
    Limit,
    /// No uid or no `O_NOFOLLOW` on this platform.
    Unsupported,
    /// Any other I/O error.
    Io,
}

impl Reason {
    /// The TS string, the one `privateResultOrExit` prints.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unsafe => "unsafe",
            Self::Changed => "changed",
            Self::Missing => "missing",
            Self::Exists => "exists",
            Self::ShortWrite => "short-write",
            Self::Limit => "limit",
            Self::Unsupported => "unsupported",
            Self::Io => "io",
        }
    }
}

/// A refused operation: the TS `{ ok: false, reason, partial, permissionOnly? }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Refusal {
    /// Why.
    pub reason: Reason,
    /// A mutation may have left a private partial artifact.
    pub partial: bool,
    /// The only fault is group/other mode bits on an owned entry (`chmod` fixes it).
    pub permission_only: bool,
}

/// Result of a private operation.
pub type PrivateResult<T> = Result<T, Refusal>;

#[derive(Debug, Clone, Copy)]
struct Fault {
    reason: Reason,
    permission_only: bool,
}

impl Fault {
    const fn new(reason: Reason) -> Self {
        Self {
            reason,
            permission_only: false,
        }
    }

    const fn mode() -> Self {
        Self {
            reason: Reason::Unsafe,
            permission_only: true,
        }
    }

    fn refusal(self, partial: bool) -> Refusal {
        Refusal {
            reason: self.reason,
            partial,
            permission_only: self.permission_only,
        }
    }
}

impl From<io::Error> for Fault {
    fn from(error: io::Error) -> Self {
        Self::new(match error.kind() {
            io::ErrorKind::AlreadyExists => Reason::Exists,
            io::ErrorKind::NotFound => Reason::Missing,
            _ => Reason::Io,
        })
    }
}

/// `{ dev, ino, uid, mode }` of an observed entry (`sameAuditIdentity`).
#[derive(Debug, Clone)]
struct Identity {
    path: String,
    dev: u64,
    ino: u64,
    uid: u32,
    mode: u32,
}

impl Identity {
    fn of(path: &str, meta: &Metadata) -> Self {
        Self {
            path: path.to_owned(),
            dev: meta.dev(),
            ino: meta.ino(),
            uid: meta.uid(),
            mode: meta.mode(),
        }
    }

    fn same(&self, meta: &Metadata) -> bool {
        self.dev == meta.dev()
            && self.ino == meta.ino()
            && self.uid == meta.uid()
            && self.mode == meta.mode()
    }
}

fn same(a: &Metadata, b: &Metadata) -> bool {
    a.dev() == b.dev() && a.ino() == b.ino() && a.uid() == b.uid() && a.mode() == b.mode()
}

/// `process.getuid()`: `/proc/self`'s owner, or `id -u` where there is no procfs.
#[must_use]
pub fn current_uid() -> Option<u32> {
    if let Ok(meta) = fs::metadata("/proc/self") {
        return Some(meta.uid());
    }
    let out = std::process::Command::new("id").arg("-u").output().ok()?;
    String::from_utf8(out.stdout).ok()?.trim().parse().ok()
}

/// `systemAuditPath` with the realpath lookup injected: only the standard macOS aliases
/// (`/var`, `/tmp` resolving to `/private/...`) are rewritten.
fn system_path_with(path: &str, real: &dyn Fn(&str) -> Option<String>) -> String {
    for prefix in ["/var", "/tmp"] {
        let under = path == prefix
            || path
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with('/'));
        if under && real(prefix).is_some_and(|r| r == format!("/private{prefix}")) {
            return format!("/private{path}");
        }
    }
    path.to_owned()
}

fn system_path(path: &str) -> String {
    system_path_with(path, &|prefix| {
        fs::canonicalize(prefix)
            .ok()
            .and_then(|p| p.to_str().map(str::to_owned))
    })
}

fn is_under(path: &str, root: &str) -> bool {
    path == root
        || path
            .strip_prefix(root)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn utf8(path: &Path) -> Result<&str, Fault> {
    path.to_str().ok_or(Fault::new(Reason::Unsafe))
}

/// The audit store rooted at `owned`, acting as `uid`: every ancestor below `owned` must be a
/// 0700 directory of `uid`.
#[derive(Debug, Clone)]
pub struct Store {
    owned: String,
    uid: u32,
}

impl Store {
    /// A store for the current process.
    ///
    /// # Errors
    /// [`Reason::Unsupported`] when the uid or `O_NOFOLLOW` is unavailable, [`Reason::Unsafe`]
    /// when `owned` is not a UTF-8 absolute path.
    pub fn new(owned: &Path) -> PrivateResult<Self> {
        let uid = current_uid().ok_or(Fault::new(Reason::Unsupported).refusal(false))?;
        Self::as_uid(owned, uid)
    }

    fn as_uid(owned: &Path, uid: u32) -> PrivateResult<Self> {
        if NOFOLLOW.is_none() {
            return Err(Fault::new(Reason::Unsupported).refusal(false));
        }
        let owned = utf8(owned).map_err(|f| f.refusal(false))?;
        if !owned.starts_with('/') {
            return Err(Fault::new(Reason::Unsafe).refusal(false));
        }
        Ok(Self {
            owned: system_path(owned),
            uid,
        })
    }

    fn flags() -> Result<i32, Fault> {
        NOFOLLOW.ok_or(Fault::new(Reason::Unsupported))
    }

    fn regular(&self, meta: &Metadata) -> Result<(), Fault> {
        if !meta.is_file() || meta.uid() != self.uid {
            return Err(Fault::new(Reason::Unsafe));
        }
        if meta.mode() & 0o177 != 0 {
            return Err(Fault::mode());
        }
        Ok(())
    }

    /// `auditParents`: validates every ancestor of `path`, creating missing ones (0700) when
    /// `create`. Ordinary ancestors above the owned root are never chmodded.
    fn parents(&self, path: &str, create: bool) -> Result<Vec<Identity>, Fault> {
        let path = system_path(path);
        if !path.starts_with('/') || posix::resolve("/", &path) != path {
            return Err(Fault::new(Reason::Unsafe));
        }
        if !is_under(&path, &self.owned) {
            return Err(Fault::new(Reason::Unsafe));
        }
        let mut dirs: Vec<String> = Vec::new();
        let mut dir = posix::dirname(&path).to_owned();
        loop {
            dirs.insert(0, dir.clone());
            let up = posix::dirname(&dir).to_owned();
            if up == dir {
                break;
            }
            dir = up;
        }
        let mut identities: Vec<Identity> = Vec::new();
        for dir in dirs {
            let meta = match fs::symlink_metadata(&dir) {
                Ok(meta) => meta,
                Err(error) if error.kind() == io::ErrorKind::NotFound && create => {
                    recheck(&identities)?;
                    DirBuilder::new().mode(0o700).create(&dir)?;
                    fs::symlink_metadata(&dir)?
                }
                Err(_) => return Err(Fault::new(Reason::Missing)),
            };
            let owned = is_under(&dir, &self.owned);
            if !meta.is_dir() || (owned && meta.uid() != self.uid) {
                return Err(Fault::new(Reason::Unsafe));
            }
            if owned && meta.mode() & 0o077 != 0 {
                return Err(Fault::mode());
            }
            identities.push(Identity::of(&dir, &meta));
        }
        Ok(identities)
    }

    /// `auditGuard`: rebinds the descriptor to its path right before each operation.
    fn guard(
        &self,
        path: &str,
        file: &File,
        identity: &Metadata,
        parents: &[Identity],
    ) -> Result<(), Fault> {
        recheck(parents)?;
        let meta = file.metadata()?;
        self.regular(&meta)?;
        if !same(identity, &meta) || !same(&meta, &fs::symlink_metadata(path)?) {
            return Err(Fault::new(Reason::Changed));
        }
        Ok(())
    }

    /// `ensurePrivateAuditDirectory`: creates only missing directories (0700) and refuses
    /// insecure history unchanged.
    ///
    /// # Errors
    /// [`Refusal`] with the TS reason.
    pub fn ensure_directory(&self, path: &Path) -> PrivateResult<()> {
        let run = || -> Result<(), Fault> {
            let check = posix::join(&[utf8(path)?, ".directory-check"]);
            self.parents(&check, true)?;
            Ok(())
        };
        run().map_err(|f| f.refusal(false))
    }

    /// `createPrivateAuditFile`: exclusive 0600 creation (`O_EXCL | O_NOFOLLOW`), never
    /// overwriting or repairing. Returns the bytes written.
    ///
    /// # Errors
    /// [`Refusal`]; `partial` is set once the file was created.
    pub fn create_file(&self, path: &Path, data: &[u8]) -> PrivateResult<usize> {
        let mut partial = false;
        let mut run = || -> Result<usize, Fault> {
            let text = utf8(path)?;
            if path.exists() {
                return Err(Fault::new(Reason::Exists));
            }
            let parents = self.parents(text, true)?;
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .custom_flags(Self::flags()?)
                .open(path)?;
            partial = true;
            let identity = file.metadata()?;
            self.guard(text, &file, &identity, &parents)?;
            if file.write(data)? != data.len() {
                return Err(Fault::new(Reason::ShortWrite));
            }
            self.guard(text, &file, &identity, &parents)?;
            Ok(data.len())
        };
        run().map_err(|f| f.refusal(partial))
    }

    /// `readPrivateAuditFile` with `maxBytes`: a checked, bounded read of a private file.
    ///
    /// # Errors
    /// [`Refusal`] with the TS reason ([`Reason::Limit`] past `max_bytes`).
    pub fn read_file(&self, path: &Path, max_bytes: u64) -> PrivateResult<Vec<u8>> {
        let run = || -> Result<Vec<u8>, Fault> {
            let text = utf8(path)?;
            let parents = self.parents(text, false)?;
            let identity = fs::symlink_metadata(path)?;
            self.regular(&identity)?;
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(Self::flags()?)
                .open(path)?;
            self.guard(text, &file, &identity, &parents)?;
            if identity.size() > max_bytes {
                return Err(Fault::new(Reason::Limit));
            }
            let mut bytes = vec![0_u8; usize::try_from(identity.size()).unwrap_or(usize::MAX)];
            let mut offset = 0_usize;
            while offset < bytes.len() {
                let end = bytes.len().min(offset + 65536);
                let count = file.read_at(&mut bytes[offset..end], offset as u64)?;
                if count == 0 {
                    return Err(Fault::new(Reason::Changed));
                }
                offset += count;
            }
            self.guard(text, &file, &identity, &parents)?;
            if file.metadata()?.size() != identity.size() {
                return Err(Fault::new(Reason::Changed));
            }
            Ok(bytes)
        };
        run().map_err(|f| f.refusal(false))
    }

    /// `removePrivateAuditFile` (without `expectedIdentity`): unlinks a private artifact only
    /// after the descriptor and path checks. A missing file refuses with [`Reason::Missing`].
    ///
    /// # Errors
    /// [`Refusal`] with the TS reason.
    pub fn remove_file(&self, path: &Path) -> PrivateResult<()> {
        let run = || -> Result<(), Fault> {
            let text = utf8(path)?;
            let parents = self.parents(text, false)?;
            let identity = fs::symlink_metadata(path)?;
            self.regular(&identity)?;
            let file = OpenOptions::new()
                .read(true)
                .custom_flags(Self::flags()?)
                .open(path)?;
            self.guard(text, &file, &identity, &parents)?;
            fs::remove_file(path)?;
            Ok(())
        };
        run().map_err(|f| f.refusal(false))
    }
}

/// `recheckAuditParents`.
fn recheck(identities: &[Identity]) -> Result<(), Fault> {
    for identity in identities {
        if !identity.same(&fs::symlink_metadata(&identity.path)?) {
            return Err(Fault::new(Reason::Changed));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, reason = "test assertions")]

    use std::ffi::OsString;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::sync::atomic::{AtomicU32, Ordering};

    use super::*;

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    /// A private scratch directory, removed on drop.
    struct Temp(PathBuf);

    impl Temp {
        fn new() -> Self {
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir()
                .join(format!("navori-audit-private-{}-{n}", std::process::id()));
            fs::create_dir_all(&dir).unwrap();
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
            Self(dir)
        }

        fn root(&self) -> PathBuf {
            self.0.join("audits")
        }
    }

    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn env(pairs: &[(&str, &str)]) -> Vec<(OsString, OsString)> {
        pairs
            .iter()
            .map(|(k, v)| (OsString::from(k), OsString::from(v)))
            .collect()
    }

    fn store(temp: &Temp) -> Store {
        Store::new(&temp.root()).unwrap()
    }

    fn reason<T: std::fmt::Debug>(result: PrivateResult<T>) -> Reason {
        result.unwrap_err().reason
    }

    #[test]
    fn audits_root_uses_the_absolute_override_normalised() {
        let e = env(&[
            ("NAVORI_AUDITS_ROOT", "  /srv//a/../audits/ "),
            ("HOME", "/h"),
        ]);
        assert_eq!(audits_root(&e), Ok(PathBuf::from("/srv/audits")));
    }

    #[test]
    fn audits_root_rejects_a_relative_override() {
        let e = env(&[("NAVORI_AUDITS_ROOT", "rel"), ("HOME", "/h")]);
        let err = audits_root(&e).unwrap_err();
        assert_eq!(err.code(), Some("invalid-audit-root"));
        assert_eq!(
            err.message().as_deref(),
            Some("Audit root must be absolute.")
        );
    }

    #[test]
    fn audits_root_defaults_to_home_when_the_override_is_blank() {
        let e = env(&[("NAVORI_AUDITS_ROOT", "  "), ("HOME", "/home/u")]);
        assert_eq!(audits_root(&e), Ok(PathBuf::from("/home/u/.navori/audits")));
    }

    #[test]
    fn audits_root_home_failures() {
        assert_eq!(
            audits_root(&env(&[("HOME", "rel")])),
            Err(AuditPathError::HomeUnresolved)
        );
        assert_eq!(audits_root(&env(&[])), Err(AuditPathError::Unmodeled));
        assert_eq!(
            audits_root(&env(&[("HOME", "")])),
            Err(AuditPathError::Unmodeled)
        );
        assert_eq!(
            AuditPathError::HomeUnresolved.code(),
            Some("home-unresolved")
        );
    }

    #[test]
    fn repo_audit_dir_joins_one_segment() {
        let e = env(&[("NAVORI_AUDITS_ROOT", "/a")]);
        assert_eq!(repo_audit_dir(&e, "repo"), Ok(PathBuf::from("/a/repo")));
    }

    #[test]
    fn repo_audit_dir_rejects_anything_but_one_segment() {
        let e = env(&[("NAVORI_AUDITS_ROOT", "/a")]);
        for bad in ["", ".", "..", "a/b", "a\\b"] {
            let err = repo_audit_dir(&e, bad).unwrap_err();
            assert_eq!(err.code(), Some("invalid-repo-name"));
            assert_eq!(
                err.message().unwrap(),
                format!(
                    "Invalid repo name '{bad}' for the audit store: expected a single path \
                     segment (no separators, not '.' or '..')."
                )
            );
        }
    }

    #[test]
    fn macos_aliases_are_rewritten_only_when_they_resolve_under_private() {
        let mac = |p: &str| Some(format!("/private{p}"));
        let linux = |p: &str| Some(p.to_owned());
        assert_eq!(system_path_with("/var/x", &mac), "/private/var/x");
        assert_eq!(system_path_with("/tmp", &mac), "/private/tmp");
        assert_eq!(system_path_with("/tmpx/y", &mac), "/tmpx/y");
        assert_eq!(system_path_with("/var/x", &linux), "/var/x");
        assert_eq!(system_path_with("/var/x", &|_| None), "/var/x");
    }

    #[test]
    fn ensure_directory_creates_missing_owned_dirs_with_mode_0700() {
        let temp = Temp::new();
        let store = store(&temp);
        let dir = temp.root().join("repo");
        store.ensure_directory(&dir).unwrap();
        for d in [temp.root(), dir] {
            assert_eq!(fs::metadata(d).unwrap().mode() & 0o777, 0o700);
        }
    }

    #[test]
    fn ensure_directory_refuses_an_open_owned_directory_as_permission_only() {
        let temp = Temp::new();
        let store = store(&temp);
        fs::create_dir(temp.root()).unwrap();
        fs::set_permissions(temp.root(), fs::Permissions::from_mode(0o755)).unwrap();
        let refusal = store
            .ensure_directory(&temp.root().join("repo"))
            .unwrap_err();
        assert_eq!(refusal.reason, Reason::Unsafe);
        assert!(refusal.permission_only);
        assert!(!refusal.partial);
        assert!(!temp.root().join("repo").exists());
    }

    #[test]
    fn a_directory_of_another_uid_is_unsafe_and_not_permission_only() {
        let temp = Temp::new();
        let mine = store(&temp);
        fs::create_dir(temp.root()).unwrap();
        fs::set_permissions(temp.root(), fs::Permissions::from_mode(0o700)).unwrap();
        let other = Store::as_uid(&temp.root(), mine.uid.wrapping_add(1)).unwrap();
        let refusal = other
            .ensure_directory(&temp.root().join("repo"))
            .unwrap_err();
        assert_eq!(refusal.reason, Reason::Unsafe);
        assert!(!refusal.permission_only);
    }

    #[test]
    fn a_path_outside_the_owned_root_is_unsafe() {
        let temp = Temp::new();
        let store = store(&temp);
        assert_eq!(
            reason(store.ensure_directory(&temp.0.join("elsewhere"))),
            Reason::Unsafe
        );
        assert_eq!(
            reason(store.read_file(Path::new("rel"), 10)),
            Reason::Unsafe
        );
        assert_eq!(
            reason(store.read_file(&temp.root().join("a/../b"), 10)),
            Reason::Unsafe
        );
    }

    #[test]
    fn a_missing_ancestor_without_create_is_missing() {
        let temp = Temp::new();
        let store = store(&temp);
        assert_eq!(
            reason(store.remove_file(&temp.root().join("repo/.armed"))),
            Reason::Missing
        );
    }

    #[test]
    fn a_symlinked_ancestor_is_unsafe() {
        let temp = Temp::new();
        let store = store(&temp);
        fs::create_dir(temp.root()).unwrap();
        let real = temp.0.join("real");
        fs::create_dir(&real).unwrap();
        symlink(&real, temp.root().join("repo")).unwrap();
        assert_eq!(
            reason(store.create_file(&temp.root().join("repo/.armed"), b"x")),
            Reason::Unsafe
        );
        assert!(!real.join(".armed").exists());
    }

    #[test]
    fn create_writes_an_exclusive_0600_file_and_returns_its_size() {
        let temp = Temp::new();
        let store = store(&temp);
        let file = temp.root().join("repo/.armed");
        assert_eq!(store.create_file(&file, b"{}\n"), Ok(3));
        assert_eq!(fs::read(&file).unwrap(), b"{}\n");
        assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
        assert_eq!(reason(store.create_file(&file, b"again")), Reason::Exists);
        assert_eq!(fs::read(&file).unwrap(), b"{}\n");
    }

    #[test]
    fn create_refuses_a_final_symlink_without_following_it() {
        let temp = Temp::new();
        let store = store(&temp);
        store.ensure_directory(&temp.root().join("repo")).unwrap();
        let target = temp.0.join("target");
        let file = temp.root().join("repo/.armed");
        symlink(&target, &file).unwrap();
        assert_eq!(reason(store.create_file(&file, b"x")), Reason::Exists);
        assert!(!target.exists());
    }

    #[test]
    fn read_returns_the_bytes_of_a_private_file() {
        let temp = Temp::new();
        let store = store(&temp);
        let file = temp.root().join("repo/.armed");
        store.create_file(&file, b"hello\n").unwrap();
        assert_eq!(store.read_file(&file, 2048), Ok(b"hello\n".to_vec()));
    }

    #[test]
    fn read_is_bounded() {
        let temp = Temp::new();
        let store = store(&temp);
        let file = temp.root().join("repo/.armed");
        store.create_file(&file, &vec![b'a'; 2049]).unwrap();
        assert_eq!(reason(store.read_file(&file, 2048)), Reason::Limit);
        assert_eq!(store.read_file(&file, 2049).map(|b| b.len()), Ok(2049));
    }

    #[test]
    fn read_refuses_a_file_open_to_group_as_permission_only() {
        let temp = Temp::new();
        let store = store(&temp);
        let file = temp.root().join("repo/.armed");
        store.create_file(&file, b"x").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        let refusal = store.read_file(&file, 2048).unwrap_err();
        assert_eq!(refusal.reason, Reason::Unsafe);
        assert!(refusal.permission_only);
    }

    #[test]
    fn read_and_remove_refuse_a_final_symlink() {
        let temp = Temp::new();
        let store = store(&temp);
        store.ensure_directory(&temp.root().join("repo")).unwrap();
        let target = temp.0.join("target");
        fs::write(&target, b"x").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        let file = temp.root().join("repo/.armed");
        symlink(&target, &file).unwrap();
        assert_eq!(reason(store.read_file(&file, 2048)), Reason::Unsafe);
        assert_eq!(reason(store.remove_file(&file)), Reason::Unsafe);
        assert!(target.exists());
    }

    #[test]
    fn a_file_of_another_uid_is_unsafe() {
        let temp = Temp::new();
        let mine = store(&temp);
        let file = temp.root().join("repo/.armed");
        mine.create_file(&file, b"x").unwrap();
        let other = Store::as_uid(&temp.root(), mine.uid.wrapping_add(1)).unwrap();
        // The owned directories already fail for the other uid, the file would too.
        assert_eq!(reason(other.read_file(&file, 10)), Reason::Unsafe);
        assert_eq!(
            other
                .regular(&fs::symlink_metadata(&file).unwrap())
                .unwrap_err()
                .reason,
            Reason::Unsafe
        );
    }

    #[test]
    fn remove_deletes_and_reports_missing_afterwards() {
        let temp = Temp::new();
        let store = store(&temp);
        let file = temp.root().join("repo/.armed");
        store.create_file(&file, b"x").unwrap();
        assert_eq!(store.remove_file(&file), Ok(()));
        assert!(!file.exists());
        assert_eq!(reason(store.remove_file(&file)), Reason::Missing);
    }

    #[test]
    fn recheck_detects_an_ancestor_replaced_during_the_operation() {
        let temp = Temp::new();
        let store = store(&temp);
        let file = temp.root().join("repo/.armed");
        store.ensure_directory(&temp.root().join("repo")).unwrap();
        let parents = store.parents(file.to_str().unwrap(), false).unwrap();
        fs::remove_dir(temp.root().join("repo")).unwrap();
        fs::create_dir(temp.root().join("repo")).unwrap();
        fs::set_permissions(temp.root().join("repo"), fs::Permissions::from_mode(0o700)).unwrap();
        let replaced = recheck(&parents);
        // A fresh inode normally changes identity; some filesystems reuse the number.
        if let Err(fault) = replaced {
            assert_eq!(fault.reason, Reason::Changed);
        }
        fs::remove_dir(temp.root().join("repo")).unwrap();
        assert_eq!(recheck(&parents).unwrap_err().reason, Reason::Missing);
    }

    #[test]
    fn reasons_print_as_the_ts_strings() {
        assert_eq!(Reason::ShortWrite.as_str(), "short-write");
        assert_eq!(Reason::Unsupported.as_str(), "unsupported");
        assert_eq!(Reason::Missing.as_str(), "missing");
    }
}
