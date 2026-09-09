#!/usr/bin/env python3
"""Fase 1 — minería de transcripts: tasa de activación SOBRE OPORTUNIDADES.

Recorre las sesiones auditadas, marca eventos-disparador con heurísticas
verificables, y los cruza contra las invocaciones reales de Skill/Agent,
separando las AUTOMÁTICAS de las PEDIDAS por el usuario.

Señal de fallo de comando: `is_error` del bloque tool_result (no regex sobre la
salida — eso contaba ✗ impresos por scripts propios como si fueran fallos).

Todo lo de aquí es aproximado por construcción. Se imprimen conteos crudos y
ejemplos para que cada número se pueda auditar a mano.
"""
import json, os, re, sys, glob
from collections import Counter

PROJECTS = os.path.expanduser("~/.claude/projects")
SESSIONS = [s.strip() for s in open(sys.argv[1]) if s.strip()]

VERIFY_CMD = re.compile(
    r"\b(pnpm|npm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|type-check|build|check)"
    r"|\bvitest\b|\bjest\b|\btsc\b|\bpytest\b|\bruff\b|\beslint\b|\bbiome\b"
    r"|test:coverage|gh pr checks|gh run", re.I)
DONE_CLAIM = re.compile(
    r"(^|\s)(listo|hecho|terminado|completado|queda listo|todo (en )?verde|✅)\b", re.I)
ERROR_LINE = re.compile(r"(error TS\d+|^\s*Error:|\bFAIL\b|error\[E\d+\]|Traceback)", re.M)
PR_CMD = re.compile(r"(?:^|&&\s*|;\s*)gh pr create")
COMMIT_CMD = re.compile(r"git commit")
SRC_FILE = re.compile(r"\.(ts|tsx|js|jsx|py|go|rs|java|mjs|cjs)$")
CD_PREFIX = re.compile(r'^\s*cd\s+("[^"]*"|\S+)\s*&&\s*')


def load(prefix):
    for d in os.listdir(PROJECTS):
        for f in glob.glob(os.path.join(PROJECTS, d, prefix + "*.jsonl")):
            return f
    return None


def text_of(msg):
    c = (msg or {}).get("content")
    if isinstance(c, str):
        return c
    return "\n".join(b.get("text") or "" for b in c
                     if isinstance(b, dict) and b.get("type") == "text") if isinstance(c, list) else ""


def sig(cmd):
    """Firma de comando: sin el `cd ... &&` de cabecera, primeros 4 tokens."""
    return " ".join(CD_PREFIX.sub("", cmd or "").split()[:4])


def parse(path):
    """Devuelve turnos del hilo principal. Cada tool_use lleva su is_error."""
    turns, cur, mode = [], None, Counter()
    pending = {}   # tool_use_id -> dict del tool en el turno
    with open(path) as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("permissionMode"):
                mode[d["permissionMode"]] += 1
            if d.get("isSidechain"):
                continue
            t, msg = d.get("type"), d.get("message") or {}
            c = msg.get("content")
            if t == "user":
                blocks = c if isinstance(c, list) else []
                results = [b for b in blocks if isinstance(b, dict) and b.get("type") == "tool_result"]
                if results:
                    for b in results:
                        tu = pending.get(b.get("tool_use_id"))
                        if tu is not None:
                            tu["error"] = bool(b.get("is_error"))
                            body = b.get("content")
                            tu["out"] = body if isinstance(body, str) else json.dumps(body)[:8000]
                    continue
                txt = text_of(msg)
                if txt.strip():
                    cur = {"user": txt, "tools": [], "assistant": []}
                    turns.append(cur)
            elif t == "assistant" and cur is not None and isinstance(c, list):
                for b in c:
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "tool_use":
                        rec = {"name": b.get("name"), "input": b.get("input") or {},
                               "error": False, "out": ""}
                        cur["tools"].append(rec)
                        pending[b.get("id")] = rec
                    elif b.get("type") == "text":
                        cur["assistant"].append(b.get("text") or "")
    return turns, mode


