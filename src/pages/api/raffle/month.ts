import type { APIRoute } from "astro";
import type { D1Database } from "@cloudflare/workers-types";
import { json } from "../../../lib/http";

function isMonthKey(s: string) {
  return /^\d{4}-\d{2}$/.test(s);
}

function monthKeyToLabel(monthKey: string) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 15, 12));
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "long",
    year: "numeric",
  }).format(d);
}

function chicagoCurrentMonthKey(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
  }).format(d).slice(0, 7);
}

function shiftMonthKey(monthKey: string, delta: number) {
  const [y, m] = monthKey.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1, 12));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export const GET: APIRoute = async ({ request, locals }) => {
  const env = (locals as any).runtime?.env as { DB?: D1Database } | undefined;
  const DB = env?.DB;
  if (!DB) return json({ ok: false, error: "DB binding missing" }, 500);

  const url = new URL(request.url);
  const monthParam = (url.searchParams.get("month") ?? "").trim();

  const currentMonth = chicagoCurrentMonthKey();
  const raffleKey = isMonthKey(monthParam) ? monthParam : currentMonth;

  const winnerMonthsRes = await DB.prepare(`
    SELECT DISTINCT raffle_key as monthKey
    FROM raffle_winners
    ORDER BY raffle_key DESC
  `).all();

  const metaMonthsRes = await DB.prepare(`
    SELECT DISTINCT month_key as monthKey
    FROM raffle_months
    ORDER BY month_key DESC
  `).all();

  const jumpMonths = Array.from(
    new Set([
      currentMonth,
      ...(winnerMonthsRes.results ?? []).map((r: any) => String(r.monthKey ?? "").trim()),
      ...(metaMonthsRes.results ?? []).map((r: any) => String(r.monthKey ?? "").trim()),
    ])
  )
    .filter(isMonthKey)
    .sort((a, b) => b.localeCompare(a))
    .map((k) => ({ key: k, label: monthKeyToLabel(k) }));

  const prevMonthKey = shiftMonthKey(raffleKey, -1);
  const nextMonthKey = shiftMonthKey(raffleKey, 1);

  const winnersRes = await DB.prepare(`
    SELECT id,
           draw_date as drawDate,
           ticket_number as ticketNumber,
           winner_name as name,
           town,
           prize
    FROM raffle_winners
    WHERE raffle_key = ?
    ORDER BY draw_date DESC, created_at DESC
  `).bind(raffleKey).all();

  const metaRes = await DB.prepare(`
    SELECT title, poster_key, poster_alt
    FROM raffle_months
    WHERE month_key = ?
  `).bind(raffleKey).first();

  const titleRaw = metaRes ? String((metaRes as any).title ?? "").trim() : "";
  const posterKeyRaw = metaRes ? String((metaRes as any).poster_key ?? "").trim() : "";
  const posterAltRaw = metaRes ? String((metaRes as any).poster_alt ?? "").trim() : "";

  return json({
    ok: true,
    monthKey: raffleKey,
    monthLabel: monthKeyToLabel(raffleKey),
    prevMonthKey,
    nextMonthKey,
    raffleTitle: titleRaw || null,
    rafflePosterUrl: posterKeyRaw ? `/api/raffle/poster?month=${encodeURIComponent(raffleKey)}` : null,
    rafflePosterAlt: posterAltRaw || `${monthKeyToLabel(raffleKey)} raffle poster`,
    winners: winnersRes.results ?? [],
    months: jumpMonths,
  });
};