import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `mine-topic-keys.py` reads `~/.engram/engram.db` — a 644, world-readable file
 * that also holds the user's prompts in the clear. That is the one security
 * surface of #760, and the audit's mitigation is a column allow-list. A comment
 * saying "we don't read the body" decays the first time someone adds a field;
 * an assertion does not, so the restriction lives here as a test.
 *
 * Driven through `python3` rather than ported to TypeScript: the same choice
 * `mine-search-routing.test.ts` makes, and for the same reason — what has to be
 * correct is the script that actually runs, not a second copy of it.
 */

const MINER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "mine-topic-keys.py",
);

const hasPython = spawnSync("python3", ["--version"]).status === 0;

const PRELUDE = [
  "import importlib.util, json, sys",
  `spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(MINER)})`,
  "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
].join("\n");

/**
 * Run a snippet against the real module and parse its JSON.
 *
 * It THROWS on a non-zero exit or empty stdout instead of falling back to `{}`.
 * Without that, a syntax error in the miner turns every assertion below into a
 * comparison against an empty object — the suite stays green while the script
 * it guards is broken, which is the failure mode this file exists to prevent.
 */
function py(snippet: string, args: string[] = []): unknown {
  const r = spawnSync("python3", ["-c", `${PRELUDE}\n${snippet}`, ...args], { encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`python3 salió ${r.status}:\n${r.stderr}`);
  if (!r.stdout.trim()) throw new Error(`python3 no imprimió nada:\n${r.stderr}`);
  return JSON.parse(r.stdout) as unknown;
}

function classify(key: string, project = ""): string[] {
  return py("print(json.dumps(m.classify_key(sys.argv[1], sys.argv[2] or None)))", [
    key,
    project,
  ]) as string[];
}

type Row = Record<string, string | number | null>;

/** Build a throwaway engram-shaped DB and return its path. */
function makeDb(rows: Row[], opts: { softDelete?: boolean } = {}): string {
  const softDelete = opts.softDelete !== false;
  const path = join(mkdtempSync(join(tmpdir(), "navori-topickeys-")), "engram.db");
  // `title` and `content` are in the fixture ON PURPOSE: they are what the
  // miner must never select. Without them in the schema, a future `SELECT *`
  // would pass this suite.
  const ddl =
    "CREATE TABLE observations (id INTEGER PRIMARY KEY, topic_key TEXT, type TEXT, " +
    "revision_count INTEGER, project TEXT, created_at TEXT, title TEXT, content TEXT" +
    (softDelete ? ", deleted_at TEXT" : "") +
    ")";
  const r = spawnSync(
    "python3",
    [
      "-c",
      [
        "import json, sqlite3, sys",
        "path, ddl, rows = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])",
        "c = sqlite3.connect(path)",
        "c.execute(ddl)",
        "for row in rows:",
        "    cols = list(row)",
        "    c.execute('INSERT INTO observations (%s) VALUES (%s)' % (','.join(cols), ','.join('?' * len(cols))), [row[k] for k in cols])",
        "c.commit(); c.close()",
        "print('ok')",
      ].join("\n"),
      path,
      ddl,
      JSON.stringify(rows),
    ],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`no se pudo armar la DB de prueba:\n${r.stderr}`);
  return path;
}

/** The synthetic corpus. Every number asserted below is countable by hand. */
const SECRET = "PROMPT-DEL-USUARIO-QUE-NO-DEBE-SALIR";
const CORPUS: Row[] = [
  // clave, tipo, revisiones, proyecto, fecha, título, cuerpo, borrada
  row("area/uno", "decision", 3, "2026-09-01"),
  row("area/dos", "decision", 1, "2026-09-02"),
  row("sin-slash-clave", "manual", 1, "2026-09-03"),
  row("demo-tema", "manual", 1, "2026-09-04"),
  row("area/fechada-2026-09", "manual", 1, "2026-09-05"),
  row("área/acentuada", "manual", 1, "2026-06-01"),
  row(null, "session_summary", 1, "2026-09-06"),
  row("", "manual", 1, "2026-09-07"),
  // Borrada: 5 saves que NO deben contarse. Si el soft-delete se ignorara, el
  // reuso global saltaría de 20.0% a 40.0% y el salto sería visible.
  { ...row("area/borrada", "decision", 5, "2026-09-08"), deleted_at: "2026-09-09" },
];

function row(
  topic_key: string | null,
  type: string,
  revision_count: number,
  created_at: string,
): Row {
  return {
    topic_key,
    type,
    revision_count,
    project: "demo",
    created_at,
    title: `titulo ${created_at}`,
    content: SECRET,
  };
}

interface Bucket {
  filas: number;
  saves: number;
  evolucionados: number;
  reuso: number;
}
interface Summary {
  todas: Bucket;
  claveadas: Bucket;
  sin_clave: Bucket;
  pct_sin_clave: number;
  formas: Record<string, number>;
  irreusables: { topic_key: string; created_at: string; revision_count: number }[];
  irreusables_total: number;
  tipos_sin_clave: Record<string, number>;
}

function summarize(db: string, project?: string): Summary {
  return py(
    [
      "rows = m.load(sys.argv[1], [sys.argv[2]] if sys.argv[2] else [])",
      "res = m.summarize(rows)",
      "res['formas'] = dict(res['formas']); res['tipos_sin_clave'] = dict(res['tipos_sin_clave'])",
      "print(json.dumps(res))",
    ].join("\n"),
    [db, project ?? ""],
  ) as Summary;
}

/**
 * The `describe.runIf(hasPython)` below is the twin's convention
 * (`mine-search-routing.test.ts`), and locally it is the right one: a developer
 * without `python3` should not get a red suite over a script they cannot run.
 *
 * But this is the one file in the repo where that silent skip takes a SECURITY
 * assertion with it — a run without `python3` reports green while nothing
 * verified that the miner still refuses to read the user's prompts. This guard
 * lives OUTSIDE the block on purpose (an `it` inside a skipped `describe` skips
 * too) and only bites where the skip is not acceptable: GitHub Actions sets
 * `CI` on its own, the same signal `distribution.test.ts` relies on.
 */
it.runIf(Boolean(process.env.CI))(
  "en CI, `python3` tiene que estar: sin él nada verificó la restricción",
  () => {
    expect(hasPython).toBe(true);
  },
);

describe.runIf(hasPython)("mine-topic-keys — el minero de higiene de claves (#760)", () => {
  it("no lee el cuerpo de la observación ni la tabla de prompts", () => {
    // La restricción explícita de #760, como aserción y no como comentario.
    const src = readFileSync(MINER, "utf-8");

    // Anti-vacuidad PRIMERO: sin esto, un path mal armado o un archivo vacío
    // haría pasar las tres negaciones de abajo sin haber leído nada.
    expect(src.length).toBeGreaterThan(2000);
    expect(src).toContain("observations");
    expect(src).toContain("topic_key");
    expect(src).toContain("revision_count");

    expect(src).not.toContain("user_prompts");
    expect(src).not.toContain("content");
    expect(src).not.toContain("title");

    // Y la lista de permitidas, leída del módulo real: agregar una columna
    // rompe aquí, que es donde un revisor la ve.
    expect(py("print(json.dumps({'t': m.TABLE, 'c': list(m.COLUMNS)}))")).toEqual({
      t: "observations",
      c: ["topic_key", "type", "revision_count", "project", "created_at"],
    });

    // Ninguna otra tabla en ningún FROM/JOIN del archivo. Sin la bandera `i`, a
    // propósito: el SQL del minero va en mayúsculas y el `from` de un import de
    // Python no es un FROM de SQL.
    const tablas = [...src.matchAll(/\b(?:FROM|JOIN)\s+(\S+)/g)].map((m) => m[1]);
    expect(tablas.length).toBeGreaterThan(0);
    expect([...new Set(tablas)]).toEqual(["{TABLE}"]);
  });

  it("abre la DB read-only de verdad: un INSERT rebota", () => {
    // `sqlite3.connect(path)` sobre un archivo escribible da una conexión que
    // PUEDE escribir. Que el script no emita un INSERT es una propiedad del
    // código; la URI `mode=ro` lo vuelve una propiedad del canal — y esta es la
    // única forma de probar que la URI quedó bien armada y no ignorada.
    const db = makeDb(CORPUS);
    const verdict = py(
      [
        "conn = m.open_readonly(sys.argv[1])",
        "try:",
        "    conn.execute(\"INSERT INTO observations (topic_key) VALUES ('x')\")",
        "    print(json.dumps('escribio'))",
        "except Exception as e:",
        "    print(json.dumps(type(e).__name__))",
      ].join("\n"),
      [db],
    );
    expect(verdict).toBe("OperationalError");
  });

  it("no devuelve el cuerpo aunque esté en la tabla", () => {
    // La aserción textual caza un `SELECT` nuevo; ésta caza un `SELECT *`.
    const db = makeDb(CORPUS);
    const rows = py("print(json.dumps(m.load(sys.argv[1])))", [db]) as Row[];
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(Object.keys(rows[0] ?? {})).toEqual([
      "topic_key",
      "type",
      "revision_count",
      "project",
      "created_at",
    ]);
  });

  describe("clasificador de forma de clave", () => {
    it("reconoce la forma documentada `<area>/<slug>`", () => {
      expect(classify("engram/topic-key-dedup")).toEqual(["area-slug"]);
    });

    it("marca off-convention la clave sin slash", () => {
      // 146 de 236 claves vivas del repo están así, y es el hueco que
      // `engram-protocol.md` deja: pide una clave estable y nunca dice qué forma tiene.
      expect(classify("navori-harness-sesion-issues")).toEqual(["sin-slash"]);
    });

    it("marca irreusable la clave con `YYYY-MM` embebido", () => {
      // Irreusable por construcción: `…-2026-09` no puede evolucionar en octubre
      // aunque el agente busque perfecto. Y las dos mitades "duplicadas" que
      // #728 P3 cita son de esta forma.
      expect(classify("navori-audit-hallazgos-2026-09")).toEqual(["sin-slash", "fechada"]);
      // Las etiquetas NO son excluyentes: esta clave del repo es las dos cosas.
      expect(classify("navori/audit-reprocesos-2026-08")).toEqual(["area-slug", "fechada"]);
    });

    it("marca el no-ASCII, que el slugificador del upstream no puede reproducir", () => {
      // `mem_suggest_topic_key` devuelve `auditor-a` para `Auditoría`, así que
      // una clave escrita a mano con acentos es irrecuperable por esa vía: quien
      // la busque nunca la va a acuñar igual. Hoy son 0 en todo el corpus — es
      // un tripwire, y un cero medido también es un resultado.
      expect(classify("auditoría/ruteo")).toEqual(["area-slug", "no-ascii"]);
    });

    it("detecta el prefijo de proyecto por segmento, no por `startswith`", () => {
      // La columna `project` ya lleva el proyecto; repetirlo en la clave es ruido
      // (114 de 236 claves del repo lo hacen). Pero `startswith` pelado contaría
      // `navorificar-x` como prefijada, y eso es otra palabra.
      expect(classify("navori-audit-hallazgos", "navori-harness")).toEqual([
        "sin-slash",
        "prefijo-proyecto",
      ]);
      expect(classify("navori/audit", "navori-harness")).toEqual(["area-slug", "prefijo-proyecto"]);
      expect(classify("navorificar-x", "navori-harness")).toEqual(["sin-slash"]);
      expect(classify("engram/dedup", "navori-harness")).toEqual(["area-slug"]);
    });

    it("no clasifica lo que no es clave", () => {
      expect(classify("")).toEqual([]);
      expect(classify("   ")).toEqual([]);
    });
  });

  describe("tasas sobre un corpus sintético", () => {
    it("reparte los saves entre las tres poblaciones", () => {
      const res = summarize(makeDb(CORPUS));

      // 8 filas vivas, 10 saves (una fila con revision_count=3), 2 evolucionados.
      expect(res.todas).toEqual({ filas: 8, saves: 10, evolucionados: 2, reuso: 20 });
      // 6 con clave, 8 saves, 2 evolucionados.
      expect(res.claveadas).toEqual({ filas: 6, saves: 8, evolucionados: 2, reuso: 25 });
      // 2 sin clave (NULL y cadena vacía cuentan igual), ninguno evolucionó.
      expect(res.sin_clave).toEqual({ filas: 2, saves: 2, evolucionados: 0, reuso: 0 });
      expect(res.pct_sin_clave).toBe(25);
    });

    it("respeta el soft-delete", () => {
      // La fila borrada trae 5 saves. Contarla subiría el reuso global de 20.0%
      // a 40.0% con observaciones que el usuario ya retiró.
      const res = summarize(makeDb(CORPUS));
      expect(res.todas.saves).toBe(10);
      expect(res.irreusables.map((i) => i.topic_key)).not.toContain("area/borrada");
    });

    it("sigue corriendo si el esquema no trae `deleted_at`", () => {
      // La cláusula se introspecta con PRAGMA en vez de asumirse: un esquema
      // futuro sin soft-delete debe medir, no explotar.
      const db = makeDb([row("area/uno", "decision", 2, "2026-09-01")], { softDelete: false });
      expect(summarize(db).todas).toEqual({ filas: 1, saves: 2, evolucionados: 1, reuso: 50 });
    });

    it("cuenta las formas de clave y lista las irreusables, recientes primero", () => {
      const res = summarize(makeDb(CORPUS));
      expect(res.formas).toEqual({
        "area-slug": 4,
        "sin-slash": 2,
        fechada: 1,
        "no-ascii": 1,
        "prefijo-proyecto": 1,
      });
      expect(res.irreusables_total).toBe(2);
      expect(res.irreusables.map((i) => i.topic_key)).toEqual([
        "area/fechada-2026-09",
        "área/acentuada",
      ]);
    });

    it("desglosa por type lo que no lleva clave", () => {
      // `mem_session_summary` no acepta `topic_key` en su schema: esa parte de la
      // masa sin clave es inclaveable POR API, no negligencia del agente. Sin el
      // desglose, el "% sin clave" fija un techo que nadie puede alcanzar.
      expect(summarize(makeDb(CORPUS)).tipos_sin_clave).toEqual({
        session_summary: 1,
        manual: 1,
      });
    });

    it("filtra por proyecto", () => {
      const db = makeDb([
        row("area/uno", "decision", 1, "2026-09-01"),
        { ...row("area/dos", "decision", 1, "2026-09-02"), project: "otro" },
      ]);
      expect(summarize(db, "demo").todas.filas).toBe(1);
      expect(summarize(db, "otro").todas.filas).toBe(1);
      expect(summarize(db).todas.filas).toBe(2);
    });
  });
});
