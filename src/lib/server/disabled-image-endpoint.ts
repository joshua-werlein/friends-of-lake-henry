import type { APIRoute } from "astro";

export const ALL: APIRoute = () => new Response(null, { status: 404 });
