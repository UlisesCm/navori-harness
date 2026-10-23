/** Native extension controls only; shared hook denials keep their script identity. */
export const PI_EXTENSION_DENIALS = {
  planBlocked: {
    control: "plan-gate",
    tools: ["navori_subagent"],
    prefix: "Navori plan gate blocked the implementer",
  },
  planUnavailable: {
    control: "plan-gate",
    tools: ["navori_subagent"],
    prefix: "Navori plan gate unavailable; subagent blocked",
  },
  planMissing: {
    control: "plan-gate",
    tools: ["navori_subagent"],
    prefix: "Navori executable not found on PATH; plan gate unavailable; subagent blocked",
  },
  handoffUnavailable: {
    control: "handoff-check",
    tools: ["navori_subagent"],
    prefix: "Navori handoff check unavailable; ",
  },
  handoffJson: {
    control: "handoff-check",
    tools: ["navori_subagent"],
    prefix: "Invalid Navori handoff check JSON; ",
  },
  handoffDenied: {
    control: "handoff-check",
    tools: ["navori_subagent"],
    prefix: "Navori handoff check did not pass; ",
  },
  implementerFeature: {
    control: "handoff-check",
    tools: ["navori_subagent"],
    prefix: "Navori implementer requires an explicit Navori feature slug for handoff check",
  },
  reviewerFeature: {
    control: "handoff-check",
    tools: ["navori_subagent"],
    prefix: "Navori reviewer requires an explicit Navori feature slug for handoff check",
  },
  scribeFeature: {
    control: "handoff-check",
    tools: ["navori_subagent"],
    prefix: "Navori scribe requires an explicit Navori feature slug for handoff check",
  },
  implementerHandoff: {
    control: "handoff-check",
    tools: ["navori_subagent"],
    prefix: "Navori implementer handoff invalid: ",
  },
  reviewerHandoff: {
    control: "handoff-check",
    tools: ["navori_subagent"],
    prefix: "Navori reviewer handoff invalid: ",
  },
  managedBlocked: {
    control: "managed-lane",
    tools: ["write", "edit"],
    prefix: "Navori blocked this ",
  },
  managedPath: {
    control: "managed-lane",
    tools: ["write", "edit"],
    prefix: "Navori cannot tell which file this ",
  },
  managedEvaluate: {
    control: "managed-lane",
    tools: ["write", "edit"],
    prefix: "Navori cannot evaluate ",
  },
  managedInspect: {
    control: "managed-lane",
    tools: ["write", "edit"],
    prefix: "Navori cannot inspect ",
  },
  managedError: {
    control: "managed-lane",
    tools: ["write", "edit"],
    prefix: "Navori could not evaluate this ",
  },
  powershell: {
    control: "powershell",
    tools: ["powershell"],
    prefix: "Navori disabled Pi's powershell tool: ",
  },
  runtime: {
    control: "runtime-restricted",
    tools: ["bash", "edit", "write", "powershell"],
    prefix: "Navori does not verify Pi ",
  },
  manifest: {
    control: "manifest-skew",
    tools: ["bash", "edit", "write"],
    prefix: "Navori cannot evaluate its Pi controls (",
  },
  markdownBinding: {
    control: "manifest-skew",
    tools: ["bash", "edit", "write"],
    prefix: "Navori Markdown ownership hook binding is missing or incompatible; ",
  },
  markdownControls: {
    control: "manifest-skew",
    tools: ["bash", "edit", "write"],
    prefix: "Navori cannot evaluate Markdown ownership controls; ",
  },
} as const;

export type PiExtensionControl =
  (typeof PI_EXTENSION_DENIALS)[keyof typeof PI_EXTENSION_DENIALS]["control"];

/** Read only a failed tool's leading text block. Never retain diagnostic text or scan model prose. */
export function classifyPiExtensionDenial(
  toolName: string,
  isError: unknown,
  content: unknown,
): PiExtensionControl | undefined {
  if (isError !== true || !Array.isArray(content)) return undefined;
  const first: unknown = content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    !("type" in first) ||
    first.type !== "text" ||
    !("text" in first) ||
    typeof first.text !== "string"
  )
    return undefined;
  let control: PiExtensionControl | undefined;
  let prefixLength = 0;
  for (const denial of Object.values(PI_EXTENSION_DENIALS)) {
    const tools: readonly string[] = denial.tools;
    if (
      tools.includes(toolName) &&
      denial.prefix.length > prefixLength &&
      first.text.startsWith(denial.prefix)
    ) {
      control = denial.control;
      prefixLength = denial.prefix.length;
    }
  }
  return control;
}
