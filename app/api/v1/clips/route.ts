/**
 * POST /api/v1/clips — an AI video clip from a text prompt (Wan 2.2).
 *
 * Answers 202 with a job to poll at /api/v1/jobs/{id}. The finished job
 * carries `video_url` (an MP4 in storage, 24 fps) and `settings` — everything
 * the backend used, including the seed, so a good clip can be made again.
 *
 * GET /api/v1/clips — whether a clip can be made right now, and the limits of
 * the backend that would make it.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, appUrlFrom, authenticate, checkQuota } from "@/lib/server/apiauth";
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

const schema = z
  .object({
    prompt: z.string().trim().min(1).max(CLIP_LIMITS.maxPromptChars),
    /** Omit for the standard Wan negative prompt. */
    negative_prompt: z.string().trim().max(CLIP_LIMITS.maxPromptChars).optional(),
    /** landscape = 16:9 YouTube, vertical = Shorts. */
    aspect: z.enum(CLIP_LIMITS.aspects).optional(),
    /** Omit for the backend's default: 720p on Modal, 480p on a free T4. */
    quality: z.enum(CLIP_LIMITS.qualities).optional(),
    /** 4k+1, up to 121 (~5 s at 24 fps). */
    num_frames: z.number().int().min(CLIP_LIMITS.minFrames).max(CLIP_LIMITS.maxFrames).optional(),
    steps: z.number().int().min(1).max(100).optional(),
    guidance: z.number().min(0).max(20).optional(),
    seed: z.number().int().min(0).max(2 ** 32 - 1).optional(),
    callback_url: z.string().url().max(1000).optional(),
  })
  // Unknown fields are ignored, never a 400 — same promise as every endpoint.
  .passthrough();

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  await discoverMissingWan(12_000);
  return NextResponse.json(clipReadiness(await listBackends()));
}

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (e) {
    const issue = e instanceof z.ZodError ? e.issues[0] : null;
    return apiError(
      issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid JSON body.",
      400,
      "invalid_request"
    );
  }

  // Quota is counted in characters of text to speak; a clip speaks none, so
  // this only stops a key that is already over its limit.
  const overQuota = await checkQuota(auth.key, 0);
  if (overQuota) return overQuota;

  const appUrl = appUrlFrom(req);
  try {
    const job = await createAndDispatchClip(
      {
        prompt: body.prompt,
        negativePrompt: body.negative_prompt,
        aspect: body.aspect,
        quality: body.quality,
        numFrames: body.num_frames,
        steps: body.steps,
        guidance: body.guidance,
        seed: body.seed,
        source: auth.key.id,
        callbackUrl: body.callback_url,
      },
      appUrl
    );
    return NextResponse.json(
      {
        job_id: job.id,
        status: job.status,
        stage: job.stage,
        status_url: `${appUrl}/api/v1/jobs/${job.id}`,
        backend: job.backend,
        ...(job.clip?.settings ? { settings: job.clip.settings } : {}),
      },
      { status: 202 }
    );
  } catch (e) {
    if (e instanceof JobError) return apiError(e.message, e.status, e.code);
    console.warn("[voiceforge] clip dispatch failed:", e);
    return apiError("Couldn't start the clip.", 500, "internal_error");
  }
}
