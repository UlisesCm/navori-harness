import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { expandHookIncludes } from "../render/hook-includes.ts";
import { getCoreRoot } from "../render/bundled-assets.ts";
import { acrossShells } from "./helpers/shells.ts";

/**
 * Behavioral tests for the PII-egress rule (#1445), in its two homes: the Bash lane inside
 * `guard-destructive.sh` (spec 0039 R28 forbids a second hook on the Bash path) and
 * `pii-egress-guard.sh` (WebFetch/WebSearch). Each case installs the RENDERED script
 * (includes expanded, exactly what ships to a repo) into a temp dir and drives it with its
 * PreToolUse payload on stdin. Every identifier is fictitious, and git is isolated
 * (`GIT_CONFIG_GLOBAL` fixture, `GIT_CONFIG_NOSYSTEM`, scratch `HOME`), so the developer's
 * real email never enters a case.
 */
const HOOKS_DIR = resolve(getCoreRoot(), "core-assets/hooks");
const BASH_SCRIPT = "guard-destructive.sh";
const WEB_SCRIPT = "pii-egress-guard.sh";
const EMAIL = "dev@example.test";
const ENV_ID_NAME = "Jane Roe";
const ENV_ID_HANDLE = "jroe-handle";
const GENERIC = "navori-agent/1.0";

let dir: string;
let gitconfig: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "navori-pii-"));
  gitconfig = join(dir, "gitconfig");
  writeFileSync(gitconfig, `[user]\n\temail = ${EMAIL}\n\tname = Dev Example\n`);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface RunOptions {
  /** `NAVORI_PERSONAL_IDS` value (unset when absent). */
  ids?: string;
  /** Use an empty git config instead of the fixture (no git email). */
  noGitEmail?: boolean;
  /** Replace PATH (absolute) — for the missing-tools cases. */
  path?: string;
  /** Raw stdin instead of `JSON.stringify(payload)`. */
  raw?: string;
}

interface Result {
  status: number;
  stdout: string;
  stderr: string;
}

function envFor(options: RunOptions): NodeJS.ProcessEnv {
  const nodeDir = dirname(process.execPath);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: dir,
    GIT_CONFIG_GLOBAL: options.noGitEmail === true ? "/dev/null" : gitconfig,
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    NAVORI_AUDITS_ROOT: join(dir, "no-audits"),
    PATH: options.path ?? `${nodeDir}:/usr/bin:/bin:${process.env.PATH ?? ""}`,
  };
  delete env.NAVORI_PERSONAL_IDS;
  if (options.ids !== undefined) env.NAVORI_PERSONAL_IDS = options.ids;
  return env;
}

/** Install the rendered hook and run it under every available shell (#391). */
function run(script: string, payload: unknown, options: RunOptions = {}): Result {
  const rendered = expandHookIncludes(readFileSync(join(HOOKS_DIR, script), "utf-8"))
    .replace("{{shq:branchBase}}", "'main'")
    .replace("{{shq:piPermissionRules}}", "'-'")
    .replace("{{shq:navoriOwnedPaths}}", "'-'")
    .replace("{{navori.progressGuardLane}}", "0");
  const path = join(dir, script);
  writeFileSync(path, rendered);
  chmodSync(path, 0o755);
  const input = options.raw ?? JSON.stringify(payload);
  return acrossShells(
    (shell) => {
      // A replaced PATH hides the shell too: resolve it by absolute path.
      const bin =
        options.path === undefined
          ? shell
          : ([`/bin/${shell}`, `/usr/bin/${shell}`].find((p) => existsSync(p)) ?? shell);
      const r = spawnSync(bin, [path], {
        cwd: dir,
        input,
        encoding: "utf-8",
        env: envFor(options),
      });
      return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    {
      sensitive: "here-strings, parameter expansion and word-splitting differ between bash and zsh",
    },
  );
}

function bash(command: string, options: RunOptions = {}): Result {
  return run(
    BASH_SCRIPT,
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } },
    options,
  );
}

function web(tool: "WebFetch" | "WebSearch", input: Record<string, unknown>): Result {
  return run(WEB_SCRIPT, { hook_event_name: "PreToolUse", tool_name: tool, tool_input: input });
}

/** A block names the rule and the generic identifier, and never an identifier or the command. */
function expectBlocked(r: Result, source: string, secrets: string[] = [EMAIL]): void {
  expect(r.status).toBe(2);
  expect(r.stderr).toContain("pii-egress-guard");
  expect(r.stderr).toContain(source);
  expect(r.stderr).toContain(GENERIC);
  // The lane has its own deny path: the guard's `block()` prints the command.
  expect(r.stderr).not.toContain("[navori] command:");
  for (const secret of [...secrets, "curl", "wget"]) {
    expect(r.stderr.toLowerCase()).not.toContain(secret.toLowerCase());
  }
  expect(r.stdout).toBe("");
}

function expectAllowed(r: Result): void {
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");
  expect(r.stdout).toBe("");
}

