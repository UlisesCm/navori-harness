---
name: nestjs-modules
description: Use when creating or modifying src/<feature>/ in NestJS — rules for modules: controllers, services, providers, DI scopes.
type: reference
---

# NestJS Modules — project conventions

## When to use this skill

Before creating a new feature module, adding a provider, exposing endpoints, or touching the dependency graph. The module + DI model is what keeps the app testable; skipping the pattern breaks the fast unit tests.

## Minimal structure of a feature module

```
src/<feature>/
├── <feature>.module.ts       # @Module decorator: imports, providers, controllers, exports
├── <feature>.controller.ts   # HTTP layer — receives DTOs, calls service, returns DTOs
├── <feature>.service.ts      # Logic — orchestrates repos/clients
├── dto/
│   ├── create-<x>.dto.ts
│   └── update-<x>.dto.ts
├── entities/                 # If you use an ORM (TypeORM/Mongoose schemas)
│   └── <x>.entity.ts
└── __tests__/
    ├── <feature>.controller.spec.ts
    └── <feature>.service.spec.ts
```

## Hard rules

1. **A module exposes only what others consume.** The `@Module`'s `exports: []` explicitly declares which providers are public. If it isn't exported, another module should NOT import it (breaks encapsulation).
2. **Constructor injection, not property injection.** `constructor(private readonly users: UsersService) {}`. Property injection (`@Inject() users: UsersService`) is for rare cases (circular deps, factory tokens). If you need it, it's a sign the module should be split.
3. **Default scope is singleton.** Only use `@Injectable({ scope: Scope.REQUEST })` when the provider needs per-request context (current user, request-scoped cache). Every request-scoped provider forces its consumers to be request-scoped too — it propagates fast.
4. **Controllers have NO logic.** They receive a DTO, call the service, return a response DTO. All transformation, business validation, or coordination goes in the service.
5. **Imports vs providers.** `imports` for whole modules (`TypeOrmModule.forFeature([User])`); `providers` for classes of the module itself. Confusing the two is a common bug.

## Quick table

| I need | Where |
|---|---|
| New HTTP endpoint | `<feature>.controller.ts` + input/output DTO |
| Business logic | `<feature>.service.ts` |
| Call another feature | Import the other module; resolve its exported service via DI |
| DB connection | `TypeOrmModule.forFeature(...)` in the module's `imports` |
| DTO validation | `class-validator` decorators on the DTO + global `ValidationPipe` |
| Cross-cutting (logging, auth) | Interceptor / Guard / Pipe global in `app.module.ts` |
| Provider with async dependency | `useFactory` in `providers: [{ provide, useFactory, inject }]` |

## Before calling the change "done"

- `{{qualityGate.fast}}` green.
- If you added a module: it appears in `app.module.ts` (imports) or as a sub-import of another declared module.
- If you exported a provider: document why. Only export what others will consume from outside.
- If you touched DI scopes: confirm the change didn't accidentally turn a singleton provider into a request-scoped one (look for a cascade).
- The controller spec calls the mocked service (not the real implementation).
