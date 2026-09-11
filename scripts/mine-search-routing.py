#!/usr/bin/env python3
"""Por dónde pasa realmente la búsqueda de contenido: wrapper, nativo o shell.

El issue #661 fija como criterio de éxito la proporción wrapper+nativo sobre el
total de búsquedas, antes contra después, sobre los mismos repos. Su línea base
se midió con una sonda de sesión — que muere con la sesión. Esto es esa sonda,
hecha reproducible, por la misma razón que `classify-activation-arm.py`: una
medición que no se puede repetir no es una línea base, es una anécdota.

QUÉ CUENTA COMO BÚSQUEDA, y por qué el denominador es la mitad del trabajo.

La v1 de este minero clasificaba el COMANDO completo: si la cadena contenía
`grep ` al inicio, tras `&&` o tras `|`, contaba una "búsqueda shell". Medido
sobre las 8,562 invocaciones reales de `grep`/`rg` del parque, eso metía en el
denominador dos cosas que no son buscar en el repo:

    46.2%  `… | grep`        filtrar la salida de otro comando
    22.3%  `grep -n x FILE`  extraer de un archivo YA conocido
    31.5%  `grep -rn x src/` buscar contenido en el repo   ← lo único comparable

Con el denominador inflado, el número publicado era 4.0%; sobre búsquedas reales
es 6.4%. Ninguno de los dos es bueno, pero solo el segundo puede llegar a 100%:
un hook que redirija al wrapper JAMÁS va a convertir un pipe, así que medir
contra el denominador viejo fija un techo imposible y hace que cualquier
intervención parezca fracasar. Es el mismo defecto que infló el 57% de
activación: un cociente cuyo denominador no es lo que el nombre dice.

Las categorías, entonces:

  wrapper      el `tgrep-search.sh` que el plugin renderiza. Índice de trigramas,
               con `allow` propio: sin prompt y sin round-trip de clasificador.
  nativo       la tool `Grep` (ripgrep por debajo, también en `allow`).
  shell        `grep`/`rg` de BÚSQUEDA lanzados por Bash: recursivos, con
               directorio como target, o sin target. Pagan clasificador en auto
               mode, arrastran la batería de hooks y meten su salida completa al
               contexto. Es lo que el wrapper reemplaza, y el único shell que
               entra al cociente.

  filtro       `… | grep`. Se reporta aparte y NO entra al cociente.
  extraccion   `grep -n x archivo-conocido`. La propia doctrina la prefiere al
               wrapper. Se reporta aparte y NO entra al cociente.

Contar por SEGMENTO y no por comando también corrige un subconteo: un solo
`cmd && grep -rn a && grep -rn b` son dos búsquedas, y la v1 contaba una.

ALCANCE: solo sesiones AUDITADAS (las que tienen log en `~/.navori/audits/`).
Es la misma población que mide el resto del instrumental, así que los números
se pueden cruzar entre sí.

LÍNEA BASE CORREGIDA (2026-09-11, 10 repos auditados):

    búsquedas reales 2,761  →  wrapper 197 · nativo 6 · shell 2,558
    bueno% = 7.4%

    (fuera del cociente: 3,958 filtros y 2,053 extracciones)

    Contra el 4.0% que publicaba la v1 sobre el denominador inflado. Y por repo,
    donde el plugin tgrep está activo: moonar 25.6%, navori-health 18.8%,
    navori-harness 17.3% — el triple de lo que se creía.

    Y el desglose importa más que el total: donde el plugin tgrep ESTÁ activo el
    wrapper llega a dos dígitos; donde no está instalado es 0%, que es
    configuración y no adopción. Confundir las dos cosas convierte un problema de
    `navori add tgrep` en un problema de doctrina, y este repo ya se quemó dos
    veces con esa conclusión fácil.

Uso:
    python3 scripts/mine-search-routing.py            # todos los repos auditados
    python3 scripts/mine-search-routing.py <repo> ... # solo esos
"""

import json
import os
import re
import shlex
import sys
from collections import Counter, defaultdict

AUDITS = os.path.expanduser("~/.navori/audits")
PROJECTS = os.path.expanduser("~/.claude/projects")

WRAPPER = "tgrep-search.sh"
VERBS = ("grep", "egrep", "fgrep", "rg")

# Las que entran al cociente de #661. Las otras dos se reportan y no suman.
SCORED = ("wrapper", "nativo", "shell")

# Separadores de shell que terminan un comando. El `|` se trata aparte porque
# es el ÚNICO que cambia la naturaleza de lo que sigue: tras un pipe, grep lee
# stdin y por definición no está buscando en el repo.
_SPLIT = re.compile(r"(\|\||\||&&|;|\n)")

