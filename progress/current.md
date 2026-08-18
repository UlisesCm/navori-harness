# Sesión actual

**Estado:** idle. Todo lo trabajado el 2026-08-18 está mergeado en `main`
(`0c01763`). No hay nada en vuelo ni branches abiertas.

## Qué se cerró hoy

**Mañana — los 6 issues abiertos** (#322 a #327), en 3 PRs mergeados:

- **#328** — el índice de skills lee la `description` de las project-local.
- **#329** — doctor: higiene de git (`specs/` ignorado con SDD activo, efímeros sin
  ignorar) + drift de config contra el workspace y contra la moda de los hermanos.
- **#330** — 27 lib-skills con user-section, `cypress`, split de `socketio`,
  `drizzle-orm`/`react-navigation`/`i18next`, `jest` reescrita sin el leak de Medusa.

**Tarde — la capa de solutioning** (spec 0012), en 2 PRs mergeados:

- **#332** (fase 0) — `ticket-audit` emite veredicto (`proceed` /
  `proceed-differently` / `split` / `doesn't apply` / `blocked`), separa el problema
  del ticket de su solución propuesta, y mide el tamaño con el comando que lo prueba.
- **#339** — skill `solution-design` + routing R2-architectural (117 palabras
  always-on) + challenge en contexto fresco vía `researcher` + cableado completo.

## Pendientes (ninguno bloqueante)

1. **[#340](https://github.com/UlisesCm/navori-harness/issues/340)** — `render --all`
   aborta el batch entero ante un config corrupto (`readConfigOrExit` hace
   `process.exit` dentro de un `try/catch` que no puede atraparlo). **Conviene
   arreglarlo ANTES del rollout**: es justo la operación que rompe.
2. **Release + rollout** a los repos registrados (per-repo, NUNCA `--all`).
   Nota heredada: los repos con `socket.io-client` necesitan `navori update` además
   de `render` para migrar `socketio` → `socketio-client`.
3. **[#331](https://github.com/UlisesCm/navori-harness/issues/331)** — `maestro` /
   detección por señales de filesystem (cambia el contrato de `detectLibrarySkills`).
4. **Evaluar `gitignoreHarness: "local"` en este repo.** Hoy está en `off` y el
   `.gitignore` se mantiene a mano; faltaba `.claude/progress/` pese a estar en el
   CUBO_A de navori, y 8 artefactos efímeros se colaron al índice (ya corregido).
   Activar la feature haría que el render gestione esas entradas — evaluar si
   duplica las que ya están escritas a mano.
5. **Heredado de ayer (repo externo bonum-webapp)**: publicar el comentario del
   PR #639 (borrador en `progress/pr639-comment-draft.md`), cerrar #640 y #559, y
   el rebind de SonarCloud (requiere admin).

## Para la próxima sesión que use la capa nueva

El ajuste de "un fork de producto no es automáticamente un blocker" se aplicó
sobre **una sola observación** (el eval E). Si al procesar tickets reales notas que
la capa deja pasar forks que sí merecían pararse, el umbral se subió de más y hay
que revisar esa regla en `solution-design`.

## Notas

- La ruta de los repos Bonum en el `~/.claude/CLAUDE.md` global sigue
  desactualizada: dice `/Users/ulisescm/Documents/dev/bonum/`, la real es
  `/Users/ulisescm/Documents/Dev - Docs/bonum/`.
- `~/.navori/registry.json` conserva una entrada de prueba apuntando a
  `.../scratchpad/inherit-test`.
- Gotchas útiles: el CLI de `dist/` bundlea los assets de plugins en build (probar
  un cambio de `plugin.json` exige `pnpm build` antes), y `render --apply` puede
  quedarse esperando input interactivo — con `--json` no.
