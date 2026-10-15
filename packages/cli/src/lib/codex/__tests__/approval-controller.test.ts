import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { request as httpRequest } from "node:http";
import { requestBrowserDecision, type NativeApprovalIdentity } from "../approval-controller.ts";

const { launch, isolation } = vi.hoisted(() => ({
  launch: vi.fn<(url: string) => Promise<boolean>>(),
  isolation: vi.fn<() => boolean>(),
}));
vi.mock(import("../approval-ui.ts"), async (original) => ({
  ...(await original()),
  launchApprovalBrowser: launch,
  approvalSourceIsolationAvailable: isolation,
}));
beforeEach(() => isolation.mockReturnValue(true));
afterEach(() => vi.clearAllMocks());
const identity: NativeApprovalIdentity = {
  requestId: 0,
  threadId: "native-main",
  turnId: "turn",
  callId: "call",
  action: "github.pr.create",
};

/** Exercise actual HTTP Host/Origin checks without fetch's host-header rewriting. */
function send(
  origin: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      `${origin}${path}`,
      { method: body === undefined ? "GET" : "POST", headers },
      (response) => {
        let raw = "";
        response.on("data", (chunk: Buffer) => {
          raw += chunk.toString();
        });
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: raw, headers: response.headers }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

/** Capture the private launcher boundary in tests only; production exposes no bootstrap URL. */
async function start(
  timeout = 5_000,
): Promise<{ origin: string; credential: string; decision: Promise<string> }> {
  let shown: (url: string) => void = () => {};
  const bootstrap = new Promise<string>((resolve) => {
    shown = resolve;
  });
  launch.mockImplementation(async (url) => {
    shown(url);
    return true;
  });
  const decision = requestBrowserDecision(
    identity,
    { destination: "fixture", body: "<script>untrusted</script>" },
    timeout,
  );
  const url = new URL(await bootstrap);
  return { origin: url.origin, credential: url.hash.slice(1), decision };
}

/** Typed browser challenge carries no reusable grant or effect. */
async function challenge(
  origin: string,
  credential: string,
): Promise<{ csrf: string; identity: NativeApprovalIdentity }> {
  const response = await send(origin, "/request", { Authorization: `Bearer ${credential}` });
  expect(response.status).toBe(200);
  const data = JSON.parse(response.body) as { csrf: string; identity: NativeApprovalIdentity };
  return { csrf: data.csrf, identity: data.identity };
}

describe("host approval controller", () => {
  // Covers: R6, R16
  it("never bootstraps the controller without source isolation", async () => {
    isolation.mockReturnValue(false);
    await expect(requestBrowserDecision(identity, {})).resolves.toBe("pending");
    expect(launch).not.toHaveBeenCalled();
  });
  // Covers: R6, R7
  it("accepts the exact native ID zero once and closes concurrent/replay decisions", async () => {
    const { origin, credential, decision } = await start();
    const current = await challenge(origin, credential);
    const body = JSON.stringify({ ...current, decision: "accept" });
    const headers = {
      Authorization: `Bearer ${credential}`,
      Origin: origin,
      "Content-Type": "application/json",
    };
    const outcomes = await Promise.allSettled([
      send(origin, "/decision", headers, body),
      send(origin, "/decision", headers, body),
    ]);
    expect(
      outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value.status === 200),
    ).toHaveLength(1);
    await expect(decision).resolves.toBe("accept");
    await expect(send(origin, "/decision", headers, body)).rejects.toThrow();
  });
  // Covers: R6
  it("rejects guessed public IDs, absent/wrong credential, Host, Origin, CSRF and cross-scope input", async () => {
    const { origin, credential, decision } = await start();
    const current = await challenge(origin, credential);
    const proper = {
      Authorization: `Bearer ${credential}`,
      Origin: origin,
      "Content-Type": "application/json",
    };
    const body = { ...current, decision: "accept" };
    const cases: Array<{ headers: Record<string, string>; body: unknown }> = [
      { headers: {}, body },
      { headers: { ...proper, Authorization: "Bearer guessed" }, body },
      { headers: { ...proper, Host: "foreign.invalid" }, body },
      { headers: { ...proper, Origin: "null" }, body },
      { headers: { ...proper, Origin: `${origin}/wrong` }, body },
      { headers: { ...proper, Origin: "" }, body },
      { headers: proper, body: { ...body, csrf: "0".repeat(64) } },
      { headers: proper, body: { ...body, identity: { ...identity, callId: "guessed" } } },
      { headers: proper, body: { ...body, approved: true } },
    ];
    for (const candidate of cases)
      expect(
        (await send(origin, "/decision", candidate.headers, JSON.stringify(candidate.body))).status,
      ).toBe(403);
    expect((await send(origin, "/decision", proper)).status).toBe(403);
    expect((await send(origin, "/decision", proper, "invalid-json")).status).toBe(400);
    expect((await send(origin, "/decision", proper, " ".repeat(9_000))).status).toBe(400);
    expect(
      (await send(origin, "/decision", proper, JSON.stringify({ ...current, decision: "decline" })))
        .status,
    ).toBe(200);
    await expect(decision).resolves.toBe("decline");
  });
  // Covers: R6, R16
  it("never exposes bootstrap credentials in public HTML or headers and times out without acceptance", async () => {
    const { origin, credential, decision } = await start(1_000);
    const response = await send(origin, "/", {});
    expect(response.status).toBe(200);
    expect(response.body).not.toContain(credential);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    await expect(decision).resolves.toBe("pending");
  });
  // Covers: R6
  it("keeps headless/unreachable host UI pending", async () => {
    launch.mockResolvedValue(false);
    await expect(requestBrowserDecision(identity, {})).resolves.toBe("pending");
  });
});
