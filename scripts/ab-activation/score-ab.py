#!/usr/bin/env python3
"""Mide el A/B de activación: ¿delegó cada corrida, y quedó verde el gate?

Lee el transcript de cada sesión lanzada por `run-ab.sh` y reporta por brazo:
  - delegaciones (`Agent`/`Task`) y skills invocadas
  - mezcla de herramientas (Bash vs nativas), que es la variable que el modo
    de permisos toca directamente y el confusor a vigilar
  - si la tarea quedó terminada (el gate corrió y el campo se propagó)

La pregunta del A/B es la primera línea; las otras dos existen para que un
resultado nulo se pueda interpretar en vez de solo reportarse.
"""
import json, os, sys, glob
from collections import Counter

PROJECTS = os.path.expanduser("~/.claude/projects")


def transcript(session_id):
    for d in os.listdir(PROJECTS):
        p = os.path.join(PROJECTS, d, session_id + ".jsonl")
        if os.path.exists(p):
            return p
    hits = glob.glob(os.path.join(PROJECTS, "*", session_id + "*.jsonl"))
    return hits[0] if hits else None


def score(session_id, run_dir):
    path = transcript(session_id)
    if not path:
        return None
    agents, skills, tools = Counter(), Counter(), Counter()
    sidechain_turns = 0
    with open(path) as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("isSidechain"):
                sidechain_turns += 1
                continue
            c = (d.get("message") or {}).get("content")
            if not isinstance(c, list):
                continue
            for b in c:
                if not (isinstance(b, dict) and b.get("type") == "tool_use"):
                    continue
                name = b.get("name")
                tools[name] += 1
                inp = b.get("input") or {}
                if name in ("Agent", "Task"):
                    agents[str(inp.get("subagent_type", "?"))] += 1
                elif name == "Skill":
                    skills[str(inp.get("skill", "?"))] += 1

    types_path = os.path.join(run_dir, "src", "types.ts")
    propagated = False
    try:
        propagated = "email" in open(types_path).read()
    except OSError:
        pass

    native = sum(tools[k] for k in ("Read", "Grep", "Glob", "Edit", "Write"))
    return dict(agents=agents, skills=skills, bash=tools.get("Bash", 0),
                native=native, sidechain=sidechain_turns, propagated=propagated,
                tools=tools)


rows = []
for line in open(sys.argv[1]):
    arm, i, sid, run = line.rstrip("\n").split("\t")
    s = score(sid, run)
    rows.append((arm, i, sid, s))

print("=" * 96)
print(f"{'brazo':<13}{'#':<4}{'delegó':<9}{'skills':<26}{'Bash':>6}{'nativas':>9}{'tarea':>9}")
print("=" * 96)
by_arm = {}
for arm, i, sid, s in rows:
    if s is None:
        print(f"{arm:<13}{i:<4}{'SIN TRANSCRIPT':<9}")
        continue
    a = by_arm.setdefault(arm, dict(n=0, deleg=0, skills=0, bash=0, native=0, done=0))
    a["n"] += 1
    a["deleg"] += 1 if s["agents"] else 0
    a["skills"] += sum(s["skills"].values())
    a["bash"] += s["bash"]; a["native"] += s["native"]
    a["done"] += 1 if s["propagated"] else 0
    deleg = ",".join(f"{k}×{v}" for k, v in s["agents"].items()) or "no"
    sk = ",".join(f"{k}" for k in s["skills"]) or "—"
    print(f"{arm:<13}{i:<4}{deleg:<9}{sk[:25]:<26}{s['bash']:>6}{s['native']:>9}"
          f"{('ok' if s['propagated'] else 'no'):>9}")

print("\n" + "=" * 96)
print("RESUMEN POR BRAZO")
print("=" * 96)
print(f"{'brazo':<15}{'n':>4}{'delegaron':>11}{'tasa':>7}{'skills':>8}{'Bash':>7}{'nativas':>9}{'tarea ok':>10}")
for arm, a in by_arm.items():
    print(f"{arm:<15}{a['n']:>4}{a['deleg']:>11}{(100*a['deleg']//a['n'] if a['n'] else 0):>6}%"
          f"{a['skills']:>8}{a['bash']:>7}{a['native']:>9}{a['done']:>10}")
print("\nNota: 'nativas' incluye Edit/Write. Si un brazo escribe por Bash y el otro")
print("por Edit/Write, la mezcla cambió — y eso es el efecto del modo, no ruido.")
