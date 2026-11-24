"""Which routing-watch lane each real call takes (read-only over transcripts).

Approximates the hook's payload as tool input JSON + tool result text and applies the hook's
own cheap probes: tool discriminator, navori_has_write_token (routing-watch.sh:1147-1185, on
the WHOLE payload), payload size, and "first Bash success after a failed Bash" (Claude
bash-outcome reset lane with node). Prints lane fractions per engine.
"""
import glob
import json
import os
import statistics

HOME = os.path.expanduser("~")
import sys
# The Pi bridge payload carries no tool_response (bridge-source.ts:133-144).
PI_NO_RESPONSE = "--pi-with-response" not in sys.argv


def has_write_token(probe):
    p = probe.replace(">&", "").replace(">/dev/null", "").replace("> /dev/null", "")
    if ">" in p:
        return True
    if "tee " in probe:
        return True
    i = probe.find("sed ")
    return i >= 0 and "-i" in probe[i:]


def text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(c.get("text", "") for c in content if isinstance(c, dict))
    return ""


def classify(rows, tool, inp, result, failed_before):
    payload = json.dumps(inp, separators=(",", ":")) + json.dumps(result)
    size = len(payload)
    lane = "otro"
    if tool in ("Bash", "bash"):
        lane = "bash-escribe" if has_write_token(payload) else "bash-simple"
    elif tool in ("Edit", "Write", "NotebookEdit", "edit", "write"):
        lane = "edit-write"
    elif tool in ("Agent", "Task", "navori_subagent"):
        lane = "agent"
    rows.append((lane, size, failed_before))


def claude_rows():
    rows, per_session = [], []
    for path in glob.glob(f"{HOME}/.claude/projects/*navori*/*.jsonl"):
        uses, failed, n = {}, False, 0
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
                    uses[c.get("id")] = (c.get("name"), c.get("input") or {})
                elif c.get("type") == "tool_result":
                    name, inp = uses.get(c.get("tool_use_id"), (None, {}))
                    if name not in ("Bash", "Edit", "Write", "NotebookEdit", "Agent", "Task"):
                        continue
                    if c.get("is_error"):
                        if name == "Bash":
                            failed = True
                        continue
                    classify(rows, name, inp, text_of(c.get("content")), failed and name == "Bash")
                    if name == "Bash":
                        failed = False
                    n += 1
        if n:
            per_session.append(n)
    return rows


def pi_rows():
    rows = []
    for path in glob.glob(f"{HOME}/.pi/agent/sessions/*navori*/*.jsonl"):
        calls = {}
        for line in open(path, errors="replace"):
            try:
                o = json.loads(line)
            except ValueError:
                continue
            m = o.get("message") or {}
            if m.get("role") == "assistant" and isinstance(m.get("content"), list):
                for c in m["content"]:
                    if isinstance(c, dict) and c.get("type") == "toolCall":
                        calls[c.get("id")] = c.get("arguments") or {}
            if m.get("role") == "toolResult" and not m.get("isError"):
                t = m.get("toolName")
                if t in ("bash", "edit", "write", "navori_subagent"):
                    classify(rows, t, calls.get(m.get("toolCallId"), {}), "" if PI_NO_RESPONSE else text_of(m.get("content")), False)
    return rows


def report(label, rows):
    total = len(rows)
    lanes = {}
    for lane, size, fb in rows:
        lanes[lane] = lanes.get(lane, 0) + 1
    sizes = sorted(r[1] for r in rows if r[0].startswith("bash"))
    big10 = sum(1 for s in sizes if s > 10_000)
    big40 = sum(1 for s in sizes if s > 40_000)
    after_fail = sum(1 for r in rows if r[2])
    print(f"{label}: calls={total}")
    for lane, n in sorted(lanes.items(), key=lambda x: -x[1]):
        print(f"  {lane}: {n} ({100 * n / total:.1f} %)")
    if sizes:
        print(
            f"  bash payload bytes p50={statistics.median(sizes):.0f} p90={sizes[int(0.9 * len(sizes))]} "
            f">10k={100 * big10 / len(sizes):.1f} % >40k={100 * big40 / len(sizes):.1f} %"
        )
    print(f"  bash success right after a failed bash: {after_fail} ({100 * after_fail / total:.1f} %)")


import sys
if "--pi-command-only" not in sys.argv: report("claude", claude_rows())
report("pi", pi_rows())
