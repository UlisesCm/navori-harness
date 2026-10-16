/** Readonly acceptance probe for #1022's actual native verification delivery. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** @typedef {import("../../packages/cli/src/lib/handoff/actor-provenance.ts").NativeActor} NativeActor */
/** @typedef {{kind: "patch", patch: string} | {kind: "command", cmd: string, workdir: string}} Operation */
/** @typedef {{exit_code?: number, session_id?: number, output?: string}} ToolResult */
/** @typedef {{at: number, end: number, operation: Operation | undefined, result: ToolResult | undefined, success: boolean}} NativeCall */
/** @typedef {{timestamp: string, type: string, payload: {type?: string, call_id?: string, name?: string, input?: unknown, output?: unknown}}} NativeEvent */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Verification fixture (linked worktree based on origin/dev) and the base branch its run targets. */
const FIXTURE_DIR = ".navori/state/fixtures/1022-parallel-live/native-dev";
const TARGET = "dev";
const fixture = join(root, FIXTURE_DIR);
const feature = "1022-parallel-live-e1";
/** @param {string | Buffer} value @returns {string} */
const sha = (value) => createHash("sha256").update(value).digest("hex");
/** @param {unknown} condition @param {string} message @returns {void} */
const requireProof = (condition, message) => {
  if (!condition) throw new Error(message);
};

/** Only literal single-operation orchestration is interpreted; source is never evaluated.
 * @param {unknown} input @returns {Operation | undefined}
 */
export function literalOperation(input) {
  if (typeof input !== "string") return undefined;
  const match = /^\s*text\(await tools\.(apply_patch|exec_command)\(([\s\S]*)\)\);?\s*$/.exec(
    input,
  );
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[2]);
    if (match[1] === "apply_patch" && typeof value === "string")
      return { kind: "patch", patch: value };
    if (
      match[1] === "exec_command" &&
      value &&
      typeof value === "object" &&
      typeof value.cmd === "string" &&
      typeof value.workdir === "string"
    )
      return { kind: "command", ...value };
  } catch {
    // A dynamic expression, template literal or malformed JSON is not native proof.
  }
  return undefined;
}

/** Correlates native call IDs with their completed tool results, retaining metadata only.
 * @param {NativeEvent[]} events @returns {NativeCall[]}
 */
export function nativeCalls(events) {
  const pending = new Map();
  const calls = [];
  for (const event of events) {
    if (event.type !== "response_item") continue;
    const p = event.payload;
    if (!p || typeof p.call_id !== "string") continue;
    if (p.type === "custom_tool_call" && p.name === "exec")
      pending.set(p.call_id, {
        at: Date.parse(event.timestamp),
        operation: literalOperation(p.input),
      });
    if (p.type !== "custom_tool_call_output") continue;
    const call = pending.get(p.call_id);
    if (!call) continue;
    pending.delete(p.call_id);
    const blocks = Array.isArray(p.output) ? p.output : [];
    const texts = blocks
      .filter((b) => b.type === "input_text" && typeof b.text === "string")
      .map((b) => b.text);
    let result;
    try {
      result = JSON.parse(texts.at(-1));
    } catch {
      result = undefined;
    }
    calls.push({
      ...call,
      end: Date.parse(event.timestamp),
      result,
      success: texts[0]?.startsWith("Script completed\n") && result !== undefined,
    });
  }
  return calls;
}

/** Selects a unique real runtime source; copied coordinator artifacts cannot supply proof.
 * @param {string} thread
 */
function source(thread) {
  requireProof(/^[0-9a-f-]{36}$/.test(thread), "invalid native thread");
  const sessions = join(homedir(), ".codex/sessions");
  const matches = [];
  let scanned = 0;
  for (const year of readdirSync(sessions, { withFileTypes: true })) {
    if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue;
    for (const month of readdirSync(join(sessions, year.name), { withFileTypes: true })) {
      if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue;
      for (const day of readdirSync(join(sessions, year.name, month.name), {
        withFileTypes: true,
      })) {
        requireProof(++scanned <= 4096, "native source date budget exceeded");
        if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue;
        const dir = join(sessions, year.name, month.name, day.name);
        for (const file of readdirSync(dir))
          if (file.endsWith(`${thread}.jsonl`)) matches.push(join(dir, file));
      }
    }
  }
  requireProof(matches.length === 1, "unique real native source unavailable");
  requireProof(
    statSync(matches[0]).size <= 128 * 1024 * 1024,
    "native source byte budget exceeded",
  );
  const lines = readFileSync(matches[0], "utf8").trimEnd().split("\n");
  requireProof(
    lines.length <= 100000 && lines.every((line) => line.length <= 2 * 1024 * 1024),
    "native source event budget exceeded",
  );
  const events = lines.map((line) => JSON.parse(line));
  return { header: events[0], headerHash: sha(lines[0]), calls: nativeCalls(events) };
}

/** @param {string} cwd @returns {string} */
function commonDir(cwd) {
  const result = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
  requireProof(result.status === 0, "native source checkout unavailable");
  return realpathSync(result.stdout.trim());
}