# Redirecciones. Sin quitarlas, `grep -n x file.yaml 2>/dev/null` pone
# `2>/dev/null` entre los OPERANDOS: tiene `/` y no tiene extensión, así que la
# heurística de "target es un directorio" lo lee como búsqueda recursiva y
# asciende una extracción a búsqueda. Medido: 145 casos del parque.
_REDIR = re.compile(r"^([0-9]?>>?|&>|<|[0-9]?>&)")
_REDIR_BARE = re.compile(r"^([0-9]?>>?|&>|<|[0-9]?>&[0-9]?)$")


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


def classify_segment(seg, piped_into):
    """La categoría de UN segmento que invoca grep/rg, o None si no lo invoca.

    `piped_into` es lo que separa filtrar de buscar, y no hay forma de saberlo
    mirando el segmento solo: `grep -n foo` es extracción de stdin tras un pipe
    y búsqueda del repo al inicio de la línea.
    """
    try:
        toks = shlex.split(seg)
    except ValueError:
        # Comillas sin cerrar: cae al split ingenuo en vez de descartar el
        # segmento. Un comando raro debe contarse mal, no desaparecer.
        toks = seg.split()
    if not toks or toks[0] not in VERBS:
        return None
    if piped_into:
        return "filtro"

    flags = []
    operands = []
    skip_next = False
    for t in toks[1:]:
        if skip_next:
            skip_next = False
            continue
        if _REDIR.match(t):
            # `> out.txt` trae el destino en el token siguiente; `2>/dev/null`
            # lo trae pegado y se descarta entero.
            skip_next = bool(_REDIR_BARE.match(t))
            continue
        (flags if t.startswith("-") else operands).append(t)
    # `rg` es recursivo por defecto; `grep` necesita que se lo pidan.
    recursive = toks[0] == "rg" or any(
        re.match(r"^-[a-zA-Z]*[rR]", f) or f == "--recursive" for f in flags
    )
    targets = operands[1:] if len(operands) > 1 else []
    dir_target = any(
        t.endswith("/") or t in (".", "..") or ("/" in t and not re.search(r"\.[A-Za-z0-9]+$", t))
        for t in targets
    )
    if recursive or dir_target or not targets:
        return "shell"
    return "extraccion"


def classify_command(cmd):
    """Todas las invocaciones de grep/rg de un comando, por categoría."""
    out = Counter()
    if WRAPPER in cmd:
        out["wrapper"] += 1
        return out
    # Una continuación de línea NO separa comandos: sin unirla, el `\\` + salto
    # parte el segmento a mitad de un patrón entrecomillado y el fragmento
    # resultante queda sin target, que la heurística lee como búsqueda recursiva.
    cmd = re.sub(r"\\\n", " ", cmd)
    piped = False
    for part in _SPLIT.split(cmd):
        if part == "|":
            piped = True
            continue
        if part in ("||", "&&", ";", "\n"):
            piped = False
            continue
        k = classify_segment(part.strip(), piped)
        if k:
            out[k] += 1
    return out


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
                        name = block.get("name")
                        if name == "Grep":
                            per_repo[repo]["nativo"] += 1
                            continue
                        if name != "Bash":
                            continue
                        cmd = (block.get("input") or {}).get("command")
                        if isinstance(cmd, str):
                            per_repo[repo].update(classify_command(cmd))
    return per_repo


def main(argv):
    per_repo = scan()
    if argv:
        per_repo = {k: v for k, v in per_repo.items() if k in argv}
    if not per_repo:
        print("sin sesiones auditadas con búsquedas")
        return

    head = f"{'repo':30s} {'busq':>6s} {'wrapper':>8s} {'nativo':>7s} {'shell':>7s} {'bueno%':>7s}"
    head += f" {'|filtro':>8s} {'|extrac':>8s}"
    print(head)
    grand = Counter()
    for repo in sorted(per_repo):
        c = per_repo[repo]
        grand.update(c)
        total = sum(c[k] for k in SCORED)
        good = c["wrapper"] + c["nativo"]
        pct = (100 * good / total) if total else 0
        print(
            f"{repo[:30]:30s} {total:6d} {c['wrapper']:8d} {c['nativo']:7d} "
            f"{c['shell']:7d} {pct:6.1f}% {c['filtro']:8d} {c['extraccion']:8d}"
        )
    total = sum(grand[k] for k in SCORED)
    good = grand["wrapper"] + grand["nativo"]
    print(
        f"{'TOTAL':30s} {total:6d} {grand['wrapper']:8d} {grand['nativo']:7d} "
        f"{grand['shell']:7d} {(100 * good / total) if total else 0:6.1f}% "
        f"{grand['filtro']:8d} {grand['extraccion']:8d}"
    )
    print()
    print("'bueno%' = (wrapper + nativo) / busq. Es la cifra que #661 mide antes/después.")
    print("Las dos últimas columnas NO entran al cociente: un pipe no se puede convertir en")
    print("wrapper, y extraer de un archivo ya conocido es la jugada que la doctrina prefiere.")


if __name__ == "__main__":
    main(sys.argv[1:])
