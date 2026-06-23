## Stack — NestJS

Backend modular con inyección de dependencias. Cada feature es un módulo (`*.module.ts`) que agrupa controllers + providers. Los controllers son delgados; la lógica vive en los services (providers).

Regla de oro: nada de lógica de negocio en los controllers — solo enrutan, validan vía DTOs (class-validator) en el boundary y delegan al service. Aplica `nestjs-modules` para estructura y `nestjs-dtos-validation` para el contrato de entrada.
