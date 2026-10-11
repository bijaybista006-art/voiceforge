/**
 * POST /api/v1/presenter — a presenter speaking one piece of narration.
 *
 * Give it the audio (a URL, or the id of a finished TTS job) and optionally
 * which presenter; it answers 202 with a job to poll at /api/v1/jobs/{id}.
 * The finished job carries `video_url`, an MP4 that can be handed straight to
 * POST /api/v1/video as an intro or outro clip.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, appUrlFrom, authenticate } from "@/lib/server/apiauth";
import { JobError, getJob } from "@/lib/server/jobs";
import { createAndDispatchPresenter } from "@/lib/server/presenterjobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z
  .object({
    /** Omit to use the default presenter. */
    presenter_id: z.string().trim().min(1).max(120).optional(),
    /** The narration, as a public https URL… */
    audio_url: z.string().url().max(1000).optional(),
    /** …or the id of a finished TTS job, whose audio is used. */
    audio_job_id: z.string().trim().min(1).max(80).optional(),
    /** Denoising steps, 20–50. More is sharper and slower. */
    steps: z.number().int().min(10).max(50).optional(),
    /** 1.0–3.0. Higher follows the audio more closely and can jitter. */
    guidance: z.number().min(1).max(3).optional(),
    seed: z.number().int().min(0).max(2 ** 31).optional(),
    callback_url: z.string().url().max(1000).optional(),
  })
  // Unknown fields are ignored, never a 400 — the same promise the other
  // endpoints make, so a workflow written for a later version still runs.
  .passthrough();

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

  let audioUrl = body.audio_url;
  if (!audioUrl && body.audio_job_id) {
    const audioJob = await getJob(body.audio_job_id);
    if (!audioJob) {
      return apiError(`No job with id "${body.audio_job_id}".`, 404, "unknown_job");
    }
    if (audioJob.status !== "done" || !audioJob.audioUrl) {
      return apiError(
        `Job "${body.audio_job_id}" has no finished audio yet (status: ${audioJob.status}). Wait for it to be done.`,
        409,
        "audio_not_ready"
      );
    }
    audioUrl = audioJob.audioUrl;
  }
  if (!audioUrl) {
    return apiError("Send audio_url or audio_job_id.", 400, "invalid_request");
  }
  if (!audioUrl.startsWith("https://")) {
    return apiError("audio_url must be an https URL.", 400, "invalid_request");
  }

  try {
    const { job, presenter } = await createAndDispatchPresenter(
      {
        presenterId: body.presenter_id ?? null,
        audioUrl,
        steps: body.steps,
        guidance: body.guidance,
        seed: body.seed,
        source: auth.key.id,
        callbackUrl: body.callback_url,
      },
      appUrlFrom(req)
    );
    return NextResponse.json(
      {
        job_id: job.id,
        status: job.status,
        status_url: `${appUrlFrom(req)}/api/v1/jobs/${job.id}`,
        presenter_id: presenter.id,
        presenter_kind: presenter.kind,
        backend: job.backend,
      },
      { status: 202 }
    );
  } catch (e) {
    if (e instanceof JobError) return apiError(e.message, e.status, e.code);
    console.warn("[voiceforge] presenter dispatch failed:", e);
    return apiError("Couldn't start the presenter clip.", 500, "internal_error");
  }
}
