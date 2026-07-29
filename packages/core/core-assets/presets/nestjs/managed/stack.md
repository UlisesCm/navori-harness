## Stack — NestJS

Modular backend with dependency injection. Each feature is a module (`*.module.ts`) that groups controllers + providers. Controllers are thin; the logic lives in the services (providers).

Golden rule: no business logic in the controllers — they only route, validate via DTOs (class-validator) at the boundary and delegate to the service. Apply `nestjs-modules` for structure and `nestjs-dtos-validation` for the input contract.
