# Borrador del release 0.13.0: pasos e (bump) y f (docs)

> BORRADOR SIN EJECUTAR (rama wip/release-0.13-bump-docs, 20 nov 2026). No se mergea. Al
> ejecutar, cada paso va en su propio commit sobre `dev` después del corte (T10) y este archivo se
> elimina. Pasos a–g del plan: #1527 (issuecomment-7027107162).

## Bloqueos antes de ejecutar

1. **Q24 de 0062: cómo se publican los binarios.** Decisión de Ulises (20 nov 11:25): intenta
   crear la org `navori` en npm y se queda el esquema actual, `@navori/<os>-<cpu>` como
   `optionalDependencies` de `navori`, sin cambiar código. Plan B si el nombre está tomado: ver
   "Plan B de Q24" abajo.
2. **legacy.json**: 0.12.5 NO pasa la prueba rápida de Ulises (20 nov). Con 0.12.5 como legacy,
   `workspace render --apply` quita el bloque `navori:native-runtime` de 8 hooks, vuelve el texto a
   "Spanish MX" y borra el `enabledPlugins` del render nativo; `doctor --json` informa 11 renders
   pendientes en un proyecto al día. Alternativas y detalle en
   decisiones-ulises/2026-11-20-legacy-json. Decisión pendiente.
