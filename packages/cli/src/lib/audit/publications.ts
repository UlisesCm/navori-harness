import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CONTENT_ALG, IDENTITY_EXCLUDES } from "../primitives/content-identity.ts";
import { correlateGateExecutions, type SessionAudit } from "./model.ts";

export interface PublicationObservation {
  sessionId: string;
  correlatedApproval: boolean;
}
export interface CommitObservation {
  sessionId: string;
  greenGate: boolean;
}
export type PublicationEvidence =
  | {
      state: "observed";
      publications: PublicationObservation[];
      commits: CommitObservation[];
      unavailableCommitSessions?: string[];
    }
  | {
      state: "unavailable";
      reason:
        | "not-requested"
        | "unreadable-git"
        | "missing-reflog"
        | "ambiguous-publication"
        | "ambiguous-time"
        | "incomplete-session"
        | "ambiguous-ownership"
        | "missing-gate-source"
        | "missing-checkout";
    };

/** Fixed read-only plumbing, bounded output/time, no checkout, filters, hooks or network. */
function git(cwd: string, args: readonly string[], deadline = Date.now() + 5000): string {
  const remaining = Math.min(5000, deadline - Date.now());
  if (remaining <= 0) throw new Error("unreadable-git");
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };
  for (const key of Object.keys(env))
    if (
      [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_CONFIG",
        "GIT_CONFIG_PARAMETERS",
        "GIT_CONFIG_COUNT",
      ].includes(key) ||
      /^GIT_CONFIG_(?:KEY|VALUE)_/.test(key)
    )
      delete env[key];
  const result = spawnSync(
    "git",
    [
      "--no-replace-objects",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    {
      cwd,
      encoding: "utf8",
      timeout: remaining,
      maxBuffer: 4 * 1024 * 1024,
      env,
    },
  );
  if (result.error || result.status !== 0) throw new Error("unreadable-git");
  return result.stdout;
}

/** Same canonical identity as contentIdentity, using immutable tree entries only. */
export function publishedContentIdentity(
  remote: string,
  commit: string,
  deadline = Date.now() + 5000,
): string {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("unreadable-git");
  const entries: Array<{ path: Buffer; line: string }> = [];
  for (const record of git(remote, ["ls-tree", "-r", "-z", "--full-tree", commit], deadline).split(
    "\0",
  )) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    const [mode, type, blob] = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (tab < 0 || /[\r\n\uFFFD]/.test(path) || !blob) throw new Error("unreadable-git");
    if (
      type !== "blob" ||
      IDENTITY_EXCLUDES.some(
        (prefix: string): boolean => path === prefix || path.startsWith(prefix + "/"),
      )
    )
      continue;
    if (!["100644", "100755", "120000"].includes(mode ?? "")) throw new Error("unreadable-git");
    entries.push({ path: Buffer.from(path), line: `${mode} ${blob}\t${path}\0` });
  }
  entries.sort((left, right): number => Buffer.compare(left.path, right.path));
  return createHash("sha256")
    .update(CONTENT_ALG + "\n" + entries.map((entry): string => entry.line).join(""))
    .digest("hex");
}

interface RefEntry {
  commit: string;
  ref: string;
  at: number;
  message: string;
}
function reflog(cwd: string, ref?: string, deadline?: number): RefEntry[] {
  const raw = git(
    cwd,
    ["reflog", "show", ...(ref ? [ref] : ["--all"]), "--date=unix", "--format=%H%x09%gD%x09%gs"],
    deadline,
  );
  const entries: RefEntry[] = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    if (entries.length >= 10000) throw new Error("unreadable-git");
    const [commit = "", selector = "", message = ""] = line.split("\t");
    const match = /^(refs\/heads\/[^\t\r\n]+)@\{(\d+)\}$/.exec(selector);
    if (!match) continue;
    entries.push({ commit, ref: match[1]!, at: Number(match[2]) * 1000, message });
  }
  return entries;
}

function contains(session: SessionAudit, at: number): boolean {
  // A reflog timestamp has one-second resolution; its entire interval must fit.
  return Date.parse(session.startedAt) <= at && Date.parse(session.endedAt) >= at + 999;
}

