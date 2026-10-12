/**
 * Pi extension fixture for the credential-free e2e smoke: registers pi-ai's deterministic `fauxProvider` as
 * provider "faux" (models parent-model and role-model) in whichever Pi process loads it, the parent session
 * and every child process alike. No network, no account, no credentials.
 *
 * Behaviour comes from the JSON file named by NAVORI_FAUX_SCRIPT: `scripts[<role>]` is the ordered list of
 * assistant steps for NAVORI_PI_CHILD_ROLE (or "parent" when unset). Each model call also appends one line
 * to the script's `log`, which is how the test proves which provider/model a process really ran on.
 */
import { appendFileSync, readFileSync } from "node:fs";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type AssistantMessage,
  type FauxContentBlock,
  type FauxResponseStep,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One scripted assistant turn. */
type Step =
  | { calls: Array<{ name: string; args: ToolCall["arguments"] }> }
  | { text: string }
  | { bigText: number }
  | { echoAll: string };
interface Script {
  log: string;
  scripts: Record<string, Step[]>;
}

/** Text of every tool result in the transcript, in order. */
function toolResults(messages: ReadonlyArray<unknown>): string[] {
  const out: string[] = [];
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { role, content } = message as { role?: unknown; content?: unknown };
    if (role !== "toolResult" || !Array.isArray(content)) continue;
    out.push(
      content
        .map((part: unknown) =>
          typeof part === "object" && part !== null && "text" in part
            ? String((part as { text: unknown }).text)
            : "",
        )
        .join(""),
    );
  }
  return out;
}

function message(step: Step, messages: ReadonlyArray<unknown>): AssistantMessage {
  if ("calls" in step) {
    const blocks: FauxContentBlock[] = step.calls.map((call) => fauxToolCall(call.name, call.args));
    return fauxAssistantMessage(blocks, { stopReason: "toolUse" });
  }
  if ("bigText" in step) return fauxAssistantMessage(fauxText("x".repeat(step.bigText)));
  if ("echoAll" in step) {
    return fauxAssistantMessage(
      fauxText(`${step.echoAll}\n${toolResults(messages).join("\n--\n")}`),
    );
  }
  return fauxAssistantMessage(fauxText(step.text));
}

export default function (pi: ExtensionAPI): void {
  const path = process.env.NAVORI_FAUX_SCRIPT;
  if (!path) return;
  const script = JSON.parse(readFileSync(path, "utf8")) as Script;
  const role = process.env.NAVORI_PI_CHILD_ROLE ?? "parent";
  const steps = script.scripts[role] ?? [];
  // Large chunks keep a >256 KiB stream to a handful of events instead of one per few characters.
  const faux = fauxProvider({
    provider: "faux",
    models: [{ id: "parent-model" }, { id: "role-model" }],
    tokenSize: { min: 16_384, max: 16_384 },
  });
  const queue: FauxResponseStep[] = steps.map(
    (step): FauxResponseStep =>
      (context, _options, state, model) => {
        appendFileSync(
          script.log,
          `${JSON.stringify({ role, provider: model.provider, model: model.id, call: state.callCount })}\n`,
        );
        return message(step, context.messages);
      },
  );
  faux.setResponses(queue);
  pi.registerProvider(faux.provider);
}
