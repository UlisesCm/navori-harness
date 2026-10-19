import { afterEach, beforeEach, describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestHandoff } from "../actor-provenance.ts";
import { beginReview, correlateReview, sealReview } from "../review-evidence.ts";
import {
  checkReviewEditOutputs,
  preflightReviewEdits,
  reviewEditIndexName,
} from "../review-edit-binding.ts";
import { ReviewSidecarSchema } from "../review-schema.ts";
import { resolveStateRoot } from "../../primitives/state-root.ts";
import { renderCodexEngine } from "../../../engines/codex/index.ts";
import { NavoriConfigSchema } from "../../config/schema.ts";
import { emptyRepo, type RepoTemplate } from "../../../__tests__/helpers/repo-template.ts";

/** Repos built once per file and copied per case (spec 0055 D7). */
let repoTpl: RepoTemplate;
beforeAll(() => {
  repoTpl = emptyRepo({ branch: "main" });
});
afterAll(() => {
  repoTpl.dispose();
});

let dir: string;
let host: string;
let target: string;
let nonce: string;
const parent = "10000000-0000-0000-0000-000000000001";
const producer = "10000000-0000-0000-0000-000000000002";
const reviewer = "10000000-0000-0000-0000-000000000003";
const otherReviewer = "10000000-0000-0000-0000-000000000004";
const scribe = "10000000-0000-0000-0000-000000000005";
const state = (name: string): string => join(target, ".navori/state/handoffs", name);
const output = (ext = "md"): string => state(`review_demo.${ext}`);
const options = () => ({ cwd: target, feature: "demo", target: "main", gate: "" });
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const read = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
function change(file: string, mutate: (body: Record<string, unknown>) => void): void {
  const body = read(file);
  mutate(body);
  writeFileSync(file, JSON.stringify(body));
}
function actor(thread: string, role: string, version: string = "0.162.1"): void {
  vi.stubEnv("CODEX_THREAD_ID", thread);
  writeFileSync(
    join(dir, "sessions/2026/10/15", `${thread}.jsonl`),
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: thread,
        session_id: parent,
        parent_thread_id: parent,
        cli_version: version,
        cwd: host,
        agent_role: role,
        source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_role: role } } },
      },
    }) + "\n",
  );
}
function begin(): string {
  const result = beginReview(options());
  if (result.status !== "begun") throw new Error(result.message);
  expect(result.editBinding).toBe("supported");
  return result.nonce;
}
const stamp = (): string => state(`review_demo.${nonce}.begin.json`);
const index = (): string => state(reviewEditIndexName("demo", reviewer));
const check = (outputs = [output(), output("json")], thread = reviewer) =>
  checkReviewEditOutputs({ hostCwd: host, thread, outputs });
