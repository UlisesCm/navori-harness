//! Port of `lib/plan/classify.ts` and its weights (`signals.ts`): the plan level a set of files
//! and declared signals compute to, plus the `criticalPaths` glob matcher and path normalizer.

use std::collections::BTreeSet;

use crate::diagnose::source_classify::count_non_trivial;
use crate::posix::{js_trim, normalize};

const FLOOR_LEVEL: u8 = 2;
const CRITICAL_AREA_WEIGHT: u32 = 3;
const BUG_WITHOUT_ROOT_CAUSE_WEIGHT: u32 = 2;
const MAX_SCORE: u32 = 10;
const LEVEL_ZERO_MAX_SCORE: u32 = 3;
const LEVEL_ZERO_MAX_NONTRIVIAL_FILES: usize = 1;
const LEVEL_TWO_MIN_SCORE: u32 = 8;

fn non_trivial_file_weight(ceiling: usize) -> u32 {
    match ceiling {
        0 | 1 => 0,
        2 | 3 => 2,
        4..=7 => 3,
        _ => 4,
    }
}

fn root_dir_weight(distinct: usize) -> u32 {
    match distinct {
        0 | 1 => 0,
        2 => 1,
        _ => 2,
    }
}

/// `normalizeRepoPath`: the path plus the two shapes that are not repo-relative.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedRepoPath {
    pub path: String,
    pub absolute: bool,
    pub escapes: bool,
}

/// `normalizeRepoPath`: `\` to `/`, `posix.normalize`, no trailing `/`, `.` to empty.
#[must_use]
pub fn normalize_repo_path(input: &str) -> NormalizedRepoPath {
    let slashed = js_trim(input).replace('\\', "/");
    let bytes = slashed.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && &bytes[1..3] == b":/";
    let absolute = slashed.starts_with('/') || drive;
    let mut path = normalize(&slashed);
    if path.len() > 1 && path.ends_with('/') {
        path.pop();
    }
    if path == "." {
        path.clear();
    }
    let escapes = path == ".." || path.starts_with("../");
    NormalizedRepoPath {
        path,
        absolute,
        escapes,
    }
}

fn matches_segment(segment: &str, pattern: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    if parts.len() == 1 {
        return segment == pattern;
    }
    let first = parts.first().copied().unwrap_or("");
    let last = parts.last().copied().unwrap_or("");
    if !segment.starts_with(first) || !segment.ends_with(last) {
        return false;
    }
    let Some(upper) = segment.len().checked_sub(last.len()) else {
        return false;
    };
    let mut cursor = first.len();
    for middle in &parts[1..parts.len() - 1] {
        if middle.is_empty() {
            continue;
        }
        let Some(found) = segment.get(cursor..).and_then(|rest| rest.find(middle)) else {
            return false;
        };
        let index = cursor + found;
        if index > upper {
            return false;
        }
        cursor = index + middle.len();
    }
    cursor <= upper
}

fn matches_glob_segments(path: &[&str], pattern: &[&str]) -> bool {
    let Some((head, rest)) = pattern.split_first() else {
        return path.is_empty();
    };
    if *head == "**" {
        return (0..=path.len()).any(|i| matches_glob_segments(&path[i..], rest));
    }
    match path.split_first() {
        Some((first, tail)) => matches_segment(first, head) && matches_glob_segments(tail, rest),
        None => false,
    }
}

/// `matchesCriticalPaths`: whether any file (normalized here) matches a `criticalPaths` glob.
#[must_use]
pub fn matches_critical_paths(files: &[String], critical_paths: &[String]) -> bool {
    if critical_paths.is_empty() {
        return false;
    }
    let patterns: Vec<Vec<&str>> = critical_paths
        .iter()
        .map(|g| g.split('/').collect())
        .collect();
    files.iter().any(|file| {
        let normalized = normalize_repo_path(file).path;
        let segments: Vec<&str> = normalized.split('/').collect();
        patterns.iter().any(|p| matches_glob_segments(&segments, p))
    })
}

