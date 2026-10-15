import { defineCommand } from "citty";
import { resolve } from "node:path";
import { z } from "zod";
import {
  prepareCodexProfile,
  claimCodexProfile,
  consumeCodexProfileHook,
  denyProfileHook,
  type ProfileHookOutput,
} from "../lib/codex/profile-dispatch.ts";
import {
  observeNativeProfiles,
  preflightNativeProfileProbe,
} from "../lib/codex/native-integration.ts";

/** Bounded stdin JSON; the fixed hook entry point never accepts a command or an imported observation. */
export async function readProfileHookInput(
  stream: NodeJS.ReadableStream,
  deadline: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      stream.removeListener("data", data);
      stream.removeListener("end", end);
      stream.removeListener("error", failure);
      if (error) reject(error);
    };
    const failure = (): void => finish(new Error("profile-hook-input-unavailable"));
    const data = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 1024 * 1024) finish(new Error("profile-hook-input-too-large"));
      else chunks.push(bytes);
    };
    const end = (): void => {
      finish();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown);
      } catch {
        reject(new Error("profile-hook-input-invalid"));
      }
    };
    const timer = setTimeout(failure, Math.max(1, deadline - Date.now()));
    stream.on("data", data).once("end", end).once("error", failure);
  });
}

/** Explicit metadata-only preparation/claim; no public RPC, dispatch, observation import or grant. */
export const codexProfileCommand = defineCommand({
  meta: {
    name: "profile",
    description: "Prepare and exclusively claim future native profile metadata",
  },
  subCommands: {
    probe: defineCommand({
      meta: {
        description:
          "Consume and preflight one fixed profile scenario; unsupported controls refuse before inference",
      },
      args: {
        cwd: { type: "string", description: "Project checkout for fixed read-only preflight" },
      },
      async run({ args }) {
        const input = z.object({ cwd: z.string().optional() }).parse(args);
        const result = await preflightNativeProfileProbe(resolve(input.cwd ?? process.cwd()));
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exitCode = 1;
      },
    }),
    hook: defineCommand({
      async run() {
        const deadline = Date.now() + 8_000;
        let result: ProfileHookOutput;
        try {
          result = await consumeCodexProfileHook(
            await readProfileHookInput(process.stdin, deadline),
            deadline,
          );
        } catch {
          result = denyProfileHook("profile-hook-input-unavailable; effective-selection-pending");
        }
        process.stdout.write(`${JSON.stringify(result)}\n`);
      },
    }),
    observe: defineCommand({
      args: {
        cwd: {
          type: "string",
          description: "Project checkout for a new read-only principal context",
        },
      },
      async run({ args }) {
        const input = z.object({ cwd: z.string().optional() }).parse(args);
        const result = await observeNativeProfiles(resolve(input.cwd ?? process.cwd()));
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (result.pending.length) process.exitCode = 1;
      },
    }),
    prepare: defineCommand({
      args: {
        cwd: { type: "string", description: "Project checkout" },
        name: { type: "string", required: true, description: "Exact native inventory name" },
        action: { type: "string", required: true, description: "New work identity" },
      },
      async run({ args }) {
        const input = z
          .object({ cwd: z.string().optional(), name: z.string(), action: z.string() })
          .parse(args);
        const result = await prepareCodexProfile(resolve(input.cwd ?? process.cwd()), {
          name: input.name,
          action: input.action,
        });
        process.stdout.write(`${JSON.stringify(result)}\n`);
      },
    }),
    claim: defineCommand({
      args: {
        cwd: { type: "string", description: "Project checkout" },
        name: { type: "string", required: true, description: "Exact native inventory name" },
        action: { type: "string", required: true, description: "New work identity" },
        preparation: {
          type: "string",
          required: true,
          description: "Existing preparation identity",
        },
      },
      async run({ args }) {
        const input = z
          .object({
            cwd: z.string().optional(),
            name: z.string(),
            action: z.string(),
            preparation: z.string(),
          })
          .parse(args);
        const result = await claimCodexProfile(
          resolve(input.cwd ?? process.cwd()),
          input.preparation,
          { name: input.name, action: input.action },
        );
        process.stdout.write(`${JSON.stringify(result)}\n`);
      },
    }),
  },
});