const preflight = () => preflightReviewEdits({ cwd: target, hostCwd: host, feature: "demo" });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "navori-review-binding-")));
  host = join(dir, "host");
  target = join(dir, "delivery");
  mkdirSync(host);
  repoTpl.copyInto(host);
  git(host, "config", "user.email", "binding@example.test");
  git(host, "config", "user.name", "Binding");
  writeFileSync(join(host, "a.txt"), "base\n");
  git(host, "add", ".");
  git(host, "commit", "-qm", "base");
  git(host, "worktree", "add", "-b", "delivery", target);
  renderCodexEngine(
    host,
    NavoriConfigSchema.parse({
      name: "binding",
      engines: ["codex"],
      preset: "custom",
      branchBase: "main",
      qualityGate: { fast: "test-review-fast", full: "test-review-full" },
    }),
  );
  mkdirSync(state(""), { recursive: true });
  mkdirSync(join(dir, "sessions/2026/10/15"), { recursive: true });
  vi.stubEnv("CODEX_HOME", dir);
  vi.spyOn(process, "cwd").mockImplementation(() => target);
  writeFileSync(
    state("workplan_demo.json"),
    JSON.stringify({
      feature: "demo",
      level: 1,
      classification: { score: 1, level: 1, signals: [] },
      objective: "native binding",
      files: [{ path: "a.txt", new: false }],
      outOfScope: [],
      acceptance: [{ id: "A1", description: "binding", command: "test", expected: "pass" }],
    }),
  );
  writeFileSync(
    state("impl_demo.json"),
    JSON.stringify({
      feature: "demo",
      status: "DONE",
      worktree: target,
      branch: "delivery",
      commits: [],
      filesTouched: ["a.txt"],
      verification: { command: "test", exitCode: 0, summary: "fixture" },
      markdownRequests: [],
    }),
  );
  writeFileSync(join(target, "a.txt"), "delivery\n");
  actor(producer, "implementer");
  expect(attestHandoff(options())).toEqual({ status: "attested" });
  actor(reviewer, "reviewer");
  nonce = begin();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe("native review edit binding", () => {
  // Covers: R18
  it.each([
    ["0.162.1", "0.162.1"],
    ["0.162.1", "0.163.0"],
    ["0.163.0", "0.162.1"],
    ["0.163.0", "0.163.0"],
  ])(
    "binds reviewer %s with implementer %s and a mixed-version scribe",
    (reviewerVersion: string, producerVersion: string) => {
      actor(producer, "implementer", producerVersion);
      expect(attestHandoff(options())).toEqual({ status: "attested" });
      const scribeVersion = producerVersion === "0.162.1" ? "0.163.0" : "0.162.1";
      actor(scribe, "scribe", scribeVersion);
      expect(attestHandoff(options())).toEqual({ status: "attested" });
      actor(reviewer, "reviewer", reviewerVersion);
      nonce = begin();
      expect(read(stamp()).reviewer).toMatchObject({ thread: reviewer, version: reviewerVersion });
      expect(read(state("ownership_demo.json")).actors).toMatchObject([
        { role: "implementer", version: producerVersion },
        { role: "scribe", version: scribeVersion },
      ]);
      expect(check()).toEqual({ status: "ok", reason: "bound-review-output" });
      expect(preflight()).toEqual(check());
    },
  );

  // Covers: R18
  it.each(
    ["0.162.0", "0.163.1", "0.164.0"].flatMap((version: string) => [
      ["reviewer", version],
      ["producer", version],
    ]),
  )("denies unverified %s version %s through both readers", (kind: string, version: string) => {
    if (kind === "reviewer")
      change(stamp(), (body: Record<string, unknown>) => {
        (body.reviewer as Record<string, unknown>).version = version;
      });
    else
      change(state("ownership_demo.json"), (body: Record<string, unknown>) => {
        (body.actors as Record<string, unknown>[])[0]!.version = version;
      });
    expect(check()).toEqual({
      status: "error",
      reason: kind === "reviewer" ? "wrong-native-actor" : "ownership-mismatch",
    });
    expect(preflight()).toEqual(check());
  });
  it("publishes an exact thread pointer and shares decisions with the read-only preflight", () => {
    expect(read(index())).toEqual({ v: 1, thread: reviewer, feature: "demo", nonce });
    expect(read(stamp()).editBinding).toMatchObject({
      v: 1,
      checkout: target,
      target: "main",
      stateDir: ".navori/state/handoffs",
    });
    const before = readFileSync(index(), "utf8");
    expect(check()).toEqual({ status: "ok", reason: "bound-review-output" });
    expect(preflight()).toEqual(check());
    expect(readFileSync(index(), "utf8")).toBe(before);
    rmSync(index());
    expect(check().status).toBe("error");
    expect(preflight()).toEqual(check());
  });

  it("replaces only the same thread's index and ignores 101 unrelated historical stamps", () => {
    for (let i = 0; i < 105; i++) writeFileSync(state(`review_demo.history-${i}.begin.json`), "{}");
    const old = nonce;
    nonce = begin();
    expect(nonce).not.toBe(old);
    expect(read(index()).nonce).toBe(nonce);
    actor(otherReviewer, "reviewer");
    const otherNonce = begin();
    expect(read(index()).nonce).toBe(nonce);
    expect(read(state(reviewEditIndexName("demo", otherReviewer))).nonce).toBe(otherNonce);
    expect(check().status).toBe("ok");
    expect(check(undefined, otherReviewer).status).toBe("ok");
    expect(check(undefined, producer).status).toBe("error");
  });

  it("does not publish an external binding when only --cwd selects another checkout", () => {
    vi.mocked(process.cwd).mockReturnValue(host);
    const result = beginReview(options());
    expect(result.status).toBe("begun");
    if (result.status !== "begun") throw new Error(result.message);
    expect(result.editBinding).toBe("unavailable");
    expect(read(state(`review_demo.${result.nonce}.begin.json`)).editBinding).toBeUndefined();
    expect(read(index()).nonce).toBe(nonce);
    expect(preflight().reason).toContain("actual target checkout");
  });

  it("reports interrupted index publication and leaves no new usable pointer", () => {
    rmSync(index());
    mkdirSync(index());
    expect(beginReview(options()).status).toBe("error");
    expect(check().status).toBe("error");
    rmSync(index(), { recursive: true });
    nonce = begin();
    expect(check().status).toBe("ok");
  });

  it.each(["index", "stamp"])("bounds the %s individually and rejects malformed JSON", (which) => {
    const file = which === "index" ? index() : stamp();
    const original = readFileSync(file, "utf8");
    writeFileSync(file, " ".repeat(65537));
    expect(check()).toEqual({ status: "error", reason: "oversized-binding" });
    expect(preflight()).toEqual(check());
    writeFileSync(file, "{");
    expect(check().status).toBe("error");
    writeFileSync(file, original);
    expect(check().status).toBe("ok");
  });

  it.each([
    [
      "index nonce",
      "index",
      (b: Record<string, unknown>) => {
        b.nonce = parent;
      },
    ],
    [
      "index feature",
      "index",
      (b: Record<string, unknown>) => {
        b.feature = "other";
      },
    ],
    [
      "index thread",
      "index",
      (b: Record<string, unknown>) => {
        b.thread = producer;
      },
    ],
    [
      "stamp feature",
      "stamp",
      (b: Record<string, unknown>) => {
        b.feature = "other";
      },
    ],
    [
      "missing binding",
      "stamp",
      (b: Record<string, unknown>) => {
        delete b.editBinding;
      },
    ],
    [
      "wrong actor",
      "stamp",
      (b: Record<string, unknown>) => {
        (b.reviewer as Record<string, unknown>).thread = producer;
      },
    ],
    [
      "wrong role",
      "stamp",
      (b: Record<string, unknown>) => {
        (b.reviewer as Record<string, unknown>).role = "implementer";
      },
    ],
    [
      "invalid reviewer parent",
      "stamp",
      (b: Record<string, unknown>) => {
        (b.reviewer as Record<string, unknown>).parent = "not-a-native-thread";
      },
    ],
    [
      "wrong source checkout",
      "stamp",
      (b: Record<string, unknown>) => {
        (b.reviewer as Record<string, unknown>).sourceCwd = target;
      },
    ],
    [
      "producer role",
      "ownership",
      (b: Record<string, unknown>) => {
        (b.actors as Record<string, unknown>[])[0]!.role = "reviewer";
      },
    ],
    [
      "producer root",
      "ownership",
      (b: Record<string, unknown>) => {
        (b.actors as Record<string, unknown>[])[0]!.root = otherReviewer;
      },
    ],
    [
      "reviewer producer independence",
      "ownership",
      (b: Record<string, unknown>) => {
        (b.actors as Record<string, unknown>[])[0]!.thread = reviewer;
      },
    ],
    [
      "ownership target",
      "ownership",
      (b: Record<string, unknown>) => {
        b.target = "other";
      },
    ],
    [
      "ownership cwd",
      "ownership",
      (b: Record<string, unknown>) => {
        b.cwd = host;
      },
    ],
    [
      "ownership digest",
      "ownership",
      (b: Record<string, unknown>) => {
        b.handoff = "0".repeat(64);
      },
    ],
  ])("rejects %s through the reader and preflight", (_label, kind, mutate) => {
    change(
      kind === "index" ? index() : kind === "stamp" ? stamp() : state("ownership_demo.json"),
      mutate,
    );
    expect(check().status).toBe("error");
    expect(preflight()).toEqual(check());
  });

  it("rejects a changed handoff and mismatched checkout identity", () => {
    appendFileSync(state("impl_demo.json"), " ");
    expect(check().reason).toBe("handoff-changed");
    change(stamp(), (b) => {
      (b.editBinding as Record<string, unknown>).gitDir = host;
    });
    expect(check().reason).toBe("invalid-binding");
  });

  it("denies source, other artifacts, traversal and mixed output patches", () => {
    for (const file of [
      join(target, "a.txt"),
      state("review_other.md"),
      index(),
      state("ownership_demo.json"),
      `${target}/.navori/state/handoffs/../handoffs/review_demo.md`,
    ]) {
      expect(check([output(), file]).status, file).toBe("error");
    }
    expect(check([output()], "").reason).toBe("native-agent-id-unavailable");
  });

  it("denies symlink leaves, state ancestors and copied bindings in a registered sibling", () => {
    symlinkSync(join(target, "a.txt"), output());
    expect(check().reason).toBe("symlink-path");
    rmSync(output());
    const sibling = join(dir, "sibling");
    git(host, "worktree", "add", "-b", "sibling", sibling);
    const siblingState = join(sibling, ".navori/state/handoffs");
    mkdirSync(siblingState, { recursive: true });
    copyFileSync(index(), join(siblingState, reviewEditIndexName("demo", reviewer)));
    copyFileSync(stamp(), join(siblingState, `review_demo.${nonce}.begin.json`));
    expect(check([join(siblingState, "review_demo.md")]).reason).toBe("invalid-binding");
    rmSync(join(sibling, ".navori"), { recursive: true });
    symlinkSync(join(target, ".navori"), join(sibling, ".navori"));
    expect(check([join(siblingState, "review_demo.md")]).reason).toBe("symlink-path");
  });

  it("denies unregistered checkout-shaped copies and foreign repositories", () => {
    const fake = join(dir, "unregistered");
    mkdirSync(fake);
    copyFileSync(join(target, ".git"), join(fake, ".git"));
    expect(check([join(fake, ".navori/state/handoffs/review_demo.md")]).status).toBe("error");
    const foreign = join(dir, "foreign");
    mkdirSync(foreign);
    repoTpl.copyInto(foreign);
    expect(check([join(foreign, ".navori/state/handoffs/review_demo.md")]).reason).toBe(
      "unregistered-checkout",
    );
  });

  it("keeps post-seal Markdown append eligible while content drift still invalidates review", () => {
    writeFileSync(
      output("json"),
      JSON.stringify({ feature: "demo", verdict: "APPROVED", findings: [] }),
    );
    expect(sealReview({ ...options(), nonce }).status).toBe("validated");
    appendFileSync(output(), "delta after seal\n");
    expect(check().status).toBe("ok");
    const sidecar = ReviewSidecarSchema.parse(read(output("json")));
    expect(correlateReview(resolveStateRoot(options()), sidecar, options()).correlation).toBe(
      "correlated",
    );
    writeFileSync(join(target, "a.txt"), "drift\n");
    expect(correlateReview(resolveStateRoot(options()), sidecar, options()).correlation).toBe(
      "unavailable",
    );
  });

  it("detects old or marker-only hooks before requesting native identity", () => {
    const hook = join(host, ".codex/hooks/role-guard.sh");
    writeFileSync(hook, "# navori:review-edit-binding/v1\n");
    expect(preflight().reason).toContain("unsupported-host-hook");
    expect(preflightReviewEdits({ cwd: target, hostCwd: host, feature: "../escape" }).status).toBe(
      "error",
    );
  });

  it("renders begin/preflight/full-gate order and keeps the delta Markdown append instruction", () => {
    const doctrine = readFileSync(join(host, ".codex/agents/reviewer.toml"), "utf8");
    expect(doctrine.indexOf("receipt review preflight")).toBeGreaterThan(
      doctrine.indexOf("receipt review begin"),
    );
    expect(doctrine.indexOf("receipt review preflight")).toBeLessThan(
      doctrine.indexOf("test-review-full"),
    );
    expect(doctrine).toContain("Append");
    expect(doctrine).toContain("Never edit the sidecar after");
  });
});
