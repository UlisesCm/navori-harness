import { describe, expect, it } from "vitest";
import { checkOnePageSpec, MAX_TASKS, MAX_WORDS, type OnePageRule } from "../onepage.ts";

/** Trimmed real-world one-pager (Spanish headings). */
const JEY = `# S01 — Cuenta por correo

## Resultado

Un miembro nuevo instala la app, crea su cuenta con correo y contraseña, verifica su correo y entra a Inicio.

## Guion de aceptación (A1)

Sobre qa, con el APK preview en un Android físico.

1. Abre la app y toca "Crear cuenta". **Esperado:** llegas a Inicio con un aviso de que falta verificar el correo.
2. Toca el enlace del correo. **Esperado:** se abre la app en "Correo verificado".
3. Cierra sesión y entra con una contraseña incorrecta. **Esperado:** un mensaje claro de credenciales incorrectas.
4. Activa el modo avión e intenta entrar. **Esperado:** un aviso de sin conexión.

## Reglas aplicables

- RF-1: registro, verificación y login por correo.

## Estados

| Estado | Qué ve el miembro |
|---|---|
| Sin conexión | Aviso de sin conexión con opción de reintentar |
| Error del servidor | Mensaje con la referencia del error |

## Entorno y datos

- **API qa:** \`EMAIL_FROM\` y las claves reales de Turnstile.

## Fuera de alcance

- Login con Google y Apple (S09).

## Tareas

1. Ejecutar el guion en qa y registrar cada paso fallido como hallazgo.
2. Comprobar que los errores llegan a PostHog con su referencia.
3. Correr A2 (\`bun run test:e2e:local -- tests/e2e/local-auth.spec.ts\`) sobre el SHA promovido.
`;

const EN = `# Feature

## Outcome
A member signs in.

## Acceptance script
Staging, real device.

1. Open the app. **Expected:** the home screen.

## Applicable rules
- RF-1

## States
| State | Sees |
|---|---|
| Empty | n/a — always has data |
| Error | message |
| Offline | banner |
| No permission | n/a — public |

## Environment and data
- none

## Out of scope
- nothing

## Tasks
- [ ] A member reaches home.
`;

function rules(text: string): OnePageRule[] {
  return checkOnePageSpec(text).findings.map((f) => f.rule);
}

describe("checkOnePageSpec", () => {
  it("accepts the Spanish fixture with only the expected warnings", () => {
    const result = checkOnePageSpec(JEY);
    expect(result.ok).toBe(true);
    const warnings = result.findings.filter((f) => f.severity === "warning");
    expect(result.findings).toEqual(warnings);
    expect(warnings.map((w) => w.rule).sort()).toEqual([
      "missing-state",
      "missing-state",
      "task-implementation",
    ]);
    const missing = warnings.filter((w) => w.rule === "missing-state").map((w) => w.message);
    expect(missing.some((m) => m.includes('"empty"'))).toBe(true);
    expect(missing.some((m) => m.includes('"no permission"'))).toBe(true);
    expect(warnings.find((w) => w.rule === "task-implementation")?.message).toContain("file path");
    expect(result.words).toBe(JEY.trim().split(/\s+/).length);
  });

  it("accepts English headings with no findings", () => {
    expect(checkOnePageSpec(EN)).toMatchObject({ ok: true, findings: [] });
  });

  it("errors on each missing section", () => {
    const result = checkOnePageSpec("# Only a title\n");
    expect(result.ok).toBe(false);
    expect(rules("# Only a title\n").filter((r) => r === "missing-section")).toHaveLength(7);
  });

  it("errors above the word limit", () => {
    const text = `${EN}\n${"word ".repeat(MAX_WORDS)}`;
    expect(rules(text)).toContain("too-long");
  });

  it("errors on zero or more than 10 acceptance steps", () => {
    const none = EN.replace("1. Open the app. **Expected:** the home screen.", "Just prose.");
    expect(rules(none)).toContain("steps-count");
    const many = EN.replace(
      "1. Open the app. **Expected:** the home screen.",
      Array.from({ length: 11 }, (_, i) => `${i + 1}. Step. **Expected:** ok.`).join("\n"),
    );
    expect(rules(many)).toContain("steps-count");
  });

  it("errors on zero or more than 8 tasks", () => {
    expect(rules(EN.replace("- [ ] A member reaches home.", ""))).toContain("tasks-count");
    const many = EN.replace(
      "- [ ] A member reaches home.",
      Array.from({ length: MAX_TASKS + 1 }, () => "- A member reaches home.").join("\n"),
    );
    expect(rules(many)).toContain("tasks-count");
  });

  it("errors on an empty outcome", () => {
    expect(rules(EN.replace("A member signs in.", ""))).toContain("empty-outcome");
  });

  it("warns on a version or a signature in a task", () => {
    const version = EN.replace("A member reaches home.", "Upgrade to 2.4.1 and ship.");
    expect(rules(version)).toEqual(["task-implementation"]);
    const signature = EN.replace("A member reaches home.", "Add loadUser(id) so it works.");
    expect(rules(signature)).toEqual(["task-implementation"]);
  });

  it("ignores `## ` headings inside fenced code", () => {
    const fenced = `${EN}\n\`\`\`md\n## Extra\n## Tasks\n- a\n- b\n\`\`\`\n`;
    expect(checkOnePageSpec(fenced)).toMatchObject({ ok: true, findings: [] });
    const hidden = "```md\n## Outcome\ntext\n```\n";
    expect(rules(hidden).filter((r) => r === "missing-section")).toHaveLength(7);
  });
});
