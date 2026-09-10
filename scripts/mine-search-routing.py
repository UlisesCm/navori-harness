#!/usr/bin/env python3
"""Por dónde pasa realmente la búsqueda de contenido: wrapper, nativo o shell.

El issue #661 fija como criterio de éxito la proporción wrapper+nativo sobre el
total de búsquedas, antes contra después, sobre los mismos repos. Su línea base
se midió con una sonda de sesión — que muere con la sesión. Esto es esa sonda,
hecha reproducible, por la misma razón que `classify-activation-arm.py`: una
medición que no se puede repetir no es una línea base, es una anécdota.

QUÉ CUENTA COMO BÚSQUEDA, y por qué cada categoría:

  wrapper   el `tgrep-search.sh` que el plugin renderiza. Índice de trigramas,
            con `allow` propio: sin prompt y sin round-trip de clasificador.
  nativo    la tool `Grep` (ripgrep por debajo, también en `allow`).
  shell     `grep` / `rg` lanzados por Bash. Pagan clasificador en auto mode,
            arrastran la batería de hooks y meten su salida completa al contexto.

LO QUE NO SE CUENTA, a propósito: extraer de un archivo YA conocido
(`grep -n x ese-archivo`) es legítimo y más barato que el wrapper — la propia
doctrina lo dice. No se distingue aquí porque hacerlo requiere adivinar la
intención; el número es un techo del desperdicio, no una acusación.

ALCANCE: solo sesiones AUDITADAS (las que tienen log en `~/.navori/audits/`).
Es la misma población que mide el resto del instrumental, así que los números
se pueden cruzar entre sí.

LÍNEA BASE (2026-09-10, 10 repos auditados, 4,566 búsquedas):

    wrapper 161 · nativo 6 · shell 4,399  →  bueno% = 3.7%

    Y el desglose importa más que el total: en los 3 repos donde el plugin tgrep
    ESTÁ activo el wrapper llega a 7–10%; en los otros 7 está en 0% porque el
    plugin no está habilitado, que es configuración y no adopción. Confundir las
    dos cosas convierte un problema de `navori add tgrep` en un problema de
    doctrina, y este repo ya se quemó dos veces con esa conclusión fácil.

Uso:
    python3 scripts/mine-search-routing.py            # todos los repos auditados
    python3 scripts/mine-search-routing.py <repo> ... # solo esos
"""
import json
import os
import sys
from collections import Counter, defaultdict

AUDITS = os.path.expanduser("~/.navori/audits")
PROJECTS = os.path.expanduser("~/.claude/projects")

WRAPPER = "tgrep-search.sh"


def audited_sessions():
    """session id → repo, para toda sesión con log de audit."""
    out = {}
    if not os.path.isdir(AUDITS):
        return out
    for repo in sorted(os.listdir(AUDITS)):
        d = os.path.join(AUDITS, repo)
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            if f.startswith("session-") and f.endswith(".log"):
                out[f[len("session-") : -len(".log")]] = repo
    return out


def classify(name, tool_input):
    """La categoría de UNA llamada a herramienta, o None si no es una búsqueda."""
    if name == "Grep":
        return "nativo"
    if name != "Bash":
        return None
    cmd = tool_input.get("command")
    if not isinstance(cmd, str):
        return None
    if WRAPPER in cmd:
        return "wrapper"
    # Verbo al inicio del comando o tras un separador — no una mención cualquiera.
    for verb in ("grep", "rg"):
        if cmd.startswith(f"{verb} ") or f"| {verb} " in cmd or f"&& {verb} " in cmd:
            return "shell"
    return None


def scan():
    session_repo = audited_sessions()
    per_repo = defaultdict(Counter)
    if not os.path.isdir(PROJECTS):
        return per_repo
    for proj in os.listdir(PROJECTS):
        pdir = os.path.join(PROJECTS, proj)
        if not os.path.isdir(pdir):
            continue
        for fn in os.listdir(pdir):
            if not fn.endswith(".jsonl"):
                continue
            repo = session_repo.get(fn[: -len(".jsonl")])
            if repo is None:
                continue
            with open(os.path.join(pdir, fn), errors="replace") as fh:
                for line in fh:
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    msg = entry.get("message")
                    if not isinstance(msg, dict):
                        continue
                    content = msg.get("content")
                    if not isinstance(content, list):
                        continue
                    for block in content:
                        if not isinstance(block, dict) or block.get("type") != "tool_use":
                            continue
                        kind = classify(block.get("name"), block.get("input") or {})
                        if kind:
                            per_repo[repo][kind] += 1
    return per_repo


def main(argv):
    per_repo = scan()
    if argv:
        per_repo = {k: v for k, v in per_repo.items() if k in argv}
    if not per_repo:
        print("sin sesiones auditadas con búsquedas")
        return

    print(f"{'repo':32s} {'total':>7s} {'wrapper':>8s} {'nativo':>7s} {'shell':>7s} {'bueno%':>7s}")
    grand = Counter()
    for repo in sorted(per_repo):
        c = per_repo[repo]
        total = sum(c.values())
        grand.update(c)
        good = c["wrapper"] + c["nativo"]
        pct = (100 * good / total) if total else 0
        print(
            f"{repo[:32]:32s} {total:7d} {c['wrapper']:8d} {c['nativo']:7d} "
            f"{c['shell']:7d} {pct:6.1f}%"
        )
    total = sum(grand.values())
    good = grand["wrapper"] + grand["nativo"]
    print(
        f"{'TOTAL':32s} {total:7d} {grand['wrapper']:8d} {grand['nativo']:7d} "
        f"{grand['shell']:7d} {(100 * good / total) if total else 0:6.1f}%"
    )
    print()
    print("'bueno%' = (wrapper + nativo) / total. Es la cifra que #661 mide antes/después.")


if __name__ == "__main__":
    main(sys.argv[1:])
