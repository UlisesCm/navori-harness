import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { readConfig, writeConfig } from "../config.ts";
import { SCHEMA_BASE_URL, schemaUrl } from "../schema-url.ts";

/**
 * #505 — `https://navori.dev/schema/*` was stamped as `$schema` into every
 * config navori generates while the domain was NXDOMAIN, and it survived
 * because the only test on the subject FROZE THE LITERAL (`schema-publish.test.ts`
 * asserted `$id === "https://navori.dev/..."`). Correcting the URL broke a test,
 * so the incentive was to revert the fix.
 *
 * These tests therefore assert PROPERTIES, never a literal:
 *
 *  1. `SCHEMA_BASE_URL` is the URL the website is actually PUBLISHED at —
 *     derived here from the same two inputs the deploy pipeline uses (a `CNAME`
 *     file if a custom domain exists, otherwise the GitHub Pages URL implied by
 *     `package.json`'s `repository`). Any host the project does not publish to
 *     fails, `navori.dev` included, and the day a real domain is configured the
 *     failure points at the one line to change.
 *  2. The two surfaces AGREE: what the CLI stamps into a generated config is
 *     byte-identical to the `$id` of the schema served at that URL.
 *  3. No second literal: nothing checked in re-types a `/schema/` URL by hand.
 *
 * Each scan asserts a known-present sample first (anti-false-green): an
 * extractor that silently matches nothing would otherwise report "no
 * violations" and be indistinguishable from a clean repo.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = resolve(HERE, "..", "..", "..");
const REPO_ROOT = resolve(CLI_ROOT, "..", "..");
const PUBLIC_SCHEMA_DIR = resolve(REPO_ROOT, "apps", "website", "public", "schema");
const CNAME_PATH = resolve(REPO_ROOT, "apps", "website", "public", "CNAME");

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "navori-schema-url-"));
  tmpDirs.push(dir);
  return dir;
}

interface CliPackageJson {
  repository?: { url?: string };
}

/**
 * The site root the website is served from, derived exactly the way the deploy
 * pipeline resolves it (`deploy-website.yml` → `SITE_URL` / `SITE_BASE`):
 *
 *  - a `CNAME` in `apps/website/public/` means a custom domain is configured and
 *    GitHub Pages serves the site at its root;
 *  - otherwise it is a Project Page at `https://<owner>.github.io/<repo>`.
 *    GitHub lowercases the owner in that hostname, so the derivation does too.
 *
 * Returns no trailing slash.
 */
function publishedSiteRoot(): string {
  if (existsSync(CNAME_PATH)) {
    const domain = readFileSync(CNAME_PATH, "utf-8").trim();
    expect(domain, "CNAME exists but is empty").not.toBe("");
    return `https://${domain}`;
  }
  const pkg = JSON.parse(
    readFileSync(resolve(CLI_ROOT, "package.json"), "utf-8"),
  ) as CliPackageJson;
  const url = pkg.repository?.url ?? "";
  const match = url.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  // Anti-false-green: with no parseable `repository` there is nothing to derive
  // from, and a derivation that silently gives up is exactly the blind spot
  // this file exists to close. Throw rather than assert so the caller's
  // comparison can never run against a made-up value.
  if (!match) {
    throw new Error(
      `packages/cli/package.json "repository.url" must name a GitHub repo, got: ${url}`,
    );
  }
  const [, owner, repo] = match;
  if (!owner || !repo) throw new Error(`could not read owner/repo from repository.url: ${url}`);
  return `https://${owner.toLowerCase()}.github.io/${repo}`;
}

