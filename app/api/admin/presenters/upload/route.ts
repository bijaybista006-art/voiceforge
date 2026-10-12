/**
 * Hands the browser a signed URL so it can upload a presenter file straight
 * to storage. The file never passes through a Vercel function.
 *
 * Behind the admin session (middleware). The URL is good for one pathname
 * under presenters/<kind>/, and only for the media types that kind may be.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { isPresenterKind, maxBytesFor } from "@/lib/server/presenters";
import { PRESENTER_KINDS } from "@/lib/types";
import { createSignedUpload } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mirrors assertPresenterFile, so a link is never issued for a mismatch. */
const ALLOWED_TYPES: Record<string, string[]> = {
  recording: ["video/mp4", "video/quicktime", "video/webm"],
  image: ["image/png", "image/jpeg", "image/webp"],
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
    if (!isPresenterKind(kind)) {
      throw new Error(`kind must be one of ${PRESENTER_KINDS.join(", ")}`);
    }
    // One flat file name under the kind's own folder, nothing that could
    // climb out of it.
    if (!new RegExp(`^presenters/${kind}/[A-Za-z0-9._-]+$`).test(body.pathname)) {
      throw new Error("pathname must be a plain file name under presenters/<kind>/");
    }
    if (!typeAllowed(body.contentType, ALLOWED_TYPES[kind])) {
      throw new Error(`${body.contentType} is not a type a ${kind} can be`);
    }
    const limit = maxBytesFor(kind);
    if (body.size > limit) {
      throw new Error(`over ${Math.round(limit / 1024 / 1024)} MB`);
    }

    // The metadata row is written by the browser's follow-up call to
    // /api/admin/presenters, which checks the same rules again.
    const signed = await createSignedUpload(body.pathname);
    return NextResponse.json({ uploadUrl: signed.uploadUrl, publicUrl: signed.publicUrl });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Couldn't authorise that upload." },
      { status: 400 }
    );
  }
}
