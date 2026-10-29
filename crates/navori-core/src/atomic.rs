//! `lib/primitives/atomic.ts` (`writeFileAtomic`) and the random values the ported primitives
//! draw from Node's `crypto`, read from `/dev/urandom`.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read as _, Write as _};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::Path;

/// `n` random bytes.
///
/// # Errors
/// `/dev/urandom` cannot be read.
pub fn random_bytes<const N: usize>() -> io::Result<[u8; N]> {
    let mut bytes = [0u8; N];
    File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes)
}

/// `randomUUID()`: a lowercase version 4 UUID.
///
/// # Errors
/// `/dev/urandom` cannot be read.
pub fn random_uuid() -> io::Result<String> {
    let mut bytes = random_bytes::<16>()?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    ))
}

/// `writeFileAtomic(dest, content)`: a `.<base>.navori.tmp.<12 hex>` sibling opened with mode
/// `0o644` (before the umask), written, fsynced and renamed over `dest`. The temporary is removed
/// on any failure.
///
/// # Errors
/// Any failure to write or rename; the TS throws there.
pub fn write_file_atomic(dest: &Path, content: &[u8]) -> io::Result<()> {
    let base = dest
        .file_name()
        .ok_or_else(|| io::Error::other("destination has no file name"))?
        .to_string_lossy()
        .into_owned();
    let suffix: String = random_bytes::<6>()?
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    let temporary = dest.with_file_name(format!(".{base}.navori.tmp.{suffix}"));
    let written = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o644)
            .open(&temporary)?;
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, dest)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}
