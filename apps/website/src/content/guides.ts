import { REPO_URL } from "../consts";
import type { Lang } from "../i18n/ui";

/** Primary guide families; historical records and generated doctrine stay outside this inventory. */
export const primaryGuides = [
  "README.md",
  "CONTRIBUTING.md",
  "packages/cli/README.md",
  "packages/cli/src/engines/README.md",
  "apps/website/README.md",
  "docs/DIRECTION.md",
  "docs/EXTENDING.md",
  "docs/architecture.md",
  "docs/pi.md",
  "docs/recipes/model-tiering.md",
  "docs/recipes/setup-proveedores-externos.md",
  "docs/recipes/skill-authoring.md",
  "docs/references/skills-security-quality.md",
  "docs/runbook-curacion-engram.md",
] as const;

/** Co-located editions keep the original English filename and explicit companion suffixes. */
export function guidePath(path: string, lang: Lang): string {
  return lang === "en" ? path : path.replace(/\.md$/, `.${lang}.md`);
}

/** Stable repository links also work from the published npm README. */
export function guideUrl(path: string, lang: Lang): string {
  return `${REPO_URL}/blob/main/${guidePath(path, lang)}`;
}
