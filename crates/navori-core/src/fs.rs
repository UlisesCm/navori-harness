//! The filesystem effects of the commands that write (spec 0058 D24, R40, R43): every mutation
//! goes through [`Fs`], so a preview runs the same code over [`RecordingFs`], which only records,
//! and tests can inject faults between steps.
//!
//! [`write_file_atomic`] ports `lib/primitives/atomic.ts`: a sibling temporary opened like
//! `openSync(tmp, "w", 0o644)` (`O_CREAT|O_TRUNC|O_WRONLY`, without `O_EXCL`, Q7), then write,
//! fsync, close and rename; on any failure the temporary is removed and the error is reported as
//! `friendlyFsError` reports it.

use std::collections::BTreeMap;
use std::fmt;
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

/// An open file of an [`Fs`].
pub type FileId = u64;

/// One mutation, as [`RecordingFs`] records it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    /// `openSync(path, "w", mode)`.
    Create {
        /// The file.
        path: PathBuf,
        /// The mode before umask.
        mode: u32,
    },
    /// `writeSync(fd, bytes)`.
    Write {
        /// The file the descriptor was opened on.
        path: PathBuf,
        /// The bytes.
        bytes: Vec<u8>,
    },
    /// `fsyncSync(fd)`.
    Fsync {
        /// The file the descriptor was opened on.
        path: PathBuf,
    },
    /// `closeSync(fd)`.
    Close {
        /// The file the descriptor was opened on.
        path: PathBuf,
    },
    /// `renameSync(from, to)`.
    Rename {
        /// Source.
        from: PathBuf,
        /// Destination.
        to: PathBuf,
    },
    /// `rmSync(path, { recursive, force: true })`.
    Remove {
        /// The path.
        path: PathBuf,
        /// `recursive`.
        recursive: bool,
    },
}

/// The mutations a command may perform. Reads stay on `std::fs`: a preview reads the real repo.
pub trait Fs {
    /// `openSync(path, "w", mode)`: create or truncate, write-only, `mode` subject to umask.
    ///
    /// # Errors
    /// The OS error.
    fn create(&mut self, path: &Path, mode: u32) -> io::Result<FileId>;

    /// `writeSync(fd, bytes)`, every byte.
    ///
    /// # Errors
    /// The OS error.
    fn write(&mut self, file: FileId, bytes: &[u8]) -> io::Result<()>;

    /// `fsyncSync(fd)`.
    ///
    /// # Errors
    /// The OS error.
    fn fsync(&mut self, file: FileId) -> io::Result<()>;

    /// `closeSync(fd)`.
    ///
    /// # Errors
    /// The OS error.
    fn close(&mut self, file: FileId) -> io::Result<()>;

    /// `renameSync(from, to)`.
    ///
    /// # Errors
    /// The OS error.
    fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()>;

    /// `rmSync(path, { recursive, force: true })`: a missing path is not an error.
    ///
    /// # Errors
    /// The OS error.
    fn remove(&mut self, path: &Path, recursive: bool) -> io::Result<()>;
}

/// The real filesystem.
#[derive(Debug, Default)]
pub struct RealFs {
    open: BTreeMap<FileId, File>,
    next: FileId,
}

impl RealFs {
    fn file(&mut self, file: FileId) -> io::Result<&mut File> {
        self.open
            .get_mut(&file)
            .ok_or_else(|| io::Error::from_raw_os_error(errno::EBADF))
    }
}

impl Fs for RealFs {
    fn create(&mut self, path: &Path, mode: u32) -> io::Result<FileId> {
        let file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(path)?;
        self.next += 1;
        self.open.insert(self.next, file);
        Ok(self.next)
    }

    fn write(&mut self, file: FileId, bytes: &[u8]) -> io::Result<()> {
        self.file(file)?.write_all(bytes)
    }

    fn fsync(&mut self, file: FileId) -> io::Result<()> {
        self.file(file)?.sync_all()
    }

    fn close(&mut self, file: FileId) -> io::Result<()> {
        self.open
            .remove(&file)
            .map(drop)
            .ok_or_else(|| io::Error::from_raw_os_error(errno::EBADF))
    }

    fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()> {
        std::fs::rename(from, to)
    }

    fn remove(&mut self, path: &Path, recursive: bool) -> io::Result<()> {
        let meta = match std::fs::symlink_metadata(path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error),
        };
        let result = if !meta.is_dir() {
            std::fs::remove_file(path)
        } else if recursive {
            std::fs::remove_dir_all(path)
        } else {
            // `rmSync` on a directory without `recursive` throws `ERR_FS_EISDIR`.
            Err(io::Error::from_raw_os_error(errno::EISDIR))
        };
        match result {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            other => other,
        }
    }
}

/// Records every mutation and touches nothing: what a preview runs on (R40).
#[derive(Debug, Default)]
pub struct RecordingFs {
    /// The mutations, in order.
    pub ops: Vec<Op>,
    open: BTreeMap<FileId, PathBuf>,
    next: FileId,
}

impl RecordingFs {
    fn path(&self, file: FileId) -> io::Result<PathBuf> {
        self.open
            .get(&file)
            .cloned()
            .ok_or_else(|| io::Error::from_raw_os_error(errno::EBADF))
    }
}

impl Fs for RecordingFs {
    fn create(&mut self, path: &Path, mode: u32) -> io::Result<FileId> {
        self.ops.push(Op::Create {
            path: path.to_path_buf(),
            mode,
        });
        self.next += 1;
        self.open.insert(self.next, path.to_path_buf());
        Ok(self.next)
    }

    fn write(&mut self, file: FileId, bytes: &[u8]) -> io::Result<()> {
        let path = self.path(file)?;
        self.ops.push(Op::Write {
            path,
            bytes: bytes.to_vec(),
        });
        Ok(())
    }

    fn fsync(&mut self, file: FileId) -> io::Result<()> {
        let path = self.path(file)?;
        self.ops.push(Op::Fsync { path });
        Ok(())
    }

    fn close(&mut self, file: FileId) -> io::Result<()> {
        let path = self.path(file)?;
        self.open.remove(&file);
        self.ops.push(Op::Close { path });
        Ok(())
    }

    fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()> {
        self.ops.push(Op::Rename {
            from: from.to_path_buf(),
            to: to.to_path_buf(),
        });
        Ok(())
    }

    fn remove(&mut self, path: &Path, recursive: bool) -> io::Result<()> {
        self.ops.push(Op::Remove {
            path: path.to_path_buf(),
            recursive,
        });
        Ok(())
    }
}

/// A failed filesystem step, with the message the TS prints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FsError {
    /// `error.message`.
    pub message: String,
}

impl fmt::Display for FsError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FsError {}

/// The step that failed, for Node's default message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Syscall {
    Open,
    Write,
    Fsync,
    Close,
    Rename,
}

impl Syscall {
    const fn name(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Write => "write",
            Self::Fsync => "fsync",
            Self::Close => "close",
            Self::Rename => "rename",
        }
    }
}

/// The errno values the messages depend on: identical on Linux and macOS except where noted.
mod errno {
    pub const EPERM: i32 = 1;
    pub const ENOENT: i32 = 2;
    pub const EIO: i32 = 5;
    pub const EBADF: i32 = 9;
    pub const EACCES: i32 = 13;
    pub const EBUSY: i32 = 16;
    pub const EEXIST: i32 = 17;
    pub const EXDEV: i32 = 18;
    pub const ENOTDIR: i32 = 20;
    pub const EISDIR: i32 = 21;
    pub const EINVAL: i32 = 22;
    pub const ENFILE: i32 = 23;
    pub const EMFILE: i32 = 24;
    pub const ETXTBSY: i32 = 26;
    pub const ENOSPC: i32 = 28;
    pub const EROFS: i32 = 30;
    #[cfg(target_os = "linux")]
    pub const ENAMETOOLONG: i32 = 36;
    #[cfg(not(target_os = "linux"))]
    pub const ENAMETOOLONG: i32 = 63;
    #[cfg(target_os = "linux")]
    pub const ELOOP: i32 = 40;
    #[cfg(not(target_os = "linux"))]
    pub const ELOOP: i32 = 62;
}

