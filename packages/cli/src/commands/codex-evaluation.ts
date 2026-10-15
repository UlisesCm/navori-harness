import { defineCommand } from "citty";
import { resolve } from "node:path";
import { z } from "zod";
import {
  captureOutcomeObservation,
  validateOutcomeFile,
  EVALUATION_FIXTURES,
} from "../lib/codex/outcome-evaluation.ts";

/** Fixed diagnostic capture and strict runtime consumer; caller records cannot authorize or certify live outcomes. */
export const codexEvaluationCommand = defineCommand({
  meta: {
    name: "evaluation",
    description: "Capture bounded host observations and validate current live-evidence gaps",
  },
  subCommands: {
    capture: defineCommand({
      args: {
        cwd: { type: "string", description: "Fixed fixture checkout" },
        fixture: { type: "string", required: true, description: "One of four fixed scenarios" },
        engine: { type: "string", required: true, description: "claude or codex" },
      },
      async run({ args }) {
        const input = z
          .object({
            cwd: z.string().optional(),
            fixture: z.enum(EVALUATION_FIXTURES),
            engine: z.enum(["claude", "codex"]),
          })
          .parse(args);
        const result = await captureOutcomeObservation(
          resolve(input.cwd ?? process.cwd()),
          input.fixture,
          input.engine,
        );
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exitCode = 1;
      },
    }),
    validate: defineCommand({
      args: {
        cwd: { type: "string", description: "Project checkout" },
        records: {
          type: "string",
          required: true,
          description: "Project-relative fixed live-evaluation record set",
        },
      },
      run({ args }) {
        const input = z
          .object({ cwd: z.string().optional(), records: z.string().min(1) })
          .parse(args);
        const result = validateOutcomeFile(resolve(input.cwd ?? process.cwd()), input.records);
        process.stdout.write(`${JSON.stringify(result)}\n`);
        process.exitCode = 1;
      },
    }),
  },
});
