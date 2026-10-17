/**
 * POST /api/internal/jobs/{id}/complete — the backend saying "it's ready".
 *
 * Machine endpoint: authenticated by a callback token derived from the job id
 * and BACKEND_SECRET, so it's valid for exactly one job and needs no storage.
 * Public in middleware for that reason.
 *
 * The body carries metadata only. This handler then pulls each rendered file
 * off the backend and into Blob — see lib/server/jobs.ts for why the audio
 * can't travel in the request.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { collectJob, getJob, isValidCallbackToken, saveJob } from "@/lib/server/jobs";
import { completePresenter } from "@/lib/server/presenterjobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({
  job_id: z.string().optional(),
  kind: z.enum(["tts", "video", "presenter"]).optional(),
  status: z.string(),
  mode: z.enum(["stitch", "items"]).optional(),
  format: z.enum(["mp3", "wav"]).optional(),
  duration: z.number().optional(),
  gen_seconds: z.number().optional(),
  sample_rate: z.number().optional(),
  /** Size of a finished video file. */
  bytes: z.number().optional(),
  /**
   * Which engine really ran. Absent from this schema, zod stripped it before
   * the job record ever saw it — so a substituted model reported itself
   * faithfully all the way to here and then vanished.
   */
  engine_used: z.string().max(60).optional(),
  /** What each chunk did on the GPU: model, tag, lengths, what stopped it. */
  diagnostics: z.record(z.unknown()).optional(),
  /** Expressive narration: what was applied, and per-sentence detail. */
  params_used: z.record(z.unknown()).optional(),
  segments: z.array(z.record(z.unknown())).max(5000).optional(),
  /** Scene timings for a video render, same journey. */
  timeline: z
    .array(
      z.object({
        index: z.number().int(),
        // Defaulted, so a backend that predates the label still parses.
        kind: z.enum(["intro", "scene", "outro"]).default("scene"),
        start: z.number(),
        end: z.number(),
      })
    )
    .optional(),
  items: z
    .array(
      z.object({
        index: z.number().int().min(0),
        duration: z.number(),
        bytes: z.number().optional(),
      })
    )
    .optional(),
  error: z.string().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  if (!(await isValidCallbackToken(id, req.headers.get("x-callback-token")))) {
    return NextResponse.json({ error: "invalid callback token" }, { status: 401 });
  }

  const job = await getJob(id);
  if (!job) return NextResponse.json({ error: "unknown job" }, { status: 404 });
  // Already collected — a retried callback must not re-download everything.
  if (job.status === "done") return NextResponse.json({ ok: true, already: true });

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  // Video rendering moved out of VoiceForge. A late callback for an old
  // render job is acknowledged and otherwise ignored.
  const collected =
    job.kind === "presenter"
      ? await completePresenter(job, body)
      : job.kind === "video" || body.kind === "video"
        ? job
        : await collectJob(job, body);

  // Hand the finished job to whoever asked for a callback (n8n's Wait node
  // resume URL, typically). Failures here must not fail the collection, so
  // this is best-effort and recorded either way.
  if (collected.callbackUrl && !collected.callbackSentAt) {
    try {
      await fetch(collected.callbackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          job_id: collected.id,
          status: collected.status,
          duration: collected.duration,
          audio_url: collected.audioUrl,
          video_url: collected.videoUrl,
          items: collected.items?.map((i) => ({
            index: i.index,
            duration: i.duration,
            audio_url: i.audioUrl,
          })),
          error: collected.error,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      await saveJob({ ...collected, callbackSentAt: Date.now() });
    } catch (e) {
      console.warn("[voiceforge] job callback failed:", e);
    }
  }

  return NextResponse.json({ ok: true, status: collected.status });
}
