# Migración de navori a Rust — Requirements

**Estado:** borrador · **Fecha:** 2026-10-23 · **Base:** `migration/rust`, rama de larga vida
creada desde `dev`. Cada entrega abre su PR contra `migration/rust`; solo el corte llega a `dev`.

## Contexto

El gate full tarda entre 20 y 30 minutos (el último full registrado en 0055 duró 1 795 s) y cada hook
cuesta entre 10 y 160 ms por tool call en el uso real. La medición de 0055 atribuye la suite a
procesos, no a CPU: unos 6 000 procesos por corrida, con hooks bash/zsh (~22 %), fixtures git (~19 %)
y el CLI `dist/index.js` (~11 %, 114–128 ms de arranque en frío). El objetivo es un harness más veloz
y más robusto, y un ciclo de desarrollo más corto a largo plazo, aceptando el costo de la transición.

La migración es completa y gradual. Todo el trabajo Rust vive en la rama `migration/rust`, donde
`crates/` convive con `packages/`. Se prueba de forma local con un binario aparte (`navori-rust`) y
no se publica hasta el corte final. Mientras tanto, `dev`, producción y npm siguen saliendo solo del
build TS.

## Requirements (EARS)

### Dirección y convivencia

- **R1** — `docs/DIRECTION.md` SHALL retirar "Rust control plane" de sus no-metas y registrar la
  migración, la regla de convivencia y su porqué antes de que entre código Rust a `migration/rust`.
- **R2** — El repositorio SHALL contener un workspace cargo en `crates/` con toolchain fijado
  (`rust-toolchain.toml` con versión exacta) y `Cargo.lock` versionado.
- **R3** — El sistema SHALL permitir instalar `navori-rust` localmente con un solo comando
  documentado, sin modificar ni sombrear el `navori` instalado.
- **R4** — WHILE la migración no haya cerrado su corte, el paquete npm `navori` SHALL publicarse
  solo desde el build TS de `dev`, sin ningún artefacto Rust en su tarball ni en el flujo de release.
- **R25** — WHILE la migración esté abierta, `navori-rust --version` SHALL reportar la prerelease
  interna `0.13.0-rust.<n>` declarada en el `Cargo.toml` del workspace, que nunca se publica en npm.
- **R26** — `packages/cli` en `migration/rust` SHALL conservar la versión que trae `dev`, y el
  oráculo SHALL comparar `--version` contra la versión de `Cargo.toml` en lugar de exigir paridad
  con el TS.
- **R23** — WHILE la migración esté abierta, `migration/rust` SHALL incorporar `dev` al menos una vez
  por semana, de modo que el oráculo diferencial compare contra el TS vigente.

### Delegación incremental

- **R5** — WHEN `navori-rust` recibe un subcomando que no figura como portado, SHALL delegarlo al CLI
  TS con los mismos argumentos, stdin, entorno, directorio de trabajo y código de salida.
- **R6** — IF `navori-rust` no encuentra el CLI TS al delegar THEN SHALL salir con código distinto de
  cero y un mensaje que nombre el subcomando y las rutas buscadas, sin ejecutar nada más.
- **R7** — `navori-rust` SHALL ejecutar de forma nativa solo los subcomandos y hooks listados en un
  manifiesto versionado de portados.

### Oráculo diferencial

- **R8** — El sistema SHALL ofrecer un comando que ejecute `navori` y `navori-rust` sobre los mismos
  repos fixture y compare stdout, stderr, código de salida y el árbol de archivos resultante.
- **R9** — WHEN un subcomando se agrega al manifiesto de portados, el diferencial SHALL ser cero en
  todos sus fixtures, incluidos repos con contenido de usuario fuera de los markers.
- **R10** — WHEN un PR contra `migration/rust` (incluido el que incorpora `dev`) cambia el
  comportamiento TS de un subcomando ya portado, CI SHALL fallar si el diferencial de ese subcomando
  no es cero.

### Hooks

- **R11** — WHEN un hook se porta, su implementación Rust SHALL reproducir el exit code, stdout y
  stderr del hook shell en cada caso del corpus de veredictos, para Claude, Codex y Pi.
- **R12** — IF un hook Rust que decide si una acción procede falla (panic o error de E/S) THEN SHALL
  resolver en bloqueo o pregunta al usuario, nunca en permitir. Ante un payload ilegible, el
  veredicto SHALL ser el del hook shell (R11).
- **R13** — WHILE un hook portado no tenga binario disponible en la máquina, el harness renderizado
  SHALL seguir ejecutando su versión shell.

### Calidad y rendimiento

- **R15** — CI SHALL ejecutar `cargo fmt --check`, `cargo clippy` sin advertencias y `cargo test` en
  cada PR que toque `crates/`.
- **R16** — El código Rust de producción SHALL rechazar en clippy `unsafe`, `unwrap` y `expect`, salvo
  excepción con motivo escrito en el mismo sitio.
- **R17** — `navori-rust --version` SHALL tardar ≤ 10 ms en frío y la invocación del binario de cada
  hook portado, sin el wrapper shell del engine, SHALL tener un p95 ≤ 5 ms en `bench:hooks` con
  medición comparable.

## Fases del programa

Esta spec es la fase 1 del programa de migración: cimientos, runtime de hooks y los dos primeros
hooks (E1–E3). `design.md` describe el programa completo y las fases siguientes reutilizan sus
decisiones. Cada fase es una spec propia con ≤ 4 entregas, que declara sus requisitos EARS al
abrirse:

| Fase | Spec | Alcance | Requisitos que hereda de este programa |
|---|---|---|---|
| 1 | 0057 | Cimientos, runtime de hooks, `subagent-no-background` y `guard-destructive` en sombra | R1–R13, R15–R17, R23 |
| 2 | 0058 | Config, markers, render en preview y escrituras; activación de `guard-destructive` | Escrituras con preview, backup, fsync, markers y anti-rollback verificados con tests propios y el diferencial |
| 3 | 0059 | Ruta caliente de sesión, Codex, agents-md, cursor, copilot y Pi (incluido el refactor de la extensión en `dev`) | Garantías first-class de cada engine con las mismas pruebas de aceptación que en TS |
| 4 | 0060 | Cola larga, ensayo de distribución y corte | Gate full ≤ 5 min tras el corte; corte solo con manifiesto completo, metas cumplidas y aprobación explícita; binarios macOS y Linux; TS congelado en otras plataformas; integración a `dev` en un solo PR con el gate full verde |
