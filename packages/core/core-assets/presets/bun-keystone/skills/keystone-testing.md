---
name: keystone-testing
description: Testing de Keystone 6 con Vitest — hooks y access con context mockeado, endpoints GraphQL/REST con Supertest, factories. Aplica al escribir o revisar tests de models, access, hooks o API.
type: reference
---

# Keystone Testing — Vitest + Supertest

Dos niveles: **unit** (hooks/access/services con el `context` de Keystone mockeado, sin DB) e **integration/e2e** (API GraphQL/REST real con Supertest contra una instancia de Keystone y una DB de test). El unit es rápido y cubre la lógica; el integration cubre el contrato.

## Cuándo usar este skill

Al escribir tests para un hook, una función de `access/`, un service o un endpoint; al elegir el nivel (unit vs integration); o al depurar un test flaky de mocks.

## Unit — hooks y access con context mockeado

Los hooks y las funciones de access son funciones puras sobre `{ session, context, ... }`: se testean sin DB, mockeando el `context`.

```ts
// El mock de context expone sudo().db.<Model> y query; devuélvelo desde un helper reusable.
const context = makeMockContext({ session: adminSession });

it("validateInput rechaza truthState manual", async () => {
  await expect(
    Report.hooks.validateInput({ resolvedData: { truthState: "TRUE" }, operation: "create", context }),
  ).rejects.toThrow();
});

it("access.filter.query acota a los registros del dueño", () => {
  expect(reportAccess.filter.query({ session: userSession })).toEqual({
    author: { id: { equals: userSession.itemId } },
  });
});
```

Testea **cada capa de access por separado** (`operation`/`filter`/`field`) y **la sesión nula** (debe negar/filtrar, nunca abrir).

## Integration — API con Supertest

Levanta Keystone contra una DB de test y golpea el endpoint real (valida el contrato completo: access + hooks + resolvers).

```ts
const res = await request(app)
  .post("/api/graphql")
  .set("Cookie", authCookie)
  .send({ query: `mutation { createReport(data: {...}) { id } }` });
expect(res.status).toBe(200);
expect(res.body.errors).toBeUndefined();
```

La DB de test se levanta/migra/siembra antes y se derriba después (scripts `test:db:*` / `test:e2e`). Requiere Docker.

## Reglas duras

1. **Factories, no fixtures inline.** Centraliza la construcción de datos de test en factories (`test-factories`) y la sesión en helpers (`test-auth`); no repitas objetos `session`/`data` en cada archivo.
2. **Un mock de context reusable.** El mock de `context` (con `sudo().db`) vive en un helper compartido, no re-inventado por test.
3. **Access probado en las 3 capas + sesión nula.** Es el código más sensible; cada capa y el caso sin sesión tienen su test.
4. **Trazabilidad SDD.** En features SDD-scope, cada `R<n>` se cubre con ≥1 test que lo referencia en nombre o comentario `// Covers: R<n>`.
5. **No generar tests salvo que se pidan** (si el proyecto así lo define); cuando se piden, van al nivel correcto (unit para lógica, integration para contrato).

## Gotchas de Vitest (v4.x)

- **`vi.hoisted()`** para factories que usan variables externas dentro de `vi.mock` (el mock se hoistea sobre las declaraciones).
- **Mock-constructor con función regular, no arrow** (una arrow no es `new`-able).
- **`vi.clearAllMocks()` NO limpia implementaciones** (solo `mock.calls`); usa `vi.resetAllMocks()`/`restoreAllMocks()` cuando necesites resetear la implementación.

## Antes de declarar listo

- Los hooks/access nuevos o tocados tienen unit tests (incluida la sesión nula).
- Los datos de test salen de factories; el context sale del mock compartido.
- Si es SDD-scope, cada `R<n>` es trazable a un test.
- `{{qualityGate.fast}}` en verde (los tests con Docker corren con el gate completo).
