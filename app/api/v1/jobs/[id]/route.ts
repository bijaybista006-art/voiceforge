/**
 * GET /api/v1/jobs/{id} — poll a job.
 *
 * A poll also reconciles: if the job still says "running" we ask the backend
 * directly and finish it if it's ready. That makes the callback an
 * optimization rather than a dependency — a dropped callback costs you one
 * poll interval, not the render.
 */

import { NextResponse } from "next/server";
import { apiError, authenticate } from "@/lib/server/apiauth";
import { getJob, reconcileJob } from "@/lib/server/jobs";
import { reconcileRender } from "@/lib/server/videojobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Don't hammer a backend: only reconcile a job that's had time to progress. */
const RECONCILE_AFTER_MS = 5_000;

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  let job = await getJob(id);
  if (!job) return apiError("No job with that id.", 404, "unknown_job");

  if (
    (job.status === "running" || job.status === "queued") &&
    Date.now() - job.updatedAt > RECONCILE_AFTER_MS
  ) {
    job = job.kind === "video" ? await reconcileRender(job) : await reconcileJob(job);
  }

  return NextResponse.json({
    job_id: job.id,
    status: job.status,
    chars: job.chars,
    chunks: job.chunks,
    backend: job.backend,
    voice_id: job.voiceId,
    format: job.format,
    created_at: new Date(job.createdAt).toISOString(),
    ...(job.duration !== undefined ? { duration: job.duration } : {}),
    ...(job.genSeconds !== undefined ? { gen_seconds: job.genSeconds } : {}),
    ...(job.audioUrl ? { audio_url: job.audioUrl } : {}),
    ...(job.videoUrl ? { video_url: job.videoUrl, bytes: job.videoBytes } : {}),
    ...(job.timeline ? { timeline: job.timeline } : {}),
    ...(job.engineUsed ? { engine_used: job.engineUsed } : {}),
    ...(job.diagnostics ? { diagnostics: job.diagnostics } : {}),
    ...(job.paramsUsed ? { params_used: job.paramsUsed } : {}),
    ...(job.segments ? { segments: job.segments } : {}),
    ...(job.progress !== undefined ? { progress: job.progress, stage: job.stage } : {}),
    ...(job.mode === "items" && job.items
      ? {
          items: job.items.map((i) => ({
            index: i.index,
            duration: i.duration,
            audio_url: i.audioUrl,
          })),
        }
      : {}),
    ...(job.error ? { error: job.error } : {}),
  });
}
