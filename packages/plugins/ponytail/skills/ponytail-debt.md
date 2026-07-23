---
name: ponytail-debt
description: Cosecha cada comentario `ponytail:` del repo en un ledger de deuda, para rastrear los atajos y diferimientos deliberados en vez de dejar que se pudran en "después = nunca". Usar cuando el usuario pide "ponytail debt", "deuda ponytail", "qué difirió ponytail", "listar los atajos", "ledger de ponytail", o "qué marcamos para después". Reporte de una sola pasada, no cambia nada.
type: behavior
maxWords: 500
---

# Ponytail — ledger de deuda

Cada atajo deliberado de ponytail se marca con un comentario `ponytail:` que nombra su techo y su camino de upgrade. Este skill los junta en un solo ledger para que un diferimiento no se vuelva permanente en silencio.

## Escaneo

Buscar los marcadores en el repo, saltando `node_modules`, `.git` y output de build:

```
rg -n --glob '!node_modules' --glob '!.git' '(#|//|<!--) ?ponytail:'
```

(Agregar otros prefijos de comentario si el stack los usa: `--`, `;`, `%`.) Cada hit es una fila del ledger. Exigir el prefijo de comentario deja fuera la prosa que solo menciona la convención.

## Formato del reporte

Una fila por marcador, agrupadas por archivo:

```
<archivo>:<línea> — <qué se simplificó>. techo: <el límite nombrado>. upgrade: <el disparador para revisarlo>.
```

La convención es `ponytail: <techo>, <camino de upgrade>`, así que el techo y el disparador salen directo del comentario. Si se necesita un dueño por fila, agregar `git blame -L<línea>,<línea>`.

## Red flags

Todo comentario `ponytail:` que no nombra un camino de upgrade ni un disparador se etiqueta `sin-disparador`: esos son los que se pudren en silencio. Listarlos primero.

## Cierre

Terminar con `<N> marcadores, <M> sin disparador.` Si no hay nada: `Sin deuda ponytail. Ledger limpio.`

Solo lee y reporta; no cambia nada. Para persistirlo, preguntar y escribir el ledger a un archivo (ej. `PONYTAIL-DEBT.md`). "stop ponytail-debt" o "normal mode" para revertir.
