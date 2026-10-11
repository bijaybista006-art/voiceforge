/**
 * Hands the browser a short-lived token so it can upload a presenter file
 * straight to Blob. The file never passes through a Vercel function.
 *
 * Behind the admin session (middleware). The token is scoped to one pathname
 * under presenters/<kind>/ and to the media types that kind may be.
 */

import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { isPresenterKind, maxBytesFor } from "@/lib/server/presenters";
import { PRESENTER_KINDS } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Mirrors assertPresenterFile, so a token is never issued for a mismatch. */
const ALLOWED_TYPES: Record<string, string[]> = {
  recording: ["video/mp4", "video/quicktime", "video/webm"],
  image: ["image/png", "image/jpeg", "image/webp"],
};

export async function POST(req: Request) {
  const body = (await req.json()) as HandleUploadBody;

  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const kind = String(
          (JSON.parse(clientPayload || "{}") as { kind?: string }).kind ?? ""
        );
        if (!isPresenterKind(kind)) {
          throw new Error(`kind must be one of ${PRESENTER_KINDS.join(", ")}`);
        }
        if (!pathname.startsWith(`presenters/${kind}/`)) {
          throw new Error("pathname must sit under presenters/<kind>/");
        }
        return {
          allowedContentTypes: ALLOWED_TYPES[kind],
          maximumSizeInBytes: maxBytesFor(kind),
          addRandomSuffix: false,
          validUntil: Date.now() + 30 * 60 * 1000,
          tokenPayload: clientPayload ?? "",
        };
      },
      // The metadata row is written by the browser's follow-up call to
      // /api/admin/presenters: onUploadCompleted never fires against
      // localhost, and a path that only works in production never gets tested.
      onUploadCompleted: async () => {},
    });

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Couldn't authorise that upload." },
      { status: 400 }
    );
  }
}
