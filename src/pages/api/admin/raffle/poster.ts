import type { APIRoute } from "astro";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { redirect } from "../../../../lib/http";

function isAllowedImageType(type: string) {
  return (
    type === "image/jpeg" ||
    type === "image/png" ||
    type === "image/webp" ||
    type === "image/gif"
  );
}

function extFromContentType(type: string) {
  switch (type) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "bin";
  }
}

export const POST: APIRoute = async (context) => {
  try {
    const form = await context.request.formData();
    const monthKey = String(form.get("monthKey") ?? "").trim();
    const alt = String(form.get("alt") ?? "").trim();
    const fileLike = form.get("poster");

    if (!/^\d{4}-\d{2}$/.test(monthKey)) {
      return redirect(`${context.url.origin}/admin/raffle?err=invalid-month`);
    }

    if (alt.length < 5) {
      return redirect(`${context.url.origin}/admin/raffle?month=${encodeURIComponent(monthKey)}&err=alt`);
    }

    if (!fileLike || typeof fileLike === "string") {
      return redirect(`${context.url.origin}/admin/raffle?month=${encodeURIComponent(monthKey)}&err=file`);
    }

    const file = fileLike as File;

    if (!isAllowedImageType(file.type)) {
      return redirect(`${context.url.origin}/admin/raffle?month=${encodeURIComponent(monthKey)}&err=type`);
    }

    const MAX_BYTES = 8 * 1024 * 1024;
    if (file.size <= 0 || file.size > MAX_BYTES) {
      return redirect(`${context.url.origin}/admin/raffle?month=${encodeURIComponent(monthKey)}&err=size`);
    }

    const env = (context.locals as any).runtime?.env as
      | { DB?: D1Database; PHOTOS_BUCKET?: R2Bucket }
      | undefined;

    const DB = env?.DB;
    const BUCKET = env?.PHOTOS_BUCKET;

    if (!DB || !BUCKET) {
      return redirect(`${context.url.origin}/admin/raffle?month=${encodeURIComponent(monthKey)}&err=server`);
    }

    const existing = await DB.prepare(`
      SELECT poster_key
      FROM raffle_months
      WHERE month_key = ?
    `).bind(monthKey).first<{ poster_key: string | null }>();

    const ext = extFromContentType(file.type);
    const r2Key = `raffle/posters/${monthKey}.${ext}`;
    const buf = await file.arrayBuffer();

    await BUCKET.put(r2Key, buf, {
      httpMetadata: { contentType: file.type },
    });

    try {
      await DB.prepare(`
        INSERT INTO raffle_months (month_key, title, rules_json, poster_key, poster_alt, created_at, updated_at)
        VALUES (?, '', NULL, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ON CONFLICT(month_key) DO UPDATE SET
          poster_key = excluded.poster_key,
          poster_alt = excluded.poster_alt,
          updated_at = excluded.updated_at
      `).bind(monthKey, r2Key, alt).run();
    } catch (e) {
      await BUCKET.delete(r2Key);
      throw e;
    }

    if (existing?.poster_key && existing.poster_key !== r2Key) {
      await BUCKET.delete(existing.poster_key);
    }

    return redirect(`${context.url.origin}/admin/raffle?month=${encodeURIComponent(monthKey)}&ok=poster`);
  } catch (e) {
    console.error(e);
    return redirect(`${context.url.origin}/admin/raffle?err=server`);
  }
};