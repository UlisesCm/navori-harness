#!/usr/bin/env python3
"""Higiene de `topic_key` y tasa de reuso: cuánto de lo que se guarda EVOLUCIONA.

El issue #760 parte de que "la métrica que lo distinguiría no existe: la tasa de
reuso de `topic_key`". Existe desde que alguien corre una query — el esquema de
engram la soporta con `revision_count`. Esto es esa query, hecha repetible, por
la misma razón que `mine-search-routing.py` y `mine-activation.py`: una medición
que no se puede repetir no es una línea base, es una anécdota.

Mide dos cosas distintas que se confunden todo el tiempo:

  reuso      de cada 100 saves que aterrizaron, cuántos evolucionaron una
             observación que ya existía en vez de crear una fila nueva.
  higiene    de las claves que SÍ se pasaron, qué forma tienen — y cuántas son
             irreusables por construcción, o sea que ningún agente podría
             reusarlas aunque buscara perfecto.

QUÉ LEE, Y QUÉ NO — la restricción dura, y es de seguridad.

`~/.engram/engram.db` está en 644 (world-readable) y guarda, además de las
observaciones, los prompts del usuario en claro. Este minero abre la DB
**read-only de verdad** (URI `mode=ro`, no una promesa en un comentario), toca
UNA tabla —`observations`— y de ella exactamente las columnas de `COLUMNS`:
clave, tipo, conteo de revisiones, proyecto y fecha. El cuerpo y el título de la
observación están fuera, y la tabla de prompts del usuario está fuera entera. La
salida lleva conteos y claves; nunca texto libre. La clave SÍ se imprime: es una
clave, no prosa del usuario, y es el único dato accionable del reporte.

Eso no es una convención de estilo: es la mitigación que la auditoría de #760
dejó por escrito, y `mine-topic-keys.test.ts` la afirma leyendo ESTE archivo
como texto. Agregar una columna aquí rompe ese test a propósito.

POR QUÉ EL DENOMINADOR ES LA MITAD DEL TRABAJO.

1. El denominador del reuso son los SAVES que aterrizaron (`SUM(revision_count)`),
   no las filas. Dividir entre filas responde otra pregunta —"qué fracción de las
   filas se tocó más de una vez", 47/674 = 7.0% en este corpus— y se parece lo
   bastante al número bueno como para pasar por él. La intervención que #760
   discute actúa POR SAVE, así que el denominador tiene que ser por save.

2. Las observaciones SIN clave se quedan DENTRO del denominador global. Son el
   65% del corpus y el defecto dominante que el ticket no nombra: para ellas el
   upsert no puede engancharse, busque quien busque. Sacarlas convertiría la
   métrica en "higiene de claves" mientras el problema mayor queda invisible —
   por eso el reuso entre claveadas se reporta AL LADO del global, nunca en su
   lugar.

3. Pero una parte de esa masa sin clave **no es negligencia del agente**:
   `mem_session_summary` no acepta `topic_key` en su schema, así que sus 132
   `session_summary` son inclaveables por API. Por eso se imprime el desglose de
   tipos sin clave. Un "% sin clave" a secas fija un techo que nadie puede
   alcanzar, y entonces cualquier intervención parece fracasar — el mismo defecto
   que infló el denominador de `mine-search-routing.py` con pipes y extracciones.

4. `duplicate_count` NO es reuso: cuenta los choques de hash exacto del dedupe de
   engram, y en este corpus es 0 en las 674 filas. Usarlo como numerador
   reportaría 0% de reuso con toda la maquinaria funcionando.

LÍNEA BASE (2026-09-13 19:42 CST, commit `16c9dc8`, proyecto `navori-harness`):

    filas 674 · saves 737
    reuso global          8.5%   (63 de 737 saves evolucionaron)
    reuso entre claveadas 19.1%  (56 de 293 saves con clave)
    reuso sin clave        1.6%  (7 de 444)
    sin topic_key         64.8%  (437 de 674)
    off-convention        61.6%  (146 de 237 claves sin `/`)
    con fecha embebida    13     irreusables por construcción

    Y el parque entero, mismo instrumento, misma corrida: 2,955 filas · 3,294
    saves · reuso 10.3% · sin clave 58.8% · off-convention 65.8% (802/1,218).
    navori-harness no es un caso raro; es el caso típico.

    La auditoría de #760 publicó horas antes 8.6% · 19.4% · 65.2% · 62.7% · 13
    sobre 670 filas. La diferencia es DERIVA DEL CORPUS, no del instrumento:
    los cuatro saves que entraron entre las dos corridas traen clave
    `<area>/<slug>`, y los invariantes lo confirman —146 claves sin slash, 114
    con prefijo de proyecto y 13 fechadas son los MISMOS tres números que la
    auditoría midió con SQL a mano; lo único que se movió son los denominadores.
    El corpus está vivo: durante esta sesión pasó de 673 a 674 filas entre dos
    queries. Por eso toda cifra de este minero se cita con `filas` y `saves` al
    lado. Un porcentaje solo no distingue un efecto de cuatro saves nuevos.

    Las 13 con fecha son el hallazgo accionable: `navori-audit-hallazgos-2026-09`
    no puede evolucionar en octubre. Y las dos mitades "duplicadas" que #728 P3
    cita están entre esas 13.

Uso:
    python3 scripts/mine-topic-keys.py                    # todos los proyectos
    python3 scripts/mine-topic-keys.py navori-harness     # solo ese
    python3 scripts/mine-topic-keys.py --project moonar-medusa-monorepo
    python3 scripts/mine-topic-keys.py --top 30           # más claves irreusables
    ENGRAM_DB=/ruta/a.db python3 scripts/mine-topic-keys.py
"""

