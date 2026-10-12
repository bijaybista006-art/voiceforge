/**
 * Hands the browser a signed URL so it can upload straight to storage.
 *
 * Assets do NOT go through this function. Vercel rejects any request body
 * over 4.5 MB with FUNCTION_PAYLOAD_TOO_LARGE, and a typical music track is
 * 3–8 MB — so routing the file through here silently capped uploads at a size
 * most real files exceed. The browser talks to storage directly and only the
 * metadata comes back to us.
 *
 * Behind the admin session (middleware), and the URL is good for one
 * pathname so it cannot be reused to write anywhere else in the bucket.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isAssetKind, MAX_ASSET_BYTES } from "@/lib/server/assets";
import { ASSET_KINDS } from "@/lib/types";
import { createSignedUpload } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mirrors the server-side rules, so a link is never issued for a mismatch. */
const ALLOWED_TYPES: Record<string, string[]> = {
  music: ["audio/*"],
  sfx: ["audio/*"],
  motion: ["video/*"],
  // Raster only: ffmpeg cannot decode SVG on the Debian build Modal uses.
  banner: ["image/png", "image/jpeg", "image/webp"],
  intro: ["video/*"],
  outro: ["video/*"],
  clip: ["video/*"],
};

/** "audio/*" matches any audio type; anything else must match exactly. */
function typeAllowed(mime: string, allowed: string[]): boolean {
  return allowed.some((a) => (a.endsWith("/*") ? mime.startsWith(a.slice(0, -1)) : a === mime));
}

const schema = z.object({
  kind: z.string(),
  pathname: z.string().max(300),
  contentType: z.string().max(120),
  size: z.number().int().positive(),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const { kind } = body;
    if (!isAssetKind(kind)) {
      throw new Error(`kind must be one of ${ASSET_KINDS.join(", ")}`);
    }
    // One flat file name under the kind's own folder, nothing that could
    // climb out of it.
    if (!new RegExp(`^assets/${kind}/[A-Za-z0-9._-]+$`).test(body.pathname)) {
      throw new Error("pathname must be a plain file name under assets/<kind>/");
    }
    if (!typeAllowed(body.contentType, ALLOWED_TYPES[kind])) {
      throw new Error(`${body.contentType} is not a type a ${kind} can be`);
    }
    const limit = MAX_ASSET_BYTES;
    if (body.size > limit) {
      throw new Error(`over ${Math.round(limit / 1024 / 1024)} MB`);
    }

    // The metadata row is written by the browser's follow-up call to
    // /api/admin/assets, which checks the same rules again.
    const signed = await createSignedUpload(body.pathname);
    return NextResponse.json({ uploadUrl: signed.uploadUrl, publicUrl: signed.publicUrl });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Couldn't authorise that upload." },
      { status: 400 }
    );
  }
}
