import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  APPROVAL_HTML,
  approvalContentSecurityPolicy,
  launchApprovalBrowser,
  approvalSourceIsolationAvailable,
} from "./approval-ui.ts";

const identitySchema = z.strictObject({
  requestId: z.union([z.string().min(1), z.number().int().nonnegative()]),
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  callId: z.string().min(1),
  action: z.literal("github.pr.create"),
});
/** Identity is assigned by the owned native connection, never by a CLI approval assertion. */
export type NativeApprovalIdentity = z.infer<typeof identitySchema>;
/** A browser decision is held in the host process, without a transferable grant. */
export type BrowserDecision = "accept" | "decline" | "pending";

const decisionSchema = z.strictObject({
  identity: identitySchema,
  decision: z.enum(["accept", "decline"]),
  csrf: z.string().length(64),
});

/** Constant-time comparison avoids accepting partial or malformed credentials. */
function matches(received: string | undefined, expected: string): boolean {
  if (received === undefined) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Bounded JSON reading fails before allocating unbounded caller data. */
async function readDecision(request: IncomingMessage): Promise<unknown> {
  let raw = "";
  for await (const chunk of request) {
    raw += String(chunk);
    if (Buffer.byteLength(raw) > 8_192) throw new Error("oversized-decision");
  }
  return JSON.parse(raw) as unknown;
}

/** Real loopback controller; consuming the decision happens synchronously before callbacks/effects. */
export async function requestBrowserDecision(
  identity: NativeApprovalIdentity,
  scope: Readonly<Record<string, unknown>>,
  timeoutMs = 120_000,
  signal?: AbortSignal,
): Promise<BrowserDecision> {
  if (!approvalSourceIsolationAvailable()) return "pending";
  const boundIdentity = identitySchema.parse(identity);
  const displayed = JSON.parse(JSON.stringify(scope)) as Record<string, unknown>;
  let credential = `${randomBytes(32).toString("hex")}.${randomBytes(32).toString("hex")}`;
  let csrf = randomBytes(32).toString("hex");
  let outstanding = true;
  let finish: (decision: BrowserDecision) => void = () => {};
  const decision = new Promise<BrowserDecision>((resolve) => {
    finish = resolve;
  });
  const consume = (value: BrowserDecision): void => {
    if (!outstanding) return;
    outstanding = false;
    credential = "";
    csrf = "";
    finish(value);
  };
  const abort = (): void => consume("pending");
  signal?.addEventListener("abort", abort, { once: true });
  let host = "";
  let origin = "";
  const respond = (response: ServerResponse, status: number, body = ""): void => {
    response.writeHead(status, {
      "Content-Type":
        status === 200 && body === APPROVAL_HTML ? "text/html; charset=utf-8" : "application/json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": approvalContentSecurityPolicy(),
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
    });
    response.end(body);
  };
  const server = createServer((request, response) => {
    void (async (): Promise<void> => {
      if (request.headers.host !== host || !outstanding) {
        respond(response, 403);
        return;
      }
      if (request.method === "GET" && request.url === "/") {
        respond(response, 200, APPROVAL_HTML);
        return;
      }
      if (!matches(request.headers.authorization, `Bearer ${credential}`)) {
        respond(response, 403);
        return;
      }
      if (request.method === "GET" && request.url === "/request") {
        if (request.headers.origin !== undefined && request.headers.origin !== origin) {
          respond(response, 403);
          return;
        }
        respond(response, 200, JSON.stringify({ identity: boundIdentity, scope: displayed, csrf }));
        return;
      }
      if (
        request.method !== "POST" ||
        request.url !== "/decision" ||
        request.headers.origin !== origin ||
        request.headers["content-type"] !== "application/json"
      ) {
        respond(response, 403);
        return;
      }
      const parsed = decisionSchema.safeParse(await readDecision(request));
      if (
        !outstanding ||
        !parsed.success ||
        !matches(parsed.data.csrf, csrf) ||
        JSON.stringify(parsed.data.identity) !== JSON.stringify(boundIdentity)
      ) {
        respond(response, 403);
        return;
      }
      consume(parsed.data.decision);
      respond(response, 200, JSON.stringify({ status: "consumed" }));
    })().catch(() => {
      respond(response, 400);
    });
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  try {
    if (signal?.aborted) return "pending";
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") return "pending";
    host = `127.0.0.1:${address.port}`;
    origin = `http://${host}`;
    const timer = setTimeout(() => consume("pending"), timeoutMs);
    try {
      if (!(await launchApprovalBrowser(`${origin}/#${credential}`))) consume("pending");
      return await decision;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    consume("pending");
    return "pending";
  } finally {
    signal?.removeEventListener("abort", abort);
    credential = "";
    csrf = "";
    server.close();
    server.closeAllConnections();
  }
}
