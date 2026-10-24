//! Build-time source inventory shared with tests; generated artifacts never enter src/.

use std::error::Error;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

type BuildResult<T> = Result<T, Box<dyn Error>>;

/// Inventory of regular source files, sorted by JS UTF-16 path ordering.
pub struct Sources {
    root: PathBuf,
    files: Vec<(String, PathBuf)>,
    directories: Vec<PathBuf>,
}

impl Sources {
    /// Read every source directory, rejecting symlinks and special files even in other hooks.
    pub fn read(root: &Path) -> BuildResult<Self> {
        let mut sources = Self {
            root: root.to_path_buf(),
            files: Vec::new(),
            directories: Vec::new(),
        };
        sources.walk(root)?;
        sources
            .files
            .sort_by(|left, right| left.0.encode_utf16().cmp(right.0.encode_utf16()));
        Ok(sources)
    }

    fn walk(&mut self, directory: &Path) -> BuildResult<()> {
        let kind = fs::symlink_metadata(directory)?.file_type();
        if !kind.is_dir() || kind.is_symlink() {
            return Err("non-directory or symlink in Rust sources".into());
        }
        self.directories.push(directory.to_path_buf());
        for entry in fs::read_dir(directory)? {
            let path = entry?.path();
            let kind = fs::symlink_metadata(&path)?.file_type();
            if kind.is_symlink() {
                return Err("symlink in Rust sources".into());
            }
            if kind.is_dir() {
                self.walk(&path)?;
            } else if kind.is_file() {
                let name = path
                    .strip_prefix(&self.root)?
                    .to_str()
                    .ok_or("non-UTF-8 source path")?
                    .to_owned();
                self.files.push((name, path));
            } else {
                return Err("non-regular file in Rust sources".into());
            }
        }
        Ok(())
    }

    /// All directories and files must be watched to catch edits, additions and removals.
    pub fn watched_paths(&self) -> impl Iterator<Item = &Path> {
        self.directories
            .iter()
            .map(PathBuf::as_path)
            .chain(self.files.iter().map(|(_, path)| path.as_path()))
    }

    /// D8: exact source bytes prefixed by relative path + NUL and followed by NUL.
    pub fn implementation_hash(&self, id: &str) -> BuildResult<String> {
        if id.is_empty()
            || !id.bytes().all(|byte| {
                byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
            })
        {
            return Err("invalid hook id".into());
        }
        let local = self.root.join("hooks").join(id.replace('-', "_"));
        if !self.directories.contains(&local) {
            return Err("missing hook sources".into());
        }
        let mut hash = Sha256::new();
        for (relative, path) in &self.files {
            if relative.starts_with("hooks/") && !path.starts_with(&local) {
                continue;
            }
            if !fs::symlink_metadata(path)?.file_type().is_file() {
                return Err("non-regular file in Rust sources".into());
            }
            hash.update(relative.as_bytes());
            hash.update([0]);
            hash.update(fs::read(path)?);
            hash.update([0]);
        }
        let hex: String = hash
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        Ok(format!("sha256:{hex}"))
    }

    /// Generate only hash data in OUT_DIR; no generated source can hash its own digest.
    pub fn table(&self) -> BuildResult<String> {
        let hooks = self.root.join("hooks");
        let mut names: Vec<&str> = self
            .directories
            .iter()
            .filter(|path| path.parent() == Some(hooks.as_path()))
            .filter_map(|path| path.file_name()?.to_str())
            .filter(|name| {
                !name.is_empty()
                    && name.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                    })
            })
            .collect();
        names.sort_unstable();
        let mut output = String::from("static IMPLEMENTATION_HASHES: &[(&str, &str)] = &[\n");
        for name in names {
            writeln!(
                output,
                "    ({name:?}, {:?}),",
                self.implementation_hash(name)?
            )?;
        }
        output.push_str("];\n");
        Ok(output)
    }
}