/// `(code, libuv description)` of an errno, as Node names it in `error.message`.
fn uv_error(raw: i32) -> Option<(&'static str, &'static str)> {
    Some(match raw {
        errno::EPERM => ("EPERM", "operation not permitted"),
        errno::ENOENT => ("ENOENT", "no such file or directory"),
        errno::EIO => ("EIO", "i/o error"),
        errno::EBADF => ("EBADF", "bad file descriptor"),
        errno::EACCES => ("EACCES", "permission denied"),
        errno::EBUSY => ("EBUSY", "resource busy or locked"),
        errno::EEXIST => ("EEXIST", "file already exists"),
        errno::EXDEV => ("EXDEV", "cross-device link not permitted"),
        errno::ENOTDIR => ("ENOTDIR", "not a directory"),
        errno::EISDIR => ("EISDIR", "illegal operation on a directory"),
        errno::EINVAL => ("EINVAL", "invalid argument"),
        errno::ENFILE => ("ENFILE", "file table overflow"),
        errno::EMFILE => ("EMFILE", "too many open files"),
        errno::ETXTBSY => ("ETXTBSY", "text file is busy"),
        errno::ENOSPC => ("ENOSPC", "no space left on device"),
        errno::EROFS => ("EROFS", "read-only file system"),
        errno::ENAMETOOLONG => ("ENAMETOOLONG", "name too long"),
        errno::ELOOP => ("ELOOP", "too many symbolic links encountered"),
        _ => return None,
    })
}

/// Node's `error.message` for a failed fs call: `CODE: description, syscall 'path'` (`-> 'dest'`
/// for a rename; no path for calls on a descriptor). An errno outside the table keeps the OS text.
fn node_message(error: &io::Error, syscall: Syscall, path: &Path, dest: Option<&Path>) -> String {
    let Some((code, description)) = error.raw_os_error().and_then(uv_error) else {
        return error.to_string();
    };
    let target = match syscall {
        Syscall::Write | Syscall::Fsync | Syscall::Close => String::new(),
        Syscall::Open | Syscall::Rename => format!(" '{}'", path.display()),
    };
    let dest = dest.map_or_else(String::new, |d| format!(" -> '{}'", d.display()));
    format!("{code}: {description}, {}{target}{dest}", syscall.name())
}

/// `friendlyFsError(err, target)`: the known errnos name the destination and a hint; any other
/// keeps Node's own message.
fn friendly_fs_error(
    error: &io::Error,
    syscall: Syscall,
    path: &Path,
    dest: Option<&Path>,
    target: &Path,
) -> FsError {
    let target = target.display();
    let message = match error.raw_os_error() {
        Some(errno::EACCES) => format!(
            "Cannot write {target}: permission denied. Check that you own the file and the parent directory is writable."
        ),
        Some(errno::EROFS) => format!("Cannot write {target}: filesystem is read-only."),
        Some(errno::EISDIR) => format!(
            "Cannot write {target}: a directory exists at that path. Remove it or choose another location."
        ),
        Some(errno::ENOSPC) => format!("Cannot write {target}: no space left on device."),
        Some(errno::ENOENT) => {
            format!("Cannot write {target}: a directory in the path does not exist.")
        }
        Some(errno::ENAMETOOLONG) => {
            format!("Cannot write {target}: path is too long for this filesystem.")
        }
        _ => node_message(error, syscall, path, dest),
    };
    FsError { message }
}

