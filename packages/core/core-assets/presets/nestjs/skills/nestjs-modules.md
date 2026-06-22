---
name: nestjs-modules
description: Reglas para módulos NestJS — controllers, services, providers, DI scopes. Aplica al crear o modificar src/<feature>/.
type: reference
---

# NestJS Modules — convenciones del proyecto

## Cuándo usar este skill

Antes de crear un nuevo feature module, agregar provider, exponer endpoints o tocar la grafa de dependencias. El modelo de módulos + DI es lo que mantiene la app testeable; saltarse el patrón rompe los unit tests rápidos.

## Estructura mínima de un feature module

```
src/<feature>/
├── <feature>.module.ts       # @Module decorator: imports, providers, controllers, exports
├── <feature>.controller.ts   # HTTP layer — recibe DTOs, llama service, devuelve DTOs
├── <feature>.service.ts      # Lógica — orquesta repos/clients
├── dto/
│   ├── create-<x>.dto.ts
│   └── update-<x>.dto.ts
├── entities/                 # Si usas ORM (TypeORM/Mongoose schemas)
│   └── <x>.entity.ts
└── __tests__/
    ├── <feature>.controller.spec.ts
    └── <feature>.service.spec.ts
```

## Reglas duras

1. **Un módulo expone solo lo que otros consumen.** El `exports: []` del `@Module` declara explícitamente qué providers son públicos. Si no está exportado, otro módulo NO debería importarlo (rompe encapsulación).
2. **Inyección por constructor, no por propiedad.** `constructor(private readonly users: UsersService) {}`. Property injection (`@Inject() users: UsersService`) es para casos raros (circular deps, factory tokens). Si lo necesitas, es señal de que el módulo debería estar dividido.
3. **Default scope es singleton.** Solo usa `@Injectable({ scope: Scope.REQUEST })` cuando el provider necesite contexto por-request (current user, request-scoped cache). Cada provider request-scoped fuerza a sus consumidores a serlo también — propaga rápido.
4. **Controllers NO tienen lógica.** Reciben DTO, llaman service, devuelven response DTO. Toda transformación, validación de negocio o coordinación va en el service.
5. **Imports vs providers.** `imports` para módulos completos (`TypeOrmModule.forFeature([User])`); `providers` para clases del propio módulo. Confundir los dos es bug común.

## Tabla rápida

| Necesito | Dónde |
|---|---|
| Endpoint HTTP nuevo | `<feature>.controller.ts` + DTO de entrada/salida |
| Lógica de negocio | `<feature>.service.ts` |
| Llamar otra feature | Import el módulo de la otra; resuelve su service exportado por DI |
| Connection a DB | `TypeOrmModule.forFeature(...)` en `imports` del módulo |
| Validación de DTO | `class-validator` decorators en el DTO + `ValidationPipe` global |
| Cross-cutting (logging, auth) | Interceptor / Guard / Pipe en `app.module.ts` global |
| Provider con dependencia async | `useFactory` en `providers: [{ provide, useFactory, inject }]` |

## Antes de declarar el cambio "listo"

- `{{qualityGate.fast}}` en verde.
- Si agregaste un módulo: aparece en `app.module.ts` (imports) o como sub-import de otro módulo declarado.
- Si exportaste un provider: documenta por qué. Solo se exporta lo que otros van a consumir desde fuera.
- Si tocaste DI scopes: confirma que el cambio no convirtió un provider singleton en request-scoped por accidente (busca cascada).
- Spec del controller llama al service mockeado (no a la implementación real).
