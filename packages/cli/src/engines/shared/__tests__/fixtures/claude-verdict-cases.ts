/**
 * Spec 0048 R16 (D3): the verdicts the Claude copy of each shared hook script gave BEFORE 0048,
 * recorded against the pre-0048 scripts (`main` @ 22cc6dea). The Pi arm may only ADD blocks, so
 * a Claude copy that answers differently on any row below is a behavior change, not a byte change.
 */

/** A shell command and the exit code (0 allow, 2 block) the pre-0048 guard gave it. */
export interface GuardCase {
  readonly command: string;
  readonly exit: 0 | 2;
}

export const GUARD_GOLDEN: readonly GuardCase[] = [
  { command: "rm -rf /", exit: 2 },
  { command: "rm -rf --no-preserve-root /", exit: 2 },
  { command: "rm -rf ~", exit: 2 },
  { command: "git commit --no-verify -m x", exit: 2 },
  { command: "git push --force origin main", exit: 2 },
  { command: "git push origin main", exit: 0 },
  { command: ":(){ :|:& };:", exit: 2 },
  { command: "echo x > CLAUDE.md", exit: 2 },
  { command: "dd if=/dev/zero of=/dev/sda", exit: 2 },
  { command: "mkfs.ext4 /dev/sda1", exit: 0 },
  { command: "git status", exit: 0 },
  { command: "git push -u origin feature/x", exit: 0 },
  { command: "rm -rf ./dist", exit: 0 },
  { command: "ls -la", exit: 0 },
  // Pi-only blocks (control plane, `--no-extensions`) are allowed by Claude.
  { command: "echo x > .pi/settings.json", exit: 0 },
  { command: "pi --no-extensions", exit: 0 },
];

/** A payload (merged over `{ cwd }`) and the exit the pre-0048 script gave it. */
export interface PayloadCase {
  readonly name: string;
  readonly payload: Record<string, unknown>;
  readonly exit: 0 | 2;
}

const child = { agent_id: "pi-implementer", agent_type: "implementer" };
const bashCall = (command: string): Record<string, unknown> => ({
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command },
});

export const NO_BACKGROUND_GOLDEN: readonly PayloadCase[] = [
  { name: "child foreground", payload: { ...bashCall("bun run test"), ...child }, exit: 0 },
  { name: "parent plain", payload: bashCall("ls"), exit: 0 },
  // D-U2 (D12), the one user-approved behavior change: pre-0048 these exited 0 in a child.
  { name: "child trailing &", payload: { ...bashCall("sleep 9 &"), ...child }, exit: 2 },
  { name: "child nohup", payload: { ...bashCall("nohup sleep 9"), ...child }, exit: 2 },
  { name: "parent trailing &", payload: bashCall("sleep 9 &"), exit: 0 },
  {
    name: "child run_in_background",
    payload: {
      ...child,
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "sleep 9", run_in_background: true },
    },
    exit: 2,
  },
  {
    name: "parent run_in_background",
    payload: {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "sleep 9", run_in_background: true },
    },
    exit: 0,
  },
];

/** State-based and lifecycle scripts: the payload only selects the event. */
export const STATE_SCRIPT_GOLDEN: Readonly<Record<string, readonly PayloadCase[]>> = {
  "managed-drift-watch": [
    {
      name: "post bash",
      payload: { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      exit: 0,
    },
    {
      name: "post edit",
      payload: {
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: { file_path: "a.txt" },
      },
      exit: 0,
    },
  ],
  "worktree-reclaim": [
    { name: "session end", payload: { hook_event_name: "SessionEnd", reason: "other" }, exit: 0 },
  ],
  "audit-mode-close": [
    { name: "session end", payload: { hook_event_name: "SessionEnd", reason: "other" }, exit: 0 },
  ],
};
