//! Generated from `packages/cli/src/lib/assets/library-skills.ts` (registry data only).
//! `presets_parity::registry_and_every_bundled_preset_match` fails when the TS table changes;
//! regenerate this file then. The detection half (`LIBRARY_SKILL_SIGNALS`, `MIGRATION_PAIRS` and
//! the `detect*` functions, spec 0060 T23) is hand-ported from the same file.

use std::collections::{HashMap, HashSet};
use std::path::Path;

/// `(id, label)` of every `LIBRARY_SKILLS` entry, in registry order.
pub const LIBRARY_SKILLS: &[(&str, &str)] = &[
    ("react-router", "React Router"),
    ("axios", "Axios HTTP"),
    ("socketio-server", "Socket.IO server"),
    ("socketio-client", "Socket.IO client"),
    ("redux-toolkit", "Redux Toolkit"),
    ("tanstack-query", "TanStack Query"),
    ("react-hook-form", "React Hook Form"),
    ("mantine-ui-patterns", "Mantine UI"),
    ("mantine-form", "Mantine Form"),
    ("mongoose", "Mongoose ODM"),
    ("drizzle-orm", "Drizzle ORM"),
    ("expo-sqlite", "Expo SQLite"),
    ("supabase", "Supabase client & auth"),
    ("supabase-postgres", "Supabase Postgres & RLS"),
    ("supabase-edge-functions", "Supabase Edge Functions"),
    ("supabase-selfhost", "Self-hosted Supabase"),
    ("zod-validation", "Zod validation"),
    ("winston-logging", "Winston logging"),
    ("stripe", "Stripe payments"),
    ("apollo-client", "Apollo Client"),
    ("zustand", "Zustand"),
    ("tamagui", "Tamagui"),
    ("uniwind", "Uniwind"),
    ("react-native-reusables", "React Native Reusables"),
    ("react-navigation", "React Navigation"),
    ("expo-router", "expo-router"),
    ("eas-release", "EAS Build/Submit/Update"),
    ("i18next", "i18next"),
    ("bullmq", "BullMQ jobs & queues"),
    ("amqplib", "amqplib (RabbitMQ)"),
    ("hono", "Hono"),
    ("better-auth", "Better Auth"),
    ("react-email", "React Email + Resend"),
    ("tanstack-router", "TanStack Router"),
    ("shadcn-base-ui", "shadcn/ui (Base UI)"),
    ("tailwind-v4", "Tailwind CSS"),
    ("dashboard-patterns", "Admin dashboard patterns"),
    ("vitest", "Vitest"),
    ("jest", "Jest"),
    ("fastapi", "FastAPI + Pydantic"),
    ("pytest", "pytest"),
    ("testing-library", "Testing Library"),
    ("playwright", "Playwright E2E"),
    ("cypress", "Cypress"),
    ("maestro", "Maestro E2E"),
    ("supertest", "SuperTest HTTP"),
    ("citty", "citty CLI"),
    ("clack", "Clack prompts"),
];

/// `REMOVED_LIB_SKILLS`.
pub const REMOVED_LIB_SKILLS: &[&str] = &["formik", "joi-validation", "socketio", "nativewind"];

/// `REMOVED_LIB_SKILL_SUCCESSORS`.
pub const REMOVED_LIB_SKILL_SUCCESSORS: &[(&str, &[&str])] =
    &[("socketio", &["socketio-server", "socketio-client"])];

/// `unknownLibraries(ids)`: each id the registry does not ship, with whether it was retired and
/// its successors.
#[must_use]
pub fn unknown_libraries(ids: &[String]) -> Vec<(String, bool, &'static [&'static str])> {
    ids.iter()
        .filter(|id| !LIBRARY_SKILLS.iter().any(|(known, _)| known == id))
        .map(|id| {
            let successors = REMOVED_LIB_SKILL_SUCCESSORS
                .iter()
                .find(|(removed, _)| removed == id)
                .map_or(&[][..], |(_, s)| *s);
            (
                id.clone(),
                REMOVED_LIB_SKILLS.contains(&id.as_str()),
                successors,
            )
        })
        .collect()
}

/// `librarySkillById`: the label of a registered lib skill.
#[must_use]
pub fn library_skill_label(id: &str) -> Option<&'static str> {
    LIBRARY_SKILLS
        .iter()
        .find_map(|(known, label)| (*known == id).then_some(*label))
}

