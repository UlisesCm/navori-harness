/**
 * The single source of truth for every `$schema` URL navori stamps into the
 * files it generates (config, workspace manifest, preset manifest, prompts) AND
 * for the `$id` the published JSON Schemas carry (`scripts/gen-schemas.mjs`).
 * Both surfaces MUST agree: an editor fetches the URL from `$schema` and then
 * trusts the document it gets back, so a mismatch is a silently broken
 * contract.
 *
 * WHY THIS URL — it is where the website actually deploys. `deploy-website.yml`
 * publishes `apps/website/` to GitHub Pages at
 * `https://<owner>.github.io/<repo>/`, and Astro serves `apps/website/public/`
 * at the site root, so `apps/website/public/schema/<file>` is reachable at
 * `<site>/schema/<file>` (verified: HTTP 200, `content-type: application/json`).
 *
 * It replaces `https://navori.dev/...`, which was stamped into every generated
 * config for months while the domain was never registered — NXDOMAIN. Editors
 * failed to fetch it, so no repo onboarded by navori ever got the validation or
 * autocompletion that declaring a `$schema` is *for* (#505).
 *
 * HARDCODED ON PURPOSE, not derived from the git remote or from CI's
 * `github.repository_owner`. The workflow derives its base URL so any FORK
 * deploys without configuration; this constant answers a different question —
 * where the schemas that back the *published npm package* live. The CLI is
 * published as `navori` from this repo, so what it stamps must point at the
 * maintainer's site, not at wherever the fork that happens to be running it
 * lives. A fork's user would otherwise receive a `$schema` pointing at a Pages
 * site that may not even be enabled.
 *
 * THE DAY A CUSTOM DOMAIN EXISTS (e.g. `navori.dev` gets registered):
 *   1. add `apps/website/public/CNAME` with the bare domain,
 *   2. set the `SITE_URL` / `SITE_BASE` repo variables the deploy workflow reads,
 *   3. change the one line below to `https://<domain>/schema`,
 *   4. run `pnpm gen:schemas` so the published `$id`s follow.
 * `schema-url.test.ts` derives the expected value from the CNAME file and the
 * `repository` field, so it fails until step 3 is done — the constant cannot
 * drift away from where the site is actually served.
 */
export const SCHEMA_BASE_URL = "https://ulisescm.github.io/navori-harness/schema";

/** Absolute `$schema` URL for one published schema file. */
export function schemaUrl(file: string): string {
  return `${SCHEMA_BASE_URL}/${file}`;
}
