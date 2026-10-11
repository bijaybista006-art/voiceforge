/**
 * The presenter library, admin side. Behind the admin session (middleware).
 *
 * POST takes METADATA only, never the file: the browser uploads straight to
 * Blob with a token from ./upload, because Vercel rejects any request body
 * over 4.5 MB and a 15-second phone recording is several times that.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { listBackends } from "@/lib/server/backends";
import {
  MAX_IMAGE_BYTES,
  MAX_RECORDING_BYTES,
  MAX_RECORDING_SECONDS,
  MIN_RECORDING_SECONDS,
  PresenterError,
  isPresenterStorageReady,
  listPresenters,
  presenterReadiness,
  presenterStorageHint,
  registerPresenter,
} from "@/lib/server/presenters";
import { PRESENTER_KINDS, PRESENTER_SOURCES } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [presenters, backends] = await Promise.all([listPresenters(), listBackends()]);
  return NextResponse.json({
    presenters,
    storageReady: isPresenterStorageReady(),
    hint: presenterStorageHint(),
    limits: {
      recordingBytes: MAX_RECORDING_BYTES,
      imageBytes: MAX_IMAGE_BYTES,
      minSeconds: MIN_RECORDING_SECONDS,
      maxSeconds: MAX_RECORDING_SECONDS,
    },
    // Whether each kind could be rendered right now, and if not, why — so
    // the page never offers a presenter nothing can voice without saying so.
    readiness: {
      recording: presenterReadiness(backends, "recording"),
      image: presenterReadiness(backends, "image"),
    },
  });
}

const schema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(PRESENTER_KINDS),
  url: z.string().url().max(1000),
  mime: z.string().min(3).max(120),
  sizeBytes: z.number().int().min(1).max(MAX_RECORDING_BYTES),
  durationSec: z.number().min(0).max(3600).optional(),
  source: z.enum(PRESENTER_SOURCES),
  confirmed: z.boolean(),
});

export async function POST(req: NextRequest) {
  if (!isPresenterStorageReady()) {
    return NextResponse.json({ error: presenterStorageHint() }, { status: 503 });
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (e) {
    const issue = e instanceof z.ZodError ? e.issues[0] : null;
    return NextResponse.json(
      { error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request." },
      { status: 400 }
    );
  }

  try {
    const presenter = await registerPresenter(body);
    return NextResponse.json({ ok: true, presenter }, { status: 201 });
  } catch (e) {
    if (e instanceof PresenterError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.warn("[voiceforge] presenter registration failed:", e);
    return NextResponse.json({ error: "Couldn't save that presenter." }, { status: 500 });
  }
}
