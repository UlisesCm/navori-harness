"""Count routing-watch firings per session from real transcripts (read-only).

Claude: PostToolUse matcher Bash|Edit|Write|NotebookEdit|Agent|Task, successful results only
(a failed call goes to PostToolUseFailure). Pi: parent tool_result for bash/edit/write/
navori_subagent, skipOnError. Prints per-engine distribution of firings per session.
"""
import glob
import json
import os
import statistics
import sys

CLAUDE_TOOLS = {"Bash", "Edit", "Write", "NotebookEdit", "Agent", "Task"}
PI_TOOLS = {"bash", "edit", "write", "navori_subagent"}
HOME = os.path.expanduser("~")


def claude_session(path):
    names, n, per_tool = {}, 0, {}
    for line in open(path, errors="replace"):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if o.get("isSidechain"):
            continue
        content = (o.get("message") or {}).get("content")
        if not isinstance(content, list):
            continue
        for c in content:
            if not isinstance(c, dict):
                continue
            if c.get("type") == "tool_use":
                names[c.get("id")] = c.get("name")
            elif c.get("type") == "tool_result" and not c.get("is_error"):
                name = names.get(c.get("tool_use_id"))
                if name in CLAUDE_TOOLS:
                    n += 1
                    per_tool[name] = per_tool.get(name, 0) + 1
    return n, per_tool


def pi_session(path):
    n, per_tool = 0, {}
    for line in open(path, errors="replace"):
        try:
            o = json.loads(line)
        except ValueError:
            continue
        m = o.get("message") or {}
        if m.get("role") == "toolResult" and not m.get("isError") and m.get("toolName") in PI_TOOLS:
            n += 1
            per_tool[m["toolName"]] = per_tool.get(m["toolName"], 0) + 1
    return n, per_tool


def summary(label, rows):
    counts = sorted(r[1] for r in rows if r[1] > 0)
    if not counts:
        print(f"{label}: no sessions")
        return
    tools = {}
    for r in rows:
        for k, v in r[2].items():
            tools[k] = tools.get(k, 0) + v
    p90 = counts[min(len(counts) - 1, int(0.9 * len(counts)))]
    print(
        f"{label}: sessions={len(counts)} total={sum(counts)} median={statistics.median(counts)} "
        f"p90={p90} max={counts[-1]} per_tool={tools}"
    )


def main():
    claude = [
        (p, *claude_session(p))
        for p in glob.glob(f"{HOME}/.claude/projects/*navori*/*.jsonl")
    ]
    pi = [
        (p, *pi_session(p))
        for p in glob.glob(f"{HOME}/.pi/agent/sessions/*navori*/*.jsonl")
    ]
    summary("claude", claude)
    summary("pi", pi)
    if "--rows" in sys.argv:
        for p, n, t in sorted(claude + pi, key=lambda r: -r[1])[:15]:
            print(n, os.path.basename(os.path.dirname(p))[:60], os.path.basename(p)[:40])


main()