/// `randomBytes(6).toString("hex")`: twelve hex digits from the OS.
fn random_hex() -> String {
    let mut bytes = [0_u8; 6];
    let filled = File::open("/dev/urandom").and_then(|mut f| f.read_exact(&mut bytes));
    if filled.is_err() {
        // Uniqueness, not secrecy, is what the name needs: fall back to the std hasher's seed.
        use std::hash::{BuildHasher, RandomState};
        let seed = RandomState::new().hash_one(std::process::id());
        bytes.copy_from_slice(&seed.to_le_bytes()[..6]);
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// `.<base>.navori.tmp.<hex>`, next to `dest`.
fn temp_path(dest: &Path) -> PathBuf {
    let base = dest
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let name = format!(".{base}.navori.tmp.{}", random_hex());
    dest.parent()
        .map_or_else(|| PathBuf::from(&name), |dir| dir.join(&name))
}

/// `writeFileAtomic(destPath, content)` over `fs`.
///
/// # Errors
/// [`FsError`] with the message `writeFileAtomic` throws; the temporary is removed first.
pub fn write_file_atomic(fs: &mut dyn Fs, dest: &Path, content: &str) -> Result<(), FsError> {
    let tmp = temp_path(dest);
    let result = (|| -> Result<(), (io::Error, Syscall)> {
        let file = fs.create(&tmp, 0o644).map_err(|e| (e, Syscall::Open))?;
        let written = fs
            .write(file, content.as_bytes())
            .map_err(|e| (e, Syscall::Write))
            .and_then(|()| fs.fsync(file).map_err(|e| (e, Syscall::Fsync)));
        // `finally { closeSync(fd) }`: a throwing `finally` replaces the body's error.
        let closed = fs.close(file).map_err(|e| (e, Syscall::Close));
        closed.and(written)?;
        fs.rename(&tmp, dest).map_err(|e| (e, Syscall::Rename))
    })();
    result.map_err(|(error, syscall)| {
        // Best-effort cleanup of the temp file so we don't litter the directory.
        let _ = fs.remove(&tmp, false);
        let dest_of = (syscall == Syscall::Rename).then_some(dest);
        friendly_fs_error(&error, syscall, &tmp, dest_of, dest)
    })
}

/// Fault injection over another [`Fs`], for tests only (D24).
#[cfg(feature = "fault-injection")]
pub mod fault {
    use super::{FileId, Fs, Op};
    use std::collections::BTreeMap;
    use std::io;
    use std::path::{Path, PathBuf};

    /// A kind of mutation.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Kind {
        /// [`Fs::create`].
        Create,
        /// [`Fs::write`].
        Write,
        /// [`Fs::fsync`].
        Fsync,
        /// [`Fs::close`].
        Close,
        /// [`Fs::rename`].
        Rename,
        /// [`Fs::remove`].
        Remove,
    }

    impl Kind {
        /// The kind of a recorded op.
        #[must_use]
        pub const fn of(op: &Op) -> Self {
            match op {
                Op::Create { .. } => Self::Create,
                Op::Write { .. } => Self::Write,
                Op::Fsync { .. } => Self::Fsync,
                Op::Close { .. } => Self::Close,
                Op::Rename { .. } => Self::Rename,
                Op::Remove { .. } => Self::Remove,
            }
        }
    }

    /// Delegates to `inner`, records every op it is asked for, and fails the `nth` (from 0) op of
    /// `kind` with `errno`, without performing it (a failed close still releases the file).
    #[derive(Debug)]
    pub struct FaultFs<F> {
        /// The filesystem underneath.
        pub inner: F,
        /// Every op asked for, failed ones included.
        pub trace: Vec<Op>,
        /// `(kind, nth, errno)`.
        pub fail: Option<(Kind, usize, i32)>,
        paths: BTreeMap<FileId, PathBuf>,
    }

    impl<F: Fs> FaultFs<F> {
        /// Wraps `inner`.
        pub fn new(inner: F, fail: Option<(Kind, usize, i32)>) -> Self {
            Self {
                inner,
                trace: Vec::new(),
                fail,
                paths: BTreeMap::new(),
            }
        }

        fn record(&mut self, op: Op) -> io::Result<()> {
            let kind = Kind::of(&op);
            let seen = self.trace.iter().filter(|o| Kind::of(o) == kind).count();
            self.trace.push(op);
            match self.fail {
                Some((k, nth, errno)) if k == kind && nth == seen => {
                    Err(io::Error::from_raw_os_error(errno))
                }
                _ => Ok(()),
            }
        }

        fn path(&self, file: FileId) -> PathBuf {
            self.paths.get(&file).cloned().unwrap_or_default()
        }
    }

    impl<F: Fs> Fs for FaultFs<F> {
        fn create(&mut self, path: &Path, mode: u32) -> io::Result<FileId> {
            self.record(Op::Create {
                path: path.to_path_buf(),
                mode,
            })?;
            let file = self.inner.create(path, mode)?;
            self.paths.insert(file, path.to_path_buf());
            Ok(file)
        }

        fn write(&mut self, file: FileId, bytes: &[u8]) -> io::Result<()> {
            let path = self.path(file);
            self.record(Op::Write {
                path,
                bytes: bytes.to_vec(),
            })?;
            self.inner.write(file, bytes)
        }

        fn fsync(&mut self, file: FileId) -> io::Result<()> {
            let path = self.path(file);
            self.record(Op::Fsync { path })?;
            self.inner.fsync(file)
        }

        fn close(&mut self, file: FileId) -> io::Result<()> {
            let path = self.path(file);
            let injected = self.record(Op::Close { path });
            let closed = self.inner.close(file);
            injected.and(closed)
        }

        fn rename(&mut self, from: &Path, to: &Path) -> io::Result<()> {
            self.record(Op::Rename {
                from: from.to_path_buf(),
                to: to.to_path_buf(),
            })?;
            self.inner.rename(from, to)
        }

        fn remove(&mut self, path: &Path, recursive: bool) -> io::Result<()> {
            self.record(Op::Remove {
                path: path.to_path_buf(),
                recursive,
            })?;
            self.inner.remove(path, recursive)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recording_fs_keeps_the_atomic_order() {
        let mut fs = RecordingFs::default();
        let dest = Path::new("/repo/.claude/settings.json");
        assert_eq!(write_file_atomic(&mut fs, dest, "{}\n"), Ok(()));
        let Some(Op::Create { path: tmp, mode }) = fs.ops.first().cloned() else {
            panic!("no create: {:?}", fs.ops);
        };
        assert_eq!(mode, 0o644);
        let name = tmp
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let hex = name
            .strip_prefix(".settings.json.navori.tmp.")
            .unwrap_or_default();
        assert!(
            hex.len() == 12 && hex.bytes().all(|b| b.is_ascii_hexdigit()),
            "{name}"
        );
        assert_eq!(tmp.parent(), dest.parent());
        assert_eq!(
            fs.ops[1..],
            [
                Op::Write {
                    path: tmp.clone(),
                    bytes: b"{}\n".to_vec()
                },
                Op::Fsync { path: tmp.clone() },
                Op::Close { path: tmp.clone() },
                Op::Rename {
                    from: tmp,
                    to: dest.to_path_buf()
                },
            ]
        );
    }

    #[test]
    fn known_errnos_get_the_friendly_text_and_others_nodes_message() {
        let tmp = Path::new("/r/.a.navori.tmp.0123456789ab");
        let dest = Path::new("/r/a");
        let msg = |raw: i32, syscall: Syscall| {
            let to = (syscall == Syscall::Rename).then_some(dest);
            friendly_fs_error(&io::Error::from_raw_os_error(raw), syscall, tmp, to, dest).message
        };
        assert_eq!(
            msg(errno::EROFS, Syscall::Open),
            "Cannot write /r/a: filesystem is read-only."
        );
        assert_eq!(
            msg(errno::ENOSPC, Syscall::Write),
            "Cannot write /r/a: no space left on device."
        );
        assert_eq!(
            msg(errno::ENAMETOOLONG, Syscall::Open),
            "Cannot write /r/a: path is too long for this filesystem."
        );
        assert_eq!(
            msg(errno::EXDEV, Syscall::Rename),
            "EXDEV: cross-device link not permitted, rename '/r/.a.navori.tmp.0123456789ab' -> '/r/a'"
        );
        assert_eq!(msg(errno::EIO, Syscall::Fsync), "EIO: i/o error, fsync");
        assert_eq!(
            msg(errno::EPERM, Syscall::Open),
            "EPERM: operation not permitted, open '/r/.a.navori.tmp.0123456789ab'"
        );
    }
}
