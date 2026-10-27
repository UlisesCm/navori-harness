> [English](skills-security-quality.md) | [Español](skills-security-quality.es.md) | [简体中文](skills-security-quality.zh-CN.md)

# Referencias de seguridad y calidad de las skills

Última revisión: 2026-10-12. Este documento registra la procedencia; no es una copia de una norma ni una autorización para instalar algo por defecto.

## Inventario cerrado de skills

| Conjunto de skills | Dependencia/versión admitida | Fuente oficial | Activador | Evidencia de validación |
|---|---|---|---|---|
| Core: `verify-before-done`, `debug-failure`, `review-diff`, `security-invariants`, `locate-code` | Recursos de Harness CLI 0.12.3; actualizar la fila en cada versión | https://github.com/ulisescm/navori-harness | Descripción de su frontmatter | Límites de recursos, roster y pruebas de renderizado |
| Flujo de trabajo: `resolve-ticket`, `solution-design`, `spec-bootstrap`, `dominio`, `follow-up-prs` | Recursos de Harness CLI 0.12.3; actualizar la fila en cada versión | https://github.com/ulisescm/navori-harness | Descripción de su frontmatter | Límites de recursos, roster y pruebas de renderizado |
| `zod-validation` | Zod 4.6.7 | https://zod.dev | Validación en límites de confianza | Paquete bloqueado y regresión de fragmento |
| `vitest` | Vitest 5.0.5 | https://vitest.dev | Pruebas de Vitest | Paquete bloqueado y regresión de fragmento |
| `citty` | Citty 0.2.2 | https://github.com/unjs/citty | Cambios de CLI con Citty | Regresión de declaraciones bloqueadas |
| `clack` | @clack/prompts 1.8.1 | https://clack.cc | Flujos interactivos de CLI | Paquete bloqueado y regresión de recursos |

La entrada anterior de la versión 0.8.7 es la línea base de auditoría. Esta tabla registra los recursos generados para la versión actual, no conserva la versión anterior como versión compatible.

## Evaluación de referencias externas y skills de proveedores

| Elemento | URL canónica y revisión inmutable | Términos / uso permitido | Permisos y privacidad | Responsable | Piloto reversible |
|---|---|---|---|---|---|
| OWASP ASVS | https://github.com/OWASP/ASVS/releases/tag/v5.0.0 — 5.0.0 | CC BY-SA 4.0; consultar los identificadores de controles seleccionados; no copiar listas de verificación | Sin acceso a herramientas; las normas son datos de referencia | Responsable de seguridad | Mapeo solo de fixtures; sin cambios al roster, config ni hooks |
| NIST SSDF | https://csrc.nist.gov/pubs/sp/800/218/final — SP 800-218 rev. 1.1 | Publicación pública de NIST; citar y resumir localmente | Sin acceso a herramientas | Responsable de seguridad | Mapeo solo de fixtures; sin cambios al roster, config ni hooks |
| SLSA | https://slsa.dev/spec/v1.1/ — v1.1 | CC BY 4.0; citar solo los niveles de procedencia | Sin acceso a herramientas | Responsable de seguridad | Mapeo solo de fixtures; sin cambios al roster, config ni hooks |
| ISO/IEC 25010 | https://www.iso.org/standard/78176.html — edición 2023 | Derechos de autor de ISO; usar solo como modelo de atributos; no reproducir texto ni tablas | Sin acceso a herramientas | Responsable de arquitectura | El fixture de la matriz usa únicamente criterios propios |
| OpenAI security-best-practices | https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-best-practices/SKILL.md — commit `49f948faa9258a0c61caceaf225e179651397431` | Aplican los términos del repositorio; evaluar antes de redistribuir | Revisión de fixture de solo lectura; no habilitar hooks ni herramientas | Responsable de seguridad | No está instalada; sin cambios al roster, config ni hooks; la reversión no requiere acciones |
| OpenAI security-threat-model | https://github.com/openai/skills/blob/49f948faa9258a0c61caceaf225e179651397431/skills/.curated/security-threat-model/SKILL.md — commit `49f948faa9258a0c61caceaf225e179651397431` | Aplican los términos del repositorio; evaluar antes de redistribuir | Revisión de fixture de solo lectura; no habilitar hooks ni herramientas | Responsable de seguridad | No está instalada; sin cambios al roster, config ni hooks; la reversión no requiere acciones |

Cualquier adopción futura requiere aprobación explícita, una revisión documentada de permisos y privacidad, un piloto acotado con criterios de salida y la eliminación de la skill o el plugin agregado si se revierte. El valor predeterminado sigue siendo las dos skills locales y ligeras.
