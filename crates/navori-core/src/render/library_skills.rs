//! Generated from `packages/cli/src/lib/assets/library-skills.ts` (registry data only).
//! `presets_parity::registry_and_every_bundled_preset_match` fails when the TS table changes;
//! regenerate this file then.

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

/// `librarySkillById`: the label of a registered lib skill.
#[must_use]
pub fn library_skill_label(id: &str) -> Option<&'static str> {
    LIBRARY_SKILLS
        .iter()
        .find_map(|(known, label)| (*known == id).then_some(*label))
}