/** Session-window association is descriptive, never native actor authorization. */
export function readPublications(
  remote: string | undefined,
  sessions: readonly SessionAudit[],
): PublicationEvidence {
  if (!remote) return { state: "unavailable", reason: "not-requested" };
  if (
    sessions.some(
      (session: SessionAudit): boolean =>
        !session.sealed ||
        !Number.isFinite(Date.parse(session.startedAt)) ||
        !Number.isFinite(Date.parse(session.endedAt)),
    )
  )
    return { state: "unavailable", reason: "incomplete-session" };
  const deadline = Date.now() + 10000;
  try {
    if (git(remote, ["rev-parse", "--is-bare-repository"], deadline).trim() !== "true")
      return { state: "unavailable", reason: "unreadable-git" };
    if (git(remote, ["config", "--get", "core.logAllRefUpdates"], deadline).trim() !== "always")
      return { state: "unavailable", reason: "missing-reflog" };
    const tips = reflog(remote, undefined, deadline);
    if (!tips.length) return { state: "unavailable", reason: "missing-reflog" };
    const publications: PublicationObservation[] = [];
    const identities = new Map<string, string>();
    const branches = new Map<string, { session: SessionAudit; ref: string }>();
    for (const session of sessions)
      if (session.gitBranch && session.cwd)
        branches.set(JSON.stringify([session.sessionId, session.gitBranch]), {
          session,
          ref: `refs/heads/${session.gitBranch}`,
        });
    for (const tip of tips) {
      if (!sessions.some((session: SessionAudit): boolean => contains(session, tip.at))) continue;
      const candidates = sessions.filter(
        (session: SessionAudit): boolean =>
          (session.host === "pi" || !session.host || session.host === "claude") &&
          contains(session, tip.at),
      );
      if (candidates.length !== 1) return { state: "unavailable", reason: "ambiguous-publication" };
      const session = candidates[0]!;
      const fingerprint =
        identities.get(tip.commit) ?? publishedContentIdentity(remote, tip.commit, deadline);
      identities.set(tip.commit, fingerprint);
      const reviews = sessions
        .filter(
          (source: SessionAudit): boolean =>
            source.cwd !== null &&
            source.cwd === session.cwd &&
            (source.host ?? "claude") === (session.host ?? "claude"),
        )
        .flatMap((source: SessionAudit) => source.cliEvents ?? [])
        .flatMap((event) => {
          const outcome = event.outcomePayload;
          return outcome?.name === "review-outcome" &&
            outcome.alg === CONTENT_ALG &&
            outcome.fp === fingerprint &&
            outcome.correlation === "correlated" &&
            typeof outcome.sealedAtMs === "number" &&
            outcome.sealedAtMs < tip.at &&
            outcome.sealedAtMs <= event.tsMs &&
            event.tsMs < tip.at
            ? [outcome]
            : [];
        });
      // A later rejection of the same bytes supersedes an earlier approval.
      reviews.sort((left, right): number => right.sealedAtMs! - left.sealedAtMs!);
      const latest = reviews[0];
      const tied = reviews.length > 1 && latest?.sealedAtMs === reviews[1]?.sealedAtMs;
      publications.push({
        sessionId: session.sessionId,
        correlatedApproval: !tied && latest?.verdict === "approved",
      });
      branches.set(JSON.stringify([session.sessionId, tip.ref.replace(/^refs\/heads\//, "")]), {
        session,
        ref: tip.ref,
      });
    }
    const commits: CommitObservation[] = [];
    for (const { session, ref } of branches.values()) {
      if (!session.cwd) return { state: "unavailable", reason: "missing-checkout" };
      const entries = reflog(session.cwd, ref, deadline);
      if (!entries.length) return { state: "unavailable", reason: "missing-reflog" };
      const history = entries
        .filter(
          (entry: RefEntry): boolean =>
            /^commit(?: \(initial\)| \(amend\))?:/.test(entry.message) &&
            contains(session, entry.at),
        )
        .sort((left: RefEntry, right: RefEntry): number => left.at - right.at);
      const gates = correlateGateExecutions(session).filter(
        (gate): boolean => gate.handle.split("\0")[0] === "quality-gate-pre-commit",
      );
      if (
        history.length &&
        !gates.length &&
        !session.hookLogFrom &&
        session.sources?.["audit-log"]?.state !== "observed"
      )
        return { state: "unavailable", reason: "missing-gate-source" };
      const gateTime = (gate: (typeof gates)[number]): number =>
        Date.parse(gate.endedAt ?? gate.startedAt ?? "");
      let previous = Date.parse(session.startedAt) - 1;
      for (const entry of history) {
        if (entry.at <= previous) return { state: "unavailable", reason: "ambiguous-time" };
        if (
          gates.some(
            (gate): boolean => gateTime(gate) >= entry.at && gateTime(gate) < entry.at + 1000,
          )
        )
          return { state: "unavailable", reason: "ambiguous-time" };
        const preceding = gates
          .filter((gate): boolean => gateTime(gate) > previous && gateTime(gate) < entry.at)
          .sort((left, right): number => gateTime(right) - gateTime(left));
        const latest = preceding[0];
        if (latest && !latest.ownerExact)
          return { state: "unavailable", reason: "ambiguous-ownership" };
        if (latest && !latest.ran) return { state: "unavailable", reason: "missing-gate-source" };
        if (latest && preceding[1] && gateTime(latest) === gateTime(preceding[1]))
          return { state: "unavailable", reason: "ambiguous-time" };
        const green =
          latest?.ran === true &&
          latest.outcome === "completed" &&
          latest.terminal === "allow" &&
          latest.ownerExact;
        commits.push({ sessionId: session.sessionId, greenGate: green });
        previous = entry.at + 999;
      }
    }
    const known = new Set([...branches.values()].map((entry): string => entry.session.sessionId));
    const unavailableCommitSessions = sessions
      .filter((session: SessionAudit): boolean => !known.has(session.sessionId))
      .map((session: SessionAudit): string => session.sessionId);
    return {
      state: "observed",
      publications,
      commits,
      ...(unavailableCommitSessions.length ? { unavailableCommitSessions } : {}),
    };
  } catch {
    return { state: "unavailable", reason: "unreadable-git" };
  }
}