3. **claudePlugins**: no hay 0.12.6; sale en 0.13 (Ulises, 20 nov 11:25).
4. **Paso f′**: integrar main en dev (merge commit, #1705 y #1748) y luego dev en migration/rust,
   antes del PR dev → main.

## Paso e: bump a 0.13.0

Un solo commit `chore(release): navori v0.13.0` sobre `dev`, después del corte:

| Archivo | Cambio | Nota |
|---|---|---|
| `packages/cli/package.json` | `0.12.5` → `0.13.0` | El TS congelado del repo; `release-tag.yml` crea el tag al llegar a main. |
| `Cargo.toml` (`[workspace.package]`) | `0.13.0-rust.1` → `0.13.0` | `workspaceVersion()` de `dist-assemble.mjs` toma de aquí la versión de `navori` y de los paquetes de plataforma. |
| `Cargo.lock` | `cargo update --workspace` (con `--locked`, el build falla hasta actualizarlo) | Solo cambian las versiones de los crates del workspace. |
| `packaging/legacy.json` | según la decisión pendiente | 0.12.5 descartado por la prueba rápida; ver decisiones-ulises/2026-11-20-legacy-json. |
| `crates/navori-cli/src/notices.rs` | `ENABLED: bool = false` → `true` | T11/R85. **Va en este PR del bump, no en el del corte** (Ulises, 20 nov 11:25). |
| `navori.config.json` (`harnessVersion`) y `.claude/settings.json` (`$navori.version`) | los escribe el render | No editar a mano. |

Comandos, en este orden (los mismos de README § Releases, adaptados al binario):

```bash
# 1. versión y lock
cargo update --workspace
# 2. re-render obligatorio: STAMP_VERSION sale de packages/cli/package.json (navori-core lib.rs)
bun run --filter navori build && node packages/cli/dist/index.js render --apply
#    (tras el corte: cargo build --release -p navori-cli && target/release/navori-rust render --apply)
# 3. goldens que dependen de la versión
#    packages/cli/src/__tests__/fixtures/cli-surface.golden.json (en 0.12.5 cambió 62 líneas)
#    imágenes og de apps/website/public (og*.svg y og*.png llevan la versión)
# 4. verificación
navori gate full
bun run cutover:check && bun run check:post-cutover && cargo test --workspace --locked
node scripts/js/dist-assemble.mjs --out /tmp/navori-0.13 --pack --binary linux-x64=target/release/navori-rust
```

Puntos a revisar al ejecutar:

- `STAMP_VERSION` (`crates/navori-core/src/lib.rs:10`) es la versión del TS del checkout. Tras el
  corte el TS del repo queda congelado en 0.13.0, así que los marcadores seguirán estampando la
  versión de `packages/cli/package.json`. Confirmar que eso sigue siendo lo buscado o si pasa a
  `VERSION` (decisión de diseño, no del bump).
- Que `navori --version` del binario responda `0.13.0`: el `postinstall` compara la versión del
  paquete con la del binario y, si no coinciden, deja los bins JS (`packaging/npm/lib/install.js`).

## Paso f: docs

### `apps/website/src/content/releases.ts`: entrada 0.13

`landing-inventory.test.ts` falla si la minor actual del CLI no tiene entrada. Borrador para
redactar con Ulises (la línea principal es suya):

```ts
{
  minor: "0.13",
  date: "<fecha del tag v0.13.0>",
  headline: {
    es: "navori es un binario nativo",
    en: "navori is a native binary",
    "zh-CN": "navori 现为原生二进制程序",
  },
  bullets: [
    {
      es: "La CLI es un binario Rust para macOS (arm64 y x64) y Linux (arm64 y x64, estático con musl), con los mismos comandos y la misma salida que el TS. En otras plataformas, el paquete instala el último TS publicado, verificado con su integrity.",
      en: "The CLI is a Rust binary for macOS (arm64 and x64) and Linux (arm64 and x64, statically linked with musl), with the same commands and the same output as the TS one. On other platforms the package installs the last published TS, verified against its integrity.",
      "zh-CN": "CLI 现为 Rust 二进制程序，支持 macOS（arm64 与 x64）和 Linux（arm64 与 x64，使用 musl 静态链接），命令与输出与 TS 版本一致。其他平台会安装最后发布的 TS 版本，并校验其 integrity。",
    },
    {
      es: "Los hooks de Claude Code y Pi corren nativos, con los mismos veredictos que los scripts de shell, comprobados con replay y siete días de sombra.",
      en: "Claude Code and Pi hooks run natively, with the same verdicts as the shell scripts, checked by replay and seven days of shadow runs.",
      "zh-CN": "Claude Code 与 Pi 的钩子以原生方式运行，裁决与 shell 脚本一致，已通过回放和七天影子运行验证。",
    },
    {
      es: "master, audit, codex, workspace, ticket y registry siguen en el TS congelado, que viaja dentro del paquete; no necesitas instalar nada aparte.",
      en: "master, audit, codex, workspace, ticket and registry stay on the frozen TS, which ships inside the package; there is nothing else to install.",
      "zh-CN": "master、audit、codex、workspace、ticket 与 registry 仍由冻结的 TS 版本处理，它随包一起发布，无需另行安装。",
    },
    {
      es: "claudePlugins en navori.config.json declara los plugins de Claude Code y el render escribe enabledPlugins en .claude/settings.json (#1747).",
      en: "claudePlugins in navori.config.json declares Claude Code plugins, and render writes enabledPlugins into .claude/settings.json (#1747).",
      "zh-CN": "navori.config.json 中的 claudePlugins 用于声明 Claude Code 插件，render 会将 enabledPlugins 写入 .claude/settings.json（#1747）。",
    },
  ],
},
```

Pendiente de confirmar al redactar: la lista exacta de delegación permanente
(`scripts/js/rust-areas.mjs` en el árbol del corte), el texto de #1717/#1727 (auditoría con
escritores concurrentes, en la memoria release-0.13-plan) y #1718 (plazo de du en doctor).

### `README.md`, `README.es.md`, `README.zh-CN.md`

- **§ Releases (T11, R21, R22):** los pasos 2, 3 y 8 cambian con el binario:
  - paso 2: subir `packages/cli/package.json` **y** `[workspace.package]` de `Cargo.toml`;
  - paso 3: el re-render se hace con el binario (`target/release/navori-rust render --apply`);
  - paso 8: `npm publish` ya no sale de `packages/cli`. Se publican los paquetes que arma
    `dist-assemble.mjs` desde los artefactos de `rust-release.yml` (`npm-packages/*.tgz`): primero
    los cuatro de plataforma, después `navori`. Depende de Q24.
  - Nuevo: `packaging/legacy.json` fija el TS de respaldo y de la delegación permanente; se
    actualiza solo con una decisión explícita.
