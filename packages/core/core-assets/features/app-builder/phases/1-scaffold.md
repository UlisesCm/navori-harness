---
name: app-builder-1-scaffold
description: "Usar en la fase 1 de app-builder. Levanta el monorepo, la app Expo/RN booteando en device, el kit de primitivos en components/ui/* y el contrato de tokens de dos capas."
type: reference
---

# Fase 1 — Scaffold

## Objetivo

Un monorepo con la app Expo/React Native booteando en el device del usuario, el kit de primitivos de UI instalado y el contrato de tokens de dos capas scaffoldeado con valores neutros de Capa 1 (estructura).

## Protocolo

1. **Un solo monorepo.** Layout: `apps/mobile` (Expo/RN), `packages/*` para dominio compartido, config de backend en la raiz. El scaffold es parte de la feature, no un prerequisito.
2. **Package manager: npm, no pnpm.** El layout de symlinks aislados de pnpm rompe la resolucion de Metro.
3. **Kit de primitivos via el CLI de react-native-reusables.** Copia (owned, editable) en `components/ui/*`: Button, Input, Card, Text, mas composites propios ListRow, Chip/Badge, ScreenHeader, LoadingState, EmptyState. Nunca importes primitivos de un paquete en runtime.
4. **Contrato de tokens de dos capas en `lib/theme.ts`.** Capa 1 (estructura, ahora) con valores neutros: alturas de control, escala de radios, escala de espaciado, anchos de borde, slots de escala tipografica. Sin decisiones de color: eso es Capa 2 en la fase 5.
5. **Valida con `expo export`**, no solo `tsc`: tsc no ejercita la config de babel/metro.

## Skills

- `expo-runtime` (navori, preset react-native-expo) — runtime de Expo, expo-sqlite, gotchas de Metro.
- `turbo-workspaces` (navori, preset monorepo) — layout de workspaces del monorepo.
- `typescript`, `ponytail` (externas) — la `doctor` avisara si no estan bundleadas.

## Como verificar el gate

- La app bootea en el device real del usuario.
- Los primitivos existen en `components/ui/*` y cada uno consume tokens de `lib/theme.ts` — cero dimensiones inline.
- Sin lockfile ajeno (`pnpm-lock.yaml`, `yarn.lock`): su presencia es fallo de gate automatico.

## Artifacts

- `apps/mobile` scaffold, `components/ui/*`, `lib/theme.ts` (tokens Capa 1).
- Engram: `app/{app}/phase-1`.

## Modelo

`haiku`, effort bajo: trabajo mecanico de scaffold.