describe("SCHEMA_BASE_URL points at where the site is actually published (#505)", () => {
  it("matches the site root the deploy pipeline resolves, + /schema", () => {
    expect(SCHEMA_BASE_URL).toBe(`${publishedSiteRoot()}/schema`);
  });

  it("is an absolute https URL with a dotted, resolvable-looking host", () => {
    const url = new URL(SCHEMA_BASE_URL);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
  });

  it("names a directory that is actually published by the website", () => {
    // The URL is only as good as the files behind it: Astro serves
    // apps/website/public/ at the site root, so this directory IS /schema.
    expect(existsSync(PUBLIC_SCHEMA_DIR)).toBe(true);
    const published = readdirSync(PUBLIC_SCHEMA_DIR).filter((f) => f.endsWith(".json"));
    expect(published.length).toBeGreaterThan(0);
  });
});

describe("the stamped $schema and the published $id are the same URL (#505)", () => {
  const published = readdirSync(PUBLIC_SCHEMA_DIR).filter((f) => f.endsWith(".json"));

  it("finds the published schema files (anti-false-green)", () => {
    expect(published).toContain("navori.config.v1.json");
    expect(published.length).toBeGreaterThanOrEqual(4);
  });

  for (const file of published) {
    it(`${file} declares $id === schemaUrl("${file}")`, () => {
      const doc = JSON.parse(readFileSync(resolve(PUBLIC_SCHEMA_DIR, file), "utf-8")) as {
        $id?: string;
      };
      expect(doc.$id).toBe(schemaUrl(file));
    });
  }

  it("writeConfig stamps the URL of a schema that exists on disk", () => {
    const path = join(makeTmpDir(), "navori.config.json");
    writeConfig(path, { name: "demo", engines: ["claude"], preset: "custom" });
    const stamped = readConfig(path).$schema;
    expect(stamped).toBe(schemaUrl("navori.config.v1.json"));
    // End of the contract: the URL the user's editor will fetch resolves to a
    // file this repo publishes, and that file claims the very same identity.
    const file = stamped?.slice(`${SCHEMA_BASE_URL}/`.length) ?? "";
    const doc = JSON.parse(readFileSync(resolve(PUBLIC_SCHEMA_DIR, file), "utf-8")) as {
      $id?: string;
    };
    expect(doc.$id).toBe(stamped);
  });
});

/** Files that may legitimately mention a `/schema/` URL, walked recursively. */
const SCANNED_ROOTS = [
  resolve(CLI_ROOT, "src"),
  resolve(CLI_ROOT, "scripts"),
  resolve(REPO_ROOT, "packages", "core", "core-assets"),
  resolve(REPO_ROOT, "apps", "website", "src"),
];

const SCANNED_FILES = [resolve(REPO_ROOT, "navori.config.json")];

const SCANNED_EXTENSIONS = [".ts", ".mjs", ".json", ".astro", ".md"];

/** Any absolute URL whose path lives under `/schema/` — what a `$schema` is. */
const SCHEMA_URL_RE = /https:\/\/[^\s"'`)]*\/schema\/[A-Za-z0-9._-]+/g;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      walk(full, out);
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
}

describe("no checked-in file re-types a schema URL by hand (#505)", () => {
  const files: string[] = [...SCANNED_FILES];
  for (const root of SCANNED_ROOTS) if (existsSync(root)) walk(root, files);

  const hits = files.flatMap((file) =>
    [...readFileSync(file, "utf-8").matchAll(SCHEMA_URL_RE)].map((m) => ({
      where: file.slice(REPO_ROOT.length + 1),
      url: m[0],
    })),
  );

  it("the scan finds the URLs it is supposed to police (anti-false-green)", () => {
    // The 12 presets + prompts.json + the root config all carry one, so a
    // scanner returning nothing is broken, not a clean repo.
    expect(hits.length).toBeGreaterThanOrEqual(14);
    expect(hits.map((h) => h.where)).toContain("navori.config.json");
  });

  it("every one of them starts with SCHEMA_BASE_URL", () => {
    const foreign = hits
      .filter((h) => !h.url.startsWith(`${SCHEMA_BASE_URL}/`))
      .map((h) => `${h.where}: ${h.url}`);
    expect(foreign, "use schemaUrl() / SCHEMA_BASE_URL instead of a literal").toEqual([]);
  });
});
