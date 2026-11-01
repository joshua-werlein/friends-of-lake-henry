import type { APIRoute } from "astro";
import type { D1Database } from "@cloudflare/workers-types";
import { json } from "../../../../lib/http";

function mustBeIsoDate(s: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isRealIsoDate(s: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(`${s}T00:00:00Z`);
    if (!Number.isFinite(d.getTime())) return false;
    // Ensure it didn’t roll over (e.g., 2025-02-30 -> March 2)
    return d.toISOString().slice(0, 10) === s;
}

function chicagoCurrentMonthKey(d = new Date()) {
    return new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/Chicago",
        year: "numeric",
        month: "2-digit",
    }).format(d).slice(0, 7);
}

export const GET: APIRoute = async ({ request, locals }) => {
    const env = (locals as any).runtime?.env as any;

    const DB = env.DB as D1Database | undefined;
    if (!DB) return json({ ok: false, error: "DB binding missing" }, 500);

    const url = new URL(request.url);
    const raffleKey = (url.searchParams.get("raffleKey") ?? "").trim();

    if (!/^\d{4}-\d{2}$/.test(raffleKey)) {
        return json({ ok: false, error: "raffleKey (YYYY-MM) required" }, 400);
    }

    const includeMonths = url.searchParams.get("includeMonths") === "1";
    const includeMeta = url.searchParams.get("includeMeta") === "1";

    const { results } = await DB
        .prepare(
            `SELECT id, raffle_key as raffleKey, draw_date as drawDate, ticket_number as ticketNumber, winner_name as name, town, prize, created_at as createdAt
       FROM raffle_winners
       WHERE raffle_key = ?
       ORDER BY draw_date DESC, CASE WHEN prize LIKE '1st place%' THEN 1 WHEN prize LIKE '2nd place%' THEN 2 WHEN prize LIKE '3rd place%' THEN 3 ELSE 4 END, created_at DESC`
        )
        .bind(raffleKey)
        .all();

    let months: string[] | undefined;
    if (includeMonths) {
        const currentMonth = chicagoCurrentMonthKey();

        const winnerMonthsRes = await DB.prepare(
            `SELECT DISTINCT raffle_key as monthKey
     FROM raffle_winners
     ORDER BY raffle_key DESC`
        ).all();

        const activeMonths = (winnerMonthsRes.results ?? [])
            .map((r: any) => String(r.monthKey ?? "").trim())
            .filter((s) => /^\d{4}-\d{2}$/.test(s))
            .sort((a, b) => b.localeCompare(a));

        months = Array.from(new Set([currentMonth, ...activeMonths]))
            .filter((s) => /^\d{4}-\d{2}$/.test(s))
            .sort((a, b) => b.localeCompare(a));
    }

    let meta: { title: string | null } | undefined;
    if (includeMeta) {
        const row = await DB.prepare(
            `SELECT title FROM raffle_months WHERE month_key = ?`
        ).bind(raffleKey).first();

        meta = { title: row ? String((row as any).title ?? "") || null : null };
    }

    return json({ ok: true, winners: results ?? [],raffleKey, months, meta}, 200);
};

export const POST: APIRoute = async ({ request, locals }) => {
    const env = (locals as any).runtime?.env as any;

    const DB = env.DB as D1Database | undefined;
    if (!DB) return json({ ok: false, error: "DB binding missing" }, 500);

    let data: any = null;
    try {
        data = await request.json();
    } catch {
        return json({ ok: false, error: "Invalid JSON" }, 400);
    }

    const action = (data?.action ?? "add").toString();

    if (action === "setMeta") {
        const monthKey = (data?.raffleKey ?? "").toString().trim();
        const titleRaw = (data?.title ?? "").toString();
        const title = titleRaw.trim();

        if (!/^\d{4}-\d{2}$/.test(monthKey)) {
            return json({ ok: false, error: "raffleKey (YYYY-MM) required" }, 400);
        }

        // Clear only the title: the month may still own a poster and rules.
        if (!title) {
            await DB.prepare(`UPDATE raffle_months SET title = '',
                updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE month_key = ?`)
                .bind(monthKey)
                .run();
            return json({ ok: true, meta: { title: "" } }, 200);
        }

        await DB.prepare(
            `INSERT INTO raffle_months (month_key, title, updated_at)
             VALUES (?, ?, (strftime('%Y-%m-%dT%H:%M:%fZ','now')))
                 ON CONFLICT(month_key) DO UPDATE SET
                title = excluded.title,
                                               updated_at = excluded.updated_at`
        )
            .bind(monthKey, title)
            .run();

        return json({ ok: true, meta: { title } }, 200);
    }

    if (action === "delete") {
        const id = (data?.id ?? "").toString().trim();
        if (!id) return json({ ok: false, error: "Missing id" }, 400);

        await DB.prepare(`DELETE FROM raffle_winners WHERE id = ?`).bind(id).run();
        return json({ ok: true }, 200);
    }
    if (action !== "add") return json({ ok: false, error: "Unknown action" }, 400);
    const drawDate = (data?.drawDate ?? "").toString().trim();
    const raffleKey = drawDate.slice(0, 7); // "YYYY-MM"
    const ticketNumberRaw = (data?.ticketNumber ?? "").toString().trim();
    const name = (data?.name ?? "").toString().trim();
    const town = (data?.town ?? "").toString().trim();
    const prize = (data?.prize ?? "").toString().trim() || null;

    if (!drawDate) return json({ ok: false, error: "drawDate required" }, 400);
    if (!raffleKey) return json({ ok: false, error: "raffleKey required" }, 400);
    if (!mustBeIsoDate(drawDate)) return json({ ok: false, error: "drawDate must be YYYY-MM-DD" }, 400);
    if (!isRealIsoDate(drawDate)) return json({ ok: false, error: "drawDate must be a valid date" }, 400);

    const ticketNumber = Number(ticketNumberRaw);
    if (!Number.isSafeInteger(ticketNumber) || ticketNumber <= 0) {
        return json({ ok: false, error: "ticketNumber must be a positive whole number" }, 400);
    }
    if (name.length < 2) return json({ ok: false, error: "name required" }, 400);
    if (town.length < 2) return json({ ok: false, error: "town required" }, 400);

    if (name.length > 200 || town.length > 200 || (prize?.length ?? 0) > 250) return json({ ok: false, error: "Name, hometown or prize is too long" }, 400);

    // Deterministic ID helps avoid duplicates; allow same ticket across different dates.
    const id = `${raffleKey}-${drawDate}-${ticketNumber}`.replace(/[^\w-]/g, "");

    try {
        await DB.prepare(
            `INSERT INTO raffle_winners (id, raffle_key, draw_date, ticket_number, winner_name, town, prize)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
            .bind(id, raffleKey, drawDate, ticketNumber, name, town, prize)
            .run();
    } catch (err: any) {
        const msg = String(err?.message ?? "");
        if (msg.includes("UNIQUE") || msg.includes("constraint")) {
            return json({ ok: false, error: "That ticket number already exists for that day/month." }, 409);
        }
        return json({ ok: false, error: "DB insert failed" }, 500);
    }
    return json({ ok: true, id }, 200);
};
