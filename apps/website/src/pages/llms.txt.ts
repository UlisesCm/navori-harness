import type { APIRoute } from "astro";
import { commandOrder, commandDocs } from "../content/commands";
import { ui } from "../i18n/ui";
import { INVENTORY, NPM_URL, REPO_URL, PLUGIN_IDS, ENGINE_IDS } from "../consts";
import cliPkg from "../../../../packages/cli/package.json";

/**
 * `/llms.txt` — the site, written for an agent instead of a browser.
 *
 * The convention (llmstxt.org) is a single markdown file at a well-known path:
 * what the project is, and a linked index of the pages worth reading, so a
 * model answering a question about navori does not have to scrape and rank the
 * whole site to find the command reference.
 *
 * Generated rather than hand-written, and that is the point — it reads
 * `commandOrder` and the shared `INVENTORY`, so a new subcommand appears here
 * the moment it has a docs page. A hand-maintained copy would drift exactly the
 * way the landing did.
 *
 * `prerender` is explicit so this survives a future switch to a server output
 * mode: the file must be static.
 */
export const prerender = true;

export const GET: APIRoute = ({ site }) => {
  const origin = site ?? new URL("https://ulisescm.github.io");
  const base = import.meta.env.BASE_URL;
  const url = (path: string): string =>
    new URL(`${base}${path}`.replace(/\/{2,}/g, "/"), origin).toString();

  const es = ui.es;

  const commandLines = commandOrder.map((id) => {
    const doc = commandDocs.es[id];
    return `- [navori ${id}](${url(`docs/${id}`)}): ${doc?.summary ?? ""}`;
  });

  const body = `# navori

> ${es["site.tagline"]}. ${es["site.description"]}

navori es un CLI (paquete npm \`navori\`, binario \`navori\`, versión ${cliPkg.version}, MIT, Node >= 20)
que instala y mantiene un harness multi-agente + SDD en cualquier repositorio.

Hechos clave:

- Fuente de verdad: un \`navori.config.json\` checked-in. \`navori render\` reconstruye el harness
  completo desde ese archivo, de forma idempotente.
- Modelo híbrido: solo los bloques marcados con \`<!-- navori:managed -->\` se sincronizan. Todo lo
  que el usuario escribe fuera de esos marcadores es intocable.
- \`render\` hace preview por default; \`--apply\` escribe, con backup previo y escritura atómica.
- Inventario: ${INVENTORY.commands} subcomandos, ${INVENTORY.presets} presets, ${INVENTORY.plugins} plugins, ${INVENTORY.engines} engines, ${INVENTORY.agents} agentes, ${INVENTORY.skills} skills.
- Engines soportados: ${ENGINE_IDS.join(", ")}.
- Plugins disponibles: ${PLUGIN_IDS.join(", ")}.
- Tres alcances aditivos y opt-in: el repo (\`navori init\`), la máquina (\`navori global init\`,
  en \`~/.claude\`) y el workspace (\`navori workspace\`, \`navori dominio\`). Sin el init
  correspondiente, navori no escribe nada fuera del repo.
- navori GENERA el harness; no ejecuta las herramientas del agente. Dicta qué herramienta usar y
  bajo qué doctrina vía skills, permisos y protocolo.

## Empezar

- [Quickstart](${url("quickstart")}): instalar, inicializar y renderizar, en cuatro pasos.
- [A fondo](${url("deep-dive")}): los agentes, los tiers de modelo, el consumo de tokens, la memoria persistente y el glosario para quien no viene del mundo de los agentes.

## Referencia de comandos

${commandLines.join("\n")}

## Recursos

- [Repositorio](${REPO_URL}): código, issues y specs de arquitectura bajo \`specs/\`.
- [Paquete npm](${NPM_URL}): \`npx navori init\`.
- [JSON Schema de navori.config.json](${url("schema/navori.config.v1.json")})
- [JSON Schema de un preset](${url("schema/navori.preset.v1.json")})
- [JSON Schema de un workspace](${url("schema/navori.workspace.v1.json")})

## Notas

- El sitio es bilingüe: español en la raíz, inglés bajo \`/en/\`. El contenido es equivalente.
- La versión publicada y la documentada aquí son la misma: ${cliPkg.version}.
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
