import type { APIRoute } from "astro";
import type { D1Database } from "@cloudflare/workers-types";

function esc(s: string) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isoDateOnly(ts: unknown): string | null {
    if (!ts || typeof ts !== "string") return null;
    // Accept either full ISO or YYYY-MM-DD-ish; normalize to YYYY-MM-DD when possible
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
}

export const GET: APIRoute = async ({ site, locals }) => {
    if (!site) return new Response("Missing site", { status: 500 });

    // Static canonical public routes
    const staticPaths = [
        "/",
        "/donate",
        "/donors",
        "/events",
        "/raffle",
        "/contact",
        "/photos",
        "/privacy",
        "/data-deletion",
        "/terms",
    ];

    // Build list of <url> entries
    const entries: Array<{ loc: string; lastmod?: string | null }> = staticPaths.map((p) => ({
        loc: new URL(p, site).toString(),
    }));

    // Try to add dynamic URLs from D1, if DB isn't available, sitemap still returns the static URLs.
    const DB = (locals as any)?.runtime?.env?.DB as D1Database | undefined;

    if (DB) {
        // Published events
        const evRes = await DB.prepare(
            `SELECT id, updated_at
       FROM events
       WHERE status = 'published'`
        ).all<{ id: string; updated_at: string | null }>();

        for (const r of evRes.results ?? []) {
            entries.push({
                loc: new URL(`/events/${encodeURIComponent(r.id)}`, site).toString(),
                lastmod: isoDateOnly(r.updated_at),
            });
        }

        // Approved photos
        const phRes = await DB.prepare(
            `SELECT id, approved_at
       FROM photos
       WHERE status = 'approved'`
        ).all<{ id: string; approved_at: string | null }>();

        for (const r of phRes.results ?? []) {
            entries.push({
                loc: new URL(`/photos/${encodeURIComponent(r.id)}`, site).toString(),
                lastmod: isoDateOnly(r.approved_at),
            });
        }
    }

    const body =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
        entries
            .map((e) => {
                const loc = `<loc>${esc(e.loc)}</loc>`;
                const lastmod = e.lastmod ? `<lastmod>${esc(e.lastmod)}</lastmod>` : "";
                return `<url>${loc}${lastmod}</url>`;
            })
            .join("") +
        `</urlset>`;

    return new Response(body, {
        headers: {
            "Content-Type": "application/xml; charset=utf-8",
            // Cache is important so crawlers don't trigger frequent D1 reads
            "Cache-Control": "public, max-age=3600",
        },
    });
};