describe("pii-egress-guard — blocks an identifier sent to an external host (#1445)", () => {
  it("blocks the git email in a curl User-Agent", () => {
    expectBlocked(
      bash(`curl -A "${EMAIL}" "https://nominatim.openstreetmap.org/search?q=x"`),
      "the configured user email",
    );
  });

  it("matches case-insensitively", () => {
    expectBlocked(
      bash(`curl -H "User-Agent: ${EMAIL.toUpperCase()}" https://api.example.com`),
      "the configured user email",
    );
  });

  it("matches the URL-encoded form", () => {
    expectBlocked(
      bash(`curl "https://api.example.com/?email=dev%40example.test"`),
      "the configured user email",
    );
  });

  it("matches a heredoc body attached to the network segment", () => {
    expectBlocked(
      bash(`curl --data @- https://api.example.com <<EOF\n{"email":"${EMAIL}"}\nEOF`),
      "the configured user email",
    );
  });

  it("matches a CRLF heredoc body", () => {
    expectBlocked(
      bash(`curl --data @- https://api.example.com <<EOF\r\n{"email":"${EMAIL}"}\r\nEOF\r\n`),
      "the configured user email",
    );
  });

  it("blocks an inline read of the git email", () => {
    expectBlocked(
      bash(`curl -A "$(git config user.email)" https://api.example.com`),
      "the configured user email",
    );
  });

  it("covers wget and httpie", () => {
    expectBlocked(
      bash(`wget --user-agent=${EMAIL} https://x.example.com`),
      "the configured user email",
    );
    expectBlocked(
      bash(`http POST https://x.example.com email=${EMAIL}`),
      "the configured user email",
    );
  });

  it("covers scheme-less httpie as a whole word (#1489)", () => {
    for (const cmd of [
      `http POST api.example.com User-Agent:${EMAIL}`,
      `xh api.example.com email=${EMAIL}`,
      `cd /tmp && https api.example.com email=${EMAIL}`,
      `echo ok;xhs api.example.com email=${EMAIL}`,
      `/usr/local/bin/http api.example.com email=${EMAIL}`,
      `http --download api.example.com email=${EMAIL} -o /tmp/out`,
    ]) {
      expectBlocked(bash(cmd), "the configured user email");
    }
  });

  it("blocks an inline interpreter request", () => {
    expectBlocked(
      bash(`node -e "fetch('https://x.example.com/?u=${EMAIL}')"`),
      "the configured user email",
    );
  });

  it("matches NAVORI_PERSONAL_IDS entries and names the source, never the value", () => {
    const ids = `${ENV_ID_NAME}, ,${ENV_ID_HANDLE}`;
    const secrets = [EMAIL, ENV_ID_NAME, ENV_ID_HANDLE];
    expectBlocked(
      bash(`curl -d 'n=jane roe' https://x.example.com`, { ids, noGitEmail: true }),
      "NAVORI_PERSONAL_IDS",
      secrets,
    );
    expectBlocked(
      bash(`curl -d 'h=${ENV_ID_HANDLE}' https://x.example.com`, { ids, noGitEmail: true }),
      "NAVORI_PERSONAL_IDS",
      secrets,
    );
    expectBlocked(
      bash(`curl "https://x.example.com/?n=jane+roe"`, { ids, noGitEmail: true }),
      "NAVORI_PERSONAL_IDS",
      secrets,
    );
  });

  it("blocks a WebFetch url and a WebSearch query, never echoing them", () => {
    expectBlocked(
      web("WebFetch", { url: `https://example.com/?u=dev%40example.test` }),
      "the configured user email",
    );
    expectBlocked(web("WebSearch", { query: EMAIL }), "the configured user email");
  });

  it("handles a pretty-printed payload", () => {
    const raw = `{\n  "tool_name" : "Bash",\n  "tool_input" : {\n    "command" : "curl -A ${EMAIL} https://x.example.com"\n  }\n}`;
    expectBlocked(run(BASH_SCRIPT, null, { raw }), "the configured user email");
  });

  it("still matches a command larger than 64 KiB when the match is at the start", () => {
    const command = `curl -A ${EMAIL} https://x.example.com ; echo ${"a".repeat(70_000)}`;
    expectBlocked(bash(command), "the configured user email");
  });

  it("blocks a request whose segment sits behind sudo/env/a path and a pipe", () => {
    expectBlocked(
      bash(`echo go | env X=1 /usr/bin/curl -A ${EMAIL} https://x.example.com`),
      "the configured user email",
    );
  });
});

