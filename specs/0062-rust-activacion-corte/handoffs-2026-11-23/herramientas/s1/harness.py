"""Wall/CPU cost of routing-watch per call, by lane (S1, 23 nov 2026). Measurement only.

Runs the rendered hook from a scratch worktree of migration/rust (real tree size, so the
acceptance slow path fingerprints a realistic tree). Scenarios are interleaved per round so
load drifts hit every lane alike. Writes results.json next to this file.

Usage: python3 harness.py <scratch worktree> <rounds>
"""
import json
import os
import resource
import shutil
import statistics
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRATCH = os.path.abspath(sys.argv[1])
ROUNDS = int(sys.argv[2])
REAL_HANDOFFS = os.path.expanduser(
    "~/Documentos/dev/personal/navori-rust/.navori/state/handoffs"
)
HANDOFFS = os.path.join(SCRATCH, ".navori/state/handoffs")
SID = "bench-session"
CLAUDE_CMD = (
    'f="$CLAUDE_PROJECT_DIR/.claude/hooks/routing-watch.sh"; bash -n "$f" 2>/dev/null '
    '&& exec bash "$f" claude-post-tool-use; exit 1'
)
PI_SCRIPT = os.path.join(SCRATCH, ".pi/navori/hooks/routing-watch.sh")


def payload(tool, tool_input, response):
    return json.dumps(
        {
            "session_id": SID,
            "transcript_path": f"{SCRATCH}/transcript.jsonl",
            "cwd": SCRATCH,
            "hook_event_name": "PostToolUse",
            "tool_name": tool,
            "tool_input": tool_input,
            "tool_response": response,
            "tool_use_id": "toolu_bench",
        },
        separators=(",", ":"),
    )


def index_lines():
    """The real acceptance-index (89 criteria on 22 nov), re-rooted to the scratch dir."""
    out = []
    for line in open(os.path.join(REAL_HANDOFFS, "acceptance-index")):
        cols = line.rstrip("\n").split("\t")
        if len(cols) >= 4:
            cols[3] = HANDOFFS
            out.append("\t".join(cols))
    return out


def set_index(present):
    os.makedirs(HANDOFFS, exist_ok=True)
    idx = os.path.join(HANDOFFS, "acceptance-index")
    exp = os.path.join(HANDOFFS, "acceptance-expected.jsonl")
    if present:
        open(idx, "w").write("\n".join(index_lines()) + "\n")
        shutil.copyfile(os.path.join(REAL_HANDOFFS, "acceptance-expected.jsonl"), exp)
    else:
        for p in (idx, exp):
            if os.path.exists(p):
                os.remove(p)


def set_failure_state(present):
    d = os.path.join(SCRATCH, ".navori/state/hooks/bash-outcome-watch")
    os.makedirs(d, exist_ok=True)
    f = os.path.join(d, SID)
    if present:
        open(f, "w").write('{"count":1,"key":"x"}\n')
    elif os.path.exists(f):
        os.remove(f)


def first_criterion_command():
    """JSON-unescaped command of the first index line (the payload must carry it exactly)."""
    c = index_lines()[0].split("\t")[0]
    return json.loads('"' + c + '"')


BASH = payload(
    "Bash",
    {"command": "git status --short", "description": "status"},
    {"stdout": " M README.md\n", "stderr": "", "interrupted": False},
)
BASH_WRITE = payload(
    "Bash",
    {"command": "echo x > /tmp/s1-rw-out.txt", "description": "write"},
    {"stdout": "", "stderr": "", "interrupted": False},
)
LONG = json.load(open(os.path.join(SCRATCH, "scripts/js/bench-payloads/bash-long-40k-grep.json")))
LONG["cwd"] = SCRATCH
LONG["session_id"] = SID
LONG["hook_event_name"] = "PostToolUse"
LONG["tool_name"] = "Bash"
BASH_LONG = json.dumps(LONG, separators=(",", ":")).replace("__CWD__", SCRATCH)
EDIT = payload(
    "Edit",
    {"file_path": f"{SCRATCH}/README.md", "old_string": "a", "new_string": "b"},
    {"success": True},
)

AGENT = payload(
    "Agent",
    {"description": "x", "prompt": "do x", "subagent_type": "implementer"},
    {"content": [{"type": "text", "text": "done"}]},
)

# (name, engine, payload, index present, failure state present, criterion match)
SCENARIOS = [
    ("bash-sin-plan", "claude", BASH, False, False),
    ("bash-plan-sin-match", "claude", BASH, True, False),
    ("bash-plan-match", "claude", None, True, False),
    ("bash-tras-fallo", "claude", BASH, True, True),
    ("bash-escribe", "claude", BASH_WRITE, True, False),
    ("bash-40k-sin-plan", "claude", BASH_LONG, False, False),
    ("bash-40k-plan", "claude", BASH_LONG, True, False),
    ("edit", "claude", EDIT, True, False),
    ("agent", "claude", AGENT, True, False),
    ("pi-bash", "pi", BASH, True, False),
    ("pi-bash-escribe", "pi", BASH_WRITE, True, False),
    ("pi-edit", "pi", EDIT, True, False),
]


def run(engine, body):
    env = dict(os.environ, CLAUDE_PROJECT_DIR=SCRATCH, CLAUDE_CODE_SESSION_ID=SID)
    before = resource.getrusage(resource.RUSAGE_CHILDREN)
    t0 = time.perf_counter()
    if engine == "claude":
        cmd = ["sh", "-c", CLAUDE_CMD]
    else:
        cmd = ["bash", PI_SCRIPT]
    p = subprocess.run(cmd, input=body.encode(), cwd=SCRATCH, env=env, capture_output=True)
    wall = (time.perf_counter() - t0) * 1000
    after = resource.getrusage(resource.RUSAGE_CHILDREN)
    cpu = ((after.ru_utime - before.ru_utime) + (after.ru_stime - before.ru_stime)) * 1000
    return wall, cpu, p.returncode


def main():
    match_cmd = first_criterion_command()
    match = payload(
        "Bash",
        {"command": match_cmd, "description": "criterion"},
        {"stdout": "ok\n", "stderr": "", "interrupted": False},
    )
    data = {s[0]: {"wall": [], "cpu": [], "rc": set()} for s in SCENARIOS}
    loads = [os.getloadavg()]
    for _ in range(ROUNDS):
        for name, engine, body, index, failure in SCENARIOS:
            set_index(index)
            set_failure_state(failure)
            wall, cpu, rc = run(engine, match if body is None else body)
            data[name]["wall"].append(wall)
            data[name]["cpu"].append(cpu)
            data[name]["rc"].add(rc)
        loads.append(os.getloadavg())
    set_failure_state(False)
    out = {"rounds": ROUNDS, "loads": loads, "nproc": os.cpu_count(), "scenarios": {}}
    for name, d in data.items():
        w = sorted(d["wall"])
        out["scenarios"][name] = {
            "wall_p50": round(statistics.median(w), 2),
            "wall_p95": round(w[min(len(w) - 1, int(0.95 * len(w)))], 2),
            "cpu_p50": round(statistics.median(d["cpu"]), 2),
            "rc": sorted(d["rc"]),
        }
        print(name, out["scenarios"][name])
    print("load start/end", loads[0], loads[-1])
    json.dump(out, open(os.path.join(HERE, "results.json"), "w"), indent=1)


main()
