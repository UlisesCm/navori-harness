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
CD_PREFIX = re.compile(r'^\s*cd\s+("[^"]*"|\S+)\s*&&\s*')
# Los dos fallos que NO son un bug: el harness bloqueando y el usuario negando.
# Juntos son el 29.1% de las 281 llamadas fallidas del parque.
HOOK_BLOCK = re.compile(r"PreToolUse:|PostToolUse:|hook error")
DENIED = re.compile(r"requested permissions|user doesn't want|denied|rejected", re.I)

# ─── Qué cuenta como archivo fuente no trivial ──────────────────────────────
#
# UNA definición, y vive en TypeScript: `packages/cli/src/lib/source-classify.ts`.
# Este script no puede importarla, así que lee las reglas materializadas por
# `pnpm gen:schemas`. Un test de deriva (source-classify.test.ts) falla si el
# JSON se queda atrás del módulo.
#
# La versión anterior era una regex de extensiones, y sobre las 506 escrituras
# del parque admitía un 43% que no corresponde: 28.7% tests que acompañan
# (cláusula c), 13.4% archivos fuera del repo —un script de andamiaje bajo /tmp
# no llega a ningún diff— y una escritura en node_modules. El sesgo va en una
# sola dirección: infla el denominador de "oportunidades", que es justo por qué
# la tasa de activación salía baja. Y NO es uniforme entre repos: los tests
# acompañan al trabajo de feature, así que los repos que más delegan son los que
# más se penalizan.
_RULES_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "source-classify.rules.json")
with open(_RULES_FILE, encoding="utf-8") as _fh:
    _SPEC = json.load(_fh)
RULES = [(r["kind"], re.compile(r["pattern"])) for r in _SPEC["rules"]]

# También estas dos: tenerlas copiadas a mano aquí es como se quedaron atrás en
# cuanto el módulo ganó una extensión (`.ipynb`) — el defecto exacto que el
# archivo compartido existe para cerrar.
SOURCE_EXT = re.compile(_SPEC["sourceExt"])
HARNESS_PROSE = re.compile(_SPEC["harnessProse"])

AUDITS = os.path.expanduser("~/.navori/audits")


def session_version(sid):
    """La versión de navori RENDERIZADA cuando corrió la sesión.

    Sale del registro `start` que el hook escribe al armar audit-mode, no del
    repo: lo que el repo tenga hoy no es la doctrina que estuvo vigente
    entonces. Sin esto, un cambio de doctrina y su medición no se pueden atar.
    """
    if not os.path.isdir(AUDITS):
        return None
    for repo in os.listdir(AUDITS):
        f = os.path.join(AUDITS, repo, f"session-{sid}.log")
        if not os.path.isfile(f):
            continue
        try:
            with open(f, errors="replace") as fh:
                for line in fh:
                    d = json.loads(line)
                    return d.get("navoriRendered") if d.get("event") == "start" else None
        except Exception:
            return None
    return None


def session_cwd(sid):
    """La raíz del repo de una sesión, desde la cabecera de su log de audit.

    Sin esto no hay forma de decir "fuera del repo", y un script de scratchpad
    bajo /tmp cuenta como si fuera código del producto.
    """
    if not os.path.isdir(AUDITS):
        return ""
    for repo in os.listdir(AUDITS):
        f = os.path.join(AUDITS, repo, f"session-{sid}.log")
        if not os.path.isfile(f):
            continue
        with open(f, errors="replace") as fh:
            for line in fh:
                try:
                    return json.loads(line).get("cwd") or ""
                except json.JSONDecodeError:
                    return ""
    return ""


def to_repo_relative(path, root):
    """Espejo de `toRepoRelative` en el módulo TS."""
    if not path:
        return None
    p = path.replace("\\", "/")
    root = (root or "").replace("\\", "/").rstrip("/")
    if not root:
        return None if p.startswith("/") else p.lstrip("./")
    if p == root:
        return ""
    # Un vecino que solo COMPARTE PREFIJO no está dentro: `/repo-2/x` empieza
    # por `/repo`.
    if p.startswith(root + "/"):
        return p[len(root) + 1:]
    return None if p.startswith("/") else p.lstrip("./")


