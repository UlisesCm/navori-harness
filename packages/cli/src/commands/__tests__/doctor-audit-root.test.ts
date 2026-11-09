import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { auditRootRepairCommand } from "../../lib/audit/paths.ts";
import { scanAuditRootPermissions } from "../doctor.ts";

/**
 * Read-only doctor check: the audit root and its immediate repo dirs must be
 * private (no group/other bits), or `navori audit` refuses them. Always runs
 * against a temp dir, never the real HOME.
 */
let sandbox: string;
let root: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), "navori-doctor-audit-root-"));
  root = join(sandbox, "audits");
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe("scanAuditRootPermissions", () => {
  it("is silent when the root does not exist", () => {
    expect(scanAuditRootPermissions(root)).toBeNull();
  });

  it("is silent when the root and repo dirs are private", () => {
    mkdirSync(join(root, "repo"), { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    chmodSync(join(root, "repo"), 0o700);
    expect(scanAuditRootPermissions(root)).toBeNull();
  });

  it("reports an open repo dir without changing its mode", () => {
    mkdirSync(join(root, "repo"), { recursive: true });
    chmodSync(root, 0o700);
    chmodSync(join(root, "repo"), 0o755);
    expect(scanAuditRootPermissions(root)).toEqual({ root, paths: [join(root, "repo")] });
    expect(statSync(join(root, "repo")).mode & 0o777).toBe(0o755);
  });

  it("reports an open root too", () => {
    mkdirSync(root);
    chmodSync(root, 0o755);
    expect(scanAuditRootPermissions(root)?.paths).toEqual([root]);
  });

  it("skips a symlinked root", () => {
    const target = join(sandbox, "target");
    mkdirSync(target);
    chmodSync(target, 0o755);
    symlinkSync(target, root);
    expect(scanAuditRootPermissions(root)).toBeNull();
  });
});

describe("auditRootRepairCommand", () => {
  it("scopes dirs 700 and files 600 to the quoted root", () => {
    expect(auditRootRepairCommand("/a/audits")).toBe(
      "find '/a/audits' -type d -exec chmod 700 {} + && find '/a/audits' -type f -exec chmod 600 {} +",
    );
  });

  it("escapes single quotes in the path", () => {
    expect(auditRootRepairCommand("/a/it's")).toContain(`'/a/it'\\''s'`);
  });
});