import os
import re
import sqlite3
import sys
from collections import Counter
from urllib.request import pathname2url

# Redirigible por entorno para que un test pueda apuntarla a un sandbox, igual
# que `NAVORI_AUDITS_ROOT` en el minero gemelo.
DB_PATH = os.environ.get("ENGRAM_DB") or os.path.expanduser("~/.engram/engram.db")

# La única tabla y las únicas columnas que este script puede tocar. El SELECT se
# construye desde aquí, así que la lista de permitidas es una sola y es
# estructural — no una promesa repartida por el archivo.
TABLE = "observations"
COLUMNS = ("topic_key", "type", "revision_count", "project", "created_at")

# `YYYY-MM` embebido. Es la marca de una clave irreusable por construcción: el
# mes queda congelado en la clave, así que el tema no puede evolucionar al mes
# siguiente ni con el mejor lookup del mundo.
_DATE = re.compile(r"20\d{2}-\d{2}")

# Corta una cadena en su PRIMER segmento. No marca áreas: de los tres, solo `/`
# separa `<area>/<slug>`; `-` y `_` son separadores internos del slug y del
# nombre de un proyecto (`navori-harness`). Lo que hace la constante es decidir
# dónde termina la primera palabra, que es lo único que `_has_project_prefix`
# necesita comparar.
_HEAD = re.compile(r"[/\-_]")


def open_readonly(path):
    """Abre la DB en modo lectura de verdad: URI `mode=ro`, que SQLite impone.

    `sqlite3.connect(path)` sobre un archivo escribible da una conexión que
    puede escribir; que este script no emita un INSERT es una propiedad del
    código, no del canal. La URI lo vuelve una propiedad del canal.
    """
    return sqlite3.connect(f"file:{pathname2url(os.path.abspath(path))}?mode=ro", uri=True)


def live_clause(conn):
    """`AND deleted_at IS NULL` si el esquema trae soft-delete; vacío si no.

    Se introspecta en vez de asumirse: engram marca las observaciones borradas
    en vez de quitarlas, y contar una borrada como viva inflaría el denominador
    con saves que el usuario ya retiró. Si una versión futura del esquema deja
    de traer la columna, el minero sigue corriendo en vez de explotar.
    """
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({TABLE})")}
    if not cols:
        raise SystemExit(f"[mine-topic-keys] la DB no tiene tabla `{TABLE}`")
    missing = [c for c in COLUMNS if c not in cols]
    if missing:
        raise SystemExit(f"[mine-topic-keys] a `{TABLE}` le faltan columnas: {', '.join(missing)}")
    return " AND deleted_at IS NULL" if "deleted_at" in cols else ""