def classify_path(path, root=""):
    """Cláusula (a), decidida desde la ruta. Espejo de `classifyPath`."""
    rel = to_repo_relative(path, root)
    if rel is None:
        return "outside-repo"
    for kind, rx in RULES:
        if rx.search(rel):
            return kind
    if HARNESS_PROSE.search(rel):
        return "source"
    return "source" if SOURCE_EXT.search(rel) else "docs"


def non_trivial(paths, root=""):
    """Cláusulas (a)+(c) sobre el conjunto de UN turno. Espejo de `countNonTrivial`.

    Un test cuenta solo cuando ES el cambio: con cualquier fuente no-test
    presente, los tests acompañan y no suman. Sin ese brazo la regla sería
    inaplicable en este repo, que pide un test con cada fix.

    Es un TECHO, no un conteo exacto: la cláusula (b) —¿el cambio altera el
    comportamiento, o solo propaga un rename?— necesita el contenido del diff, y
    aquí solo hay rutas.
    """
    src = [p for p in paths if classify_path(p, root) == "source"]
    tests = [p for p in paths if classify_path(p, root) == "test"]
    return src if src else tests


def load(prefix):
    for d in os.listdir(PROJECTS):
        for f in glob.glob(os.path.join(PROJECTS, d, prefix + "*.jsonl")):
            return f
    return None


def subagent_transcripts(main_path, session):
    """Los transcripts de los subagentes de ESTA sesión.

    `load()` devuelve solo el `<session>.jsonl` del hilo principal, y el trabajo
    de los subagentes vive aparte, en `<proyecto>/<session>/subagents/`. Nunca se
    abrían: 652 archivos en el parque, invisibles para toda medición de este
    script. El sesgo va en una sola dirección —penaliza justo a las sesiones que
    delegan, que son las que el harness quiere premiar—, el mismo defecto
    direccional que #674 documentó en el clasificador de archivos.
    """
    if not main_path:
        return []
    return sorted(glob.glob(
        os.path.join(os.path.dirname(main_path), session, "subagents", "agent-*.jsonl")))