- **§ Development:** build con `cargo build`, toolchain de `rust-toolchain.toml`,
  `bun run rust:hooks-sync` para las cabeceras de los hooks nativos; `packages/cli/src` deja de ser
  la fuente de la CLI.
- **§ Monorepo structure:** `crates/` (navori-cli, navori-core, navori-hooks) y `packaging/`.
- **§ Migrating to 0.12** → agregar "Migrating to 0.13": nada que hacer en el repo; tras
  `npm i -g navori@0.13`, `navori --version` debe decir 0.13.0; en plataformas sin binario responde
  el TS.

### `CONTRIBUTING.md`, `CONTRIBUTING.es.md`, `CONTRIBUTING.zh-CN.md`

- Build y pruebas con cargo (`cargo test --workspace --locked`, clippy, fmt) además de bun.
- Cambios en hooks: `crates/navori-hooks` es la fuente; los espejos y `crates/ported.json` se
  regeneran con `rust:hooks-sync` (procedimiento #247 y skill rebase-rerender).
- `packages/cli/src` congelado: solo las suites de artefacto.

### `docs/architecture.md`, `.es.md`, `.zh-CN.md`

- CLI en Rust; el TS congelado (`legacy/`) solo para la delegación permanente y las plataformas sin
  binario.
- Hooks nativos con firma (`navori:native-hook`) y su relación con los scripts de shell.

### Specs

- 0062: marcar T10, T11 y A4 con su evidencia.
- 0060: ya cerrada para 0.13 (T23, A8) en #1756; revisar T29.
- 0057–0061: estado final en sus `tasks.md` (correr `navori spec check <spec>` antes de commitear).

## Plan B de Q24: paquetes sin scope

Solo si la org `navori` está tomada. Los paquetes de plataforma pasan de `@navori/<os>-<cpu>` a
`navori-<os>-<cpu>` (`navori-darwin-arm64`, `navori-darwin-x64`, `navori-linux-arm64`,
`navori-linux-x64`). Archivos que cambian:

- `scripts/js/dist-assemble.mjs`: `SCOPE` (:32) y los nombres que arma (:101 `optionalDependencies`,
  :110 `name` del paquete de plataforma); el directorio de salida ya es `navori-<platform>` (:143).
- `packaging/npm/lib/launcher.js:23`: el paquete que resuelve el lanzador (`@navori/${key}` →
  `navori-${key}`).
- `packages/cli/src/__tests__/dist-launcher.test.ts`: los nombres esperados.
- `.github/workflows/rust-release.yml`: el nombre del paso de ensamblado (:78) y las sondas R84 si
  nombran el paquete.
- Docs: el comentario de cabecera de `dist-assemble.mjs` (:16), `specs/0062-rust-activacion-corte`
  (D53 en `design.md` y T6/T7 en `tasks.md`) y la sección de instalación del README.
- Antes de publicar: comprobar con `npm view navori-<os>-<cpu>` que los 4 nombres estén libres.

## Paso g

PR dev → main con merge commit; notas "Qué cambia al actualizar" en el cuerpo, incluyendo #1705 y
#1748 (decisión de Ulises, 20 nov). Tag con `release-tag.yml` y publicación: Ulises.

Publicación, en este orden:

1. Publicar los 4 paquetes de binarios (`@navori/<os>-<cpu>`, o `navori-<os>-<cpu>` con el plan B).
2. **Verificar que existan antes de publicar el principal** (Ulises, 20 nov 11:25):

   ```bash
   for p in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do
     npm view "@navori/$p@0.13.0" version || { echo "falta @navori/$p"; exit 1; }
   done
   ```

   Si falta alguno, no se publica `navori`: esa plataforma quedaría sin binario.
3. Publicar `navori@0.13.0` y comprobar `npm view navori version`.
