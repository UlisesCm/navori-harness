## Stack — Vite + React + TS + Mantine

SPA con Vite. La UI se construye con componentes de Mantine y los tokens del theme (spacing, colors, radius) — no estilos hardcoded ni CSS ad-hoc cuando el design system ya lo resuelve.

Regla de oro: usa los componentes y props de Mantine antes de escribir CSS custom; respeta el theme. Aplica el skill `mantine-ui-patterns` para UI y `new-feature` para el orden de capas de un feature nuevo.
