## Aterrizaje en repos (check del harness)

Al empezar a trabajar sobre un repo, verifica el estado del harness ANTES de la tarea:

1. Sin `navori.config.json` → sugiere correr `navori init --recommended` (no lo corras sin confirmación del usuario).
2. Config presente pero `engines` no incluye `claude` → advierte que el harness no carga en sesiones de Claude Code y sugiere agregar el engine y correr `navori render --apply`.
3. Harness renderizado pero desactualizado (`navori doctor` reporta drift) → sugiere `navori sync --apply`.
4. El repo está DEBAJO del cwd de la sesión → los agentes, skills y hooks del repo NO cargan (Claude Code solo los descubre del cwd hacia arriba). Recomienda abrir una sesión anclada en el repo antes de trabajo no trivial.

La orquestación completa (agentes, gates, skills de pipeline) vive dentro del repo renderizado; esta capa global es identidad y aterrizaje, no maquinaria.
