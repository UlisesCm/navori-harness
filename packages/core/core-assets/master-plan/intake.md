# Plantilla de context/INTAKE.md

Una tabla con una fila por archivo de `context/raw/` (R10, R11):

| Archivo | Método | Resultado |
|---|---|---|
| <archivo> | markitdown <x.y.z> | context/md/<archivo>.md |
| <archivo> | lectura nativa | context/md/<archivo>.md |
| <archivo> | exportado a PDF por el usuario | context/md/<archivo>.md |
| <archivo> | no convertido | <causa> |

Cada `context/md/<archivo>.md` referenciado empieza con:

> Fuente: context/raw/<archivo> · Método: <método>
