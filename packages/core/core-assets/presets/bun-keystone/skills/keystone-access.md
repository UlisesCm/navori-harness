---
name: keystone-access
description: Access control de Keystone 6 en 3 capas (operation / filter / field). allowAll prohibido; sesión nula → filtro restrictivo. Aplica al definir o cambiar el access de cualquier list.
type: reference
---

# Keystone Access Control — 3 capas

## Cuándo usar este skill

Siempre que definas o modifiques el `access` de una list. Una línea mal puesta aquí es una fuga de datos o un bloqueo total — es el código más sensible del backend. Léelo completo antes de tocar `access`.

## Las 3 capas

```ts
access: {
  operation: { query, create, update, delete }, // ¿puede el usuario ejecutar la operación?
  filter:    { query, update, delete },          // ¿sobre QUÉ registros? (devuelve un where)
  field:     { fieldName: { read, create, update } }, // ¿puede leer/escribir ESTE campo?
}
```

1. **`operation`** — gate booleano por operación. Devuelve `true`/`false` según la sesión. Es el "¿tiene permiso de intentarlo?".
2. **`filter`** — devuelve un `where` de Prisma que acota el conjunto de registros visibles/afectables. Es el "¿sobre cuáles?". Ej.: un usuario solo ve/edita sus propios registros → `{ author: { id: { equals: session.itemId } } }`.
3. **`field`** — control fino por campo (ocultar un campo sensible en lectura, impedir escribir un campo calculado).

Las tres se combinan: `operation` decide si la request entra, `filter` acota el set, `field` recorta columnas.

## Reglas duras

1. **`allowAll` está prohibido.** Nunca `access: allowAll`. Todo list declara reglas explícitas por operación. Si algo "es público", exprésalo con una función que retorna `true` acotada, no con `allowAll`.
2. **Sesión nula → restrictivo, no abierto.** Cuando no hay sesión, el default es negar (o un `filter` que no matchee nada), nunca abrir. Empieza cerrando y abre lo justo.
3. **`filter` devuelve un where, no un booleano.** Si necesitas negar todo en una capa `filter`, devuelve un where imposible (`{ id: { equals: null } }`), no `false`.
4. **La lógica de access va en `access/`, no inline.** Extrae funciones reutilizables (`isSignedIn`, `isOwner`, `isAdmin`) a archivos de `access/` y compón; no dupliques la misma condición inline en varias lists.
5. **Access ≠ validación de negocio.** Access decide quién ve/toca qué; las reglas de negocio (un valor válido, un estado permitido) van en `validateInput` (ver `keystone-models`).

## Tabla rápida

| Quiero | Capa | Forma |
|---|---|---|
| Bloquear crear a no-admins | `operation.create` | `({ session }) => isAdmin(session)` |
| Que cada quien vea lo suyo | `filter.query` | `({ session }) => ({ owner: { id: { equals: session?.itemId } } })` |
| Ocultar un campo sensible | `field.<campo>.read` | `({ session }) => isAdmin(session)` |
| Impedir editar un campo calculado | `field.<campo>.update` | `() => false` |

## Antes de declarar el cambio "listo"

- `{{qualityGate.fast}}` en verde.
- `grep -rn "allowAll" access/ models/` → 0 resultados.
- Toda list tocada declara las 3 capas donde apliquen; ninguna operación quedó implícitamente abierta.
- Sesión nula probada: la list niega o filtra, nunca expone todo.
- Las condiciones nuevas se extrajeron a `access/` si se repiten en más de una list.
