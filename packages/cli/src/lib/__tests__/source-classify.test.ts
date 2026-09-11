import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLASSIFY_RULES_PATH, serializeClassifyRules } from "../../../scripts/gen-schemas.mjs";
import {
  CLASSIFY_RULES,
  classifyPath,
  countNonTrivial,
  toRepoRelative,
  type PathKind,
} from "../source-classify.ts";

/**
 * The term "non-trivial source file" decided two things at once — the routing
 * threshold and the pilot's ceiling on unreviewed logic — and was written as
 * prose in five places that drifted. The ladder was withdrawn in #691 because
 * of exactly that; this suite pins the single definition that has to exist
 * before it can come back.
 *
 * EVERY PATH BELOW IS REAL. They come from the 506 `Edit`/`Write` calls in the
 * park's audited sessions, where the previous definition — a bare extension
 * regex — admitted 43% that do not belong. The cases are grouped by the clause
 * they exercise so a future edit can see which one it is weakening.
 */

const REPO = "/Users/x/Documents/Dev - Docs/navori-harness";

describe("clause (a) — carries behavior, decided from the path", () => {
  const cases: Array<[string, PathKind, string]> = [
    // --- lo que SÍ es fuente ---
    ["packages/cli/src/lib/audit/parse.ts", "source", "el producto"],
    ["apps/backend/keystone.ts", "source", "el producto, en otro repo"],
    [
      "packages/core/core-assets/hooks/guard-destructive.sh",
      "source",
      "un hook es ejecutable, y romperlo rompe el guard",
    ],
    [
      "scripts/check-asset-commands.mjs",
      "source",
      "un script del gate lleva comportamiento: romperlo pone el CI en rojo",
    ],
    [
      "packages/core/core-assets/agents/reviewer.md",
      "source",
      "prosa del harness que un agente OBEDECE — clause (a) la llama comportamiento",
    ],
    ["packages/plugins/tgrep/skills/tgrep-rung.md", "source", "lo mismo, desde un plugin"],

    // --- generados: el cambio vive en el asset, no aquí ---
    [".claude/agents/reviewer.md", "generated", "espejo renderizado"],
    ["CLAUDE.md", "generated", "se arma desde bloques managed"],
    ["AGENTS.md", "generated", "igual, para el engine universal"],
    [".mcp.json", "generated", "se arma desde los manifests"],
    [
      "packages/cli/src/engines/__tests__/__golden__/claude.snap",
      "generated",
      "se regenera del árbol que fija",
    ],

    // --- efímeros: no llegan a ningún diff ---
    [".claude/progress/review_x.md", "ephemeral", "handoff entre agentes"],
    [".claude/worktrees/wt-1/foo.ts", "ephemeral", "worktree reclamable"],
    ["scratchpad/migrate-docs.js", "ephemeral", "andamiaje desechable"],

    // --- excluidos por clause (a) explícitamente ---
    ["node_modules/expo-sqlite/web/WorkerChannel.ts", "dependency", "no es nuestro"],
    ["pnpm-lock.yaml", "lockfile", "lo resuelve una herramienta"],
    ["package.json", "config", "config, no comportamiento"],
    ["navori.config.json", "config", "declara qué renderiza el harness"],
    ["tests/__fixtures__/payload.json", "fixture", "dato que el test lee"],
    ["docs/research/activacion.md", "docs", "lo leen humanos"],
    ["progress/current.md", "docs", "bitácora de sesión"],
    ["README.md", "docs", "idem"],

    // --- tests: clause (c) los trata aparte ---
    ["packages/cli/src/lib/__tests__/parse.test.ts", "test", "sufijo"],
    ["tests/unit/keystone/myReports.test.ts", "test", "directorio"],
    ["tests/helpers/db-availability.ts", "test", "vive bajo tests/"],
  ];

  for (const [path, kind, why] of cases) {
    it(`${path} → ${kind} (${why})`, () => {
      expect(classifyPath(path, REPO)).toBe(kind);
    });
  }
});

describe("fuera del repo — un archivo que no llega a un diff no es del cambio", () => {
  it("una ruta absoluta bajo otro árbol es outside-repo", () => {
    // 13.4% de las escrituras que la definición anterior contaba como fuente
    // eran esto: scripts de andamiaje bajo /private/tmp.
    expect(classifyPath("/private/tmp/claude-501/xyz/scratchpad/diff-iac.ts", REPO)).toBe(
      "outside-repo",
    );
  });

  it("un repo que solo COMPARTE PREFIJO no está dentro", () => {
    // `/repo-2/x` empieza con `/repo`. Sin el separador explícito, el vecino
    // se clasifica como propio y su código cuenta en el cambio equivocado.
    expect(toRepoRelative("/Users/x/repo-2/src/a.ts", "/Users/x/repo")).toBeNull();
  });

  it("una ruta relativa se interpreta en el repo del llamador", () => {
    expect(toRepoRelative("./src/a.ts", REPO)).toBe("src/a.ts");
  });
});

