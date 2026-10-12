import { afterEach, describe, expect, it } from "vitest";
import {
  NavoriConfigSchema,
  type NavoriConfig,
  type NavoriConfigInput,
} from "../../lib/config/schema.ts";
import { SUPPORTED_LANGS, tc } from "../../lib/i18n.ts";
import { scanOtelReceiver } from "../doctor.ts";
import { startReceiver, type OtelReceiver } from "../../lib/audit/collect.ts";
import { deadPort } from "../../lib/__tests__/helpers/ports.ts";

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
  });

  // Covers: R2
  it("receptor otel sin supervisor: solo dos estados y el aviso apunta a audit --collect", async () => {
    const report = await scanOtelReceiver(config({ audit: { mode: "always" } }), {
      port: await deadPort(),
    });
    expect(Object.keys(report ?? {}).sort()).toEqual(["port", "responding"]);
    for (const lang of SUPPORTED_LANGS) {
      const manual = tc(lang).doctor.otelReceiverManual;
      expect(manual).toContain("navori audit --collect");
      expect(manual).not.toContain("global collect");
    }
  });
});
