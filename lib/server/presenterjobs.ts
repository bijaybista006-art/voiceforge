/**
 * Presenter clips — a presenter speaking one piece of narration.
 *
 * Shares the job record, callback token and polling with TTS and long-form
 * renders, and finishes like TTS rather than like a render: a presenter clip
 * is an intro or an outro, a few megabytes, so it is copied into Blob once it
 * is done. The backend that made it scales to zero within minutes, and a URL
 * that points at a container which no longer exists is no use to the
 * slideshow render that needs the clip next.
 */

import type { BackendProvider, BackendView, Presenter } from "@/lib/types";
import { backendHeaders, getBackend, updateBackend } from "./backends";
import { putBlob } from "./blob";
import { JobError, callbackToken, saveJob, type Job } from "./jobs";
import { presenterCapability, resolvePresenter, usablePresenterBackends } from "./presenters";
import { kvGet, kvSet } from "./redis";

const INDEX = "vf:jobs";
const INDEX_LIMIT = 200;

/** A clip is seconds of video; if it has not reported in this long it is lost. */
export const PRESENTER_STALE_AFTER_MS = 45 * 60 * 1000;
/** Past this the clip stays on the backend and the job records that URL. */
const MAX_COLLECT_BYTES = 80 * 1024 * 1024;

/** Where a backend takes presenter work — its own address unless it has a dedicated one. */
export function presenterUrlOf(b: Pick<BackendView, "url" | "presenterUrl">): string {
  return (b.presenterUrl ?? b.url).replace(/\/+$/, "");
}

/**
 * Modal serves voice and presenter video from two functions whose URLs differ
 * only in the function name. Derive the second from the first, as the render
 * URL already is, instead of asking for a field nobody could fill in.
 */
export function presenterCandidateUrl(apiUrl: string): string | null {
  const MODAL_API = "-api.modal.run";
  const url = apiUrl.replace(/\/+$/, "");
  return url.endsWith(MODAL_API) ? url.slice(0, -MODAL_API.length) + "-presenter.modal.run" : null;
}

/**
 * Ask a backend's presenter address what it can do, and remember the answer.
 *
 * Stored in its own field, not folded into `capabilities`: that list is
 * rewritten from the voice server's /health on every probe, and the voice
 * server knows nothing about presenter video.
 *
 * Best-effort and never throws — a backend with no presenter function simply
 * has no presenter capabilities.
 */
