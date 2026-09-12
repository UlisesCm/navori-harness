import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The activation miner had no test at all (#720), and it is the instrument that
 * will judge whether #661 worked. Two defects made its verdict unreliable, and
 * both are the same shape: the layer that BLOCKS and the layer that MEASURES
 * shared their blind spots, which is the combination that produces a green
 * number for the wrong reason.
 *
 * Driven through `python3` rather than ported to TypeScript: the same choice
 * this suite already makes for shell assets, and for the same reason — what has
 * to be correct is the script that actually runs, not a second copy of it.
 */

const MINER = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "..",
  "scripts",
  "mine-search-routing.py",
);

const hasPython = spawnSync("python3", ["--version"]).status === 0;

/** Classify one command through the real module. */
function classify(command: string): Record<string, number> {
  const program = [
    "import importlib.util, json, sys",
    `spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(MINER)})`,
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "print(json.dumps(dict(m.classify_command(sys.argv[1]))))",
  ].join("\n");
  const r = spawnSync("python3", ["-c", program, command], { encoding: "utf-8" });
  return JSON.parse(r.stdout || "{}") as Record<string, number>;
}

describe.runIf(hasPython)("mine-search-routing — las vías que nadie contaba (#720)", () => {
  it("cuenta `git grep` como su propia categoría", () => {
    // Invisible para las tres capas a la vez: el guard anclaba cuatro verbos, el
    // minero puntuaba los mismos cuatro, y READ_LANE_BINARIES excluía `git`
    // entero. Era la migración de mínima fricción — sin prompt, sin índice y
    // fuera de toda medición. Medido en el parque: 58 llamadas.
    expect(classify("git grep patron")).toEqual({ "git-grep": 1 });
    expect(classify("git -C /repo grep patron")).toEqual({ "git-grep": 1 });
    // Con pipe también: no es un filtro de stdin, es una búsqueda del árbol.
    expect(classify("git grep patron | head -5")).toEqual({ "git-grep": 1 });
  });

  it("no confunde otro subcomando de git con una búsqueda", () => {
    expect(classify("git log --oneline")).toEqual({});
    expect(classify("git commit -m 'grep algo'")).toEqual({});
  });

  it("cuenta la búsqueda indirecta, que el guard tampoco ancla", () => {
    // `xargs grep` se clasificaba como "filtro" y `find -exec grep` no entraba
    // en absoluto: las dos formas a las que el hábito puede migrar cuando la
    // directa se bloquea.
    expect(classify("xargs grep -rn foo")).toEqual({ indirecta: 1 });
    expect(classify('find . -name "*.ts" -exec grep -l foo {} +')).toEqual({ indirecta: 1 });
  });

  it("deja intactas las categorías que ya puntuaban", () => {
    expect(classify("grep -rn foo src/")).toEqual({ shell: 1 });
    expect(classify("cat x | grep -n foo")).toEqual({ filtro: 1 });
    expect(classify("grep -n foo archivo.ts")).toEqual({ extraccion: 1 });
    expect(classify("bash .claude/scripts/tgrep-search.sh -n foo")).toEqual({ wrapper: 1 });
  });

  it("no cuenta como shell un comando que el guard bloqueó", () => {
    // Nunca corrió. Sumaba a "shell" y su reintento por el wrapper sumaba
    // aparte, así que cada búsqueda convertida por el guard quedaba a la mitad
    // en la métrica — y el antes/después de #661 nacía sesgado.
    //
    // El veredicto sale del PROPIO transcript: el bloqueo llega como
    // `tool_result` con `is_error` y el texto del hook. Exacto, sin cruzar
    // archivos ni correlacionar por reloj.
    const root = mkdtempSync(join(tmpdir(), "navori-miner-"));
    const audits = join(root, "audits", "demo");
    const projects = join(root, "projects", "enc");
    mkdirSync(audits, { recursive: true });
    mkdirSync(projects, { recursive: true });
    const sid = "sess-miner-1";
    writeFileSync(
      join(audits, `session-${sid}.log`),
      `${JSON.stringify({ ts: "2026-09-12T10:00:00Z", event: "start", repo: "demo", cwd: "/x" })}\n`,
    );

    const lines = [
      {
        message: {
          content: [
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "grep -rn foo src/" } },
            { type: "tool_use", id: "t2", name: "Bash", input: { command: "grep -rn bar src/" } },
          ],
        },
      },
      {
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              is_error: true,
              content: "[navori] BLOCKED by guard-search-routing: busqueda de contenido",
            },
            // The same string WITHOUT is_error is a file that merely quotes it —
            // a session reading the guard's own source. It must not count.
            {
              type: "tool_result",
              tool_use_id: "t2",
              is_error: false,
              content: "42: # BLOCKED by guard-search-routing appears in this file",
            },
          ],
        },
      },
    ];
    writeFileSync(
      join(projects, `${sid}.jsonl`),
      `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
    );

    const program = [
      "import importlib.util, json",
      `spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(MINER)})`,
      "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
      "print(json.dumps({k: dict(v) for k, v in m.scan().items()}))",
    ].join("\n");
    const r = spawnSync("python3", ["-c", program], {
      encoding: "utf-8",
      env: {
        ...process.env,
        NAVORI_AUDITS_ROOT: join(root, "audits"),
        NAVORI_TRANSCRIPTS_ROOT: join(root, "projects"),
      },
    });
    const out = JSON.parse(r.stdout || "{}") as Record<string, Record<string, number>>;
    expect(out.demo?.bloqueado).toBe(1);
    expect(out.demo?.shell).toBe(1);
  });

  it("acota por día de sesión, que es lo que permite el antes/después", () => {
    // El criterio de éxito de #661 es "antes contra después, mismos repos, con
    // el agregador que ya existe". Sin el corte, la única comparación posible
    // era contra una línea base calculada con el minero VIEJO — que mediría el
    // cambio del instrumento junto con el del hábito.
    const root = mkdtempSync(join(tmpdir(), "navori-miner-fecha-"));
    const audits = join(root, "audits", "demo");
    const projects = join(root, "projects", "enc");
    mkdirSync(audits, { recursive: true });
    mkdirSync(projects, { recursive: true });

    for (const [sid, day] of [
      ["sess-vieja", "2026-09-10"],
      ["sess-nueva", "2026-09-12"],
    ]) {
      writeFileSync(
        join(audits, `session-${sid}.log`),
        `${JSON.stringify({ ts: `${day}T10:00:00Z`, event: "start", repo: "demo" })}\n`,
      );
      writeFileSync(
        join(projects, `${sid}.jsonl`),
        `${JSON.stringify({
          message: {
            content: [
              {
                type: "tool_use",
                id: `t-${sid}`,
                name: "Bash",
                input: { command: "grep -rn foo src/" },
              },
            ],
          },
        })}\n`,
      );
    }

    const run = (args: string): Record<string, Record<string, number>> => {
      const program = [
        "import importlib.util, json, sys",
        `spec = importlib.util.spec_from_file_location('m', ${JSON.stringify(MINER)})`,
        "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
        // `-` viaja como None: pasar la cadena "None" haría que la comparación
        // de fechas filtrara por accidente y el test pasaría por el motivo
        // equivocado, que es peor que no tenerlo.
        "a = [None if x == '-' else x for x in sys.argv[1:]]",
        "print(json.dumps({k: dict(v) for k, v in m.scan(*a).items()}))",
      ].join("\n");
      const r = spawnSync("python3", ["-c", program, ...args.split(" ").filter(Boolean)], {
        encoding: "utf-8",
        env: {
          ...process.env,
          NAVORI_AUDITS_ROOT: join(root, "audits"),
          NAVORI_TRANSCRIPTS_ROOT: join(root, "projects"),
        },
      });
      return JSON.parse(r.stdout || "{}") as Record<string, Record<string, number>>;
    };

    expect(run("").demo?.shell).toBe(2);
    // `since` toma la sesión del 12 y deja fuera la del 10.
    expect(run("2026-09-11").demo?.shell).toBe(1);
    // `until` es exclusivo, así que toma solo la del 10.
    expect(run("- 2026-09-11").demo?.shell).toBe(1);
    // Y las dos juntas acotan una ventana que no contiene ninguna.
    expect(run("2026-09-11 2026-09-12")).toEqual({});
  });
});
