# tgrep — cómo funcionaba, qué se midió y qué no volver a descubrir

> Escrito el **2026-09-15**, con `main` en **`0145149b`**, como referencia de
> reimplementación: el plugin `tgrep` se borra del repo y esto es lo único que queda de él.
> Las citas `archivo:línea` apuntan a ese commit. Los números llevan su fuente pegada; los
> que se re-midieron para este documento lo dicen, y los que no se pudieron verificar
> también (§ *Correcciones al encargo*).

## Por qué existe este archivo

`tgrep` no era una preferencia de herramienta: era el caso de prueba con el que este repo
separó **doctrina** de **mecanismo**. La doctrina de ruteo de búsqueda se escribió, se
entendió y se midió al **7.4%** de adopción; el bloqueo mecánico la movió a **40.7%** en una
semana. Todo lo que este harness cree hoy sobre "lo que bloquea aguanta y lo que sugiere no"
se apoya en esa medición, y la medición se apoya en estas piezas. Si se reimplementa la capa
sin esta memoria, lo primero que se repite es el año de doctrina.

---

## 1. Qué era

[`tgrep`](https://github.com/microsoft/tgrep) (Microsoft, Rust, MIT) es un grep con **índice
de trigramas** y superficie de flags compatible con ripgrep. La spec
[`specs/0017-tgrep-search-layer/`](../../specs/0017-tgrep-search-layer/requirements.md) lo
incorporó como plugin de navori con una regla: *cuando el binario existe es el default de
búsqueda de contenido en todos los flujos y modos; cuando no existe, el harness no se
degrada*. Verificado con tgrep **1.0.5** entonces; esta máquina corre **1.0.8** hoy.

El paquete era `@navori/plugin-tgrep` (`packages/plugins/tgrep/`), cinco piezas:

| Pieza | Archivo | Qué hacía |
|---|---|---|
| **Manifest** | `plugin.json` | declara binario externo, dos reglas `allow`, tres scripts, dos hooks, cinco inyecciones de doctrina y un invariante |
| **Wrapper** | `scripts/tgrep-search.sh` (226 líneas) | el ÚNICO punto de entrada de búsqueda: elige motor, re-indexa, filtra flags, preserva exit codes |
| **Guard** | `scripts/guard-search-routing.sh` (362 líneas) | `PreToolUse(Bash)`: bloquea la búsqueda recursiva por shell y redirige al wrapper |
| **Hook de sesión** | `scripts/tgrep-session.sh` (97 líneas) | `SessionStart`: una línea de stdout diciendo qué motor hay, y calienta el índice |
| **Doctrina** | `managed/tgrep-protocol.md` + `skills/{tgrep-rung,tgrep-search-agent,tgrep-code-agent}.md` | bloque always-on de `CLAUDE.md`, rung de `structural-search` e inyecciones a los cuatro agentes |

**El reparto del trabajo es la parte que importa.** Tres capas con tres funciones distintas,
y la spec las separó a propósito:

- **El wrapper decide**, porque la decisión no puede vivir en la atención del modelo. Los
  hooks de `SessionStart` **no corren para subagentes** (contrato del host, verificado
  2026-09-08 y anotado en `packages/cli/src/lib/plugins.ts:86-90`), así que
  `researcher`/`explorer`/`implementer`/`reviewer` no pueden saber qué binario tiene la
  máquina. Un `if` en bash da la misma respuesta en todos.
- **El guard obliga**, porque la doctrina sola no movió la aguja (§5).
- **La doctrina explica**, y solo eso: dice qué comando correr, cómo leer el exit code y
  cuándo NO usar el wrapper.

El `Grep` nativo de Claude Code **no es pluggable** (trae ripgrep embebido, sin backend
alternativo): "tgrep como default" solo se podía lograr por regla `allow` + doctrina + guard.
Eso está fijado en `specs/0017-tgrep-search-layer/requirements.md:14-18`.

---

## 2. La mecánica exacta

### 2.1 Resolución del motor

`tgrep-search.sh` prueba en orden y sale por el primero que existe:

```
tgrep  →  rg  →  grep -rn
```

```bash
# packages/plugins/tgrep/scripts/tgrep-search.sh:138-174 (abreviado)
if command -v tgrep >/dev/null 2>&1; then
  … tgrep index "$root" --index-path "$index_dir" …
  tgrep --index-path "$index_dir" "$@" || search_status=$?
  exit "$search_status"
fi
if command -v rg >/dev/null 2>&1; then
  echo "⊘ tgrep not installed — searching with rg (no trigram index, slower). Install: $INSTALL_HINT" >&2
  exec rg "$@"
fi
# … traducción a grep -rn …
```

Detalles que no son cosméticos:

- **`command -v` se re-evalúa en cada invocación**, sin cachear la decisión: si tgrep se
  desinstala a media sesión, la siguiente búsqueda cae a `rg` con aviso
  (`design.md:186-188`).
- **Una línea a stderr por fallback**, nombrando el motor y `brew install tgrep` (R4). Es la
  señal de "estás en la ruta lenta" para el agente; el hook de sesión es la misma señal para
  el humano, una vez al arrancar. Doble canal porque los públicos son distintos.
- **`search_status`, nunca `status`**: en zsh `status` es de solo lectura (espeja `$?`) y la
  asignación aborta el script. Los hooks corren bajo el shell que cablee el host, así que un
  nombre bash-only es un bug real (`tgrep-search.sh:150-153`; los tests corren con
  `acrossShells`, bash **y** zsh).

### 2.2 El contrato de exit codes — y el tercero

```
0 = hay match
1 = no hay match
2 = NO SE BUSCÓ NADA   ← ni es 1 ni se parece
```

`0/1` se preserva en las tres vías. El **2** existe en dos lugares y es la parte que la gente
confunde:

1. **Flag rechazado** por el gate de admisión (`tgrep-search.sh:63-70`).
2. **Ningún patrón sobrevivió** la traducción a `grep` (`tgrep-search.sh:217-220`).

Leer un 2 como "no match" produce exactamente el falso negativo silencioso que toda esta capa
existe para prevenir. El descubrimiento tiene historia: la doctrina prometía "0/1 en las tres
vías" y el script salía 2 — se corrigió en **#667** (`a277602f`, 2026-09-10) y quedó anclado
en un test (`tgrep-search-script.test.ts:297`, *"exits 2 — not 1 — when no pattern survives
the flag dropping"*). El guard también lo repite en su mensaje de bloqueo
(`guard-search-routing.sh:268`).

**Trampa asociada, documentada porque costó una conclusión casi publicada** (#667): verificar
*qué motor corrió* se hace por stderr vacío (la línea de fallback es lo único que el wrapper
escribe ahí), pero aislarlo con `2>&1 1>/dev/null | head` devuelve **stdout** bajo MULTIOS de
zsh — una búsqueda con resultados se lee como "stderr vacío", un falso *"corrió tgrep"* del
mismísimo comando que iba a probarlo. Redirigir a archivos **separados** (`> out 2> err`).

### 2.3 El índice: dónde vive y por qué se reconstruye siempre

```bash
# tgrep-search.sh:117-136
root="$(git rev-parse --show-toplevel 2>/dev/null || true)"; [ -n "$root" ] || root="$PWD"
index_dir="${XDG_CACHE_HOME:-$HOME/.cache}/navori/tgrep/$(cache_key)"   # sha256(root)[0:16]
```

- **La raíz es el repo, no `$PWD`**: el índice debe quedar pegado al mismo árbol desde
  cualquier cwd. Un worktree de agente resuelve a sí mismo y obtiene su propio índice, que es
  correcto por construcción: indexa lo que ese árbol ve.
- **La clave es un hash de la ruta absoluta**, no la ruta: el workspace de este usuario es
  `Dev - Docs/…`, con espacios, y así ningún carácter raro llega al filesystem del cache.
  Sin `shasum` ni `sha256sum` cae a un slug (separa repos, deja de ser a prueba de
  colisiones).
- **El índice vive FUERA del repo** (`~/.cache/navori/tgrep/<clave>`). El default de tgrep es
  `.tgrep/` **dentro** del árbol, lo que exigiría una línea de `.gitignore` en cada repo que
  navori renderiza. El wrapper siempre pasa `--index-path`.
- **Se re-indexa antes de CADA búsqueda.** No es preferencia, es correctitud: medido en
  fixture controlado (spec 0017, H3), un índice stale da **falso negativo silencioso** —
  contenido agregado a un archivo ya indexado y archivos creados después del build salen
  `exit 1` sin warning. Y es barato: **0.07s sobre 793 archivos de texto**
  (`design.md:18`, bonum-webapp). Re-medido hoy en navori-harness (760 archivos trackeados,
  tgrep 1.0.8): **0.111s de reloj para reindex + búsqueda completa**, contra ~0.20s (p75
  1.83s) que cuesta una sola búsqueda por shell.
- **Si el índice falla** (cache no escribible, build roto, índice corrupto o a medio escribir
  por una sesión paralela) la búsqueda se rehace con `tgrep --no-index` — scan completo,
  lento y correcto. Nunca un índice posiblemente stale (`tgrep-search.sh:154-167`).

El hook `SessionStart` calienta el índice **llamando al wrapper**, no reimplementando la
cache-key: `bash "$wrapper" -q -F "navori-tgrep-warm-sentinel"` con `timeout 20`
(`tgrep-session.sh:83-94`). Un patrón centinela que no matchea nada; lo que importa es el
reindex previo. Exit 0 en todos los caminos: un hook que falla nunca debe ser la razón de que
una sesión no abra.

### 2.4 Flags aceptados

La superficie es la de ripgrep, con un **allowlist explícito** (§3). Subset portable que la
doctrina recomendaba:

```
-i  -l  -c  -n  -F  -w  -e  -g  -A/-B/-C  -m
```

Y los que la rung marcaba como "evitar, no prohibidos" (`skills/tgrep-rung.md:44`):
`--hidden`, `--no-ignore*` y `-a/--text` convierten la búsqueda en **brute-force scan**
(verificado con `--stats`), que es justo el costo que el índice existe para evitar;
`-t/--type` no nombra los mismos conjuntos en los dos motores. Corrección medida en T5 de la
spec: **`-E/--encoding` NO bypassea el índice** — `tgrep --stats -E auto <patrón>` sigue
reportando `Query plan: AND(n trigrams)` mientras los otros tres caen a `Brute-force search`
(`design.md:143-146`). La doctrina lista solo los tres verificados.

En la vía `grep -rn` sobrevive solo lo posicional (patrón y paths) más `-e PATTERN`; el
wrapper **cuenta y avisa** cuántos flags tiró (`tgrep-search.sh:176-215`). El parser salta el
**valor** de los flags que llevan uno, porque sin eso `-g '*.ts' foo .` se convierte en buscar
`*.ts` dentro de un path llamado `foo`.

### 2.5 Dot-directories — la regla que nadie recuerda

`.claude/`, `.github/` y compañía **quedan fuera de toda búsqueda por defecto**, aquí y en el
`Grep` nativo: los dos respetan reglas tipo-gitignore y no descienden a directorios ocultos.
Un resultado vacío sin `--hidden` **no prueba nada**. Eso entró como doctrina en **#612**
(`b48bd41a`, 2026-09-08) y quedó en `managed/tgrep-protocol.md:9`.

La tensión que eso crea, y cómo se resolvió: `--hidden` paga scan completo, así que para
archivos **trackeados** bajo un dot-dir la vía barata es `git grep` — y por eso el guard, que
redirige `git grep` en general, **deja pasar** el caso que nombra una ruta con punto
(`guard-search-routing.sh:339-353`). Mantener esa excepción es lo que impidió recrear la
contradicción que #721 quitó: el núcleo recetando lo que el guard bloqueaba.

---

## 3. El diseño de permisos (la mitad no obvia)

El manifest declaraba **dos reglas y ni una más**:

```json
// packages/plugins/tgrep/plugin.json:21-28
"settingsFragment": {
  "permissions": { "allow": [
    "Bash(bash .claude/scripts/tgrep-search.sh *)",
    "Bash(tgrep *)"
  ]}
}
```

Por qué así:

1. **Una regla `allow` estrecha hace la vía promptless en todos los modos.** Es el único
   mecanismo disponible, dado que el `Grep` nativo no es pluggable.
2. **En modo `auto` las reglas `allow` estrechas de Bash resuelven ANTES del clasificador**,
   así que la llamada no paga round-trip. Medido, el reparto de costo es: nativas/MCP
   ~0.08–0.13s contra ~0.20s (p75 1.83s) por shell, más la batería de hooks y la salida
   completa al contexto en cada Bash (`specs/0016-paridad-modos-permiso/design.md:26,42`;
   la misma cifra la imprime `packages/cli/src/lib/audit/signals.ts:542`).
3. **La invocación canónica es relativa** (`bash .claude/scripts/tgrep-search.sh …`). La regla
   es un literal con prefijo: cualquier otra escritura —absoluta, `cd … &&`,
   `$CLAUDE_PROJECT_DIR`— **deja de matchear y compra un prompt**. Y `$CLAUDE_PROJECT_DIR`
   existe en el entorno de un **hook**, no en el shell del agente: recetarlo (como proponía
   #724/M3) habría convertido un exit 127 ocasional en permanente. Por eso el mensaje del
   guard dice explícitamente que hay que correrlo desde la raíz del repo
   (`guard-search-routing.sh:259-267`).
4. **`rg` NO se pre-aprueba, deliberadamente.** `rg --pre CMD` ejecuta CMD **una vez por
   archivo**, y `--hostname-bin CMD` también ejecuta. Esa exclusión es doctrina vigente del
   núcleo (`packages/core/core-assets/managed/operaciones-seguras.md:7`) y **hay que
   conservarla**.

### 3.1 El agujero que eso abrió, y el gate que lo cerró (#717 C1 → #719)

El wrapper allow-listado terminaba, sin tgrep instalado, en `exec rg "$@"` **verbatim**. O
sea: la superficie que `rg` tenía prohibida quedaba reabierta un nivel de indirección más
abajo, y sin prompt. **Verificado punta a punta antes de tocar nada**: `rg --pre` ejecuta y el
wrapper reenviaba `--pre` intacto.

El fix es un **allowlist de flags, no un denylist**, y la razón es explícita: `--pre` no era
el único (`--hostname-bin` también ejecuta), y un denylist tiene que acertarle a cada flag que
ripgrep agregue después. El allowlist falla hacia rechazar, que es la dirección correcta para
una superficie que corre sin prompt.

```bash
# tgrep-search.sh:47-61
SAFE_SHORT_FLAGS="iIlcnFwegABCmohvxsSatTuzrEfL"
SAFE_LONG_FLAGS="ignore-case case-sensitive smart-case fixed-strings … index-path no-index"
```

Tres propiedades del gate que un reimplementador debe copiar:

- **Corre ANTES de elegir motor** (`tgrep-search.sh:102-111`), así que ninguna rama del
  dispatch puede ser la que reenvíe el flag. El test lo verifica con un stub por rama que
  graba si fue invocado (`tgrep-search-script.test.ts:340-378`).
- **El rechazo es exit 2**, nunca 1.
- **Admite shorts empaquetados** (`-in`, `-uuu`, `-A3`: un dígito es valor, no flag), la forma
  `--flag=value`, y **deja de inspeccionar tras `--`**.
- **El costo del allowlist es el falso bloqueo**, y un falso bloqueo enseña al llamador a
  rodear el wrapper. Por eso el conjunto no se inventó: es el subset portable que la rung
  documenta, más los que llama "evitar", más los que la traducción a grep enumera. Y hay un
  test de deriva que **lee la prosa de la rung** y falla si las dos se separan
  (`tgrep-search-script.test.ts:409`).

---

## 4. El guard: `guard-search-routing.sh`

`PreToolUse` con `matcher: "Bash"`, `timeout: 10`. Exit 2 bloquea la llamada y manda su
stderr al contexto del agente.

### 4.1 Qué bloqueaba

Tres reglas, todas sobre segmentos que **inician** un comando (nunca tras un pipe):

| Regla | Condición | Línea |
|---|---|---|
| `grep`/`egrep`/`fgrep` recursivo | verbo anclado al inicio + token `-r`/`-R`/`-rn`/`--recursive` + **no nombra ningún archivo concreto** | `:315-319` |
| `rg` | verbo anclado + **no nombra ningún archivo concreto** (rg es recursivo por default, así que la pregunta se invierte) | `:326-329` |
| `git grep` | `git [opciones globales] grep`, **salvo** que nombre una ruta con punto | `:349-353` |

El regex de recursión (`-[a-zA-Z]*[rR][a-zA-Z]*`) no puede matchear `--include` ni `--color`
porque tras el guion inicial la clase no acepta otro guion. El de `git` copia la forma que
`guard-destructive` ya usaba para `git -C … commit`, porque sin ella `git -C /repo grep` se
escapa del ancla.

### 4.2 Qué dejaba pasar **a propósito**

La frontera no es estética: **un bloqueo falso enseña al modelo a rodear el guard, y eso es
peor que la búsqueda que habría evitado** (`guard-search-routing.sh:19-28`).

| Forma | % de las invocaciones | Por qué pasa |
|---|---|---|
| `… \| grep x` | **46%** | filtra la salida de otro comando; el wrapper no puede reemplazarlo |
| `grep -n x file.ts` | **22%** | extrae de un archivo YA conocido — la propia doctrina lo prefiere al wrapper |
| lo no parseable | — | patrón con salto de línea, comilla sin cerrar: **duda = permitir** |
| `… <<EOF` (heredoc) | 2.9% de los bloqueos (25 de 852) | el cuerpo es DATO, no una llamada |
| comando > 20,000 chars | — | el guard corre bajo un timeout que no controla; ser matado es indistinguible de aprobar, así que lo que no alcanza a inspeccionar lo **permite** |
| el wrapper mismo | — | chequeado primero: internamente corre `grep -rn` en su vía de fallback |

Las tres decisiones finas, cada una nacida de un falso positivo real:

1. **Unir continuaciones de línea antes de segmentar** (`:151-152`). Sin eso, `\` + salto
   parte un patrón entrecomillado a la mitad y el fragmento queda sin target, que toda
   heurística lee como búsqueda recursiva. Medido: eso solo mal-etiquetó **más de mil
   extracciones**.
2. **Segmentar con conciencia de comillas** (#721, `:153-179`): un `awk` que camina carácter
   por carácter y solo corta en separadores **fuera** de comillas — y reescribe `||`/`&&`
   antes que `|`. Las dos sustituciones `sed` ciegas que reemplazó cortaban dentro de las
   comillas, así que `git commit -m "arregla el guard && rg ya no bloquea"` producía un
   segmento falso y se bloqueaba. Disparó sobre la sesión que escribía su propio test.
3. **`names_a_file()` no decide por la extensión** (#721, `:204-252`). Tres señales, la más
   barata primero: (a) extensión de 1–4 caracteres; (b) lista de nombres que un repo guarda
   sin extensión (`Makefile`, `Dockerfile`, `LICENSE`, `CODEOWNERS`, `Jenkinsfile`…); (c) un
   `[ -f ]` contra el filesystem, que es lo único que distingue `bin/deploy` (script) de `src`
   (árbol). **Una** ruta concreta basta para permitir, no todas: el guard falla abierto por
   diseño. El primer operando no-flag es el **patrón** y se salta — si no, `grep -rn
   "config.json" src/` parecería nombrar un archivo cuando lo que nombra es lo que busca. Y
   `grep -rn "oxlint" a/package.json b/package.json` es extracción pura pese al `-r`: grep
   ignora la recursión cuando le das archivos. Esa forma es el **9.3%** de todos los grep
   recursivos del parque (124 de 1,328), concentrada en leer archivos bajo `node_modules/`.
4. **Pelar prefijos `VAR=value`** (#724, `:298-307`): `LC_ALL=C grep -rn foo src/` evadía todas
   las reglas por sentarse un token a la derecha del ancla.

### 4.3 Cómo se lo decía al agente

```
[navori] BLOCKED by guard-search-routing: busqueda de contenido recursiva por shell
[navori] route content search through the indexed wrapper:
[navori]   bash .claude/scripts/tgrep-search.sh <same ripgrep flags>
[navori] it carries its own 'allow' rule: no prompt, no classifier round-trip.
[navori] run it from the repo root: …
[navori] exit contract: 0 = match, 1 = no match, 2 = NOTHING WAS SEARCHED.
[navori] this does NOT apply to '| grep' … nor to 'grep -n x known-file' …
```

Nombrar **el reemplazo** y no solo la regla que disparó es deliberado, y está anclado por un
test (`guard-search-routing.test.ts:147`). También lo está la frase del cwd
(`:206`), que salió de #724.

### 4.4 Instrumentación

El guard (y desde #778 también el hook de sesión) llevan el recorder de audit:
`navori_audit_begin` + veredicto resuelto **en un trap `EXIT`**, no por una llamada al final
del archivo — porque el bloque managed termina antes de la sección de usuario y una llamada
puesta después viviría en territorio del usuario. `source` dice `plugin:tgrep`, no `core`:
desactivar el plugin cambia qué hooks corren, y sin eso el reporte no puede explicar por qué
una fase adelgazó entre dos sesiones. Fallbacks no-op de `navori_audit_begin`/`_log`
definidos ANTES de los `# navori:include`, porque el hook es **fail-open**: si alguna vez
corriera sin includes expandidos, una función indefinida sería exit 127 y bajo `set -e`
mataría el hook.

Esa instrumentación es lo que hace medible todo el §5 — incluido el embudo que nadie había
calculado.

---

## 5. Los números

### 5.1 Línea base (la fase de solo-doctrina)

| Cifra | Valor | Fuente |
|---|---|---|
| Búsqueda de contenido por shell | **95.6%** (5,399 llamadas) contra 2.7% del wrapper (154) y 0.1% del `Grep` nativo (6) | issue #661, 48 sesiones / 11 repos, 2026-08-25→09-10 |
| Adopción publicada (denominador inflado) | **4.0%** | `scripts/py/mine-search-routing.py:21` |
| Reparto del denominador viejo | 46.2% filtros (`… \| grep`), 22.3% extracciones, **31.5%** búsquedas reales — sobre 8,562 invocaciones | `mine-search-routing.py:17-19` |
| Misma medición sobre búsquedas reales | **6.4%** | `mine-search-routing.py:22` |
| **Línea base corregida** (10 repos auditados, 2026-09-11) | **7.4%** — 2,761 búsquedas: wrapper 197 · nativo 6 · shell 2,558; fuera del cociente 3,958 filtros y 2,053 extracciones | `mine-search-routing.py:52-57` |
| Por repo donde el plugin estaba activo | moonar 25.6% · navori-health 18.8% · navori-harness 17.3% | `mine-search-routing.py:59-61` |

**Por qué el denominador es la mitad del trabajo.** Un hook que redirige al wrapper **jamás**
va a convertir un pipe, así que medir contra el denominador viejo fija un techo imposible y
hace que cualquier intervención parezca fracasar. Es el mismo defecto que infló el 57% de
activación: un cociente cuyo denominador no es lo que el nombre dice.

### 5.2 El antes/después del guard (#742, corte 2026-09-11)

Mismo instrumento en los dos lados —`mine-search-routing.py --desde|--hasta`—, que es la parte
que importa: comparar contra una base calculada con el minero viejo mediría el cambio del
**instrumento** junto con el del hábito.

| repo | antes | después |
|---|---:|---:|
| navori-harness | 15.7% | **58.1%** |
| navori-health | 17.5% | **53.3%** |
| moonar | 26.2% | **35.5%** |
| **TOTAL parque** | **6.6%** | **40.7%** |

Fuente: `scripts/py/mine-search-routing.py:75-79`, PR #742, `progress/history.md:1739-1742`.

**Re-corrida hoy (2026-09-15) con el mismo instrumento**, para este documento — el "antes" es
estable y el "después" se mueve porque siguen entrando sesiones:

```
[sesiones … → 2026-09-11)
repo                       busq  wrapper  nativo   shell  bueno%  |filtro |extrac |gitgrep |blq
alertaciudadana_app         972        0       4     968    0.4%     1423     572        0    2
alertaciudadana_backend     523        0       1     522    0.2%      704     408        0    1
moonar-medusa-monorepo      145       38       0     107   26.2%      259     137        0    2
navori-dashboard-template   170        0       0     170    0.0%      261     151        0    2
navori-harness              651      101       1     549   15.7%      959     562       12   15
navori-health               194       34       0     160   17.5%      194     141       11    2
TOTAL                      2701      173       6    2522    6.6%     3908    2009       23   26

[sesiones 2026-09-11 → …)
bonum-nexus                 185        0       0     185    0.0%      597     100       76    2
moonar-medusa-monorepo       57       19       0      38   33.3%       61      34        0    3
navori-harness              344      192       0     152   55.8%      390     333        0   15
navori-health                15        8       0       7   53.3%       70      19        0    2
website (worktree)           15        4       0      11   26.7%       37      15        0    3
TOTAL                       635      231       0     404   36.4%     1163     516       76   27
```

El total bajó de 40.7% a **36.4%** por una sola razón, y es la lección del §6 otra vez:
entraron 185 búsquedas de **`bonum-nexus`, un repo sin el guard**, todas por shell. El efecto
en los repos que sí lo tienen no se movió.

### 5.3 La cobertura del guard, medida antes de mergearlo (#679)

| Cifra | Valor |
|---|---|
| Comandos distintos con `grep`/`rg` usados como banco de pruebas | **5,544** (transcripts auditados del parque) |
| Cobertura sobre búsquedas reales | **955/1,042 = 91.7%** |
| Falsos positivos | **0** — 1,373 extracciones, 2,038 filtros y 93 usos del wrapper, todos intactos |
| Lo que se escapa | 87 greps anidados en `for` o en bloques `{ }` — fallar abierto ahí es lo correcto |

Ojo con dos porcentajes que **no** son el mismo: `guard-search-routing.sh:16-17` dice "dispara
en el 55% de las búsquedas genuinas" sobre las 8,562 invocaciones totales; el 91.7% es sobre
las 1,042 búsquedas **parseables** del banco. Denominadores distintos, los dos verdaderos.

### 5.4 La vía de escape: `git grep` (#720 → #739)

| Ventana | `git grep` | Lectura |
|---|---|---|
| antes del guard | 0.85% de las búsquedas (23 llamadas) | — |
| después del guard | **8.20%** (35 llamadas, en una ventana **6.3× más chica**) | **9.6× la tasa** |

El hábito **migró a la vía que ninguna capa veía**: el guard anclaba solo
`grep|egrep|fgrep|rg`, el minero puntuaba los mismos cuatro verbos, y `READ_LANE_BINARIES`
excluía `git` entero con una razón ("no hay carril nativo al que cambiar") que es falsa justo
para este subcomando — su carril nativo es `Grep`. Era invisible hasta que el minero aprendió
a contarlo. #739 (`b9f59ef8`, 2026-09-12) lo redirigió con una sola definición compartida
entre guard, minero y read-lane.

**Cerró.** Re-medido hoy, ventana `--desde 2026-09-13` (posterior a #739): **`git grep` = 0**
en los tres repos con guard (105 búsquedas, `bueno%` 34.3%). Los 76 `git grep` que aparecen en
la ventana ancha son **todos de `bonum-nexus`**, que no tiene el guard. n chico: es evidencia,
no prueba.

Y esa es la razón de que `gitgrep` e `indir` se reporten aunque no puntúen: sin ellas el
antes/después se habría leído como un triunfo limpio, y no lo era.

### 5.5 El embudo pre-registrado — calculado por primera vez aquí

El criterio **primario** de la Fase 1 nunca se calculó (§8). Se puede, porque el guard loguea
cada bloqueo y también loguea `skip / "es el wrapper"` cada vez que el agente invoca el
wrapper. Medido hoy sobre todo el store de audit (`~/.navori/audits/*/session-*.log`):

> **De los bloqueos del guard, ¿qué fracción es seguida por una llamada al wrapper del mismo
> agente dentro de 180s?** → **53 de 58 = 91.4%** (30 de ellos, inmediatamente en el evento
> siguiente).

| Razón del bloqueo | reintento por wrapper |
|---|---:|
| búsqueda recursiva por shell | 49/53 |
| `rg` sin archivo concreto | 2/2 |
| `git grep` | 2/3 |

Denominador: 61 bloqueos en el store, 58 con `tsMs` (los 3 restantes son logs viejos con
resolución de segundos). **Es un proxy por proximidad, no causalidad**: mide que el agente
volvió a buscar por la vía buena tras el bloqueo, no que fuera la misma búsqueda. Aun así
responde lo que el criterio pedía y no tiene denominador discutible.

### 5.6 Presencia del guard

Verificado hoy, contando sesiones por la presencia de registros `guard-search-routing` en el
log de audit, con el corte del 2026-09-11:

| Ventana | Sesiones | Con el guard corriendo | Bloqueos |
|---|---:|---:|---:|
| antes de 2026-09-11 | 49 | **0** (el hook no existía) | 0 |
| 2026-09-11 en adelante | 37 | **29** | 61 |
| solo navori-harness, después | 15 | 12 | 53 |

Las 8 sesiones sin guard en la ventana "después" son de repos que nunca lo recibieron
(`bonum-nexus`, `fixture-repo`) — o sea, configuración, no adopción. Confundir esas dos cosas
es el error que este repo cometió dos veces (§6).

### 5.7 Costo por vía

| Vía | Latencia | Round-trip del clasificador (auto) |
|---|---|---|
| `Grep`/`Read` nativos, MCP con `allow` | ~0.08–0.13s | no |
| wrapper (regla `allow` estrecha) | 0.111s medido hoy, reindex incluido | no |
| búsqueda por shell | ~0.20s, **p75 1.83s** | sí, salvo regla estrecha; más batería de hooks y salida completa al contexto |

Fuente: `specs/0016-paridad-modos-permiso/design.md:26,42`; `packages/cli/src/lib/audit/signals.ts:542`.

---

## 6. Lo que NO funcionó

**1. La doctrina sola.** El bloque de protocolo shippeó en 0.7.8 y midió **7.4%** sobre 2,761
búsquedas reales. Y no fue por incomprensión: *la sesión que escribió el mejor análisis de
tgrep que existe siguió yéndose por shell 9 de cada 10 veces* (#668). En este harness la línea
divisoria está medida — lo que bloquea aguanta (`guard-destructive` 14/14,
`quality-gate-pre-commit` 7/7), lo que sugiere no (aviso de ruteo 0/1, esta doctrina 7.4%).
La spec 0017 había dejado el hook router **fuera de alcance** con una condición escrita:
*"re-evaluar solo si el audit post-rollout muestra que el wrapper no se usa"*
(`design.md:217-219`). La condición se cumplió y por eso existe el guard. **Dejar la
condición escrita fue lo que permitió cambiar de opinión sin re-litigar.**

**2. El rollout confundió "tener el plugin" con "tener la capa".** `alertaciudadana_app`
(972 búsquedas) y `_backend` (523) tenían `tgrep-search.sh` en disco y seguían en **0.4% y
0.2%**, contra 20–28% de los repos con 0.8.5. Misma doctrina, mismo wrapper, misma config: la
única variable distinta era `guard-search-routing.sh`, que entró con 0.8.5 (#679) un día
después de que esos dos se quedaran en 0.8.4.

Y al ejecutar el rollout (#743) el inventario **volvió a corregir la premisa**, dos veces:

- **Ninguno de los dos tenía tgrep en su rama compartida.** El `tgrep-search.sh` que midió
  esas 1,495 búsquedas vivía solo en **commits locales sin pushear**. La medición era válida
  (las sesiones corrieron contra ese árbol), pero la rama que todos ven nunca lo tuvo.
- **Por lo tanto la palanca no era `render --apply` a secas.** El guard lo distribuye el
  **plugin**, no el core: con tgrep ausente de `navori.config.json`, `render --apply` sube la
  versión **sin escribir el guard**. La palanca es `navori add tgrep` **y** render — las dos.
  (Verificado con preview en los dos repos; comentario de cierre de #743, 2026-09-13.)

Eso dejó cría en el CLI: `packages/cli/src/lib/distribution.ts:8-18` y la señal de
`packages/cli/src/lib/audit/signals.ts:763-779` existen porque *"un repo se auditó dos semanas
sobre '1,495 búsquedas con tgrep al 0.3%' mientras su harness vivía en 55 archivos staged sin
commitear y una rama sin contraparte remota. Todos los checks existentes estuvieron verdes
todo el tiempo, porque todos comparan el disco contra algo que también vive en esa máquina."*

**3. Medir con un instrumento que no ve las vías de escape.** §5.4. La métrica se puso verde
mientras el hábito migraba.

**4. El eval E2 nunca tuvo datos.** El escenario "fallback visible, tgrep ausente" quedó sin
correr: las dos máquinas medidas tenían tgrep (`evals.md:17`). El fallback solo está cubierto
por tests.

---

## 7. Decisiones de diseño, con su razón y su test

| Decisión | Razón (medida) | Anclaje |
|---|---|---|
| **Reindex antes de cada búsqueda**, no daemon | índice stale = falso negativo silencioso (H3); reindex 0.07s (H5); `tgrep serve` es TCP JSON-RPC **sin auth** y con bind sin documentar (H10) | `tgrep-search-script.test.ts:147,156` |
| **El fallback vive en el wrapper**, no en doctrina condicional | `SessionStart` no llega a subagentes; un `if` en bash es infalible, "si tgrep está activo…" en prosa depende de atención | `tgrep-search-script.test.ts:233,263`; `plugins.ts:86-90` |
| **Cache fuera del repo** | el default de tgrep es `.tgrep/` dentro del árbol y el schema de plugins no sabe escribir `.gitignore` | `tgrep-search-script.test.ts:172` (`git status --porcelain` vacío tras correr) |
| **Clave de cache = hash de la raíz** | rutas con espacios (`Dev - Docs/…`) | todo el fixture usa `repo con espacio/` |
| **Invocación canónica relativa** | la regla `allow` es un literal con prefijo; `$CLAUDE_PROJECT_DIR` no existe en el shell del agente | `render-tgrep-plugin.test.ts:96`; `guard-search-routing.test.ts:206` |
| **Allowlist de flags, no denylist** | `--pre` no era el único (`--hostname-bin`); un denylist debe acertarle a cada flag futuro | `tgrep-search-script.test.ts:340-419` |
| **Rechazo = exit 2** | un 1 se lee como "no match" y produce el falso negativo que todo esto previene | `tgrep-search-script.test.ts:297` |
| **El guard falla ABIERTO** (heredoc, >20k, no parseable) | redirige una búsqueda, no protege contra pérdida de datos: el trade-off es el **opuesto** al de `guard-destructive`, a propósito | `guard-search-routing.test.ts:135,139,158` |
| **Nunca bloquear pipe ni extracción** | 46% + 22% de las invocaciones; un bloqueo falso enseña a rodear el guard | `guard-search-routing.test.ts:101-133,223,250` |
| **`git grep` redirigido salvo dot-path** | es la migración de mínima fricción (9.6×), pero `--hidden` degrada a brute-force y ahí `git grep` es correcto | `guard-search-routing.test.ts:289-320` |
| **Doctrina en skill (on-demand), no en el bloque always-on** | el cap de `tgrep-rung` subió a 550 palabras a cambio de sacar ~300 del always-on: se cambia costo **por sesión** por costo **por uso** | `skills/tgrep-rung.md:5-10`; `skill-caps-composed.test.ts` |
| **Dos reglas `allow` y ni una más** | nada de `rg`/`grep` directo: el fallback corre **dentro** del proceso ya autorizado | `render-tgrep-plugin.test.ts:96` |
| **`SessionStart` como evento de plugin** | R7: el enum Zod era la única compuerta; `pluginHooksToClaudeShape` ya era genérica | `plugins.test.ts`, `plugin-gate-hooks.test.ts` (`// Covers: R7`) |
| **codegraph no gana hook propio** | su watcher + catch-up ya mantienen el grafo fresco; la sinergia es de **ruteo**, no de infraestructura | `design.md:180-182` |

**Descartado explícitamente en v1** (`design.md:102-108, 211-226`): `tgrep serve` / watch mode;
un wrapper MCP sobre su JSON-RPC (la jugada estructural grande: familia `mcp__tgrep__*` sin
Bash, bloqueada hasta que exista un `serve` seguro); allow-listear `rg`/`grep` directos;
retención del cache; paridad codex (codex **ignora** los hooks de plugin —
`build-config-toml.ts` cablea los suyos —, así que nada de esto le llegaba).

**Un hallazgo transversal que sobrevive al borrado**: la spec midió que tgrep se activó (13 y
24 usos en dos sesiones reales) mientras **codegraph seguía en cero** en las mismas sesiones,
mismo repo, mismo modelo. La diferencia no era doctrina sino **fricción**: el wrapper es un
comando Bash con regla `allow`, la vía que el agente ya usaba; codegraph exigía descubrir,
cargar y cambiar de familia de herramienta. De ahí salió el experimento `alwaysLoad`
(`evals.md:74-100`): con `"alwaysLoad": true` en la entrada **stdio** del `.mcp.json`, las
tools diferidas de la sesión bajaron de 68 a 67 y `codegraph_explore` arrancó cargado. La doc
oficial de Claude Code documenta `alwaysLoad` solo para http/sse/ws: **está incompleta, no en
contra**.

---

## 8. Lo que hacía falta y nunca se hizo

1. **El embudo pre-registrado de la Fase 1 nunca se calculó.** Era el criterio **primario**
   (`progress/current.md:108-114`) y no había minero que lo produjera —
   `mine-search-routing.py` solo reporta la columna `blq`. Specs posteriores (0023, 0025)
   construyeron su embudo propio calcado de esa idea, pero el de tgrep quedó sin correr. §5.5
   lo calcula por primera vez, en 15 líneas de Python sobre logs que ya existían.
2. **E2 (fallback sin tgrep) sin datos de campo.** Falta una máquina sin el binario.
3. **`flag-doctrine.test.ts` no existe.** `tgrep-search.sh:42` afirma que ese archivo lee la
   prosa de la rung y falla si derivan. El test **sí** existe, pero vive en
   `tgrep-search-script.test.ts:409`. Es deriva de comentario, clase #647 (doctrina que afirma
   algo falso), en el propio archivo que esa clase de bug creó.
4. **Retención del cache.** `design.md:220-221` lo descartó con *"índices de 6M por repo;
   irrelevante hoy"*. Hoy: **325M en 21 índices**, uno de **115M**. Sigue siendo barato, pero
   el supuesto ya no es el que se escribió.
5. **`tgrep serve` y el wrapper MCP.** El diseño v1 no dejó deuda (el wrapper es el único
   punto a cambiar), pero nunca se leyó el bind address en el fuente de tgrep, que era la
   condición para reabrirlo.
6. **Paridad codex.** Nada de esto llegaba al adapter codex.
7. **Rollout de `alertaciudadana`.** PR #254 de `_app` quedó **abierto y sin veredicto de
   `reviewer`**; `_backend` quedó con 55 archivos staged sin commitear y **sin PR**. Con
   riesgo registrado: los dos tienen commits de harness sin pushear que quedan **superados**
   por ese trabajo — si se pushean después, el 0.8.4 pisa al 0.8.6. Hay que descartarlos, no
   rebasarlos.

---

## 9. Si se reimplementa: el orden que importa

1. **El wrapper primero, con el gate de flags desde la línea uno.** Una regla `allow` sobre un
   script que reenvía `"$@"` a ripgrep es ejecución arbitraria sin prompt. El gate va **antes**
   del dispatch de motor.
2. **El contrato de exit codes escrito en los tres lugares** (script, doctrina, mensaje del
   guard) y con un test que pinche el 2. La deriva entre prosa y script es el bug recurrente
   de este repo.
3. **Reindex por búsqueda**, índice fuera del árbol, clave hasheada.
4. **El guard después, no antes**, y con su banco de pruebas tomado de comandos **reales**:
   la lista de lo que deja pasar vale más que la de lo que bloquea.
5. **El minero, con el denominador correcto, ANTES de tocar conducta.** Sin `--desde/--hasta`
   no hay antes/después honesto; sin separar filtros y extracciones no hay techo alcanzable;
   sin contar las vías de escape (`git grep`, `indir`) la métrica se pone verde en falso.
6. **El criterio de éxito pre-registrado y escrito antes de ver datos**, embudo incluido — y
   el embudo con un script que lo calcule, no con una intención.
7. **Al hacer rollout, verificar la rama compartida, no el disco.** `navori add <plugin>` +
   `render --apply` + `git diff --stat origin/<base> -- .claude CLAUDE.md navori.config.json`.

---

## Correcciones al encargo

Cuatro cifras del brief no coinciden con lo que el repo registra ni con lo que se puede
re-medir hoy. El dato manda, así que quedan así:

1. **6.6% → 40.7%, no 44.4%.** El número documentado es 40.7% (#742, `mine-search-routing.py:79`,
   `progress/history.md:1739`), y el desglose es navori-harness 15.7→**58.1**, navori-health
   17.5→**53.3**, moonar 26.2→**35.5**. Las variantes del brief (44.4 / 49.4 / 35.3) **no
   aparecen** en el repo, ni en issues, ni en PRs, ni en el store de audit; probablemente
   vengan de una corrida intermedia entre el 09-12 y hoy. Re-corrido hoy con el mismo
   instrumento: **36.4%** total, harness 55.8%, moonar 33.3% (§5.2). El "antes" (6.6%) es
   idéntico en las tres corridas.
2. **`website` no es un repo y su "antes" no es 0%.** Es un worktree de navori-harness
   (`cwd = .claude/worktrees/graph-v2/apps/website`) etiquetado como repo fantasma por el bug
   #764 —`repo=$(basename "$cwd")`—, arreglado en #792. Su 26.7% es real; su "antes" es
   **ausencia de sesiones**, que no es lo mismo que 0% de adopción. La distinción importa:
   este repo ya se quemó dos veces confundiendo configuración con adopción.
3. **"5 de 58 sesiones → 8 de 8" y "7 → 46 bloqueos" no se pudieron verificar.** No están en el
   repo, ni en issues/PRs, ni se reproducen desde `~/.navori/audits`. Lo que sí se mide hoy es
   §5.6: **0 de 49 → 29 de 37 sesiones**, con **61 bloqueos** registrados en el store (58 con
   `tsMs`). El "7" coincide exactamente con los bloqueos de la ventana 2026-09-11→09-12, que
   quizá sea su origen.
4. **La palanca de `alertaciudadana` no era `render --apply` en vez de `navori add tgrep`:
   eran las dos.** El comentario de cierre de #743 (2026-09-13) verificó que ninguno de los dos
   repos tenía tgrep en su rama compartida, y que con el plugin ausente de la config el render
   sube la versión **sin escribir el guard**. La premisa de fondo (el wrapper solo compra ~0%,
   el guard es lo que mueve la aguja) queda intacta; el comando era incompleto. §6.

Y dos cifras que el brief daba bien, con matiz: la línea base **7.4%** sobre 2,761 búsquedas
es correcta, y convive con un **6.4%** calculado sobre otra muestra (las 8,562 invocaciones,
`mine-search-routing.py:22`) y con el **6.6%** que da excluir el día en que entró el guard —
son tres ventanas, no tres verdades. El **9.6×** de `git grep` es correcto (0.85% → 8.20%,
23 contra 35 llamadas en una ventana 6.3× más chica) y, además, **ya cerró**: cero `git grep`
en los repos con guard después de #739 (§5.4).
