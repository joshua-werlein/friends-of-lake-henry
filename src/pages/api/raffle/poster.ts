import type { APIRoute } from "astro";
import type { D1Database, R2Bucket } from "@cloudflare/workers-types";
import { fileResponse, SECURITY_HEADERS_FILE, SECURITY_HEADERS_NOSTORE } from "../../../lib/http";

const err = (msg: string, status: number) =>
  new Response(msg, { status, headers: SECURITY_HEADERS_NOSTORE });

const ALLOWED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

function guessContentTypeFromKey(key: string): string | null {
  const k = key.toLowerCase();
  if (k.endsWith(".jpg") || k.endsWith(".jpeg")) return "image/jpeg";
  if (k.endsWith(".png")) return "image/png";
  if (k.endsWith(".webp")) return "image/webp";
  if (k.endsWith(".gif")) return "image/gif";
  if (k.endsWith(".avif")) return "image/avif";
  return null;
}

function normalizeAllowedImageContentType(ct: string | null | undefined): string | null {
  if (!ct) return null;
  const base = ct.trim().toLowerCase().split(";")[0].trim();
  return ALLOWED_IMAGE_TYPES.has(base) ? base : null;
}

export const GET: APIRoute = async ({ locals, url }) => {
  const monthKey = url.searchParams.get("month")?.trim();
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return err("Missing month", 400);

  const env = (locals as any).runtime?.env as
    | { DB?: D1Database; PHOTOS_BUCKET?: R2Bucket }
    | undefined;

  const DB = env?.DB;
  const BUCKET = env?.PHOTOS_BUCKET;
  if (!DB || !BUCKET) return err("Server misconfigured", 500);

  const row = await DB.prepare(`
    SELECT poster_key
    FROM raffle_months
    WHERE month_key = ?
  `).bind(monthKey).first<{ poster_key: string | null }>();

  const key = row?.poster_key;
  if (!key) return err("Not found", 404);

  const obj = await BUCKET.get(key);
  if (!obj) return err("Not found", 404);

  const headers = new Headers(SECURITY_HEADERS_FILE);
  const contentType =
    normalizeAllowedImageContentType(obj.httpMetadata?.contentType) ||
    guessContentTypeFromKey(key);

  if (!contentType) return err("Unsupported image type", 415);

  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "public, max-age=86400");
  if (obj.httpEtag) headers.set("ETag", obj.httpEtag);

  return fileResponse(obj.body as any, headers, 200);
};