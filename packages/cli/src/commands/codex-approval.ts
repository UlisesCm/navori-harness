import { defineCommand } from "citty";
import { fork } from "node:child_process";
import { approvalDeny, relayApproval, requestApproval } from "../lib/codex/approval-route.ts";

/** The parent stays responsive while synchronous Git/filesystem work runs in a killable group. */
async function supervised(operation: string): Promise<void> {
  await new Promise<void>((done) => {
    const child = fork(process.argv[1]!, process.argv.slice(2), {
      detached: true,
      silent: true,
      env: { ...process.env, NAVORI_CODEX_PENDING_WORKER: "1" },
    });
    let output = "";
    let finished = false;
    const fallback =
      operation === "request"
        ? approvalDeny({ status: "pending", reason: "handler-unavailable-or-timeout" })
        : { status: "pending", reason: "handler-unavailable-or-timeout" };
    const finish = (valid: boolean): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdin.unpipe(child.stdin!);
      process.stdin.pause();
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        /* Already exited. */
      }
      let result: unknown = fallback;
      try {
        const parsed = JSON.parse(output) as {
          status?: string;
          hookSpecificOutput?: { permissionDecision?: string };
        };
        if (
          valid &&
          (operation === "request"
            ? parsed.hookSpecificOutput?.permissionDecision === "deny"
            : parsed.status === "pending")
        )
          result = parsed;
      } catch {
        /* Incomplete output stays pending. */
      }
      process.stdout.write(`${JSON.stringify(result)}\n`);
      done();
    };
    // Leave one second for cleanup before the hook's independent outer deadline.
    const timer = setTimeout(() => finish(false), 4_000);
    child.on("error", () => finish(false));
    child.stdout!.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 64 * 1024) finish(false);
    });
    child.on("close", (code: number | null) => finish(code === 0));
    child.stdin!.on("error", () => {});
    if (operation === "request") process.stdin.pipe(child.stdin!);
    else child.stdin!.end();
  });
}

/** Mediates pending requests without publication, interactive grants or trust changes. */
export const codexApprovalCommand = defineCommand({
  meta: { name: "approval", description: "Prepare or relay a non-authorizing pending PR request" },
  args: {
    operation: { type: "positional", required: true, description: "request or relay" },
    id: { type: "positional", required: false, description: "Request UUID for relay" },
    cwd: { type: "string", description: "Checkout for relay (default: cwd)" },
  },
  async run({ args }) {
    // IPC is an internal scheduling channel, never an authorization source.
    if (!(process.env.NAVORI_CODEX_PENDING_WORKER === "1" && typeof process.send === "function")) {
      await supervised(args.operation);
      return;
    }
    if (args.operation === "request") {
      let raw = "";
      for await (const chunk of process.stdin) {
        raw += String(chunk);
        if (Buffer.byteLength(raw) > 64 * 1024) break;
      }
      process.stdout.write(`${JSON.stringify(approvalDeny(requestApproval(raw)))}\n`);
    } else if (args.operation === "relay") {
      process.stdout.write(
        `${JSON.stringify(relayApproval(args.id ?? "", args.cwd ?? process.cwd()))}\n`,
      );
    } else {
      process.stdout.write(
        `${JSON.stringify({ status: "pending", reason: "unsupported-operation" })}\n`,
      );
    }
  },
});
