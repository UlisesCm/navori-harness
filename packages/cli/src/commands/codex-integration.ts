import { defineCommand } from "citty";
import { resolve, join } from "node:path";
import { z } from "zod";
import { readConfig } from "../lib/config/config.ts";
import { approvalSourceIsolationAvailable } from "../lib/codex/approval-ui.ts";
import {
  runNativeIntegration,
  type NativeIntegrationResult,
} from "../lib/codex/native-integration.ts";

/** Project opt-in is scope consent; neither a CLI assertion nor TTY authorizes the held effect. */
export async function startCodexIntegration(
  cwd: string,
  requestId: string,
  probeOnly = false,
): Promise<NativeIntegrationResult> {
  const config = readConfig(join(cwd, "navori.config.json"));
  if (!config.engines.includes("codex") || config.harness?.codexIntegration !== true)
    return {
      status: "pending",
      reason: "project-opt-in-required",
      connection: "unstarted",
      events: [],
    };
  if (!z.uuid().safeParse(requestId).success)
    return {
      status: "pending",
      reason: "invalid-pending-request",
      connection: "unstarted",
      events: [],
    };
  if (!probeOnly && !approvalSourceIsolationAvailable())
    return {
      status: "pending",
      reason: "human-source-isolation-unverified",
      connection: "unstarted",
      events: [],
    };
  if (process.platform !== "darwin")
    return {
      status: "pending",
      reason: "human-host-bootstrap-unavailable",
      connection: "unstarted",
      events: [],
    };
  return runNativeIntegration(cwd, requestId, probeOnly);
}

/** Explicit scoped host command, without approve/grant/publish or general task execution routes. */
export const codexIntegrationCommand = defineCommand({
  meta: {
    name: "integration",
    description: "Opt-in native host boundary for one pending PR publication",
  },
  subCommands: {
    start: defineCommand({
      args: {
        cwd: { type: "string", description: "Project checkout" },
        request: {
          type: "string",
          required: true,
          description: "Existing non-authorizing pending request ID",
        },
        probe: {
          type: "boolean",
          description: "Verify a new native context without starting a turn or approval UI",
        },
      },
      async run({ args }) {
        const input = z
          .object({ cwd: z.string().optional(), request: z.uuid(), probe: z.boolean().optional() })
          .parse(args);
        const cwd = resolve(input.cwd ?? process.cwd());
        const result = await startCodexIntegration(cwd, input.request, input.probe === true);
        process.stdout.write(`${JSON.stringify(result)}\n`);
      },
    }),
  },
});
