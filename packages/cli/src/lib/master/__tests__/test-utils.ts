import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { writeConfig } from "../../config/config.ts";

export function createGitHelper(cwd: string) {
  return (args: string[]): void => {
    execFileSync("git", args, { cwd, stdio: "ignore" });
  };
}

export function createCommitHelper(git: (args: string[]) => void) {
  return (message: string): void => {
    git(["add", "-A"]);
    git(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", message]);
  };
}

export function createSeedConfigHelper(cwd: string) {
  return (overrides: Record<string, unknown> = {}): void => {
    writeConfig(join(cwd, "navori.config.json"), {
      name: "demo",
      engines: ["claude"],
      preset: "custom",
      ...overrides,
    });
  };
}
