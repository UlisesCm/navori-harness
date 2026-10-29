//! Port of `lib/diagnose/source-classify.ts`: what counts as a non-trivial source file, decided
//! from paths alone (clauses (a) and (c) of the TS module; clause (b) needs the diff content).
//!
//! The rules are the TS literals, in the same order (first match wins). JS `.` never matches a line
//! terminator, so it is spelled `[^\n\r\u{2028}\u{2029}]` here; no rule uses `\d`, `\s` or `\w`.

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;

/// How a path relates to the change, most specific first.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PathKind {
    OutsideRepo,
    Ephemeral,
    Dependency,
    Generated,
    Lockfile,
    Fixture,
    Test,
    Config,
    Docs,
    Source,
}

impl PathKind {
    /// The TS name of the kind (`excluded` keys).
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::OutsideRepo => "outside-repo",
            Self::Ephemeral => "ephemeral",
            Self::Dependency => "dependency",
            Self::Generated => "generated",
            Self::Lockfile => "lockfile",
            Self::Fixture => "fixture",
            Self::Test => "test",
            Self::Config => "config",
            Self::Docs => "docs",
            Self::Source => "source",
        }
    }
}

const RULES: &[(PathKind, &str)] = &[
    (PathKind::Ephemeral, r"(^|/)\.claude/(progress|worktrees)/"),
    (PathKind::Ephemeral, r"(^|/)(scratchpad|\.scratch)/"),
    (PathKind::Dependency, r"(^|/)node_modules/"),
    (
        PathKind::Dependency,
        r"(^|/)(dist|build|out|coverage|\.next|\.astro)/",
    ),
    (PathKind::Generated, r"(^|/)\.claude/"),
    (PathKind::Generated, r"(^|/)(CLAUDE|AGENTS)\.md$"),
    (PathKind::Generated, r"(^|/)\.mcp\.json$"),
    (PathKind::Generated, r"(^|/)__golden__/|\.snap$"),
    (
        PathKind::Lockfile,
        r"(^|/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum)$",
    ),
    (
        PathKind::Fixture,
        r"(^|/)(__fixtures__|__mocks__|fixtures)/",
    ),
    (PathKind::Test, r"\.(test|spec)\.[mc]?[jt]sx?$"),
    (PathKind::Test, r"(^|/)(__tests__|tests?)/"),
    (
        PathKind::Test,
        r"(^|/)(test|tests)_[^/]+\.py$|(^|/)[^/]+_test\.(py|go)$",
    ),
    (
        PathKind::Config,
        r"(^|/)(package\.json|tsconfig[^/]*\.json|jsconfig\.json|biome\.jsonc?|\.eslintrc[^/]*|\.prettierrc[^/]*|\.editorconfig|\.gitignore|\.npmrc|\.nvmrc)$",
    ),
    (PathKind::Config, r"(^|/)navori\.config\.json$"),
    (
        PathKind::Docs,
        r"(^|/)(docs|specs)/|(^|/)(README|CONTRIBUTING|CHANGELOG|LICENSE)[^/]*$",
    ),
    (PathKind::Docs, r"(^|/)progress/"),
];

const SOURCE_EXT: &str = r"\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|sh|bash|zsh|sql|vue|svelte|astro|ipynb)$";
const HARNESS_PROSE: &str =
    r"(^|/)(core-assets|plugins)/([^\n\r\u{2028}\u{2029}]*/)?(agents|skills|managed)/[^/]+\.md$";
const LOCAL_SKILL_PATH: &str = r"^\.claude/skills/([^/]+)/";

struct Compiled {
    rules: Vec<(PathKind, Regex)>,
    source_ext: Regex,
    harness_prose: Regex,
    local_skill: Regex,
}

static COMPILED: LazyLock<Option<Compiled>> = LazyLock::new(|| {
    Some(Compiled {
        rules: RULES
            .iter()
            .map(|(kind, re)| Regex::new(re).ok().map(|re| (*kind, re)))
            .collect::<Option<_>>()?,
        source_ext: Regex::new(SOURCE_EXT).ok()?,
        harness_prose: Regex::new(HARNESS_PROSE).ok()?,
        local_skill: Regex::new(LOCAL_SKILL_PATH).ok()?,
    })
});

/// `toRepoRelative`: a repo-relative POSIX path, or `None` when it is outside the repo.
#[must_use]
pub fn to_repo_relative(file_path: &str, repo_root: &str) -> Option<String> {
    if file_path.is_empty() {
        return None;
    }
    let p = file_path.replace('\\', "/");
    let root = repo_root.replace('\\', "/");
    let root = root.trim_end_matches('/');
    let strip_dot = |s: &str| s.strip_prefix("./").unwrap_or(s).to_owned();
    if root.is_empty() {
        return Some(strip_dot(&p));
    }
    if p == root {
        return Some(String::new());
    }
    if let Some(rest) = p.strip_prefix(root).and_then(|r| r.strip_prefix('/')) {
        return Some(rest.to_owned());
    }
    if p.starts_with('/') {
        None
    } else {
        Some(strip_dot(&p))
    }
}

/// `classifyPath`: clause (a), decided from the path alone. `None` only if a rule failed to
/// compile, which the tests rule out.
#[must_use]
pub fn classify_path(
    file_path: &str,
    repo_root: &str,
    local_skill_ids: Option<&BTreeSet<String>>,
) -> Option<PathKind> {
    let compiled = COMPILED.as_ref()?;
    let Some(rel) = to_repo_relative(file_path, repo_root) else {
        return Some(PathKind::OutsideRepo);
    };
    if let Some(ids) = local_skill_ids.filter(|ids| !ids.is_empty()) {
        let local = compiled
            .local_skill
            .captures(&rel)
            .and_then(|c| c.get(1))
            .is_some_and(|id| ids.contains(id.as_str()));
        if local {
            return Some(PathKind::Source);
        }
    }
    for (kind, re) in &compiled.rules {
        if re.is_match(&rel) {
            return Some(*kind);
        }
    }
    if compiled.harness_prose.is_match(&rel) || compiled.source_ext.is_match(&rel) {
        return Some(PathKind::Source);
    }
    Some(PathKind::Docs)
}

/// `countNonTrivial`: a CEILING (clause (b) needs the diff content), with what counted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NonTrivialCount {
    pub ceiling: usize,
    pub counted: Vec<String>,
}

/// `countNonTrivial`: clauses (a) and (c) over the paths of one change.
#[must_use]
pub fn count_non_trivial(
    paths: &[String],
    repo_root: &str,
    local_skill_ids: Option<&BTreeSet<String>>,
) -> Option<NonTrivialCount> {
    let mut counted = Vec::new();
    let mut tests = Vec::new();
    for path in paths {
        match classify_path(path, repo_root, local_skill_ids)? {
            PathKind::Source => counted.push(path.clone()),
            PathKind::Test => tests.push(path.clone()),
            _ => {}
        }
    }
    if counted.is_empty() {
        counted = tests;
    }
    Some(NonTrivialCount {
        ceiling: counted.len(),
        counted,
    })
}
