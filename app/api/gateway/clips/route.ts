/**
 * AI video clips for the studio. Behind the admin session (middleware); the
 * browser never learns a backend URL or the backend secret.
 *
 * GET  -> can a clip be made right now, and with what limits
 * POST -> start one; poll GET /api/gateway/clips/{id}
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { appUrlFrom } from "@/lib/server/apiauth";
import { listBackends } from "@/lib/server/backends";
import {
  CLIP_LIMITS,
  clipReadiness,
  createAndDispatchClip,
  discoverMissingWan,
} from "@/lib/server/clipjobs";
import { JobError } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  prompt: z.string().trim().min(1).max(CLIP_LIMITS.maxPromptChars),
  negativePrompt: z.string().trim().max(CLIP_LIMITS.maxPromptChars).optional(),
  aspect: z.enum(CLIP_LIMITS.aspects).optional(),
  quality: z.enum(CLIP_LIMITS.qualities).optional(),
  numFrames: z.number().int().min(CLIP_LIMITS.minFrames).max(CLIP_LIMITS.maxFrames).optional(),
  steps: z.number().int().min(1).max(100).optional(),
  guidance: z.number().min(0).max(20).optional(),
  seed: z.number().int().min(0).max(2 ** 32 - 1).optional(),
});

export async function GET() {
  await discoverMissingWan(12_000);
  return NextResponse.json(clipReadiness(await listBackends()));
}

export async function POST(req: NextRequest) {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (e) {
    const issue = e instanceof z.ZodError ? e.issues[0] : null;
    return NextResponse.json(
      { error: issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request." },
      { status: 400 }
    );
  }
  try {
    const job = await createAndDispatchClip({ ...body, source: "studio" }, appUrlFrom(req));
    return NextResponse.json(
      { job_id: job.id, status: job.status, stage: job.stage, backend: job.backend, settings: job.clip?.settings ?? null },
      { status: 202 }
    );
  } catch (e) {
    if (e instanceof JobError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    console.warn("[voiceforge] studio clip failed:", e);
    return NextResponse.json({ error: "Couldn't start the clip." }, { status: 500 });
  }
}