/// Detection signals of one `LIBRARY_SKILLS` entry: `deps`, `paths` and `minMajor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SkillSignals {
    /// Skill id, in [`LIBRARY_SKILLS`] order.
    pub id: &'static str,
    /// Dependency names; any single one present activates the skill.
    pub deps: &'static [&'static str],
    /// Paths (relative to the scanned directory) whose existence also activates it.
    pub paths: &'static [&'static str],
    /// Lowest major a matched dep's declared range may resolve to.
    pub min_major: Option<u32>,
}

const fn deps(id: &'static str, deps: &'static [&'static str]) -> SkillSignals {
    SkillSignals {
        id,
        deps,
        paths: &[],
        min_major: None,
    }
}

const fn paths(id: &'static str, paths: &'static [&'static str]) -> SkillSignals {
    SkillSignals {
        id,
        deps: &[],
        paths,
        min_major: None,
    }
}

/// The `deps`/`paths`/`minMajor` of every `LIBRARY_SKILLS` entry, in registry order (same ids as
/// [`LIBRARY_SKILLS`]; a unit test pins that).
pub const LIBRARY_SKILL_SIGNALS: &[SkillSignals] = &[
    deps("react-router", &["react-router-dom", "react-router"]),
    deps("axios", &["axios"]),
    deps("socketio-server", &["socket.io"]),
    deps("socketio-client", &["socket.io-client"]),
    deps("redux-toolkit", &["@reduxjs/toolkit", "redux"]),
    deps(
        "tanstack-query",
        &["@tanstack/react-query", "vue-query", "solid-query"],
    ),
    deps("react-hook-form", &["react-hook-form"]),
    deps("mantine-ui-patterns", &["@mantine/core"]),
    deps(
        "mantine-form",
        &["@mantine/form", "mantine-form-zod-resolver"],
    ),
    deps("mongoose", &["mongoose", "@nestjs/mongoose"]),
    deps("drizzle-orm", &["drizzle-orm", "drizzle-kit"]),
    deps("expo-sqlite", &["expo-sqlite"]),
    deps(
        "supabase",
        &["@supabase/supabase-js", "@supabase/server", "supabase"],
    ),
    paths(
        "supabase-postgres",
        &["supabase/migrations", "supabase/schemas"],
    ),
    paths(
        "supabase-edge-functions",
        &["supabase/functions", "volumes/functions"],
    ),
    paths(
        "supabase-selfhost",
        &[
            "volumes/api/envoy/lds.template.yaml",
            "volumes/functions/main/index.ts",
            "volumes/api/kong.yml",
            "docker/volumes/api/envoy/lds.template.yaml",
            "docker/volumes/functions/main/index.ts",
            "docker/volumes/api/kong.yml",
            "supabase-project/volumes/api/envoy/lds.template.yaml",
            "supabase-project/volumes/functions/main/index.ts",
            "supabase-project/volumes/api/kong.yml",
        ],
    ),
    deps("zod-validation", &["zod"]),
    deps("winston-logging", &["winston"]),
    deps(
        "stripe",
        &["stripe", "@stripe/stripe-js", "@stripe/react-stripe-js"],
    ),
    deps("apollo-client", &["@apollo/client"]),
    deps("zustand", &["zustand"]),
    deps("tamagui", &["tamagui", "@tamagui/core"]),
    deps("uniwind", &["uniwind"]),
    deps(
        "react-native-reusables",
        &["@rn-primitives/portal", "@rn-primitives/slot"],
    ),
    deps("react-navigation", &["@react-navigation/native"]),
    deps("expo-router", &["expo-router"]),
    paths("eas-release", &["eas.json"]),
    deps("i18next", &["i18next", "react-i18next"]),
    deps("bullmq", &["bullmq"]),
    deps("amqplib", &["amqplib"]),
    deps("hono", &["hono"]),
    deps("better-auth", &["better-auth"]),
    deps("react-email", &["@react-email/components", "resend"]),
    deps("tanstack-router", &["@tanstack/react-router"]),
    deps("shadcn-base-ui", &["@base-ui/react", "shadcn"]),
    SkillSignals {
        id: "tailwind-v4",
        deps: &["tailwindcss"],
        paths: &[],
        min_major: Some(4),
    },
    deps(
        "dashboard-patterns",
        &[
            "@tanstack/react-table",
            "mantine-react-table",
            "mantine-datatable",
            "ag-grid-react",
            "react-admin",
            "@refinedev/core",
        ],
    ),
    deps("vitest", &["vitest"]),
    deps("jest", &["jest", "jest-expo"]),
    deps("fastapi", &["fastapi"]),
    deps("pytest", &["pytest"]),
    deps(
        "testing-library",
        &[
            "@testing-library/react",
            "@testing-library/react-native",
            "@testing-library/dom",
            "@testing-library/vue",
            "@testing-library/svelte",
            "@testing-library/user-event",
            "@testing-library/cypress",
        ],
    ),
    deps("playwright", &["@playwright/test", "playwright"]),
    deps("cypress", &["cypress"]),
    paths("maestro", &[".maestro"]),
    deps("supertest", &["supertest"]),
    deps("citty", &["citty"]),
    deps("clack", &["@clack/prompts"]),
];

/// `parseMajorVersion(range)`: the leading major of a declared range (`^3.3.5`, `~3`, `3.x`,
/// `>=3`), `None` for `workspace:*`, `latest`, `*`, git URLs and the like.
#[must_use]
pub fn parse_major_version(range: &str) -> Option<f64> {
    let text = crate::posix::js_trim(range);
    let text = ["^", "~", ">=", "<=", "="]
        .iter()
        .find_map(|prefix| text.strip_prefix(prefix))
        .unwrap_or(text);
    let text = text.trim_start_matches(crate::integrity::is_js_whitespace);
    let text = text.strip_prefix('v').unwrap_or(text);
    let digits = text.len() - text.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if digits == 0 {
        return None;
    }
    text[..digits].parse().ok()
}

/// `detectLibrarySkills(deps, cwd, depVersions)`: every skill (registry order) whose deps meet
/// `present` (and its `minMajor`, fail-open) or, with no dep matched, whose `paths` exist under
/// `cwd`.
#[must_use]
pub fn detect_library_skills<S: std::hash::BuildHasher>(
    present: &HashSet<String, S>,
    cwd: Option<&Path>,
    dep_versions: &HashMap<String, String, S>,
) -> Vec<String> {
    LIBRARY_SKILL_SIGNALS
        .iter()
        .filter(
            |skill| match skill.deps.iter().find(|d| present.contains(**d)) {
                Some(matched) => match (skill.min_major, dep_versions.get(*matched)) {
                    (Some(min), Some(range)) => {
                        parse_major_version(range).is_none_or(|major| major >= f64::from(min))
                    }
                    _ => true,
                },
                None => cwd.is_some_and(|cwd| skill.paths.iter().any(|p| cwd.join(p).exists())),
            },
        )
        .map(|skill| skill.id.to_owned())
        .collect()
}

/// One `MIGRATION_PAIRS` entry: `(legacy, preferred, domain)`.
pub type MigrationPair = (
    &'static [&'static str],
    &'static [&'static str],
    &'static str,
);

