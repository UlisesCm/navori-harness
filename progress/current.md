# Current — idle

- Sin trabajo en curso. El PR #1110 (#1093, lib-skills de Python) queda abierto con CI verde,
  pendiente de merge.
- Siguiente paso propuesto: release 0.11.0 (#1100). Requiere la entrada 0.11 en
  `apps/website/src/content/releases.ts` antes del bump (paso 1 de `README.md` § Releases); el test
  `landing-inventory.test.ts` falla si el minor actual del CLI no tiene entrada.
- Mientras no salga 0.11.0, el `navori` global (0.10.1) hace que `plan-gate.sh` busque el workplan
  en `.claude/progress/`: copiarlo ahí (y al worktree en uso) antes de despachar un implementer.
