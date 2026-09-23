import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { NavoriConfig } from "../config.ts";
import { listAvailableExternalProviders } from "../external-providers.ts";

/**
 * #981 — the shared filter `add --suggest` and `doctor` both call to decide
 * "external-tool plugin that exists but isn't enabled". Real `git` calls
 * against a scratch temp dir (same pattern as `git-hygiene-doctor.test.ts`),
 * not mocked: `isGitHubRepo` only ever reads `git config`, never mutates.
 */

function config(plugins: Record<string, { enabled: boolean }> = {}): NavoriConfig {
  return { plugins } as unknown as NavoriConfig;
}

function nonGitDir(): string {
  return mkdtempSync(join(tmpdir(), "navori-external-providers-"));
}

function githubRepo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "navori-external-providers-gh-"));
  execFileSync("git", ["-C", cwd, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", "git@github.com:acme/demo.git"], {
    stdio: "ignore",
  });
  return cwd;
}

describe("listAvailableExternalProviders", () => {
  it("lists external-tool plugins that aren't enabled, excluding gh outside a GitHub repo", () => {
    const ids = listAvailableExternalProviders(config(), nonGitDir());
    expect(ids).toContain("codegraph");
    expect(ids).toContain("jscpd");
    expect(ids).not.toContain("gh");
  });

  it("never lists engram — always-on, not a user choice", () => {
    const ids = listAvailableExternalProviders(config(), nonGitDir());
    expect(ids).not.toContain("engram");
  });

  it("omits a plugin already enabled in config", () => {
    const ids = listAvailableExternalProviders(
      config({ codegraph: { enabled: true } }),
      nonGitDir(),
    );
    expect(ids).not.toContain("codegraph");
    expect(ids).toContain("jscpd");
  });

  it("lists gh once the repo has a GitHub remote", () => {
    const ids = listAvailableExternalProviders(config(), githubRepo());
    expect(ids).toContain("gh");
  });

  it("omits gh once it's enabled, even in a GitHub repo", () => {
    const ids = listAvailableExternalProviders(config({ gh: { enabled: true } }), githubRepo());
    expect(ids).not.toContain("gh");
  });
});
