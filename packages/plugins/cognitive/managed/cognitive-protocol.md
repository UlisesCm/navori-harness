## Complejidad cognitiva (SonarJS)

Antes de aprobar un cambio, verificar que las funciones tocadas no exceden el umbral de complejidad cognitiva.

- Threshold por default: `cognitive-complexity: ["error", 15]` (ESLint SonarJS).
- Si una función excede el umbral: **refactorizar antes de aprobar** (extraer funciones, simplificar condicionales, dividir responsabilidades).
- Casos válidos donde se relaja: state machines explícitas, parsers, switch/case sobre un enum cerrado. Documentar con `// cognitive-complexity-allowed: <razón>` antes del bloque.

Tool externa no requerida — la regla corre dentro del lint del proyecto si está configurada. Si no, este protocolo es informativo y debe leerse en code review.
