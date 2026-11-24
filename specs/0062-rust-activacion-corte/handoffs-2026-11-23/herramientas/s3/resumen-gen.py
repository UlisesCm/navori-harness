#!/usr/bin/env python3
"""Builds the R81 daily summary from the latest rehearsal table (read-only on journals).

Usage: resumen-gen.py <ensayo.md> <corte label> <notes.md> > resumen.md
Claude rows: the calls cell reads "n llamadas hasta el 20 nov, sin tráfico después" (Ulises, 20 nov 14:55).
"""
import sys

ensayo, corte, notes = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(ensayo, encoding="utf-8").read().split("\n")
out_rows = []
for line in lines:
    if not line.startswith("|"):
        continue
    cells = line.split("|")
    # Row cells: ['', hook, engine, gating, calls, ...]
    if len(cells) > 5 and cells[2].strip() == "claude":
        calls = cells[4].strip()
        cells[4] = f" {calls} llamadas hasta el 20 nov, sin tráfico después "
        line = "|".join(cells)
    if line.startswith("| Batch |"):
        out_rows.append("")
    out_rows.append(line)
verdict = next((l for l in lines if l.startswith("R81,")), "")
print(f"## Resumen diario R81 (S3)\n")
print(f"**Corte: {corte}.** Este comentario se edita cada día; no se abre uno nuevo.\n")
print(open(notes, encoding="utf-8").read().rstrip() + "\n")
print(f"### Ensayo del cierre de la 1.ª ventana (`--now 2026-11-26T17:16:00-06:00`, evidencia; no decide la activación): {verdict}\n")
print("\n".join(out_rows))