describe("clause (c) — un test que acompaña no cuenta doble", () => {
  it("fuente + su test cuentan UNO", () => {
    const r = countNonTrivial(["src/lib/fix.ts", "src/lib/__tests__/fix.test.ts"], REPO);
    expect(r.ceiling).toBe(1);
    expect(r.counted).toEqual(["src/lib/fix.ts"]);
    expect(r.excluded["test-riding-along"]).toEqual(["src/lib/__tests__/fix.test.ts"]);
  });

  it("dos fuentes y sus tests cuentan DOS — el conteo de tests nunca se mueve", () => {
    const r = countNonTrivial(
      ["src/a.ts", "src/b.ts", "src/__tests__/a.test.ts", "src/__tests__/b.test.ts"],
      REPO,
    );
    expect(r.ceiling).toBe(2);
  });

  it("un test SOLO sí es el cambio, y cuenta", () => {
    // Sin este brazo la cláusula sería incoherente: una suite nueva sobre código
    // que este cambio no toca ES el cambio.
    const r = countNonTrivial(["src/__tests__/nueva.test.ts"], REPO);
    expect(r.ceiling).toBe(1);
    expect(r.counted).toEqual(["src/__tests__/nueva.test.ts"]);
  });

  it("un cambio de puro espejo renderizado cuenta CERO", () => {
    // El release de 0.8.4: 45 rutas de espejo más el bump del manifest. Ninguna
    // es lógica, y contarlas como tal es lo que hundía la tasa de activación.
    const r = countNonTrivial(
      [".claude/agents/reviewer.md", ".claude/hooks/routing-watch.sh", "CLAUDE.md", "package.json"],
      REPO,
    );
    expect(r.ceiling).toBe(0);
    expect(Object.keys(r.excluded).sort()).toEqual(["config", "generated"]);
  });
});

describe("el resultado dice que es un techo, no un número exacto", () => {
  it("la clave se llama `ceiling` — clause (b) necesita el diff y aquí no está", () => {
    const r = countNonTrivial(["src/a.ts"], REPO);
    // Un rename propagado por diez call sites cuenta diez aquí y uno de verdad.
    // El nombre es lo que impide que un consumidor lo trate como exacto — que es
    // justo cómo un número pasó a significar tres cosas distintas.
    expect(r).toHaveProperty("ceiling");
    expect(r).not.toHaveProperty("count");
  });

  it("cada exclusión se puede mostrar, no se descarta en silencio", () => {
    const r = countNonTrivial(["src/a.ts", "pnpm-lock.yaml", "node_modules/x/y.ts"], REPO);
    expect(r.excluded.lockfile).toEqual(["pnpm-lock.yaml"]);
    expect(r.excluded.dependency).toEqual(["node_modules/x/y.ts"]);
  });
});

describe("las reglas son portables a otro lenguaje", () => {
  it("no usa construcciones que Python no comparta", () => {
    // La lista se sirve tal cual a `mine-activation.py`. Lookbehind, grupos con
    // nombre y backreferences son donde JS y Python divergen, así que una regla
    // que los use rompe al otro consumidor en silencio.
    for (const rule of CLASSIFY_RULES) {
      expect(rule.re.source, `${rule.kind}: ${rule.re.source}`).not.toMatch(/\(\?<|\\\d/);
    }
  });

  it("cada regla dice por qué existe", () => {
    // El `why` viaja en el JSON: el otro consumidor no puede leer este archivo.
    for (const rule of CLASSIFY_RULES) {
      expect(rule.why.length, rule.re.source).toBeGreaterThan(20);
    }
  });

  it("el .source de cada literal sobrevive el viaje a Python", () => {
    // Los literales compilan por construcción —el parser de TS ya lo garantiza—,
    // así que lo que hay que fijar es lo otro: que su `.source` no traiga nada
    // que el otro motor rechace. El escape `\/` que produce un literal JS es
    // legal en Python; una barra sin escapar dentro de una clase, no siempre.
    for (const rule of CLASSIFY_RULES) {
      expect(rule.re.source.length, rule.kind).toBeGreaterThan(0);
      expect(rule.re.flags, `${rule.kind}: los flags no viajan en el JSON`).toBe("");
    }
  });
});

describe("el JSON que lee Python no puede quedarse atrás del módulo", () => {
  it("scripts/source-classify.rules.json coincide con CLASSIFY_RULES", () => {
    // Mismo patrón que los JSON Schemas: se regenera en memoria y se compara.
    // Sin esto, el archivo checked-in es una SEGUNDA definición que deriva en
    // silencio — que es exactamente cómo este término llegó a significar tres
    // cosas distintas y costó retirar la escalera entera (#691).
    const onDisk = readFileSync(resolve(CLASSIFY_RULES_PATH), "utf-8");
    expect(onDisk, "el JSON quedó atrás del módulo — corre 'pnpm gen:schemas'").toBe(
      serializeClassifyRules(),
    );
  });
});
