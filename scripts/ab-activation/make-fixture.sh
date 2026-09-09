#!/usr/bin/env bash
# Fixture del A/B de activación (H4: `auto` vs `acceptEdits`).
#
# Genera un repo pequeño donde la tarea cruza el umbral R2 de la propia escalera
# de navori sin ambigüedad: hay que LEER 5 archivos para entender el flujo
# (regla de 4 archivos) y CAMBIAR 5 (umbral de escritura de gentle-ai). Si el
# orquestador no delega aquí, no es porque la tarea no lo amerite.
#
# Uso:  bash make-fixture.sh <destino>
set -euo pipefail
DEST="${1:?uso: make-fixture.sh <destino>}"
rm -rf "$DEST"; mkdir -p "$DEST/src/__tests__"
cd "$DEST"

cat > package.json <<'JSON'
{
  "name": "ab-fixture",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "lint": "tsc --noEmit"
  },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
JSON

cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022", "module": "ESNext", "moduleResolution": "bundler",
    "strict": true, "noEmit": true, "types": [], "skipLibCheck": true,
    "allowImportingTsExtensions": true
  },
  "include": ["src"]
}
JSON

# --- el tipo compartido: el epicentro del cambio
cat > src/types.ts <<'TS'
/** Canonical user shape shared by every consumer in this package. */
export interface User {
  id: string;
  name: string;
}

export function makeUser(id: string, name: string): User {
  return { id, name };
}
TS

# --- cuatro consumidores, cada uno construye o proyecta un User
cat > src/greeter.ts <<'TS'
import type { User } from "./types.ts";

export function greet(user: User): string {
  return `Hola, ${user.name}`;
}
TS

cat > src/serializer.ts <<'TS'
import type { User } from "./types.ts";

export function serialize(user: User): string {
  return JSON.stringify({ id: user.id, name: user.name });
}
TS

cat > src/registry.ts <<'TS'
import { makeUser } from "./types.ts";
import type { User } from "./types.ts";

const users = new Map<string, User>();

export function register(id: string, name: string): User {
  const user = makeUser(id, name);
  users.set(id, user);
  return user;
}

export function find(id: string): User | undefined {
  return users.get(id);
}
TS

cat > src/report.ts <<'TS'
import type { User } from "./types.ts";
import { serialize } from "./serializer.ts";

export function report(users: User[]): string {
  return users.map((u) => `${u.id}\t${u.name}\t${serialize(u)}`).join("\n");
}
TS

cat > src/__tests__/user.test.ts <<'TS'
import { describe, it, expect } from "vitest";
import { makeUser } from "../types.ts";
import { greet } from "../greeter.ts";
import { serialize } from "../serializer.ts";
import { register, find } from "../registry.ts";
import { report } from "../report.ts";

describe("user pipeline", () => {
  it("builds, greets and serializes", () => {
    const u = makeUser("1", "Ana");
    expect(greet(u)).toBe("Hola, Ana");
    expect(JSON.parse(serialize(u))).toEqual({ id: "1", name: "Ana" });
  });

  it("registers and finds", () => {
    register("2", "Beto");
    expect(find("2")?.name).toBe("Beto");
  });

  it("reports every user on its own line", () => {
    expect(report([makeUser("3", "Cira")]).split("\n")).toHaveLength(1);
  });
});
TS

cat > navori.config.json <<'JSON'
{
  "$schema": "https://navori.dev/schema/navori.config.v1.json",
  "name": "ab-fixture",
  "engines": ["claude"],
  "preset": "custom",
  "language": "es",
  "branchBase": "main",
  "commits": "es",
  "qualityGate": { "fast": "npm run typecheck", "full": "npm run typecheck && npm run test" },
  "plugins": {}
}
JSON

git init -q . && git add -A && git -c user.email=ab@fixture -c user.name=ab commit -qm "fixture inicial"
echo "fixture listo en $DEST"
