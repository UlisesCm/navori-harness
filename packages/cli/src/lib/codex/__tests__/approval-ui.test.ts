import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  APPROVAL_HTML,
  approvalContentSecurityPolicy,
  launchApprovalBrowser,
} from "../approval-ui.ts";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock(import("node:child_process"), () => ({ spawn }));

describe("private approval browser UI", () => {
  // Covers: R6, R16
  it("does not launch a default browser without verified source isolation", async () => {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    if (!platform) throw new Error("missing-platform-descriptor");
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    spawn.mockImplementation(() => {
      const child = Object.assign(new EventEmitter(), { kill: vi.fn() });
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    try {
      await expect(launchApprovalBrowser("private-bootstrap-fixture")).resolves.toBe(false);
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platform);
      vi.clearAllMocks();
    }
  });
  // Covers: R6, R16
  it("removes bootstrap fragment and renders immutable scope as text without persistent credentials", () => {
    expect(APPROVAL_HTML).toContain("history.replaceState");
    expect(APPROVAL_HTML).toContain(".textContent = JSON.stringify(challenge.scope");
    expect(APPROVAL_HTML).not.toMatch(
      /localStorage|sessionStorage|document.cookie|innerHTML|https:\/\//,
    );
    expect(APPROVAL_HTML).toContain("aria-label");
    expect(APPROVAL_HTML).toContain('role="status"');
    expect(APPROVAL_HTML).toContain("button.disabled = true");
  });
  // Covers: R6
  it("permits only the fixed inline script/style and same-origin requests", () => {
    const policy = approvalContentSecurityPolicy();
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
  });
});
