# Retirar la capa global (`navori global`) — Requirements

**Fecha:** 2026-10-08 · **Estado:** borrador para aprobación.
**Evidencia:** reconocimiento de la huella de `navori global` (Spec 0010) sobre `dev` @ `ca13b11b`.

## Contexto

`navori global` (Spec 0010) instala un piso por máquina en `~/.claude` (plugin
`~/.claude/skills/navori/`, hook `SessionStart` del baseline, permisos propios en
`settings.json`, manifest `~/.navori/global.json`) y un LaunchAgent del collector de audit
(`global collect`). Nunca se adoptó, y su costo es de unos 5.5–6k LOC entre src, tests, docs
y web, además de ramas de render (`fallbackScope`, `globalSafe`) que el harness de repo carga sin usarlas.

## Alcance y decisiones

**Decisiones del usuario (2026-10-08):**

- **Se retira todo `navori global`**, incluido `global collect`: el LaunchAgent
  `com.navori.audit-collect` y su supervisión en `doctor` salen junto con el resto.
- **Sin comando de migración.** Para quien ya instaló la capa, `doctor` detecta los restos y da
  los pasos de limpieza manual. navori no escribe ni borra nada en `~/.claude` ni en
  `~/LaunchAgents`.
- **La Spec 0010 se marca como superseded** por esta spec y se conserva como historia.
  `docs/DIRECTION.md` se reescribe para retirar la capa global como meta.

## Requirements (EARS)

- **R1** — El CLI SHALL NOT registrar el subcomando `global` ni ninguno de sus hijos (`init`,
  `render`, `doctor`, `uninstall`, `collect`).
- **R2** — El paquete publicado SHALL NOT contener los módulos de la capa global:
  `commands/global.ts`, `commands/global-prompts.ts`, `lib/config/global-config.ts`,
  `engines/claude/global-render.ts`, `engines/claude/global-plugin.ts`,
  `lib/workspace/global-scope.ts` y `lib/audit/launchd.ts`.
- **R3** — WHEN `audit`, `backup`, `migrations` o `registry` resuelven el idioma, el sistema
  SHALL resolverlo sin leer `~/.navori/global.json`.
- **R4** — WHEN `doctor` diagnostica un harness ajeno (Spec 0014), el sistema SHALL producir los
  mismos hallazgos que hoy para una máquina sin capa global instalada.
- **R5** — El render de repo SHALL producir un output idéntico byte a byte al de antes del
  retiro, para todos los engines, una vez retirados el campo `globalSafe` y la plomería
  `fallbackScope`.
- **R6** — WHEN `doctor` corre y existe al menos uno de estos restos: `~/.navori/global.json`,
  `~/.claude/skills/navori/`, `~/.claude/hooks/navori-global-baseline.sh` o el plist
  `com.navori.audit-collect` en `~/Library/LaunchAgents/`, el sistema SHALL reportar un warning
  que liste los restos encontrados y los pasos manuales para quitarlos.
- **R7** — WHILE `doctor` reporta restos de la capa global, el sistema SHALL NOT escribir,
  mover ni borrar ningún archivo fuera del repo.
- **R8** — IF no existe ninguno de los restos de R6 THEN `doctor` SHALL NOT emitir hallazgo
  alguno sobre la capa global.
- **R9** — La documentación pública (READMEs, `apps/website`, `llms.txt`, inventario de
  comandos) SHALL NOT documentar `navori global` como comando disponible.
- **R10** — `docs/DIRECTION.md` SHALL NOT declarar la capa global como meta ni como invariante,
  y `specs/0010-global-harness` SHALL declararse superseded por esta spec.