def analyze(session, examples):
    path = load(session)
    if not path:
        return None
    turns, mode = parse(path)
    repo = os.path.basename(os.path.dirname(path)).split("-Docs-")[-1]

    opp, hit, auto, asked = Counter(), Counter(), Counter(), Counter()
    failed_once = {}

    for ti, t in enumerate(turns):
        u = t["user"].lower()
        cmds = " ; ".join(str(x["input"].get("command", "")) for x in t["tools"]
                          if x["name"] == "Bash")
        used_skill = {str(x["input"].get("skill", "")) for x in t["tools"] if x["name"] == "Skill"}
        used_agent = {str(x["input"].get("subagent_type", "")) for x in t["tools"]
                      if x["name"] in ("Agent", "Task")}

        for x in t["tools"]:
            if x["name"] == "Skill":
                s = str(x["input"].get("skill", "?"))
                (asked if (s in u) else auto)[s] += 1
            elif x["name"] in ("Agent", "Task"):
                a = str(x["input"].get("subagent_type", "?"))
                (asked if a in u else auto)[a] += 1

        def mark(key, cond, agent=None, skill=None, note=""):
            got = (agent in used_agent if agent else False) or (skill in used_skill if skill else False)
            # `got` implica oportunidad: cuando se delega, el trabajo ocurre en el
            # sidechain y `cond` (que mira el hilo principal) es ciego. Sin esto el
            # 0% sería un artefacto del instrumento, no un hallazgo.
            if not cond and not got:
                return
            opp[key] += 1
            if got:
                hit[key] += 1
            elif len(examples[key]) < 3:
                examples[key].append(f"{session} turno {ti+1}: {note[:110]}")

        # O1 — implementer: 2+ archivos fuente tocados por Edit/Write en el turno
        touched = {str(x["input"].get("file_path", "")) for x in t["tools"]
                   if x["name"] in ("Edit", "Write") and SRC_FILE.search(str(x["input"].get("file_path", "")))}
        mark("implementer", len(touched) >= 2, agent="implementer",
             note=f"{len(touched)} archivos fuente: {sorted(touched)[:2]}")

        # O2 — verify-before-done: afirma cierre sin comando de verificación en el turno
        final = "\n".join(t["assistant"])[-1500:]
        mark("verify-before-done",
             bool(touched) and bool(DONE_CLAIM.search(final)) and not VERIFY_CMD.search(cmds),
             skill="verify-before-done", note=t["user"][:60])

        # O3 — debug-error: comando que FALLA con pared de errores
        wall = any(x["error"] and len(ERROR_LINE.findall(x["out"])) >= 5 for x in t["tools"])
        mark("debug-error", wall, skill="debug-error", note=t["user"][:60])

        # O4 — se abre PR
        mark("pr → review-diff/pilot", bool(PR_CMD.search(cmds)),
             agent="commit-pr-pilot", skill="review-diff", note=t["user"][:60])

        # O5 — reviewer: código fuente editado y commiteado en el mismo turno
        mark("reviewer", bool(touched) and bool(COMMIT_CMD.search(cmds)),
             agent="reviewer", note=f"{len(touched)} archivos + git commit")

        # O6 — loop-back-debug: MISMO comando falla dos veces en la sesión
        for x in t["tools"]:
            if x["name"] != "Bash" or not x["error"]:
                continue
            k = sig(str(x["input"].get("command", "")))
            if len(k) < 6:
                continue
            if failed_once.get(k):
                mark("loop-back-debug", True, skill="loop-back-debug", note=k)
            failed_once[k] = True

    first = turns[0]["user"][:60].replace("\n", " ") if turns else ""
    broad = bool(re.search(r"implementa|construye|crea |feature|migra|refactor|spec", first, re.I))
    return dict(session=session, repo=repo, turns=len(turns), first=first,
                mode="+".join(f"{k}:{v}" for k, v in mode.most_common(2)) or "?",
                scope="amplio" if broad else "incremental",
                opp=opp, hit=hit, auto=auto, asked=asked)


examples = {k: [] for k in ["implementer", "verify-before-done", "debug-error",
                            "pr → review-diff/pilot", "reviewer", "loop-back-debug"]}
rows = [r for r in (analyze(s, examples) for s in SESSIONS) if r]

print("=" * 104)
print(f"{'sesión':<10}{'repo':<24}{'turnos':>7}  {'modo':<26}{'scope':<13}{'activadas/oportunidades':>24}")
print("=" * 104)
TO, TH, AUTO, ASKED = Counter(), Counter(), Counter(), Counter()
for r in rows:
    TO += r["opp"]; TH += r["hit"]; AUTO += r["auto"]; ASKED += r["asked"]
    o, h = sum(r["opp"].values()), sum(r["hit"].values())
    print(f"{r['session']:<10}{r['repo'][:23]:<24}{r['turns']:>7}  {r['mode'][:25]:<26}"
          f"{r['scope']:<13}{f'{h}/{o}':>24}")

print("\n" + "=" * 104)
print("POR DISPARADOR")
print("=" * 104)
print(f"{'disparador':<26}{'oportunidades':>15}{'activadas':>12}{'tasa':>8}")
for k in sorted(TO, key=lambda x: -TO[x]):
    o, h = TO[k], TH[k]
    print(f"{k:<26}{o:>15}{h:>12}{(100*h//o if o else 0):>7}%")
to, th = sum(TO.values()), sum(TH.values())
print(f"{'TOTAL':<26}{to:>15}{th:>12}{(100*th//to if to else 0):>7}%")

print("\n" + "=" * 104)
print("INVOCACIONES REALES — automáticas vs pedidas por el usuario")
print("=" * 104)
for k in sorted(set(AUTO) | set(ASKED)):
    print(f"  {k:<24} automática={AUTO[k]:<4} pedida={ASKED[k]}")

print("\n" + "=" * 104)
print("EJEMPLOS de oportunidad NO activada (para auditar la heurística a mano)")
print("=" * 104)
for k, v in examples.items():
    for e in v:
        print(f"  [{k}] {e}")