/// `MIGRATION_PAIRS`, in registry order.
pub const MIGRATION_PAIRS: &[MigrationPair] = &[
    (&["moment"], &["dayjs", "date-fns"], "Fechas"),
    (&["formik"], &["react-hook-form"], "Forms"),
    (&["joi", "@hapi/joi"], &["zod"], "Validación"),
    (&["yup"], &["zod"], "Validación"),
    (&["redux"], &["@reduxjs/toolkit"], "State"),
    (&["antd"], &["@mantine/core"], "UI"),
    (&["@chakra-ui/react"], &["@mantine/core"], "UI"),
];

/// `MIN_ADOPTION_FILES`.
pub const MIN_ADOPTION_FILES: usize = 3;

/// `MIN_PREFERRED_RATIO`.
pub const MIN_PREFERRED_RATIO: f64 = 0.5;

/// `ActiveMigration`: the legacy and preferred deps actually present.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveMigration {
    /// The legacy dep present.
    pub legacy: String,
    /// The preferred deps present, `" / "`-joined, dominant first.
    pub preferred: String,
    /// Domain prefix of the rendered rule.
    pub domain: &'static str,
}

/// `migrationDepNames()`: every dep `MIGRATION_PAIRS` names, first-seen order.
#[must_use]
pub fn migration_dep_names() -> Vec<&'static str> {
    let mut names: Vec<&'static str> = Vec::new();
    for (legacy, preferred, _) in MIGRATION_PAIRS {
        for name in legacy.iter().chain(preferred.iter()) {
            if !names.contains(name) {
                names.push(name);
            }
        }
    }
    names
}

