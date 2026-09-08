# Sesión actual

**Estado:** `main` en `fc4969f` (#602 mergeado), limpio. **npm sigue en 0.7.5** — los tags
`v0.7.6` (en git, nunca publicado) y el 0.7.7 pendiente esperan la decisión de mañana.
0 issues, 0 PRs en navori-harness.

## Segunda tanda de la jornada (después del cierre anterior, misma sesión `fa4dd30b`)

| Qué | Estado |
|---|---|
| #597 `navori audit --arm` (activación sin atención del modelo) | PR #598 mergeado → release 0.7.5 publicado |
| Rollout 0.7.5: 15/15 Bonum + PRs alertaciudadana | hecho; PRs #230 (develop), #297 (dev), #231 (qa) |
| #599 `--arm` aplica a la sesión CORRIENDO (siguiente mensaje) | PR #600 mergeado — feedback UX de Ulises |
| #601 doctrina "parquear en base" al cierre (`switch` + `pull --ff-only`, sin borrar ramas) | PR #602 mergeado |
| Release 0.7.6 | commiteado+taggeado pero NUNCA publicado a npm; `main` ya lo rebasó |

**bonum-dashboard**: harness protegido vía `.git/info/exclude` (el `.gitignore` es blanco
móvil entre sesiones paralelas — se reescribió 2 veces en un día). Sesión de BT-1447 de
Ulises corre en `fix/bt-1447-evaluators-selfeval-auto-mode` (brazo auto del A/B).

## MAÑANA — plan acordado con Ulises

1. **Revisar el audit de las sesiones de hoy** (Ulises está generando data con otros
   tasks): `navori audit --days 1` en los repos donde trabajó. Contexto: con las
   políticas nuevas de Claude, auto mode será probablemente el default — la paridad
   (spec 0016) pasa de optimización a requisito. Ulises reporta mejora notable con los
   últimos PRs.
2. **Release 0.7.7**: re-hacer el bump (el intento de hoy se descartó a propósito para
   no dejar `main` sucio; es re-ejecutable en minutos: bump → build → render → gate →
   commit → tag → push → deploy → dry-run → OTP de Ulises). Acumula 0.7.6 (arm en sesión
   corriendo) + #601 (parqueo en base). npm saltará 0.7.5 → 0.7.7.
3. Tras publicar: subir PRs #230/#297/#231 de alertaciudadana a 0.7.7 y rollout Bonum.
4. Si la data de L0 alcanza (brazos acceptEdits/default): **T2.1** y la re-auditoría §6.

## Deuda previa vigente
- CI de Navori-Technologies en rojo por BILLING de la org (no por contenido) — lo arregla
  Ulises en GitHub Billing & plans.
- `bonum-webapp` harness sin commitear; `.codex/` muerto en ai-coach; gitignores locales.
- `branchBase` de alertaciudadana_app: si la "casa" de Ulises ahí es `qa`, declararlo en
  su `navori.config.json` para que el parqueo (#601) lo respete.
