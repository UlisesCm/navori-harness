import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { NavoriConfigSchema, type NavoriConfig, type NavoriConfigInput } from "../../lib/schema.ts";
import { scanOtelReceiver } from "../doctor.ts";
import { startReceiver, type OtelReceiver } from "../../lib/audit/collect.ts";

/**
 * #697 — the check exists because the failure is silent by construction.
 *
 * With `audit.mode: always` the repo exports OTel events every second whether
 * or not anyone receives them, and a receiver that died takes the third source
 * of every session with it. Nothing in the report says "nobody was listening"
 * loudly enough to notice in time; `doctor` is where that question belongs.
 */
function config(over: Partial<NavoriConfigInput> = {}): NavoriConfig {
  return NavoriConfigSchema.parse({
    name: "demo",
    engines: ["claude"],
    preset: "custom",
    version: "1.0.0",
    language: "es",
    ...over,
  } satisfies NavoriConfigInput);
}

const open: OtelReceiver[] = [];

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close();
});

async function deadPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", () => done()));
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

describe("scanOtelReceiver (#697)", () => {
  it("no pregunta nada en un repo que audita por sesión", async () => {
    // `opt-in` does not need a receiver standing by, and painting that red
    // would be noise in every repo that never opted into always-on auditing.
    expect(await scanOtelReceiver(config({ audit: { mode: "opt-in" } }))).toBeNull();
    // The default is `opt-in`, so a config that never declares it is silent too.
    expect(await scanOtelReceiver(config())).toBeNull();
  });

  it("reporta que responde cuando el receptor está vivo", async () => {
    const r = await startReceiver({ port: 0 });
    open.push(r);
    const report = await scanOtelReceiver(config({ audit: { mode: "always" } }), { port: r.port });
    expect(report?.responding).toBe(true);
    expect(report?.port).toBe(r.port);
  });

  it("reporta que no responde cuando nadie escucha", async () => {
    const report = await scanOtelReceiver(config({ audit: { mode: "always" } }), {
      port: await deadPort(),
    });
    expect(report?.responding).toBe(false);
    // Supervision and liveness are separate questions: the gap between them is
    // the case worth reporting — loaded, dead and silent.
    expect(report?.supportsSupervisor).toBe(process.platform === "darwin");
  });
});