export async function discoverPresenter(
  provider: BackendProvider,
  timeoutMs = 50_000
): Promise<string[]> {
  const backend = await getBackend(provider);
  if (!backend) return [];
  const candidate = presenterCandidateUrl(backend.url);
  if (!candidate) return backend.presenterCapabilities ?? [];

  try {
    const res = await fetch(`${candidate}/health`, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return backend.presenterCapabilities ?? [];
    const health = (await res.json()) as { capabilities?: string[] };
    const caps = (health.capabilities ?? []).filter((c) => c.startsWith("presenter-"));
    await updateBackend(provider, { presenterUrl: candidate, presenterCapabilities: caps });
    return caps;
  } catch {
    // Asleep, not deployed, or slow to wake. Keep whatever was known.
    return backend.presenterCapabilities ?? [];
  }
}

export interface PresenterJobInput {
  /** Omit to use the default presenter. */
  presenterId?: string | null;
  /** The narration the presenter should speak. */
  audioUrl: string;
  steps?: number;
  guidance?: number;
  seed?: number;
  source: string;
  callbackUrl?: string;
}

export async function createAndDispatchPresenter(
  input: PresenterJobInput,
  appUrl: string
): Promise<{ job: Job; presenter: Presenter }> {
  const presenter = await resolvePresenter(input.presenterId ?? null);
  if (!presenter) {
    throw new JobError(
      input.presenterId
        ? `No presenter with id "${input.presenterId}". GET /api/v1/presenters lists them.`
        : "No presenter_id given and no default presenter is set. Add one in Admin → Presenters.",
      input.presenterId ? 404 : 400,
      "unknown_presenter"
    );
  }

  const targets = await usablePresenterBackends(presenter.kind);
  if (!targets.length) {
    throw new JobError(
      presenter.kind === "recording"
        ? "No backend can lip-sync a recording right now. Check Admin → Presenters for what is missing."
        : "No backend can animate a still image yet. Use a recording presenter, or see Admin → Presenters.",
      503,
      "no_presenter_backend"
    );
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  let job: Job = {
    id,
    status: "queued",
    kind: "presenter",
    mode: "stitch",
    format: "mp3",
    voiceId: "",
    source: input.source,
    chars: 0,
    chunks: 1,
    createdAt: now,
    updatedAt: now,
    backend: targets[0].provider,
    backendUrl: presenterUrlOf(targets[0]),
    callbackUrl: input.callbackUrl,
  };
  await saveJob(job);
  await kvSet(
    INDEX,
    [id, ...((await kvGet<string[]>(INDEX)) ?? []).filter((x) => x !== id)].slice(0, INDEX_LIMIT)
  );

  const body = {
    job_id: id,
    kind: presenter.kind,
    capability: presenterCapability(presenter.kind),
    video_url: presenter.kind === "recording" ? presenter.url : undefined,
    image_url: presenter.kind === "image" ? presenter.url : undefined,
    audio_url: input.audioUrl,
    steps: input.steps,
    guidance: input.guidance,
    seed: input.seed,
    callback_url: `${appUrl.replace(/\/+$/, "")}/api/internal/jobs/${id}/complete`,
    callback_token: await callbackToken(id),
  };

  // Standard order, first one that accepts — the same rule voice follows.
  const failures: string[] = [];
  for (const t of targets) {
    const url = presenterUrlOf(t);
    try {
      const res = await fetch(`${url}/render`, {
        method: "POST",
        headers: backendHeaders(),
        body: JSON.stringify(body),
        // Covers a cold container booting. The clip itself is made in the
        // backend's own worker; this only waits for it to be accepted.
        signal: AbortSignal.timeout(50_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`backend returned ${res.status} ${detail.slice(0, 200)}`);
      }
      job = await saveJob({ ...job, backend: t.provider, backendUrl: url, status: "running" });
      return { job, presenter };
    } catch (e) {
      failures.push(
        `${t.provider}: ${e instanceof Error ? e.message : "could not reach the presenter backend"}`
      );
    }
  }
  job = await saveJob({ ...job, status: "error", error: failures.join("; ") });
  throw new JobError(`Couldn't start the presenter clip on ${job.error}`, 502, "dispatch_failed");
}

interface PresenterResult {
  status: string;
  duration?: number;
  gen_seconds?: number;
  bytes?: number;
  error?: string;
  diagnostics?: Record<string, unknown>;
}

/**
 * Finish a presenter job: copy the clip into Blob and record where it is.
 *
 * If the copy fails the job still completes, pointing at the backend's own
 * copy with the job's download token. That URL only lives as long as the
 * container does, which is why it is the fallback and not the plan.
 */
export async function completePresenter(job: Job, result: PresenterResult): Promise<Job> {
  if (result.status !== "done") {
    return saveJob({ ...job, status: "error", error: result.error ?? "the presenter clip failed" });
  }

  const done = {
    ...job,
    status: "done" as const,
    duration: result.duration,
    genSeconds: result.gen_seconds,
    videoBytes: result.bytes,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
  };
  const backendCopy = `${job.backendUrl}/render/${job.id}/video?token=${await callbackToken(job.id)}`;

  if ((result.bytes ?? 0) > MAX_COLLECT_BYTES) {
    return saveJob({ ...done, videoUrl: backendCopy });
  }

  try {
    const res = await fetch(`${job.backendUrl}/render/${job.id}/video`, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`backend returned ${res.status}`);
    const blob = await putBlob(`presenter-clips/${job.id}.mp4`, await res.arrayBuffer(), "video/mp4");
    // Collected; the backend can drop its copy.
    void fetch(`${job.backendUrl}/render/${job.id}`, {
      method: "DELETE",
      headers: backendHeaders(),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
    return saveJob({ ...done, videoUrl: blob.url });
  } catch (e) {
    console.warn("[voiceforge] presenter clip not copied to Blob:", e);
    return saveJob({ ...done, videoUrl: backendCopy });
  }
}

/** Ask the backend how a clip is doing — the lost-callback safety net. */
export async function reconcilePresenter(job: Job): Promise<Job> {
  if (job.status === "done" || job.status === "error" || !job.backendUrl) return job;

  if (Date.now() - job.createdAt > PRESENTER_STALE_AFTER_MS) {
    return saveJob({
      ...job,
      status: "error",
      error: "the presenter clip never reported back within 45 minutes",
    });
  }

  try {
    const res = await fetch(`${job.backendUrl}/render/${job.id}`, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      if (job.status === "queued") return job;
      return saveJob({
        ...job,
        status: "error",
        error: "the backend restarted before this clip finished",
      });
    }
    if (!res.ok) return job;
    const result = (await res.json()) as PresenterResult & { progress?: number; stage?: string };
    if (result.status === "done" || result.status === "error") {
      return completePresenter(job, result);
    }
    if (result.progress !== undefined && result.progress !== job.progress) {
      return saveJob({ ...job, progress: result.progress, stage: result.stage });
    }
    return job;
  } catch {
    return job;
  }
}
