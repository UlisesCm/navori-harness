en curso — plan de proveedores externos, fase 1 cerrada, faltan 0.3/0.4, 1.4b, 1.5 y las fases 2-3

**Plan completo**: `/Users/ulisescm/.claude/plans/por-ahora-solo-el-lovely-badger.md` (fuera del
repo, no se inyecta solo — ábrelo con `Read`). Trae el contexto, los 16 hallazgos verificados con
su evidencia, y la investigación contra doc oficial. Este archivo es el estado; ese es el porqué.

**Decisiones que NO se re-litigan** (las tomó Ulises en este ciclo):
- **Respetar D04**: `--recommended` NO habilita tgrep/codegraph. Se ofrecen, no se auto-habilitan.
  Eso deja el eje `--recommended` vs `--full` como *"¿requiere instalar software externo?"*.
- **Setup antes que descubrimiento**: no se recomienda una herramienta cuyo modo degradado miente.
- Sin TTY, un `postInstall` interactivo **se salta con aviso** (no falla duro, no se añade un campo
  `interactive` por plugin).

## Avance

| Fase | Estado |
|---|---|
| 0.1 doctor detecta índice obsoleto de tgrep | ✅ #950 |
| 0.2 prosa de tgrep, tres estados | ✅ #952 |
| 0.3 doctor verifica capacidad (`.mcp.json` válido, versión del binario) | ❌ sin empezar, sin issue |
| 0.4 dientes del `--strict` | ❌ sin empezar, sin issue |
| 1.1 `postInstall` alcanzable | ✅ #958 |
| 1.2+1.3 verificar tras instalar + capturar stderr | ✅ #962 |
| 1.4a comando roto de `acli` (NXDOMAIN + tap) | ✅ #966 |
| 1.4b huecos de la matriz | ❌ **#965 abierto** |
| 1.5 hueco `add`→`render` | ❌ sin empezar, sin issue |
| 1.6 tests de la ruta de instalación | ✅ (en #958/#967) |
| — ejecutabilidad + guarda de TTY (deuda emergente) | ✅ #967 |
| Fase 2 descubrimiento | ❌ **nada** |
| Fase 3 diferenciación `--recommended`/`--full` | ❌ **nada** |

## Siguiente paso — elegir uno

**#965** (issue abierto, no hay que re-investigar). La matriz ya está verificada contra fuente
oficial dentro del issue:
- CON comando: `tgrep`/linux (`brew install tgrep`, bottles Linux confirmados), `semgrep`/win32
  (`pipx install semgrep`, beta por la propia doc), `engram`/win32 (`go install …`).
- SIN comando único, donde la respuesta correcta es una URL: `tgrep`/win32, `gh`/linux, `acli`/win32.
- Además: que `add` deje de cerrar en `ta.done` ("Listo") sin haber instalado nada (`add.ts`, rama
  `if (!installCmd)`); validar las claves de `install` contra las plataformas conocidas
  (`plugins.ts`, hoy `z.record(z.string(), z.string())` acepta `"macos"` y nunca matchea); y
  `currentPlatform()`, que mapea freebsd/openbsd/sunos a `win32`.
- **Decisión pendiente en el issue**: si el manifest admite `installDocs` (URL). El argumento en
  contra está escrito ahí — una URL se pudre sin que ningún test lo note, que es literalmente lo
  que pasó con el host de `acli`.

**1.5** (sin issue, el hueco más grande que queda). `navori add` no renderiza: `navori add
codegraph` deja `enabled: true` **sin `.mcp.json`, sin permiso y sin grant en los agentes** — las
tres capas que `mcp-capability-wiring.test.ts:14-21` documenta como obligatorias. Y `doctor` sale
`ok: true` porque con `readRenderedText` vacío `scanMissingInvariants` devuelve `[]`. Este ciclo
hizo a `add` honesto sobre el **binario**; sobre el **cableado** sigue mintiendo.

**Fase 2** (sin issues). Es donde vive lo que originó todo esto:
`apps/website/src/components/HeroTerminal.astro:8` promete que `--recommended` trae codegraph y
tgrep (falso); `README.md:195` dice que codegraph "se retiró" (revertido por #838); `add --suggest`
y `doctor` no nombran los plugins disponibles pero no habilitados (`doctor.ts:1537` corta con
`if (settings.enabled !== true) continue`); y el runbook de setup vive solo en
`docs/research/search-v2.md:337-340`, que no es user-facing.

## Deuda declarada

No existe **ningún** test que fije los comandos de instalación de los manifests, y uno que repita
el string sería tautológico. Es lo que dejó vivir un host NXDOMAIN en el repo sin que nadie se
enterara. Cubrirlo de forma no tautológica es parte de #965.

## Higiene

- Worktree `.claude/worktrees/issue-967` montado y limpio; su rama ya está mergeada, se puede
  retirar.
- Ramas `fix/943-doctor-index-freshness` y `test/946-tgrep-disk-mode-staleness`: redundantes (su
  contenido entró por #950/#951), esperando decisión de borrado.
- Relacionado, abierto por otro ciclo: **#954** (el guard de aislamiento de `~/.navori` no está
  scoped por worktree). Es el mecanismo que produjo un falso rojo durante #960 — entonces la causa
  real fue otra, pero el defecto existe.