/// `ClassifyInput`: the files plus the declared signals and project context.
#[derive(Debug, Clone, Default)]
pub struct ClassifyInput {
    pub files: Vec<String>,
    pub money_credentials_pii: bool,
    pub multi_repo: bool,
    pub new_external_dependency: bool,
    pub shared_contract: bool,
    pub data_schema_migration: bool,
    pub critical_area: bool,
    pub critical_paths: Vec<String>,
    pub bug_without_root_cause: bool,
    pub local_skill_ids: Option<BTreeSet<String>>,
}

/// `ClassifyResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassifyResult {
    pub score: u32,
    pub level: u8,
    pub signals: Vec<String>,
    pub non_trivial_ceiling: usize,
}

/// `classify`. `None` only if a path rule failed to compile.
#[must_use]
pub fn classify(input: &ClassifyInput) -> Option<ClassifyResult> {
    let files: Vec<String> = input
        .files
        .iter()
        .map(|f| normalize_repo_path(f).path)
        .filter(|f| !f.is_empty())
        .collect();
    let ceiling = count_non_trivial(&files, "", input.local_skill_ids.as_ref())?.ceiling;
    let mut signals = Vec::new();
    let mut score = 0;

    let file_weight = non_trivial_file_weight(ceiling);
    if file_weight > 0 {
        signals.push(format!("non-trivial-files:{ceiling}(+{file_weight})"));
    }
    score += file_weight;

    let roots: BTreeSet<String> = files
        .iter()
        .map(|f| f.split('/').take(2).collect::<Vec<_>>().join("/"))
        .collect();
    let dir_weight = root_dir_weight(roots.len());
    if dir_weight > 0 {
        signals.push(format!("root-dirs:{}(+{dir_weight})", roots.len()));
    }
    score += dir_weight;

    if input.bug_without_root_cause {
        signals.push(format!(
            "bug-without-root-cause(+{BUG_WITHOUT_ROOT_CAUSE_WEIGHT})"
        ));
        score += BUG_WITHOUT_ROOT_CAUSE_WEIGHT;
    }

    let matched = matches_critical_paths(&files, &input.critical_paths);
    if matched || input.critical_area {
        let how = if matched { "matched" } else { "declared" };
        signals.push(format!("critical-area:{how}(+{CRITICAL_AREA_WEIGHT})"));
        score += CRITICAL_AREA_WEIGHT;
    }

    let floors = [
        (input.money_credentials_pii, "money-credentials-pii"),
        (input.multi_repo, "multi-repo"),
        (input.new_external_dependency, "new-external-dependency"),
        (input.shared_contract, "shared-contract"),
        (input.data_schema_migration, "data-schema-migration"),
    ];
    let mut floored = false;
    for (on, name) in floors {
        if on {
            floored = true;
            signals.push(format!("floor:{name}"));
        }
    }

    let score = score.min(MAX_SCORE);
    let level = if floored {
        FLOOR_LEVEL
    } else if score <= LEVEL_ZERO_MAX_SCORE && ceiling <= LEVEL_ZERO_MAX_NONTRIVIAL_FILES {
        0
    } else if score >= LEVEL_TWO_MIN_SCORE {
        2
    } else {
        1
    };
    Some(ClassifyResult {
        score,
        level,
        signals,
        non_trivial_ceiling: ceiling,
    })
}

/// `declaredFlagsFromSignals`: the declared flags a stored `classification.signals` carries.
#[must_use]
pub fn declared_flags_from_signals(signals: &[String]) -> ClassifyInput {
    let has = |needle: &str| signals.iter().any(|s| s.starts_with(needle));
    ClassifyInput {
        money_credentials_pii: has("floor:money-credentials-pii"),
        multi_repo: has("floor:multi-repo"),
        new_external_dependency: has("floor:new-external-dependency"),
        shared_contract: has("floor:shared-contract"),
        data_schema_migration: has("floor:data-schema-migration"),
        critical_area: has("critical-area:declared"),
        bug_without_root_cause: has("bug-without-root-cause"),
        ..ClassifyInput::default()
    }
}