describe("pii-egress-guard — allows everything else (#1445)", () => {
  it("allows the same request with a generic identifier", () => {
    expectAllowed(bash(`curl -A "${GENERIC}" "https://nominatim.openstreetmap.org/search?q=x"`));
  });

  it("allows the email on a local or private destination", () => {
    expectAllowed(bash(`curl -A ${EMAIL} http://localhost:3000`));
    expectAllowed(bash(`curl -A ${EMAIL} http://127.0.0.1:8080`));
    expectAllowed(bash(`curl -A ${EMAIL} http://192.168.1.2`));
    expectAllowed(bash(`curl -A ${EMAIL} localhost:3000`));
  });

  it("treats a look-alike host as external", () => {
    expectBlocked(
      bash(`curl -A ${EMAIL} http://127.0.0.1.evil.example.com`),
      "the configured user email",
    );
  });

  it("allows commands that mention the email but send nothing", () => {
    expectAllowed(bash(`git commit --author "Dev <${EMAIL}>" -m x`));
    expectAllowed(bash(`git push origin main`));
    expectAllowed(bash(`echo ${EMAIL}`));
  });

  it("is per segment: the email in one segment, an unrelated request in another", () => {
    expectAllowed(bash(`git commit -m "by ${EMAIL}" && curl -s https://x.example.com`));
    expectAllowed(bash(`git log --author=${EMAIL} --oneline; curl -s https://api.example.com`));
    expectAllowed(bash(`git config user.email && curl -s https://api.github.com/zen`));
  });

  it("is a no-op without any identifier", () => {
    expectAllowed(bash(`curl -A ${EMAIL} https://x.example.com`, { noGitEmail: true }));
  });

  it("ignores identifiers shorter than 4 characters", () => {
    expectAllowed(bash(`curl -d ab https://x.example.com`, { ids: "ab", noGitEmail: true }));
  });

  it("ignores the email in WebFetch's prompt and on a local url", () => {
    expectAllowed(
      web("WebFetch", { url: "https://example.com/page", prompt: `summarize for ${EMAIL}` }),
    );
    expectAllowed(web("WebFetch", { url: `http://localhost:3000/?u=${EMAIL}` }));
  });

  it("allows scheme-less httpie with a generic identifier (#1489)", () => {
    expectAllowed(bash(`http POST api.example.com User-Agent:${GENERIC}`));
  });

  it("allows ordinary Bash with network-looking words", () => {
    expectAllowed(bash(`git log --since=1d && bun run sync`));
    expectAllowed(bash(`echo ${EMAIL} > notes/httpx-xhttp.txt && ls ~/http-project`));
    expectAllowed(bash(`ls ~/curl-project`));
    expectAllowed(bash(`echo "see https://example.com/docs"`));
  });

  it("allows a tool it does not cover", () => {
    expectAllowed(
      run(WEB_SCRIPT, { tool_name: "Read", tool_input: { file_path: `/tmp/curl-${EMAIL}` } }),
    );
  });
});

describe("pii-egress-guard — failure contract (#1445)", () => {
  /** A PATH holding only the listed tools (symlinks), so `jq`, `node` and `git` are absent. */
  function minimalPath(...tools: string[]): string {
    const bin = join(dir, "bin");
    mkdirSync(bin, { recursive: true });
    for (const tool of tools) {
      for (const base of ["/usr/bin", "/bin"]) {
        const target = join(base, tool);
        if (existsSync(target)) {
          symlinkSync(target, join(bin, tool));
          break;
        }
      }
    }
    return bin;
  }
  const BASE_TOOLS = ["sed", "grep", "tr", "cat", "env", "dirname", "basename", "head", "tail"];

  it("still blocks an env identifier through the sed fallback without jq, node or git", () => {
    const path = minimalPath(...BASE_TOOLS);
    expectBlocked(
      bash(`curl -d 'h=${ENV_ID_HANDLE}' https://x.example.com`, {
        ids: ENV_ID_HANDLE,
        noGitEmail: true,
        path,
      }),
      "NAVORI_PERSONAL_IDS",
      [ENV_ID_HANDLE],
    );
  });

  it("allows a clean request without jq, node or git", () => {
    const path = minimalPath(...BASE_TOOLS);
    expectAllowed(bash(`curl -A ${GENERIC} https://x.example.com`, { ids: ENV_ID_HANDLE, path }));
  });

  it("denies when a tool fails after the gate matched (could not verify)", () => {
    const bin = join(dir, "stubs");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "grep"), "#!/bin/sh\nexit 2\n");
    chmodSync(join(bin, "grep"), 0o755);
    const r = bash(`curl -d x https://x.example.com`, {
      ids: ENV_ID_HANDLE,
      noGitEmail: true,
      path: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("pii-egress-guard");
    expect(r.stderr).toContain("could not verify");
    expect(r.stderr).not.toContain(ENV_ID_HANDLE);
  });

  it("never disables the guard's other lanes: a clean request beside a force-push is still blocked", () => {
    const r = bash(`curl -s -A ${GENERIC} https://x.example.com; git push --force origin main`);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("BLOCKED by guard-destructive");
    expect(r.stderr).not.toContain("pii-egress-guard");
  });

  it("does not let the lane's gate skip the guard on a request-free command", () => {
    const r = bash(`git push --force origin main`);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("BLOCKED by guard-destructive");
  });

  it("allows before the gate when the payload is not JSON at all", () => {
    expectAllowed(run(WEB_SCRIPT, null, { raw: "not json" }));
    expectAllowed(run(BASH_SCRIPT, null, { raw: "not json" }));
  });
});