/** Checks the original header's complete designated context against CLI-owned attribution.
 * @param {NativeActor} actor
 */
function producerSource(actor) {
  const log = source(actor.thread);
  const p = log.header.payload;
  const spawned = p?.source?.subagent?.thread_spawn;
  requireProof(
    log.header.type === "session_meta" &&
      p.id === actor.thread &&
      p.session_id === actor.root &&
      p.parent_thread_id === actor.parent &&
      spawned?.parent_thread_id === actor.parent &&
      p.agent_role === actor.role &&
      spawned?.agent_role === actor.role &&
      p.cli_version === actor.version &&
      log.headerHash === actor.sourceHash &&
      realpathSync(p.cwd) === actor.sourceCwd &&
      commonDir(p.cwd) === commonDir(fixture),
    "native producer header does not match current ownership",
  );
  return log;
}

/** Resolves actual patch destinations; every successful owned write must be attributable.
 * @param {string} patch @param {string} cwd @returns {string[]}
 */
export function patchPaths(patch, cwd) {
  requireProof(
    patch.startsWith("*** Begin Patch\n") && patch.trimEnd().endsWith("*** End Patch"),
    "unsupported patch proof",
  );
  requireProof(!patch.includes("*** Move to:"), "renamed patch proof is unsupported");
  const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => {
    const path = relative(cwd, isAbsolute(m[1]) ? m[1] : resolve(cwd, m[1]));
    requireProof(
      path && !path.startsWith("../") && !isAbsolute(path),
      "native patch escapes fixture",
    );
    return path;
  });
  requireProof(paths.length > 0, "native patch has no destinations");
  return paths;
}

/** @param {NativeCall} call @returns {boolean} */
function commandPassed(call) {
  return (
    call.success &&
    call.operation?.kind === "command" &&
    call.result?.exit_code === 0 &&
    call.result.session_id === undefined &&
    realpathSync(call.operation.workdir) === realpathSync(fixture)
  );
}