def load(db_path=None, projects=()):
    """Las filas vivas de `observations`, como dicts de las columnas permitidas."""
    path = db_path or DB_PATH
    if not os.path.exists(path):
        raise SystemExit(f"[mine-topic-keys] no existe la DB: {path}")
    conn = open_readonly(path)
    try:
        sql = f"SELECT {', '.join(COLUMNS)} FROM {TABLE} WHERE 1=1{live_clause(conn)}"
        params = []
        if projects:
            sql += f" AND project IN ({','.join('?' * len(projects))})"
            params = list(projects)
        return [dict(zip(COLUMNS, row)) for row in conn.execute(sql, params)]
    finally:
        conn.close()


def classify_key(key, project=None):
    """Las etiquetas de forma de UNA `topic_key`. Lista vacía si no hay clave.

    Las etiquetas no son excluyentes: una clave puede ser `<area>/<slug>` y
    traer fecha a la vez (`navori/audit-reprocesos-2026-08` lo es). Reportarlas
    como categorías disjuntas escondería justo esa mezcla.

      area-slug          la forma documentada, `<area>/<slug>`.
      sin-slash          otra convención. Off-convention.
      prefijo-proyecto   repite el proyecto que la fila ya lleva en su columna.
      fechada            `YYYY-MM` embebido ⇒ irreusable por construcción.
      no-ascii           el slugificador del upstream destroza el no-ASCII
                         (`Auditoría` → `auditor-a`), así que una clave escrita
                         a mano con acentos es irreproducible por
                         `mem_suggest_topic_key`: quien busque la clave "bien
                         escrita" nunca la va a acuñar igual.
    """
    k = (key or "").strip()
    if not k:
        return []
    tags = ["area-slug" if "/" in k else "sin-slash"]
    if _DATE.search(k):
        tags.append("fechada")
    if not k.isascii():
        tags.append("no-ascii")
    if project and _has_project_prefix(k, project):
        tags.append("prefijo-proyecto")
    return tags


def _has_project_prefix(key, project):
    """¿La clave empieza por el proyecto (o su primer segmento)?

    Se compara el PRIMER segmento de la clave, no un `startswith` pelado: con
    `startswith` una clave `navorificar-x` contaría como prefijada para el
    proyecto `navori-harness`, y eso no es repetir el proyecto, es otra palabra.
    """
    head = _HEAD.split(key.casefold(), 1)[0]
    p = project.casefold()
    return head in (p, _HEAD.split(p, 1)[0])


def _bucket(rows):
    """filas, saves, saves que evolucionaron y tasa de reuso de una población."""
    filas = len(rows)
    saves = sum(max(1, int(r["revision_count"] or 1)) for r in rows)
    evol = saves - filas
    return {
        "filas": filas,
        "saves": saves,
        "evolucionados": evol,
        "reuso": (100 * evol / saves) if saves else 0.0,
    }


def summarize(rows, top=15):
    """Todas las cifras del reporte, a partir de las filas crudas."""
    keyed = [r for r in rows if (r["topic_key"] or "").strip()]
    unkeyed = [r for r in rows if not (r["topic_key"] or "").strip()]

    formas = Counter()
    irreusables = []
    for r in keyed:
        tags = classify_key(r["topic_key"], r["project"])
        formas.update(tags)
        if "fechada" in tags or "no-ascii" in tags:
            irreusables.append(
                {
                    "topic_key": r["topic_key"].strip(),
                    "created_at": r["created_at"] or "",
                    "revision_count": max(1, int(r["revision_count"] or 1)),
                }
            )
    # Más recientes primero: una clave fechada de junio es peso muerto, pero una
    # de este mes es un hábito todavía corriendo, que es lo accionable.
    irreusables.sort(key=lambda x: x["created_at"], reverse=True)

    return {
        "todas": _bucket(rows),
        "claveadas": _bucket(keyed),
        "sin_clave": _bucket(unkeyed),
        "pct_sin_clave": (100 * len(unkeyed) / len(rows)) if rows else 0.0,
        "formas": formas,
        "irreusables": irreusables[:top],
        "irreusables_total": len(irreusables),
        "tipos_sin_clave": Counter(r["type"] or "?" for r in unkeyed),
    }