def subagent_skills(main_path, session):
    """Uso de skills dentro de los subagentes, por las DOS vías, separadas.

    Separadas porque miden cosas distintas y una de las dos resultó ser casi
    toda la señal. Medido sobre los 652 transcripts de subagente del parque:

      - invocación explícita (`Skill` tool_use) dentro de un subagente: **2**
      - records con `attributionSkill` heredado del padre:          **~1,400**

    Un subagente casi nunca invoca una skill: la HEREDA. Sumar solo los tool_use
    —el remedio que pedía el issue— habría agregado dos llamadas en todo el
    parque y dejado fuera el resto. El campo es el mismo que `lib/audit` consume
    desde #725; aquí se lee con la misma cautela, porque el formato del
    transcript es interno al host y puede cambiar en cualquier release.
    """
    invoked, inherited = Counter(), Counter()
    for f in subagent_transcripts(main_path, session):
        try:
            fh = open(f, errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                # Filtro barato antes de parsear: la inmensa mayoría de los
                # records no dice nada de skills y este bucle corre sobre cientos
                # de archivos.
                if '"Skill"' not in line and "attributionSkill" not in line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if d.get("type") != "assistant":
                    continue
                a = d.get("attributionSkill")
                if isinstance(a, str) and a:
                    inherited[a] += 1
                c = (d.get("message") or {}).get("content")
                if not isinstance(c, list):
                    continue
                for b in c:
                    if not isinstance(b, dict) or b.get("type") != "tool_use":
                        continue
                    if b.get("name") != "Skill":
                        continue
                    sk = (b.get("input") or {}).get("skill")
                    if isinstance(sk, str) and sk:
                        invoked[sk] += 1
    return invoked, inherited


def text_of(msg):
    c = (msg or {}).get("content")
    if isinstance(c, str):
        return c
    return "\n".join(b.get("text") or "" for b in c
                     if isinstance(b, dict) and b.get("type") == "text") if isinstance(c, list) else ""


def sig(cmd):
    """Firma de comando: sin el `cd ... &&` de cabecera, primeros 4 tokens."""
    return " ".join(CD_PREFIX.sub("", cmd or "").split()[:4])


def is_debuggable(x):
    """¿Este fallo pide diagnóstico, o trae su causa escrita?"""
    if not x["error"]:
        return False
    out = x["out"] or ""
    if HOOK_BLOCK.search(out[:200]) or DENIED.search(out[:300]):
        return False
    return bool(VERIFY_CMD.search(str(x["input"].get("command", "")))) or bool(ERROR_LINE.search(out))


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
    # La raíz del repo de ESTA sesión, para poder decir "fuera del repo". Sale
    # de la cabecera de su log de audit, que es donde el hook la registró.
    root = session_cwd(session)

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

        # O1 — implementer: 2+ archivos fuente NO TRIVIALES tocados en el turno.
        # "No trivial" sale del clasificador compartido, no de una regex de
        # extensiones: descarta generados, efímeros, fuera-del-repo, y los tests
        # que acompañan a un fuente ya contado (cláusula c).
        written = [str(x["input"].get("file_path", "")) for x in t["tools"]
                   if x["name"] in ("Edit", "Write") and x["input"].get("file_path")]
        touched = set(non_trivial(written, root))
        mark("implementer", len(touched) >= 2, agent="implementer",
             note=f"{len(touched)} archivos fuente: {sorted(touched)[:2]}")

        # O2 — verify-before-done: afirma cierre sin comando de verificación en el turno
        final = "\n".join(t["assistant"])[-1500:]
        mark("verify-before-done",
             bool(touched) and bool(DONE_CLAIM.search(final)) and not VERIFY_CMD.search(cmds),
             skill="verify-before-done", note=t["user"][:60])

        # O3 — debug-error: un fallo que hay que DIAGNOSTICAR.
        #
        # La versión anterior pedía >=5 líneas de error ("pared de errores") y
        # daba 0 oportunidades en 58 sesiones. No era una heurística estrecha:
        # la condición no ocurre. Sobre 281 llamadas fallidas, NINGUNA llega a 3
        # líneas de error —ni siquiera las 67 que no llevan truncado explícito,
        # una de ellas con 387 líneas de salida—. El gate corre como hook ANTES
        # del commit, así que una suite roja se manifiesta como UN `git commit`
        # bloqueado, no como cuarenta líneas que triagear; y el 89.2% de los
        # comandos de verificación pasan por `| tail`/`| head`, con mediana de
        # salida de 7 líneas.
        #
        # El disparador de la skill se reapuntó a "falló y no sé por qué", así
        # que esto mide eso: un fallo que pide diagnóstico. Se excluyen los dos
        # que NO lo piden —un bloqueo de hook y un permiso denegado son el
        # harness funcionando, y su causa viene escrita en la propia salida—.
        # Es un PISO, no un techo: un fallo auto-explicativo (ruta inexistente)
        # que traiga una línea de error reconocible entra igual.
        debuggable = any(is_debuggable(x) for x in t["tools"])
        mark("debug-error", debuggable, skill="debug-error", note=t["user"][:60])

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

    sub_invoked, sub_inherited = subagent_skills(path, session)

    first = turns[0]["user"][:60].replace("\n", " ") if turns else ""
    broad = bool(re.search(r"implementa|construye|crea |feature|migra|refactor|spec", first, re.I))
    return dict(session=session, repo=repo, turns=len(turns), first=first,
                mode="+".join(f"{k}:{v}" for k, v in mode.most_common(2)) or "?",
                scope="amplio" if broad else "incremental",
                opp=opp, hit=hit, auto=auto, asked=asked,
                sub_invoked=sub_invoked, sub_inherited=sub_inherited,
                sub_files=len(subagent_transcripts(path, session)))


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

# ─── La distribución, no solo el agregado ───────────────────────────────────
#
# Una tasa agregada invita a leer una propiedad donde solo hay una media, y esa
# lectura ya costó una investigación entera (#705). El agregado por repo daba
# "cuatro repos donde el harness está inerte"; medida la distribución, dos
# tercios de TODAS las sesiones no delegan nada —en los repos que "sí delegan"
# también—, y que las pocas sesiones de un repo caigan todas de ese lado es lo
# que se espera por azar, no una propiedad suya.
#
# Se exige un mínimo de oportunidades por sesión: una sesión con una sola
# oportunidad es 0% o 100% y solo agrega varianza al histograma.
MIN_OPP = 3
buckets = Counter()
graded = 0
for r in rows:
    o, h = sum(r["opp"].values()), sum(r["hit"].values())
    if o < MIN_OPP:
        continue
    graded += 1
    rate = 100 * h / o
    buckets["0%" if rate == 0 else "1-24%" if rate < 25 else "25-74%" if rate < 75 else "75-100%"] += 1

print("\n" + "=" * 104)
print(f"DISTRIBUCIÓN POR SESIÓN — {graded} sesiones con >= {MIN_OPP} oportunidades")
print("=" * 104)
if graded:
    for k in ["0%", "1-24%", "25-74%", "75-100%"]:
        n = buckets[k]
        print(f"  {k:>8}{n:>5}  ({100*n/graded:4.1f}%)  {'#' * round(40 * n / graded)}")
    base = buckets["0%"] / graded
    # La doctrina vigente DURANTE la medición, que es lo único que este número
    # describe. Sin ella, una tasa base se lee como una propiedad del harness en
    # vez de como una foto de la versión que estaba puesta.
    vers = sorted({v for v in (session_version(r["session"]) for r in rows) if v})
    if vers:
        span = vers[0] if len(vers) == 1 else f"{vers[0]} … {vers[-1]}"
        print(f"\n  Versiones renderizadas durante estas sesiones: {span}")
    print(f"\n  Tasa base de sesiones que NO delegan nada: {100*base:.1f}%.")
    print("  Con esa base, que las N sesiones de un repo salgan todas en cero tiene")
    print(f"  probabilidad {100*base:.0f}%^N — con 3 sesiones, {100*base**3:.0f}%. Antes de")
    print("  leer una propiedad del repo en un agregado, contar cuántas sesiones lo forman.")
else:
    print(f"  (ninguna sesión llegó a {MIN_OPP} oportunidades)")

print("\n" + "=" * 104)
print("INVOCACIONES REALES — automáticas vs pedidas por el usuario")
print("=" * 104)
for k in sorted(set(AUTO) | set(ASKED)):
    print(f"  {k:<24} automática={AUTO[k]:<4} pedida={ASKED[k]}")

# ─── Lo que ocurre DENTRO de los subagentes ─────────────────────────────────
#
# Aparte y no sumado al bloque de arriba, a propósito: ese cuenta invocaciones
# del hilo principal, y mezclarle records de trabajo heredado convertiría una
# tabla de "cuántas veces se pidió" en un híbrido que no responde ninguna de las
# dos preguntas. Es la trampa que este archivo ya pagó dos veces (#673, #674):
# un contador leído como si midiera otra cosa.
SUB_INV, SUB_INH = Counter(), Counter()
sub_files = 0
for r in rows:
    SUB_INV += r["sub_invoked"]; SUB_INH += r["sub_inherited"]; sub_files += r["sub_files"]
print("\n" + "=" * 104)
print(f"DENTRO DE LOS SUBAGENTES — {sub_files} transcripts que este script no abría")
print("=" * 104)
if sub_files == 0:
    print("  (ninguna sesión analizada delegó)")
else:
    print(f"  {'skill':<26}{'invocada':>10}{'heredada':>10}")
    for k in sorted(set(SUB_INV) | set(SUB_INH), key=lambda x: -(SUB_INH[x] + SUB_INV[x])):
        print(f"  {k[:24]:<26}{SUB_INV[k]:>10}{SUB_INH[k]:>10}")
    print(f"  {'TOTAL':<26}{sum(SUB_INV.values()):>10}{sum(SUB_INH.values()):>10}")
    print("\n  'invocada' = tool Skill dentro del subagente. 'heredada' = records que el")
    print("  host marcó con attributionSkill del padre. Un subagente casi nunca invoca")
    print("  una skill: la hereda, y esa columna es la que estaba perdida entera.")

print("\n" + "=" * 104)
print("EJEMPLOS de oportunidad NO activada (para auditar la heurística a mano)")
print("=" * 104)
for k, v in examples.items():
    for e in v:
        print(f"  [{k}] {e}")
