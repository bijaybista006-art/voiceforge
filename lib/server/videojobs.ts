/**
 * Long-form video render jobs.
 *
 * Shares the job record, callback token and polling machinery with TTS, but
 * completes differently: a 20-minute MP4 is 150–400 MB, so it is never pulled
 * into a Vercel function and pushed to Blob. The backend keeps the file and
 * the job records a URL that n8n downloads directly.
 */

import type { Asset, VideoChapterSpan, VideoScene } from "@/lib/types";
import { backendHeaders, usableRenderBackends } from "./backends";
import { pickAssets } from "./assets";
import { JobError, callbackToken, saveJob, type Job } from "./jobs";
import { kvGet, kvSet } from "./redis";

const KEY = (id: string) => `vf:job:${id}`;
const INDEX = "vf:jobs";
const INDEX_LIMIT = 200;

/** A render can legitimately run for an hour; TTS jobs never do. */
export const RENDER_STALE_AFTER_MS = 3 * 60 * 60 * 1000;

export interface VideoJobInput {
  scenes: VideoScene[];
  /** A pinned scene, `true` to take one from the asset library, or false. */
  intro?: VideoScene | boolean;
  outro?: VideoScene | boolean;
  width: number;
  height: number;
  fps: number;
  motion: "none" | "classic" | "dynamic" | "zoom_in";
  transition: string;
  transitionSeconds: number;
  captions: boolean;
  music: boolean;
  musicTag?: string;
  sfx: boolean;
  /** Extra sound effects at exact times; each tag resolves to one library asset. */
  sfxCues?: Array<{ at: number; tag: string }>;
  banner: boolean;
  source: string;
  callbackUrl?: string;
}

/**
 * Choose the music, banner and sound effects for this render.
 *
 * Done HERE rather than on the backend so a video looks and sounds the same
 * whichever GPU answered, and so Colab needs no asset folder on disk. An
 * empty library yields nothing rather than an error — no music is a fine
 * video, a failed render is not.
 */
async function chooseAssets(input: VideoJobInput, totalSeconds: number) {
  const chosen: {
    musicUrl?: string;
    bannerUrl?: string;
    sfx: Array<{ url: string; at: number }>;
  } = { sfx: [] };

  if (input.music) {
    chosen.musicUrl = (await pickAssets("music", 1, input.musicTag))[0]?.url;
  }
  if (input.banner) {
    chosen.bannerUrl = (await pickAssets("banner", 1))[0]?.url;
  }
  if (input.sfx) {
    // Sparse on purpose: a sting on every cut is right for a 30-second Short
    // and unbearable across twenty minutes. One to open, one to close.
    const open = await pickAssets("sfx", 1, "hit");
    const close = await pickAssets("sfx", 1, "ding");
    const pick = (a: Asset[], at: number) => a[0] && chosen.sfx.push({ url: a[0].url, at });
    pick(open, 0);
    pick(close, Math.max(totalSeconds - 3, 0));
  }
  if (input.sfxCues?.length) {
    // One asset per tag, so every step change makes the same sound.
    const byTag = new Map<string, string | undefined>();
    for (const cue of input.sfxCues) {
      if (!byTag.has(cue.tag)) byTag.set(cue.tag, (await pickAssets("sfx", 1, cue.tag))[0]?.url);
      const url = byTag.get(cue.tag);
      if (url) chosen.sfx.push({ url, at: cue.at });
    }
  }

  return chosen;
}

/**
 * Turn an intro/outro spec into the wire shape the renderer wants.
 *
 * `true` means "whatever the library has", which is how `music` and `banner`
 * have always worked. An empty library yields nothing rather than an error:
 * no intro is a fine video, a failed render is not.
 */
export async function resolveBookend(
  spec: VideoScene | boolean | undefined,
  kind: "intro" | "outro"
): Promise<
  { type: string; url: string; audio_url?: string; seconds?: number } | undefined
> {
  if (!spec) return undefined;
  if (spec === true) {
    const asset = (await pickAssets(kind, 1))[0];
    // Uploads for these kinds are restricted to video/*, so "clip" is right.
    return asset ? { type: "clip", url: asset.url } : undefined;
  }
  return { type: spec.type, url: spec.url, audio_url: spec.audioUrl, seconds: spec.seconds };
}

/**
 * A frame's window has to fit inside the video.
 *
 * zod cannot check this — it needs `width` and `height` from the same
 * request — so it happens here, and it throws a JobError so the caller gets
 * a 400 naming the scene rather than a render that fails ten minutes in.
 */
export function assertFramesFit(scenes: VideoScene[], width: number, height: number): void {
  scenes.forEach((s, i) => {
    if (!s.frame) return;
    const { x, y, w, h } = s.frame.rect;
    if (w <= 0 || h <= 0) {
      throw new JobError(
        `scene ${i}: frame.rect w and h must be positive, got ${w}x${h}`,
        400,
        "bad_frame"
      );
    }
    if (x + w > width || y + h > height) {
      throw new JobError(
        `scene ${i}: frame.rect ${x},${y} ${w}x${h} does not fit inside ${width}x${height}`,
        400,
        "bad_frame"
      );
    }
  });
}

/** Best-effort guess so sfx can be placed and the client sees an estimate. */
export function estimateSeconds(scenes: VideoScene[], minSceneSeconds: number): number {
  return scenes.reduce((n, s) => n + (s.seconds ?? minSceneSeconds), 0);
}

