/**
 * The studio's "text to presenter video". Behind the admin session
 * (middleware), so it needs no API key — it is the same operation
 * POST /api/v1/presenter performs for a workflow, started from the browser.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { appUrlFrom } from "@/lib/server/apiauth";
import { JobError } from "@/lib/server/jobs";
import { MAX_PRESENTER_TEXT_CHARS, createPresenterFromText } from "@/lib/server/presenterjobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  text: z.string().trim().min(1).max(MAX_PRESENTER_TEXT_CHARS),
  presenterId: z.string().trim().min(1).max(120).optional(),
  voiceId: z.string().trim().min(1).max(120).optional(),
  language: z.string().trim().min(2).max(12).optional(),
});

export async function POST(req: NextRequest) {
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
    const { job, presenter, voice } = await createPresenterFromText(
      {
        text: body.text,
        presenterId: body.presenterId ?? null,
        voiceId: body.voiceId ?? null,
        language: body.language,
        source: "studio",
      },
      appUrlFrom(req)
    );
    return NextResponse.json(
      {
        jobId: job.id,
        status: job.status,
        stage: job.stage,
        presenterId: presenter.id,
        voiceId: voice.id,
        backend: job.backend,
      },
      { status: 202 }
    );
  } catch (e) {
    if (e instanceof JobError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    }
    console.warn("[voiceforge] studio presenter clip failed to start:", e);
    return NextResponse.json({ error: "Couldn't start the clip." }, { status: 500 });
  }
}
