/**
 * The studio's view of one background narration job — used for Nepali
 * chunks, which run as jobs rather than in a single request. Behind the
 * admin session (middleware).
 *
 * Polling is also what finishes a job whose completion callback was lost:
 * a running job that has not moved for a few seconds is asked about.
 */

import { NextResponse } from "next/server";
import { getJob, reconcileJob } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RECONCILE_AFTER_MS = 5_000;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let job = await getJob(id);
  if (!job || (job.kind ?? "tts") !== "tts") {
    return NextResponse.json({ error: "No job with that id.", code: "unknown_job" }, { status: 404 });
  }
  if (
    (job.status === "running" || job.status === "queued") &&
    Date.now() - job.updatedAt > RECONCILE_AFTER_MS
  ) {
    job = await reconcileJob(job).catch(() => job!);
  }
  return NextResponse.json({
    job_id: job.id,
    status: job.status,
    backend: job.backend ?? null,
    audio_url: job.audioUrl ?? job.items?.[0]?.audioUrl ?? null,
    duration: job.duration ?? null,
    gen_seconds: job.genSeconds ?? null,
    error: job.error ?? null,
  });
}
