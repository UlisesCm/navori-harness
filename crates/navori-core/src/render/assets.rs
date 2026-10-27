//! Bundled assets by the paths the TS resolves against `getCoreRoot()` and `getPluginPath()`
//! (`lib/render/bundled-assets.ts`). The table is the one `build.rs` embeds: the same roots, so a
//! fresh `dist/` copy and these bytes are identical.

use crate::assets::ASSETS;

/// Linear on purpose: `build.rs` sorts `PathBuf`s component-wise, which is not `str` order
/// (`a/b` sorts before `a-b`), so a binary search by string could miss an entry.
fn lookup(path: &str) -> Option<&'static [u8]> {
    ASSETS
        .iter()
        .find_map(|(candidate, bytes)| (*candidate == path).then_some(*bytes))
}

/// A file under the core package, e.g. `core-assets/hooks/_partials/extract-cmd.sh`.
#[must_use]
pub fn core(relative: &str) -> Option<&'static [u8]> {
    lookup(&format!("packages/core/{relative}"))
}

/// A file under a bundled plugin, e.g. (`tgrep`, `hooks/…`).
#[must_use]
pub fn plugin(id: &str, relative: &str) -> Option<&'static [u8]> {
    lookup(&format!("packages/plugins/{id}/{relative}"))
}

/// Every bundled file whose path starts with `prefix` (repo-relative), in path order.
pub fn under(prefix: &str) -> impl Iterator<Item = (&'static str, &'static [u8])> + '_ {
    ASSETS
        .iter()
        .copied()
        .filter(move |(path, _)| path.starts_with(prefix))
}