/// `detectMigrations(deps, counts)`: each pair with a legacy and a preferred dep present and,
/// when `counts` is given, past the dominance gate (`MIN_ADOPTION_FILES`, `MIN_PREFERRED_RATIO`)
/// whenever the legacy side was seen in code; preferred deps are then ordered by usage.
#[must_use]
pub fn detect_migrations<S: std::hash::BuildHasher>(
    present: &HashSet<String, S>,
    counts: Option<&HashMap<String, usize, S>>,
) -> Vec<ActiveMigration> {
    let mut out = Vec::new();
    for (legacy, preferred, domain) in MIGRATION_PAIRS {
        let Some(legacy_hit) = legacy.iter().find(|d| present.contains(**d)) else {
            continue;
        };
        let mut hits: Vec<&str> = preferred
            .iter()
            .copied()
            .filter(|d| present.contains(*d))
            .collect();
        if hits.is_empty() {
            continue;
        }
        if let Some(counts) = counts {
            let usage = |d: &str| counts.get(d).copied().unwrap_or(0);
            let preferred_used: usize = hits.iter().map(|d| usage(d)).sum();
            let legacy_used: usize = legacy.iter().map(|d| usage(d)).sum();
            #[expect(
                clippy::cast_precision_loss,
                reason = "file counts are far below 2^53, as JS numbers"
            )]
            let below_ratio = (preferred_used as f64) < legacy_used as f64 * MIN_PREFERRED_RATIO;
            if legacy_used > 0 && (preferred_used < MIN_ADOPTION_FILES || below_ratio) {
                continue;
            }
            // Stable: ties keep registry order.
            hits.sort_by_key(|d| std::cmp::Reverse(usage(d)));
        }
        out.push(ActiveMigration {
            legacy: (*legacy_hit).to_owned(),
            preferred: hits.join(" / "),
            domain,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(names: &[&str]) -> HashSet<String> {
        names.iter().map(|n| (*n).to_owned()).collect()
    }

    // Covers: R73
    #[test]
    fn signals_follow_the_registry() {
        let ids: Vec<&str> = LIBRARY_SKILL_SIGNALS.iter().map(|s| s.id).collect();
        let registry: Vec<&str> = LIBRARY_SKILLS.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, registry);
    }

    // Covers: R73
    #[test]
    fn library_skills_by_dep_path_and_min_major() {
        let versions: HashMap<String, String> =
            [("tailwindcss".to_owned(), "^3.3.5".to_owned())].into();
        assert_eq!(
            detect_library_skills(&set(&["redux", "zod", "tailwindcss"]), None, &versions),
            vec!["redux-toolkit".to_owned(), "zod-validation".to_owned()]
        );
        let unresolved: HashMap<String, String> =
            [("tailwindcss".to_owned(), "workspace:*".to_owned())].into();
        assert_eq!(
            detect_library_skills(&set(&["tailwindcss"]), None, &unresolved),
            vec!["tailwind-v4".to_owned()]
        );
        let dir = std::env::temp_dir().join(format!("navori-libskills-{}", std::process::id()));
        let _ = std::fs::create_dir_all(dir.join(".maestro"));
        assert_eq!(
            detect_library_skills(&set(&[]), Some(&dir), &HashMap::new()),
            vec!["maestro".to_owned()]
        );
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(parse_major_version(" >= v12.1"), Some(12.0));
        assert_eq!(parse_major_version("latest"), None);
        assert_eq!(parse_major_version("<3"), None);
    }

    // Covers: R73
    #[test]
    fn migrations_presence_and_dominance() {
        let deps = set(&["moment", "dayjs", "date-fns", "redux"]);
        assert_eq!(
            detect_migrations(&deps, None),
            vec![ActiveMigration {
                legacy: "moment".to_owned(),
                preferred: "dayjs / date-fns".to_owned(),
                domain: "Fechas",
            }]
        );
        let counts: HashMap<String, usize> = [
            ("moment".to_owned(), 4),
            ("dayjs".to_owned(), 1),
            ("date-fns".to_owned(), 3),
        ]
        .into();
        assert_eq!(
            detect_migrations(&deps, Some(&counts))[0].preferred,
            "date-fns / dayjs"
        );
        let sparse: HashMap<String, usize> =
            [("moment".to_owned(), 23), ("dayjs".to_owned(), 3)].into();
        assert!(detect_migrations(&set(&["moment", "dayjs"]), Some(&sparse)).is_empty());
        assert_eq!(migration_dep_names().len(), 14);
    }
}
