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
               directorio como target, o sin target. Arrastran la batería de
               hooks y meten su salida completa al contexto — y `rg`, que no
               está allow-listado, paga además clasificador en auto mode
               (`grep` sí lo está, y las reglas estrechas resuelven antes que
               el clasificador). Es lo que el wrapper reemplaza, y el único
               shell que entra al cociente.

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

REMEDICIÓN ANTES/DESPUÉS DEL GUARD (2026-09-12, mismo instrumento en los dos
lados — que es la parte que importa: comparar contra una línea base calculada
con el minero viejo mediría el cambio del INSTRUMENTO junto con el del hábito):

    corte en 2026-09-11, el día que entró `guard-search-routing` (#679)

    repo               antes    después
    navori-harness     15.7%  →  58.1%
    navori-health      17.5%  →  53.3%
    moonar             26.2%  →  35.5%
    TOTAL parque        6.6%  →  40.7%

    La capa que bloquea funciona, otra vez, y con el tamaño del efecto medido.

    Y el hallazgo que sale del mismo corte: `git grep` pasó de 0.85% a 8.20% de
    las búsquedas — **9.6× la tasa**, 23 llamadas contra 35 en una ventana 6.3×
    más chica. El hábito MIGRÓ a la vía que ninguna capa veía, exactamente como
    #720 predijo. Era invisible hasta que este minero aprendió a contarla, y
    #739 ya la redirige; la próxima ventana dirá si cierra.

    Esa es la razón de que `gitgrep` e `indir` se reporten aunque no puntúen: sin
    ellas, este antes/después se habría leído como un triunfo limpio.

Uso:
    python3 scripts/mine-search-routing.py            # todos los repos auditados
    python3 scripts/mine-search-routing.py --desde 2026-09-11   # antes/después
    python3 scripts/mine-search-routing.py --hasta 2026-09-11
    python3 scripts/mine-search-routing.py <repo> ... # solo esos
"""

import json
import os
import re
import shlex
import sys
from collections import Counter, defaultdict

# Redirigibles por entorno para que un test pueda apuntarlos a un sandbox — las
# mismas variables que respeta el CLI (`NAVORI_AUDITS_ROOT`,
# `NAVORI_TRANSCRIPTS_ROOT`), porque un segundo nombre para el mismo store es un
# segundo lugar donde se desincroniza.
AUDITS = os.environ.get("NAVORI_AUDITS_ROOT") or os.path.expanduser("~/.navori/audits")
PROJECTS = os.environ.get("NAVORI_TRANSCRIPTS_ROOT") or os.path.expanduser("~/.claude/projects")

WRAPPER = "tgrep-search.sh"
VERBS = ("grep", "egrep", "fgrep", "rg")

# Las que entran al cociente de #661. Las demás se reportan y no suman.
SCORED = ("wrapper", "nativo", "shell")

# #720 — las vías que el guard NO ancla y que por eso son la migración de
# mínima fricción: se cuentan aparte para que esa migración sea visible, y no
# puntúan porque su estatus no es el mismo que el de un `grep -rn`.
#
#   git-grep   legítimo solo para dot-dirs (ahí `--hidden` degrada a scan
#              bruto); el guard lo redirige en cualquier otro caso.
#   indirecta  `xargs grep`, `find -exec grep`: el mismo trabajo, un nivel de
#              indirección después. El guard las deja pasar y el minero las
#              leía como "filtro" o no las veía en absoluto.
UNSCORED_ROUTES = ("git-grep", "indirecta")

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
    """session id → (repo, día de la sesión), para toda sesión con log de audit.

    El día sale del registro `start`, que el propio `audit --start` escribe con
    el instante de marcado. Se lee del log y no del mtime del archivo: un log se
    copia al directorio del reporte, y la fecha de copia no es la de la sesión.
    """
    out = {}
    if not os.path.isdir(AUDITS):
        return out
    for repo in sorted(os.listdir(AUDITS)):
        d = os.path.join(AUDITS, repo)
        if not os.path.isdir(d):
            continue
        for f in os.listdir(d):
            if not (f.startswith("session-") and f.endswith(".log")):
                continue
            day = ""
            try:
                with open(os.path.join(d, f), errors="replace") as fh:
                    for line in fh:
                        try:
                            rec = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if rec.get("event") == "start":
                            day = str(rec.get("ts", ""))[:10]
                            break
            except OSError:
                pass
            out[f[len("session-") : -len(".log")]] = (repo, day)
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
    if not toks:
        return None

    # `git grep` — invisible para las tres capas a la vez hasta #720. Se cuenta
    # SIEMPRE, con pipe o sin él: no es un filtro de stdin, es una búsqueda del
    # árbol trackeado.
    if toks[0] == "git":
        i = 1
        while i < len(toks) and toks[i].startswith("-"):
            # Una opción global de git puede traer su valor en el token siguiente.
            i += 2 if "=" not in toks[i] and i + 1 < len(toks) and not toks[i + 1].startswith("-") else 1
        return "git-grep" if i < len(toks) and toks[i] == "grep" else None

    # `xargs grep` y `find … -exec grep`: el mismo trabajo con un nivel de
    # indirección. El guard tampoco las ancla (ver #720), así que contarlas como
    # "filtro" —o no contarlas— escondía justo la forma a la que el hábito puede
    # migrar cuando la directa se bloquea.
    if toks[0] == "xargs":
        return "indirecta" if any(t in VERBS for t in toks[1:]) else None
    if toks[0] == "find":
        return "indirecta" if any(t in VERBS for t in toks[1:]) else None

    if toks[0] not in VERBS:
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


def scan(since=None, until=None):
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
            meta = session_repo.get(fn[: -len(".jsonl")])
            if meta is None:
                continue
            repo, day = meta
            # `--desde` parte el parque en antes/después de una intervención,
            # medido con ESTE instrumento en los dos lados. Comparar la cifra de
            # hoy contra una línea base calculada con el minero viejo mediría el
            # cambio del instrumento junto con el del hábito, que es justamente
            # lo que #720 acaba de quitar del camino.
            if since and day and day < since:
                continue
            if until and day and day >= until:
                continue
            # DOS PASADAS, y la razón es #720/M4: un comando que el guard
            # bloqueó NUNCA CORRIÓ, pero su `tool_use` está en el transcript
            # igual — así que sumaba a "shell" y su reintento por el wrapper
            # sumaba aparte. Cada búsqueda convertida por el guard quedaba a la
            # mitad en la métrica, y el antes/después de #661 nacía sesgado.
            #
            # El veredicto se lee del PROPIO transcript: el bloqueo llega como
            # `tool_result` con `is_error` y el texto del hook. Eso es exacto y
            # no necesita cruzar con `~/.navori/audits/` ni correlacionar por
            # reloj — la lección de #560 y de `ownerOf`.
            pending = {}
            blocked = set()
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
                        if not isinstance(block, dict):
                            continue
                        kind = block.get("type")
                        if kind == "tool_use":
                            name = block.get("name")
                            if name == "Grep":
                                per_repo[repo]["nativo"] += 1
                                continue
                            if name != "Bash":
                                continue
                            cmd = (block.get("input") or {}).get("command")
                            if isinstance(cmd, str):
                                pending[block.get("id")] = cmd
                        elif kind == "tool_result":
                            # Las DOS condiciones: hay contenido que solo CITA
                            # la cadena (un archivo del propio guard leído en
                            # sesión), y sin `is_error` se contarían lecturas
                            # como bloqueos.
                            if not block.get("is_error"):
                                continue
                            if "BLOCKED by guard-" in json.dumps(block.get("content")):
                                blocked.add(block.get("tool_use_id"))

            for use_id, cmd in pending.items():
                if use_id in blocked:
                    per_repo[repo]["bloqueado"] += 1
                    continue
                per_repo[repo].update(classify_command(cmd))
    return per_repo


def main(argv):
    # `--desde YYYY-MM-DD` / `--hasta YYYY-MM-DD` acotan por día de sesión. Sin
    # ellos el comportamiento es el de siempre: todo el parque.
    since = until = None
    repos = []
    i = 0
    while i < len(argv):
        if argv[i] == "--desde" and i + 1 < len(argv):
            since = argv[i + 1]
            i += 2
        elif argv[i] == "--hasta" and i + 1 < len(argv):
            until = argv[i + 1]
            i += 2
        else:
            repos.append(argv[i])
            i += 1
    per_repo = scan(since, until)
    if repos:
        per_repo = {k: v for k, v in per_repo.items() if k in repos}
    if not per_repo:
        print("sin sesiones auditadas con búsquedas")
        return
    rango = ""
    if since or until:
        rango = f"  [sesiones {since or '…'} → {until or '…'})"
    if rango:
        print(rango.strip())

    head = f"{'repo':30s} {'busq':>6s} {'wrapper':>8s} {'nativo':>7s} {'shell':>7s} {'bueno%':>7s}"
    head += f" {'|filtro':>8s} {'|extrac':>8s} {'|gitgrep':>9s} {'|indir':>7s} {'|blq':>5s}"
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
            f"{c['shell']:7d} {pct:6.1f}% {c['filtro']:8d} {c['extraccion']:8d} "
            f"{c['git-grep']:9d} {c['indirecta']:7d} {c['bloqueado']:5d}"
        )
    total = sum(grand[k] for k in SCORED)
    good = grand["wrapper"] + grand["nativo"]
    print(
        f"{'TOTAL':30s} {total:6d} {grand['wrapper']:8d} {grand['nativo']:7d} "
        f"{grand['shell']:7d} {(100 * good / total) if total else 0:6.1f}% "
        f"{grand['filtro']:8d} {grand['extraccion']:8d} "
        f"{grand['git-grep']:9d} {grand['indirecta']:7d} {grand['bloqueado']:5d}"
    )
    print()
    print("'bueno%' = (wrapper + nativo) / busq. Es la cifra que #661 mide antes/después.")
    print("'filtro' y 'extrac' NO entran al cociente: un pipe no se puede convertir en wrapper,")
    print("y extraer de un archivo ya conocido es la jugada que la doctrina prefiere.")
    print()
    print("'gitgrep' e 'indir' tampoco puntúan, y se muestran porque son las vías a las que el")
    print("hábito puede migrar cuando la directa se bloquea (#720): si suben mientras 'bueno%'")
    print("sube, la mejora es de forma y no de fondo. 'blq' son comandos que el guard bloqueó —")
    print("nunca corrieron, así que no suman a 'shell'; su reintento por el wrapper sí cuenta.")


if __name__ == "__main__":
    main(sys.argv[1:])
