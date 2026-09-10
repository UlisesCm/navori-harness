#!/usr/bin/env python3
"""Clasifica sesiones en el brazo "antes" o "después" del arreglo de entrega.

Es el paso PREVIO a `mine-activation.py`: separa qué sesiones recibieron la
escalera de ruteo como cuerpo y cuáles se quedaron con el puntero, para poder
comparar tasas de activación entre brazos comparables.

La pregunta es "¿qué recibió el modelo?", y el transcript guarda DOS cosas que
se parecen y no son la misma:

  hook_success.stdout             lo que el hook IMPRIMIÓ            no sirve
  hook_additional_context.content lo que el host INYECTÓ, ya recortado  sirve

Clasificar por `stdout` es el mismo defecto que #623 —creer que porque el hook
lo escribió, llegó— cometido por el instrumento que mide ese defecto. Medido:
en 50f01529 el stdout trae la escalera entera (28,643 bytes) y el contexto
inyectado son 2,276 bytes sin ella.

Y `content` es una LISTA DE BLOQUES, no un string: leerlo como string devuelve
vacío en silencio, que se lee igual que "no llegó".

Uso:
    python3 scripts/classify-activation-arm.py <dir-de-proyecto> [<dir> ...]
    python3 scripts/classify-activation-arm.py --ids-after <dir> [<dir> ...]

`<dir>` es un directorio bajo ~/.claude/projects (nombre o ruta). Con
`--ids-after` imprime solo los ids del brazo "después", uno por línea, listo
para alimentar a `mine-activation.py`.
"""
import json
import os
import sys

PROJECTS = os.path.expanduser("~/.claude/projects")

# El bloque cuya presencia define el brazo: es el cuerpo de la escalera, no su
# puntero. El puntero dice "no cabe en el contexto de arranque" y NO cuenta.
LADDER = "## Role: orchestrator"


def blocks_to_text(value):
    """`hook_additional_context.content` viene como lista de bloques."""
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    out = []
    for block in value:
        if isinstance(block, str):
            out.append(block)
        elif isinstance(block, dict):
            for key in ("text", "content"):
                if isinstance(block.get(key), str):
                    out.append(block[key])
    return "\n".join(out)


def injected_context(path):
    """El contexto de arranque tal como el host lo inyectó, ya recortado.

    Se concatenan TODOS los hooks de SessionStart: el de navori no es el
    primero, y mirar solo el primero da un falso negativo.
    """
    parts = []
    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            attachment = entry.get("attachment")
            if isinstance(attachment, dict):
                if attachment.get("type") == "hook_additional_context":
                    parts.append(blocks_to_text(attachment.get("content")))
            # Los hooks de arranque se emiten antes del primer turno real.
            if entry.get("type") in ("user", "assistant") and parts:
                break
    return "\n".join(parts)


def first_timestamp(path):
    with open(path, errors="replace") as fh:
        for line in fh:
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("timestamp"):
                return entry["timestamp"]
    return "?"


def sessions(dirname):
    root = dirname if os.path.isdir(dirname) else os.path.join(PROJECTS, dirname)
    if not os.path.isdir(root):
        sys.exit(f"no existe el directorio de proyecto: {root}")
    for name in sorted(os.listdir(root)):
        if name.endswith(".jsonl"):
            yield os.path.join(root, name)


def main(argv):
    ids_only = "--ids-after" in argv
    dirs = [a for a in argv if not a.startswith("--")]
    if not dirs:
        sys.exit(__doc__)

    rows = []
    for dirname in dirs:
        label = os.path.basename(dirname.rstrip("/")).split("Docs-")[-1]
        for path in sessions(dirname):
            ctx = injected_context(path)
            rows.append(
                {
                    "repo": label,
                    "id": os.path.basename(path)[: -len(".jsonl")],
                    "ts": first_timestamp(path),
                    "bytes": len(ctx),
                    "after": LADDER in ctx,
                }
            )
    rows.sort(key=lambda r: (r["repo"], r["ts"]))

    if ids_only:
        for row in rows:
            if row["after"]:
                print(row["id"])
        return

    print(f"{'repo':30s} {'sesión':10s} {'inicio':17s} {'inyectado':>10s}  brazo")
    for row in rows:
        arm = "DESPUÉS" if row["after"] else "antes"
        print(
            f"{row['repo'][:30]:30s} {row['id'][:8]:10s} {row['ts'][:16]:17s} "
            f"{row['bytes']:10d}  {arm}"
        )
    after = sum(1 for r in rows if r["after"])
    print(f"\n{after} después · {len(rows) - after} antes · {len(rows)} sesiones")


if __name__ == "__main__":
    main(sys.argv[1:])