def _fila(label, b):
    return f"{label:20s} {b['filas']:7d} {b['saves']:7d} {b['evolucionados']:7d} {b['reuso']:7.1f}%"


def report(res):
    """Imprime el reporte. Conteos y claves; nunca texto libre de la DB."""
    print(f"{'corpus':20s} {'filas':>7s} {'saves':>7s} {'evol':>7s} {'reuso':>8s}")
    print(_fila("todas", res["todas"]))
    print(_fila("con topic_key", res["claveadas"]))
    print(_fila("sin topic_key", res["sin_clave"]))
    print()

    sin = res["sin_clave"]["filas"]
    tot = res["todas"]["filas"]
    print(f"sin topic_key: {res['pct_sin_clave']:.1f}% ({sin}/{tot})")
    print()

    con = res["claveadas"]["filas"]
    print(f"{'forma de clave':26s} {'conteo':>7s} {'%':>7s}   (sobre {con} claves)")
    for tag in ("area-slug", "sin-slash", "prefijo-proyecto", "fechada", "no-ascii"):
        n = res["formas"][tag]
        print(f"{tag:26s} {n:7d} {(100 * n / con) if con else 0:6.1f}%")
    print()

    if res["irreusables"]:
        print(f"claves irreusables ({res['irreusables_total']}), más recientes primero:")
        for it in res["irreusables"]:
            print(f"  {it['created_at'][:10]:10s} rev={it['revision_count']:<3d} {it['topic_key']}")
        print()

    if res["tipos_sin_clave"]:
        print("sin clave, por type:")
        for t, n in res["tipos_sin_clave"].most_common(8):
            print(f"  {t:20s} {n:5d}")
        print()

    print("'reuso' = (saves - filas) / saves: de cada 100 saves que aterrizaron, cuántos")
    print("evolucionaron una observación existente. El denominador son SAVES, no filas:")
    print("la intervención que #760 discute actúa por save.")
    print()
    print("Las filas sin clave NO se sacan del denominador global — son el defecto dominante,")
    print("y para ellas el upsert no puede engancharse busque quien busque. Pero parte de esa")
    print("masa es inclaveable POR API (`mem_session_summary` no acepta `topic_key`), y por eso")
    print("va el desglose por type: un '% sin clave' a secas fija un techo que nadie alcanza.")
    print()
    print("'fechada' es irreusable por construcción: el mes queda congelado en la clave y el")
    print("tema no puede evolucionar al siguiente. Es la lista accionable del reporte.")


_FLAGS = ("--project", "--top", "--db")


def main(argv):
    """Parsea argumentos y reporta. Un argumento mal escrito ES un error.

    Las tres formas de equivocarse salen por `SystemExit` con mensaje y código
    ≠ 0, porque la alternativa es peor que un error: una bandera desconocida o
    una sin valor caían al filtro de proyecto y el minero contestaba "sin
    observaciones vivas" —una frase que se lee como un dato medido y en realidad
    es un typo—, y un `--top` no numérico reventaba con un traceback crudo.
    """
    top = 15
    db = DB_PATH
    projects = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg in _FLAGS:
            if i + 1 >= len(argv):
                raise SystemExit(f"[mine-topic-keys] `{arg}` necesita un valor")
            value = argv[i + 1]
            if arg == "--project":
                projects.append(value)
            elif arg == "--db":
                db = value
            elif not value.isdigit() or int(value) < 1:
                raise SystemExit(f"[mine-topic-keys] `--top` espera un entero ≥ 1, no {value!r}")
            else:
                top = int(value)
            i += 2
        elif arg.startswith("-"):
            raise SystemExit(
                f"[mine-topic-keys] bandera desconocida: {arg} (conocidas: {', '.join(_FLAGS)})"
            )
        else:
            projects.append(arg)
            i += 1

    rows = load(db, projects)
    if not rows:
        print("sin observaciones vivas" + (f" para {', '.join(projects)}" if projects else ""))
        return
    if projects:
        print(f"[proyecto: {', '.join(projects)}]")
    report(summarize(rows, top))


if __name__ == "__main__":
    main(sys.argv[1:])
