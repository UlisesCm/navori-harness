import type { APIRoute } from "astro";
import { llmsIndex } from "../content/markdown";
/** English is the primary root index. */
export const GET: APIRoute = ({ site }) =>
  new Response(llmsIndex("en", site!.href, import.meta.env.BASE_URL), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