export async function createAndDispatchRender(
  input: VideoJobInput,
  appUrl: string
): Promise<Job> {
  assertFramesFit(input.scenes, input.width, input.height);

  const targets = await usableRenderBackends();
  const target = targets[0];
  if (!target) {
    throw new JobError(
      "No backend can render video right now. Start a notebook, or deploy the Modal render function.",
      503,
      "no_render_backend"
    );
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  const minScene = 4;
  const estimate = estimateSeconds(input.scenes, minScene);

  let job: Job = {
    id,
    status: "queued",
    kind: "video",
    mode: "stitch",
    format: "mp3",
    voiceId: "",
    source: input.source,
    chars: 0,
    chunks: input.scenes.length,
    createdAt: now,
    updatedAt: now,
    backend: target.backend.provider,
    backendUrl: target.url,
    callbackUrl: input.callbackUrl,
  };
  await saveJob(job);
  await kvSet(INDEX, [id, ...((await kvGet<string[]>(INDEX)) ?? []).filter((x) => x !== id)].slice(0, INDEX_LIMIT));

  const assets = await chooseAssets(input, estimate);

  const [intro, outro] = await Promise.all([
    resolveBookend(input.intro, "intro"),
    resolveBookend(input.outro, "outro"),
  ]);

  const body = {
    job_id: id,
    intro,
    outro,
    scenes: input.scenes.map((s) => ({
      type: s.type,
      url: s.url,
      audio_url: s.audioUrl,
      caption: s.caption,
      seconds: s.seconds,
      motion: s.motion,
      frame: s.frame
        ? { overlay_url: s.frame.overlayUrl, rect: s.frame.rect }
        : undefined,
      poster_url: s.posterUrl,
    })),
    width: input.width,
    height: input.height,
    fps: input.fps,
    motion: input.motion,
    transition: input.transition,
    transition_seconds: input.transitionSeconds,
    captions: input.captions,
    min_scene_seconds: minScene,
    banner_url: assets.bannerUrl,
    music_url: assets.musicUrl,
    sfx: assets.sfx.map((s) => ({ url: s.url, at: s.at })),
    callback_url: `${appUrl.replace(/\/+$/, "")}/api/internal/jobs/${id}/complete`,
    callback_token: await callbackToken(id),
  };

  // Under "auto" every render-capable backend is a candidate, best first, so
  // one that refuses (a disabled Modal workspace, a dead tunnel) is skipped.
  const failures: string[] = [];
  for (const t of targets) {
    try {
      const res = await fetch(`${t.url}/render`, {
        method: "POST",
        headers: backendHeaders(),
        body: JSON.stringify(body),
        // Long enough for a cold container to boot; the render itself happens
        // in the backend's own worker, so this only covers acceptance.
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`backend returned ${res.status} ${detail.slice(0, 200)}`);
      }
      return saveJob({ ...job, backend: t.backend.provider, backendUrl: t.url, status: "running" });
    } catch (e) {
      failures.push(
        `${t.backend.provider}: ${e instanceof Error ? e.message : "could not reach the render backend"}`
      );
    }
  }
  job = await saveJob({ ...job, status: "error", error: failures.join("; ") });
  throw new JobError(`Couldn't start the render on ${job.error}`, 502, "dispatch_failed");
}

/**
 * Finish a video job from the backend's callback.
 *
 * No collection step: the file stays on the backend and the job records the
 * URL to fetch it from. Pulling 400 MB through a Vercel function to put it in
 * Blob would be slow, expensive and pointless when n8n can download it
 * directly.
 */
export async function completeRender(
  job: Job,
  result: {
    status: string;
    duration?: number;
    gen_seconds?: number;
    bytes?: number;
    scenes?: number;
    timeline?: VideoChapterSpan[];
    error?: string;
  }
): Promise<Job> {
  if (result.status !== "done") {
    return saveJob({ ...job, status: "error", error: result.error ?? "render failed" });
  }
  // Carry the job's own callback token so n8n can download the file with a
  // plain GET — a download node can't set the backend-secret header.
  const token = await callbackToken(job.id);
  return saveJob({
    ...job,
    status: "done",
    duration: result.duration,
    genSeconds: result.gen_seconds,
    videoBytes: result.bytes,
    timeline: result.timeline,
    videoUrl: `${job.backendUrl}/render/${job.id}/video?token=${token}`,
  });
}

/** Ask the render backend how a job is doing — the lost-callback safety net. */
export async function reconcileRender(job: Job): Promise<Job> {
  if (job.status === "done" || job.status === "error" || !job.backendUrl) return job;

  if (Date.now() - job.createdAt > RENDER_STALE_AFTER_MS) {
    return saveJob({
      ...job,
      status: "error",
      error: "the render never reported back within three hours",
    });
  }

  try {
    const res = await fetch(`${job.backendUrl}/render/${job.id}`, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      // Not yet dispatched is not the same as forgotten — see the same guard
      // in jobs.ts. Only a render the backend once acknowledged can be lost
      // to a restart.
      if (job.status === "queued") return job;
      return saveJob({
        ...job,
        status: "error",
        error: "the backend restarted before this render finished",
      });
    }
    if (!res.ok) return job;
    const result = (await res.json()) as {
      status: string;
      progress?: number;
      stage?: string;
      duration?: number;
      gen_seconds?: number;
      bytes?: number;
      error?: string;
    };
    if (result.status === "done" || result.status === "error") {
      return completeRender(job, result);
    }
    // Still going — record progress so the Jobs page can show it.
    if (result.progress !== undefined && result.progress !== job.progress) {
      return saveJob({ ...job, progress: result.progress, stage: result.stage });
    }
    return job;
  } catch {
    return job;
  }
}
