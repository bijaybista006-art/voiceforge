/**
 * Job history for the admin Jobs page. Behind the admin session (middleware).
 *
 * Listing also reconciles anything still marked running, so a job whose
 * callback was lost resolves itself as soon as someone looks at the page.
 */

import { NextResponse, type NextRequest } from "next/server";
import { deleteJob, listJobs, reconcileJob } from "@/lib/server/jobs";
import { reconcilePresenter } from "@/lib/server/presenterjobs";
import { isRedisConfigured } from "@/lib/server/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const jobs = await listJobs(50);

  const settled = await Promise.all(
    jobs.map(async (job) => {
      // 30s, not the 10s page refresh: each reconcile is a request to the
      // backend, and on Modal that can wake a billed GPU container.
      const stale = Date.now() - job.updatedAt > 30_000;
      return (job.status === "running" || job.status === "queued") && stale
        ? (job.kind === "presenter"
            ? reconcilePresenter(job)
            : job.kind === "video"
              ? Promise.resolve(job)
              : reconcileJob(job)
          ).catch(() => job)
        : job;
    })
  );

  return NextResponse.json({
    jobs: settled.map((j) => ({
      id: j.id,
      status: j.status,
      mode: j.mode,
      format: j.format,
      voiceId: j.voiceId,
      source: j.source,
      chars: j.chars,
      chunks: j.chunks,
      backend: j.backend,
      createdAt: j.createdAt,
      duration: j.duration,
      genSeconds: j.genSeconds,
      audioUrl: j.audioUrl,
      kind: j.kind,
      videoUrl: j.videoUrl,
      progress: j.progress,
      stage: j.stage,
      items: j.items,
      error: j.error,
    })),
    storageConnected: isRedisConfigured(),
  });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Which job?" }, { status: 400 });
  await deleteJob(id);
  return NextResponse.json({ ok: true });
}
