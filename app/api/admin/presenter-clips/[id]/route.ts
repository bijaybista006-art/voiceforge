/**
 * Poll one presenter clip from the studio.
 *
 * A poll is also what moves a text job forward: once its narration has
 * finished, this is where the lip-sync gets started. See reconcilePresenter.
 */

import { NextResponse, type NextRequest } from "next/server";
import { getJob } from "@/lib/server/jobs";
import { reconcilePresenter } from "@/lib/server/presenterjobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Don't hammer a backend: only look again once it has had time to progress. */
const RECONCILE_AFTER_MS = 4_000;

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let job = await getJob(id);
  if (!job || job.kind !== "presenter") {
    return NextResponse.json({ error: "No presenter clip with that id." }, { status: 404 });
  }

  if (
    (job.status === "running" || job.status === "queued") &&
    Date.now() - job.updatedAt > RECONCILE_AFTER_MS
  ) {
    job = await reconcilePresenter(job);
  }

  return NextResponse.json({
    jobId: job.id,
    status: job.status,
    stage: job.stage ?? null,
    progress: job.progress ?? null,
    backend: job.backend ?? null,
    presenterId: job.presenter?.id ?? null,
    voiceId: job.voiceId || null,
    videoUrl: job.videoUrl ?? null,
    audioUrl: job.audioUrl ?? null,
    duration: job.duration ?? null,
    genSeconds: job.genSeconds ?? null,
    error: job.error ?? null,
    diagnostics: job.diagnostics ?? null,
    createdAt: job.createdAt,
  });
}
