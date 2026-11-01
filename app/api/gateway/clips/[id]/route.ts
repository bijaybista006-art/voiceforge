/**
 * The studio's view of one AI video clip. Behind the admin session.
 *
 * Polling is also what finishes a clip whose completion callback was lost:
 * a running clip that has not moved for a few seconds is asked about.
 */

import { NextResponse } from "next/server";
import { reconcileClip } from "@/lib/server/clipjobs";
import { getJob } from "@/lib/server/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RECONCILE_AFTER_MS = 5_000;

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let job = await getJob(id);
  if (!job || job.kind !== "clip") {
    return NextResponse.json({ error: "No clip with that id.", code: "unknown_job" }, { status: 404 });
  }
  if ((job.status === "running" || job.status === "queued") && Date.now() - job.updatedAt > RECONCILE_AFTER_MS) {
    job = await reconcileClip(job).catch(() => job!);
  }
  return NextResponse.json({
    job_id: job.id,
    status: job.status,
    stage: job.stage ?? null,
    progress: job.progress ?? null,
    backend: job.backend ?? null,
    video_url: job.videoUrl ?? null,
    duration: job.duration ?? null,
    gen_seconds: job.genSeconds ?? null,
    settings: job.clip?.settings ?? null,
    error: job.error ?? null,
    // Why the free GPUs did not make it, when it ran elsewhere.
    skipped: job.clip?.skipped ?? [],
  });
}
