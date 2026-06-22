## Operaciones sobre datos e infraestructura

Read-only por default. Antes de mutar datos, esquema o infraestructura (DB, storage, deploys, recursos cloud), lee y propón; no mutes sin opt-in explícito del usuario para ESTA tarea.

- **DB / queries**: por default solo lectura (`SELECT`, `EXPLAIN`, flags tipo `onlyRead`). `INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE` requieren que el usuario lo pida de forma explícita.
- **Comandos de shell**: inspeccionar es libre (`ls`, `cat`, `git status/diff/log`). Los destructivos (`rm -rf`, `git reset --hard`, force-push, `chmod -R`) los manda el harness a `ask`/`deny` y un hook los bloquea — no intentes evadir esa capa.
- **Si una mutación destructiva es legítima y necesaria**: explica qué hace y por qué, y deja que el usuario la confirme o la corra. Nunca la disfraces con variables, subshells o `--no-verify` para saltarte el gate.
- **Datos sensibles**: no vuelques secretos, PII ni dumps completos a logs, chat o archivos del repo.
