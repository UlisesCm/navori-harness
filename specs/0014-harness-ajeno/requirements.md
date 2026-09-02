# Harness ajeno que choca con navori — Requirements

## Context

Mucha gente tiene un harness propio antes de que navori llegue: agentes y skills en
`~/.claude` (scope personal), un `.claude/` hecho a mano en el repo —a menudo gitignored—,
o plugins de terceros. navori hoy no dice nada de esa convivencia, y ahí es donde se
pierden cosas: cuando dos assets comparten nombre, uno gana por precedencia y el otro
queda **inerte y en silencio**.

Caso verificado en la máquina del autor (2026-09-01): `~/.claude/skills/verify-before-done.md`
(personal, archivo plano) y `.claude/skills/verify-before-done/SKILL.md` (de navori, con
marcador managed) coexisten. La precedencia de skills es *enterprise > personal > project*,
así que **gana la personal** y la de navori —user-section incluida— no corre nunca. Nada
lo reporta.

El dato base ya existe y nadie lo muestra: `detectClaudeInfra` (`lib/claude-infra.ts`)
inventaría el harness ajeno del repo, pero solo lo consume `init`. Y #547 shippeó una
rebanada finita —agente del repo sin marcador que ensombrece al del plugin global—: un
solo tipo de asset, una sola dirección, solo contra el scope global.

Público: quien corre `navori doctor` en un repo donde ya vivía otro harness.

## Requirements (EARS)

### Qué cuenta como conflicto

- **R1** — El sistema SHALL reportar como conflicto un nombre de asset (agente o skill)
  que exista a la vez en el inventario managed de navori y en un scope ajeno: el repo sin
  marcador managed, `~/.claude`, o un plugin que no sea el de navori.
- **R2** — IF un asset ajeno convive con navori sin compartir nombre con ningún asset
  managed, THEN el sistema SHALL NOT mencionarlo — ni en `doctor`, ni en `status`, ni en
  el JSON de ninguno de los dos.
- **R3** — El sistema SHALL reportar como conflicto una regla de permiso que navori
  declara `deny` en `.claude/settings.json` y que un scope ajeno (`settings.local.json`
  del repo o `~/.claude/settings.json`) declara `allow`, nombrando la regla y el archivo
  ajeno que la contradice.

### Qué dice el aviso

- **R4** — WHEN el sistema reporta una colisión de nombre, SHALL nombrar cuál de los dos
  assets gana por precedencia, con la ruta de cada uno.
- **R5** — El sistema SHALL resolver la precedencia por tipo de asset: para agentes, el
  del repo gana al de `~/.claude` y ambos ganan al de un plugin; para skills, la de
  `~/.claude` gana a la del repo. Una skill de plugin SHALL NOT reportarse como colisión
  de nombre, porque se invoca con namespace (`/<plugin>:<skill>`).
- **R6** — WHEN el asset ajeno que gana vive en el repo y está fuera de control de
  versiones, el aviso SHALL declararlo, para que quede claro que el resto del equipo corre
  un harness distinto.
- **R7** — El aviso SHALL incluir, por cada conflicto, la acción que lo cierra: adoptarlo
  bajo gestión de navori cuando el archivo vive en el repo, o declararlo asumido cuando
  vive fuera de él.

### Silenciar sin borrar

- **R8** — WHEN `project.foreignHarness.acknowledged` de `navori.config.json` lista el
  identificador de un conflicto, el sistema SHALL dejar de reportarlo.
- **R9** — IF una entrada de `acknowledged` ya no corresponde a ningún conflicto
  detectado, THEN el sistema SHALL reportarla como obsoleta y nombrarla, para que la lista
  solo pueda encoger.
- **R10** — El identificador de un conflicto SHALL ser estable entre corridas y derivarse
  del tipo de asset, el scope ajeno y el nombre, sin depender de rutas absolutas ni del
  orden de detección.

### Adoptar un archivo hecho a mano

- **R11** — WHEN se invoca la adopción de un asset del repo, el sistema SHALL escribir el
  contenido existente dentro de un bloque managed de navori, conservando ese contenido
  byte a byte.
- **R12** — El sistema SHALL previsualizar la adopción por default y SHALL escribir a
  disco solo con `--apply`.
- **R13** — WHEN la adopción escribe a disco, el sistema SHALL crear antes un backup de
  cada archivo que va a modificar, y SHALL reportar la ruta del backup.
- **R14** — IF el archivo a adoptar ya carga un marcador managed, o vive fuera del repo,
  THEN el sistema SHALL rechazar la adopción nombrando la causa, y SHALL NOT escribir nada.
- **R15** — La adopción SHALL ser idempotente: adoptar dos veces el mismo archivo deja el
  mismo contenido y la segunda corrida no reporta cambios.

### Cómo no volverse ruido

- **R16** — IF no hay ningún conflicto, THEN `doctor` SHALL NOT imprimir la sección de
  harness ajeno, ni siquiera vacía.
- **R17** — La detección SHALL ser de solo lectura y SHALL NOT alterar el veredicto de
  `doctor` ni su código de salida.