/** Reads current ownership and independently correlated review through production validators. */
function runtimeEvidence() {
  /** @param {string} path @returns {string} */
  const moduleUrl = (path) => JSON.stringify(pathToFileURL(join(root, path)).href);
  const code = `import { parallelLiveEvidence } from ${moduleUrl("packages/cli/src/lib/handoff/parallel.ts")};
import { correlateReview } from ${moduleUrl("packages/cli/src/lib/handoff/review-evidence.ts")};
import { ReviewSidecarSchema } from ${moduleUrl("packages/cli/src/lib/handoff/review-schema.ts")};
import { resolveStateRoot } from ${moduleUrl("packages/cli/src/lib/primitives/state-root.ts")};
import { readConfig } from ${moduleUrl("packages/cli/src/lib/config/config.ts")};
import { readFileSync } from "node:fs";
const options = {cwd:process.cwd(),feature:${JSON.stringify(feature)},target:${JSON.stringify(TARGET)}};
const config = readConfig(options.cwd+"/navori.config.json");
const state = resolveStateRoot(options);
const sidecar = ReviewSidecarSchema.parse(JSON.parse(readFileSync(state.path+"/review_"+options.feature+".json","utf8")));
process.stdout.write(JSON.stringify({live:parallelLiveEvidence(options),review:correlateReview(state,sidecar,{...options,gate:config.qualityGate.full}),verdict:sidecar.verdict,gates:config.qualityGate}));`;
  const result = spawnSync("bun", ["--eval", code], {
    cwd: fixture,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  requireProof(result.status === 0, "current native ownership or sealed review unavailable");
  return JSON.parse(result.stdout);
}

/** Validates real overlap, writes and the serial post-join evidence before accepting A4. */
export function checkLive() {
  const { live, review, verdict, gates } = runtimeEvidence();
  requireProof(
    live.status === "ok" && review.correlation === "correlated" && verdict === "APPROVED",
    "current joint native review is not approved",
  );
  const c = live.authorization;
  requireProof(
    c.spec === "1022-parallel-live" &&
      c.delivery === "E1" &&
      c.milestone === "M1" &&
      JSON.stringify(c.implementerPaths) === JSON.stringify(["src/label.mjs", "src/report.mjs"]) &&
      JSON.stringify(c.markdownRequests.map((r) => r.path)) === JSON.stringify(["docs/labels.md"]),
    "unexpected verification delivery scope",
  );
  const producers = live.producers;
  for (const path of [...c.implementerPaths, ...c.markdownRequests.map((r) => r.path)]) {
    const before = spawnSync("git", ["show", `${c.head}:${path}`], { cwd: fixture, timeout: 5000 });
    if (before.status === 0)
      requireProof(
        sha(before.stdout) !== sha(readFileSync(join(fixture, path))),
        "native owned write did not change baseline bytes",
      );
    else {
      const listed = spawnSync("git", ["ls-tree", "--name-only", c.head, "--", path], {
        cwd: fixture,
        encoding: "utf8",
        timeout: 5000,
      });
      requireProof(
        listed.status === 0 && !listed.stdout.trim(),
        "native owned baseline unavailable",
      );
    }
  }
  const overlapStart = Math.max(...producers.map((p) => Date.parse(p.startedAt)));
  const overlapEnd = Math.min(...producers.map((p) => Date.parse(p.completedAt)));
  requireProof(overlapStart < overlapEnd, "native production intervals do not overlap");
  const logs = producers.map((p) => producerSource(p.actor));
  const writes = [];
  for (const [index, p] of producers.entries()) {
    const owned =
      p.role === "implementer" ? c.implementerPaths : c.markdownRequests.map((r) => r.path);
    const written = new Set();
    for (const call of logs[index].calls.filter(
      (call) => call.at >= Date.parse(p.startedAt) && call.at <= Date.parse(p.completedAt),
    )) {
      requireProof(call.operation, "unparsed native producer operation");
      if (call.operation.kind !== "patch") continue;
      requireProof(
        call.success &&
          call.end <= Date.parse(p.completedAt) &&
          JSON.stringify(call.result) === "{}",
        "owned patch lacks a successful native result",
      );
      for (const path of patchPaths(call.operation.patch, fixture)) {
        requireProof(owned.includes(path), "native producer wrote outside its ownership");
        written.add(path);
      }
      writes.push(call.at);
    }
    requireProof(
      owned.every((path) => written.has(path)),
      "producer lacks actual native own-path writes",
    );
  }
  requireProof(
    Math.min(...writes) >= overlapStart && Math.min(...writes) <= overlapEnd,
    "native work did not begin under overlapping claims",
  );
  const rootLog = source(producers[0].actor.root);
  requireProof(
    rootLog.header.payload?.id === producers[0].actor.root &&
      commonDir(rootLog.header.payload.cwd) === commonDir(fixture),
    "native coordinator source unavailable",
  );
  const joined = Math.max(...producers.map((p) => Date.parse(p.completedAt)));
  const reviewer = review.evidence?.reviewer;
  requireProof(
    reviewer &&
      reviewer.root === producers[0].actor.root &&
      producers.every((p) => p.actor.thread !== reviewer.thread),
    "native reviewer is not independent",
  );
  const reviewerLog = producerSource(reviewer);
  const allCalls = [...rootLog.calls, ...logs.flatMap((log) => log.calls), ...reviewerLog.calls];
  const firstStart = Math.min(...producers.map((p) => Date.parse(p.startedAt)));
  for (const call of allCalls.filter((call) => call.at <= joined && call.end >= firstStart)) {
    requireProof(call.operation, "unparsed operation during native production");
    if (call.operation.kind !== "command") continue;
    requireProof(call.result?.session_id === undefined, "unfinished native production command");
    const cmd = call.operation.cmd;
    requireProof(
      !/\bgit\b[^\n]*(?:\badd\b|\bcommit\b|\bcheckout\b|\bswitch\b|\breset\b|\brebase\b|\bmerge\b)/.test(
        cmd,
      ) &&
        !/\brender\b|\bgate\s+(?:fast|full)\b/.test(cmd) &&
        !cmd.includes(gates.fast) &&
        !cmd.includes(gates.full),
      "Git/render/shared checks overlapped native production",
    );
  }
  const serial = allCalls.filter(
    (call) => call.at >= joined && call.end <= Date.parse(live.finalizedAt) && commandPassed(call),
  );
  requireProof(
    serial.some((call) =>
      /\bnode\s+[^\n]*packages\/cli\/dist\/index\.js\s+render\s+--apply(?:\s|$)/.test(
        call.operation.cmd,
      ),
    ),
    "successful official post-join render unavailable",
  );
  requireProof(
    serial.some(
      (call) =>
        call.operation.cmd === gates.fast ||
        (/\bgate fast\b/.test(call.operation.cmd) &&
          /navori gate fast: exit 0/.test(call.result.output)),
    ),
    "successful post-join shared fast checks unavailable",
  );
  requireProof(
    Date.parse(review.evidence.startedAt) >= Date.parse(live.finalizedAt),
    "joint review started before finalization",
  );
  requireProof(
    reviewerLog.calls.some(
      (call) =>
        call.at >= Date.parse(review.evidence.startedAt) &&
        call.end <= Date.parse(review.evidence.sealedAt) &&
        commandPassed(call) &&
        (call.operation.cmd === gates.full ||
          (/\bgate full\b/.test(call.operation.cmd) &&
            /navori gate full: exit 0/.test(call.result.output))),
    ),
    "native independent full checks unavailable",
  );
  return {
    status: "ok",
    feature,
    runId: c.runId,
    producers: producers.length,
    overlapMs: overlapEnd - overlapStart,
    review: "correlated",
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(checkLive())}\n`);
  } catch (error) {
    process.stderr.write(
      `A4 unavailable: ${error instanceof Error ? error.message : "native evidence rejected"}\n`,
    );
    process.exitCode = 1;
  }
}
