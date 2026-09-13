import type { APIRoute } from "astro";

/**
 * `/robots.txt` — crawl policy, including the AI crawlers by name.
 *
 * Default-allow is deliberate and it is the whole point of naming them: a
 * crawler that finds no rule for its user-agent falls back to `*`, so the
 * explicit blocks don't change behaviour today. What they do is make the policy
 * a decision on the record instead of an accident, and give one obvious place
 * to flip a single crawler off without touching the rest.
 *
 * `llms.txt` is advertised here as well as via `<link rel="alternate">`, since
 * an agent fetching robots.txt first is the common case.
 *
 * CAVEAT — hosting: under GitHub Pages on a project path, the live site is
 * `<user>.github.io/<repo>/`, and crawlers only read robots.txt from the DOMAIN
 * root. So this file is authoritative only once navori is on its own domain (or
 * on a user-root Pages site). It is generated anyway: it costs nothing, it is
 * correct the day the domain changes, and `sitemap-index.xml` is a real URL
 * either way.
 */
export const prerender = true;

/** Crawlers named explicitly so the policy is auditable, not inferred. */
const AI_CRAWLERS = [
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "PerplexityBot",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "meta-externalagent",
  "Bytespider",
];

export const GET: APIRoute = ({ site }) => {
  const origin = site ?? new URL("https://ulisescm.github.io");
  const base = import.meta.env.BASE_URL;
  const abs = (path: string): string =>
    new URL(`${base}${path}`.replace(/\/{2,}/g, "/"), origin).toString();

  const aiBlock = AI_CRAWLERS.map((ua) => `User-agent: ${ua}\nAllow: /`).join("\n\n");

  const body = `# navori — https://github.com/UlisesCm/navori-harness
# Open source documentation. Crawling and training are both allowed.

User-agent: *
Allow: /

# AI crawlers, named explicitly so the policy is a decision on the record.
${aiBlock}

# Agent-readable index of this site.
# ${abs("llms.txt")}

Sitemap: ${abs("sitemap-index.xml")}
`;

  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
