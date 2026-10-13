/** Read-only continuity: preserve the task text while revalidating carried guarantees. */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../config/config.ts";
import { checkReceipt } from "../diagnose/receipt.ts";
import { correlateReview } from "../handoff/review-evidence.ts";
import { readOwnership } from "../handoff/actor-provenance.ts";
import { ReviewSidecarSchema } from "../handoff/review-schema.ts";
import { contentIdentity, type ContentIdentity } from "../primitives/content-identity.ts";
import { resolveStateRoot, stateArtifactPath } from "../primitives/state-root.ts";
import { fingerprintTree, readHead, validateEvidence } from "./evidence.ts";
import { WorkplanSchema } from "./schema.ts";

type Guarantee = { status: "passed" | "pending"; reason?: string };
export interface ResumeResult {
  status: "evaluated" | "pending";
  current: string;
  plans: Array<{
    feature: string;
    acceptance: Record<string, Guarantee>;
    review: Guarantee;
    receipt: Guarantee;
  }>;
  reason?: string;
}
const pending = (reason: string): Guarantee => ({ status: "pending", reason });

/** Reads bounded state without creating it; malformed or ambiguous state is never revived. */
export function resumePlans(cwd: string, budgetMs = 5000): ResumeResult {
  const deadline = Date.now() + Math.min(5000, Math.max(0, budgetMs));
  const result: ResumeResult = { status: "evaluated", current: "", plans: [] };
  try {
    for (const name of [
      "progress/current.md",
      ".claude/progress/current.md",
      ".codex/progress/current.md",
    ]) {
      const path = join(cwd, name);
      if (existsSync(path) && statSync(path).size <= 65536) {
        result.current = readFileSync(path, "utf8");
        break;
      }
    }
    const root = resolveStateRoot({ cwd, feature: "resume" });
    if (!existsSync(root.path)) return { ...result, status: "pending", reason: "no workplans" };
    const names = readdirSync(root.path).filter((name) =>
      /^workplan_[a-z0-9][a-z0-9._-]*\.json$/.test(name),
    );
    if (names.length === 0 || names.length > 32)
      return {
        ...result,
        status: "pending",
        reason: "workplan enumeration unavailable or exceeds budget",
      };
    const config = readConfig(join(root.cwd, "navori.config.json"));
    const defaultTarget = config.prTarget ?? config.branchBase;
    const gate = config.qualityGate?.full ?? "";
    const fingerprint = fingerprintTree(root.cwd, undefined, { readOnly: true, deadline });
    const head = readHead(root.cwd, deadline);
    const identities = new Map<string, ContentIdentity>();
    for (const name of names) {
      const path = stateArtifactPath(root, name);
      if (statSync(path).size > 65536) throw new Error("workplan exceeds read budget");
      const parsed = WorkplanSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (!parsed.success || name !== `workplan_${parsed.data.feature}.json`)
        throw new Error("invalid workplan binding");
      const plan = parsed.data;
      const target = readOwnership(root.cwd, plan.feature, root.dir)?.target ?? defaultTarget;
      let content = identities.get(target);
      if (!content) {
        content =
          Date.now() >= deadline
            ? { ok: false, reason: "timeout" }
            : contentIdentity(root.cwd, { target, timeoutMs: Math.max(1, deadline - Date.now()) });
        identities.set(target, content);
      }
      const acceptance: Record<string, Guarantee> = {};
      for (const criterion of plan.acceptance) {
        if (Date.now() >= deadline || plan.source)
          acceptance[criterion.id] = pending("deadline or source authority unavailable");
        else {
          const verdict = validateEvidence({
            root,
            feature: plan.feature,
            id: criterion.id,
            command: criterion.command,
            current: { cwd: root.cwd, head, fingerprint },
          });
          acceptance[criterion.id] = verdict.ok ? { status: "passed" } : pending(verdict.why);
        }
      }
      let review = pending("review unavailable");
      const reviewPath = stateArtifactPath(root, `review_${plan.feature}.json`);
      const options = {
        cwd: root.cwd,
        dir: root.dir,
        feature: plan.feature,
        target,
        gate,
        currentContent: content,
      };
      if (Date.now() < deadline && existsSync(reviewPath) && statSync(reviewPath).size <= 65536) {
        const sidecar = ReviewSidecarSchema.safeParse(JSON.parse(readFileSync(reviewPath, "utf8")));
        if (sidecar.success) {
          const correlation = correlateReview(root, sidecar.data, options).correlation;
          review =
            sidecar.data.verdict === "APPROVED" && correlation === "correlated"
              ? { status: "passed" }
              : pending(correlation);
        }
      }
      let receipt = pending("receipt unavailable");
      if (Date.now() < deadline) {
        const checked = checkReceipt({
          ...options,
          readOnly: true,
          deadline,
          includeConsumed: true,
        });
        receipt =
          checked.result.status === "ok" && checked.result.fresh
            ? { status: "passed" }
            : pending(checked.result.error ?? "receipt stale or changed");
      }
      result.plans.push({ feature: plan.feature, acceptance, review, receipt });
    }
    if (Date.now() >= deadline) throw new Error("resume deadline exceeded");
    return result;
  } catch (error) {
    // A partial pass after the deadline is not a current guarantee.
    for (const plan of result.plans) {
      for (const id of Object.keys(plan.acceptance))
        plan.acceptance[id] = pending("resume incomplete");
      plan.review = pending("resume incomplete");
      plan.receipt = pending("resume incomplete");
    }
    return {
      ...result,
      status: "pending",
      reason: error instanceof Error ? error.message : "resume unavailable",
    };
  }
}
