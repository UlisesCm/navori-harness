## Complejidad cognitiva (SonarJS)

Antes de aprobar un cambio, verificar que las funciones tocadas no exceden el umbral de complejidad cognitiva.

- Threshold por default: `cognitive-complexity: ["error", 15]` (ESLint SonarJS).
- Si una función excede el umbral: **refactorizar antes de aprobar** (extraer funciones, simplificar condicionales, dividir responsabilidades).
- Casos válidos donde se relaja: state machines explícitas, parsers, switch/case sobre un enum cerrado. Documentar con `// cognitive-complexity-allowed: <razón>` antes del bloque.

Gate local: navori instala `check-cognitive.sh` + un toolchain aislado en `.claude/scripts/cognitive-tool/` (eslint + sonarjs, fuera del `package.json` y el eslint config del repo). Bootstrap una sola vez: `(cd .claude/scripts/cognitive-tool && bun install)`. El hook corre el scan sobre el diff vs la branch base en cada `git commit`/`git push`; si el toolchain no está bootstrapeado, se salta en silencio (el gate es opt-in).
