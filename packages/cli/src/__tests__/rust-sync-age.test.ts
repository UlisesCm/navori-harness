import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

interface Freshness {
  syncAge: (
    cwd: string,
    options: { dev: string; head?: string; now: number },
  ) => {
    ok: boolean;
    pending: number;
    ageDays: number;
  };
}
const { syncAge } = (await import(
  pathToFileURL(join(import.meta.dirname, "../../../../scripts/js/rust-sync-age.mjs")).href
)) as Freshness;
const dirs: string[] = [];
afterEach((): void => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// Covers: R23
it("commit de dev sin incorporar con más de 7 días falla y el PR de sync pasa", (): void => {
  const cwd = mkdtempSync(join(tmpdir(), "rust-sync-age-"));
  dirs.push(cwd);
  const git = (args: string[], date = "2026-01-01T00:00:00Z"): string =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.invalid",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.invalid",
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(["init", "-b", "dev"]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "--no-gpg-sign", "-m", "base"]);
  git(["branch", "migration/rust"]);
  git([
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "-m",
    "old dev",
  ]);
  const now = Date.parse("2026-01-09T00:00:00Z");
  expect(syncAge(cwd, { dev: "dev", head: "migration/rust", now })).toMatchObject({
    ok: false,
    pending: 1,
    ageDays: 8,
  });
  git(["switch", "migration/rust"]);
  git(["merge", "--ff-only", "dev"]);
  expect(syncAge(cwd, { dev: "dev", now })).toMatchObject({ ok: true, pending: 0 });
  expect((): unknown => syncAge(cwd, { dev: "missing", now })).toThrow();

  // An old side-branch commit landed today: use the merge's committer date, not author date.
  git(["switch", "-c", "side"]);
  git([
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "--no-gpg-sign",
    "-m",
    "ancient side",
  ]);
  git(["switch", "dev"]);
  git(
    [
      "-c",
      "core.hooksPath=/dev/null",
      "merge",
      "--no-ff",
      "--no-gpg-sign",
      "-m",
      "land side",
      "side",
    ],
    "2026-01-09T00:00:00Z",
  );
  expect(syncAge(cwd, { dev: "dev", head: "migration/rust", now })).toMatchObject({
    ok: true,
    pending: 1,
    ageDays: 0,
  });
});
