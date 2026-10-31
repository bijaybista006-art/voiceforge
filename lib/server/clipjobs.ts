/**
 * AI video clips — Wan 2.2 TI2V-5B, text in, MP4 out.
 *
 * Built like presenter clips (lib/server/presenterjobs.ts), on purpose: the
 * same job record, callback token, polling and reconcile; the same backend
 * job protocol (POST /render, GET /render/{id}, GET …/video, DELETE); and the
 * same finish — the MP4 is copied into storage under clips/, because the
 * backend scales to zero and a URL into a container that is gone is no use.
 *
 * Where clips go:
 *   Modal     its own app, https://<ws>--voiceforge-wan[.<region>].modal.run,
 *             with a CPU-only /health at …--voiceforge-wan-health[.<region>]…
 *             that is what gets probed, so status checks never wake the L40S.
 *             The region form is found by trying candidates (wanCandidateUrls).
 *   Notebook  the same tunnel as voice, under /wan (only when the notebook
 *             was started with ENABLE_AI_VIDEO = True).
 * Standard order, free notebooks first, exactly as for voice and presenters.
 */

import type { BackendProvider, BackendView } from "@/lib/types";
import {
  backendFeatures,
  backendHeaders,
  getBackend,
  isUsableHealth,
  listBackends,
  updateBackend,
} from "./backends";
import { putBlob } from "./blob";
import { JobError, callbackToken, getJob, saveJob, type Job } from "./jobs";
import { getRedis, kvDel, kvGet, kvSet } from "./redis";

export const CLIP_CAPABILITY = "text-to-video";

const INDEX = "vf:jobs";
const INDEX_LIMIT = 200;

/**
 * A 720p clip on a free T4 can take most of an hour, plus time queued behind
 * narration. Past this a clip that has not reported back is lost.
 */
export const CLIP_STALE_AFTER_MS = 100 * 60 * 1000;
/** The bucket caps files at 50 MB; anything larger stays on the backend. */
const MAX_COLLECT_BYTES = 48 * 1024 * 1024;
/** A "not ready yet" answer is believed this long; "ready" is kept. */
const WAN_REPROBE_AFTER_MS = 90_000;
const MAX_CLIP_RESTARTS = 1;

// --- limits (mirror backend/wan/settings.py; the backend checks again) -----

export const CLIP_LIMITS = {
  maxPromptChars: 2000,
  minFrames: 5,
  maxFrames: 121,
  aspects: ["landscape", "vertical"] as const,
  qualities: ["720p", "480p"] as const,
};

export type ClipAspect = (typeof CLIP_LIMITS.aspects)[number];
export type ClipQuality = (typeof CLIP_LIMITS.qualities)[number];

export interface ClipInput {
  prompt: string;
  negativePrompt?: string;
  aspect?: ClipAspect;
  /** Omit to let the backend use its own default (720p on Modal, 480p on a T4). */
  quality?: ClipQuality;
  numFrames?: number;
  steps?: number;
  guidance?: number;
  seed?: number;
  source: string;
  callbackUrl?: string;
}

/**
 * Check a request and turn it into the body the backend expects.
 *
 * Pure. Fails here, with a clear message, rather than after a cold GPU
 * container has booted to say the same thing.
 */
export function clipRequestBody(input: Omit<ClipInput, "source" | "callbackUrl">): Record<string, unknown> {
  const prompt = input.prompt?.trim() ?? "";
  if (!prompt) throw new JobError("The prompt is empty. Describe the video you want.", 400, "empty_prompt");
  if (prompt.length > CLIP_LIMITS.maxPromptChars) {
    throw new JobError(
      `The prompt is ${prompt.length} characters; the limit is ${CLIP_LIMITS.maxPromptChars}.`,
      400,
      "prompt_too_long"
    );
  }
  const frames = input.numFrames;
  if (
    frames !== undefined &&
    (!Number.isInteger(frames) ||
      frames < CLIP_LIMITS.minFrames ||
      frames > CLIP_LIMITS.maxFrames ||
      (frames - 1) % 4 !== 0)
  ) {
    throw new JobError(
      `num_frames must be 4k+1 between ${CLIP_LIMITS.minFrames} and ${CLIP_LIMITS.maxFrames} (49 = 2 s, 81 = 3.4 s, 121 = 5 s).`,
      400,
      "invalid_frames"
    );
  }
  const body: Record<string, unknown> = {
    prompt,
    aspect: input.aspect ?? "landscape",
    negative_prompt: input.negativePrompt?.trim() || undefined,
    quality: input.quality,
    num_frames: frames,
    steps: input.steps,
    guidance: input.guidance,
    seed: input.seed,
  };
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

// --- where a backend makes clips ------------------------------------------

/**
 * Regions a newer Modal app's web URLs carry: `<ws>--<label>.<region>.modal.run`.
 * Apps created before Modal added regions keep `<ws>--<label>.modal.run`, which
 * is why the voice app (old) and the Wan app (new, Oct 2026) differ: seen in
 * the first deploy, voice at …--voiceforge-api.modal.run and Wan at
 * …--voiceforge-wan.us-east.modal.run.
 */
const MODAL_REGIONS = ["us-east", "us-west", "eu-west"];

type WanUrls = { service: string; health: string };

/**
 * Where a backend's Wan service could be, derived from its voice address so
 * nobody has to type it. Most likely first; discoverWan keeps the first one
 * that answers. Empty when the backend cannot have one.
 */
export function wanCandidateUrls(apiUrl: string, selfRegistered = false): WanUrls[] {
  const url = apiUrl.replace(/\/+$/, "");
  const modal = url.match(/^(https:\/\/[^/]+?)-api((?:\.[a-z0-9-]+)?\.modal\.run)$/);
  if (modal) {
    const [, base, suffix] = modal;
    // The voice URL's own form first, then the regional forms a newer app gets.
    const suffixes = [...new Set([suffix, ...MODAL_REGIONS.map((r) => `.${r}.modal.run`), ".modal.run"])];
    return suffixes.map((s) => ({ service: `${base}-wan${s}`, health: `${base}-wan-health${s}` }));
  }
  // A notebook serves clips from its voice tunnel, under /wan.
  return selfRegistered ? [{ service: `${url}/wan`, health: `${url}/wan` }] : [];
}

/** Whether a backend's Wan address should be asked (again) right now. */
export function shouldProbeWan(
  b: Pick<BackendView, "url" | "selfRegistered" | "wanCapabilities" | "wanProbedAt" | "wanProbedUrl">,
  now = Date.now()
): boolean {
  const candidates = wanCandidateUrls(b.url, b.selfRegistered !== false);
  if (!candidates.length) return false;
  if (!candidates.some((c) => c.health === b.wanProbedUrl)) return true; // never asked here
  if (b.wanCapabilities?.includes(CLIP_CAPABILITY)) return false; // it said yes
  return now - (b.wanProbedAt ?? 0) > WAN_REPROBE_AFTER_MS;
}

/** A Wan install report as one line; empty once ready. */
export function wanInstallNote(
  install?: { state?: string; stage?: string; error?: string } | null
): string | undefined {
  if (!install?.state || install.state === "ready" || install.state === "idle") return undefined;
  if (install.state === "failed" || install.state === "missing") {
    return `AI video is not available: ${(install.error ?? "no reason given").slice(0, 300)}`;
  }
  return `it is still installing AI video (${install.stage || "starting"})`;
}

/**
 * Ask a backend's Wan address what it can do, and remember the answer.
 * Best-effort; never throws.
 */
export async function discoverWan(provider: BackendProvider, timeoutMs = 50_000): Promise<string[]> {
  const backend = await getBackend(provider);
  if (!backend) return [];
  const candidates = wanCandidateUrls(backend.url, backend.selfRegistered !== false);
  if (!candidates.length) return backend.wanCapabilities ?? [];
  // The address that answered last time goes first.
  candidates.sort((a, b) => Number(b.health === backend.wanProbedUrl) - Number(a.health === backend.wanProbedUrl));

  // One budget for all candidates, so the Test route stays inside 60 s.
  const deadline = Date.now() + timeoutMs;
  let saidNo = false;
  for (const c of candidates) {
    const left = deadline - Date.now();
    if (left < 1_000) break;
    try {
      const res = await fetch(`${c.health}/health`, {
        headers: backendHeaders(),
        signal: AbortSignal.timeout(left),
      });
      if (!res.ok) {
        // Nothing deployed at this address (or a notebook without AI video).
        saidNo = true;
        continue;
      }
      const health = (await res.json()) as {
        capabilities?: string[];
        limits?: Record<string, unknown>;
        install?: { state?: string; stage?: string; error?: string };
      };
      const caps = (health.capabilities ?? []).filter((x) => x === CLIP_CAPABILITY);
      await updateBackend(provider, {
        wanProbedAt: Date.now(),
        wanProbedUrl: c.health,
        wanUrl: c.service,
        wanCapabilities: caps,
        wanNote: wanInstallNote(health.install),
        ...(health.limits ? { wanLimits: health.limits } : {}),
      });
      return caps;
    } catch {
      // Unreachable or slow here: try the next form.
    }
  }

  // Recorded either way, so it is asked again after a pause, not every view.
  const asked = { wanProbedAt: Date.now(), wanProbedUrl: candidates[0].health };
  if (saidNo) {
    await updateBackend(provider, { ...asked, wanCapabilities: [] });
    return [];
  }
  // Nothing answered at all — asleep or slow. Keep whatever was known.
  await updateBackend(provider, asked).catch(() => {});
  return backend.wanCapabilities ?? [];
}

/** Ask every backend that is due to be asked. True if anything new was learned. */
export async function discoverMissingWan(timeoutMs = 15_000): Promise<boolean> {
  const due = (await listBackends()).filter(
    (b) => b.enabled && b.health !== "offline" && shouldProbeWan(b)
  );
  if (!due.length) return false;
  const found = await Promise.all(due.map((b) => discoverWan(b.provider, timeoutMs)));
  return found.some((caps) => caps.length > 0);
}

/**
 * Which backends may make a clip, in the order given (listBackends returns
 * the standard order). Pure. Honours the backend's own "AI video" switch
 * (clipsEnabled), not the Presenter one.
 */
export function pickClipBackends(backends: BackendView[]): BackendView[] {
  return backends.filter(
    (b) =>
      isUsableHealth(b.health) &&
      backendFeatures(b).clips &&
      !!b.wanUrl &&
      (b.wanCapabilities ?? []).includes(CLIP_CAPABILITY)
  );
}

export interface ClipReadiness {
  ready: boolean;
  provider?: string;
  /** Why not, phrased as the next thing to do. */
  reason?: string;
  /** What the backend that would take the clip advertised. */
  limits?: Record<string, unknown>;
  /** While ready: what other backends are still doing, e.g. installing. */
  also?: string;
}

/** Can a clip be made right now — and if not, why not? Pure. */
export function clipReadiness(backends: BackendView[]): ClipReadiness {
  const usable = pickClipBackends(backends);
  // A backend with AI video switched off is not installing anything worth
  // mentioning — a notebook skips the install entirely in that case.
  const notes = backends
    .filter((b) => b.wanNote && isUsableHealth(b.health) && backendFeatures(b).clips && !usable.includes(b))
    .map((b) => `${b.provider}: ${b.wanNote}`);
  if (usable.length) {
    return {
      ready: true,
      provider: usable[0].provider,
      ...(usable[0].wanLimits ? { limits: usable[0].wanLimits } : {}),
      ...(notes.length ? { also: notes.join("; ") } : {}),
    };
  }
  const capable = backends.filter((b) => (b.wanCapabilities ?? []).includes(CLIP_CAPABILITY));
  if (capable.length && capable.every((b) => !backendFeatures(b).clips)) {
    return {
      ready: false,
      reason: "AI video is switched off on every backend that can make clips. Turn it on in Admin → Backends.",
    };
  }
  if (capable.length) {
    return { ready: false, reason: "The backend that makes clips is offline. Start it, or check Admin → Backends." };
  }
  if (notes.length) return { ready: false, reason: notes.join("; ") };
  return {
    ready: false,
    reason:
      "No backend can make AI video yet. Deploy modal/voiceforge_wan.py, or start a notebook with ENABLE_AI_VIDEO = True.",
  };
}

async function requireTargets(): Promise<BackendView[]> {
  // Cheap unless a backend is due to be asked; without it a notebook that
  // just finished installing would only be noticed by pressing Test.
  await discoverMissingWan(12_000);
  const targets = pickClipBackends(await listBackends());
  if (!targets.length) {
    throw new JobError(clipReadiness(await listBackends()).reason ?? "No backend can make AI video.", 503, "no_clip_backend");
  }
  return targets;
}

// --- jobs ------------------------------------------------------------------

async function newClipJob(first: BackendView, input: ClipInput, request: Record<string, unknown>, appUrl: string): Promise<Job> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const job: Job = {
    id,
    status: "queued",
    kind: "clip",
    mode: "stitch",
    format: "mp3",
    voiceId: "",
    source: input.source,
    chars: String(request.prompt ?? "").length,
    chunks: 1,
    createdAt: now,
    updatedAt: now,
    backend: first.provider,
    callbackUrl: input.callbackUrl,
    clip: { request, appUrl },
  };
  await saveJob(job);
  await kvSet(
    INDEX,
    [id, ...((await kvGet<string[]>(INDEX)) ?? []).filter((x) => x !== id)].slice(0, INDEX_LIMIT)
  );
  return job;
}

/** Hand a clip to the first backend that accepts it. */
async function dispatchClip(job: Job, targets: BackendView[]): Promise<Job> {
  const plan = job.clip!;
  // A clip sent again (lost, or failed on one backend) keeps the seed the
  // first backend chose, so the retry makes the same clip.
  const seed = plan.request.seed ?? plan.settings?.seed;
  const body = {
    ...plan.request,
    ...(seed !== undefined ? { seed } : {}),
    job_id: job.id,
    callback_url: `${plan.appUrl.replace(/\/+$/, "")}/api/internal/jobs/${job.id}/complete`,
    callback_token: await callbackToken(job.id),
  };

  const failures: string[] = [];
  for (const t of targets) {
    const url = t.wanUrl!.replace(/\/+$/, "");
    try {
      const res = await fetch(`${url}/render`, {
        method: "POST",
        headers: backendHeaders(),
        body: JSON.stringify(body),
        // Covers a cold container booting; the clip is made in the backend's
        // own worker, this only waits for it to be accepted.
        signal: AbortSignal.timeout(50_000),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        // 400 is the request, not the backend: no other backend will accept it.
        if (res.status === 400) {
          const saved = await saveJob({ ...job, status: "error", error: detail.slice(0, 400) });
          throw new JobError(`The clip request was refused: ${saved.error}`, 400, "invalid_request");
        }
        throw new Error(`backend returned ${res.status} ${detail.slice(0, 200)}`);
      }
      const accepted = (await res.json().catch(() => ({}))) as { settings?: Record<string, unknown> };
      return saveJob({
        ...job,
        backend: t.provider,
        backendUrl: url,
        status: "running",
        stage: "queued on the GPU",
        progress: 0,
        error: undefined,
        clip: { ...plan, ...(accepted.settings ? { settings: accepted.settings } : {}) },
      });
    } catch (e) {
      if (e instanceof JobError) throw e;
      failures.push(`${t.provider}: ${e instanceof Error ? e.message : "could not reach the video backend"}`);
    }
  }
  const failed = await saveJob({ ...job, status: "error", error: failures.join("; ") });
  throw new JobError(`Couldn't start the clip on ${failed.error}`, 502, "dispatch_failed");
}

/** Start a clip. Throws JobError (400 / 503 / 502) when it cannot. */
export async function createAndDispatchClip(input: ClipInput, appUrl: string): Promise<Job> {
  const request = clipRequestBody(input);
  const targets = await requireTargets();
  const job = await newClipJob(targets[0], input, request, appUrl);
  return dispatchClip(job, targets);
}

export interface ClipResult {
  status: string;
  duration?: number;
  gen_seconds?: number;
  bytes?: number;
  error?: string;
  settings?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
}

/** Finish a clip: copy it into storage and record where it is. */
export async function completeClip(job: Job, result: ClipResult): Promise<Job> {
  if (result.status !== "done") {
    // One backend failing (a T4 out of memory at 720p) is not the clip
    // failing: offer it to the next backend in the order first.
    const moved = await moveToNextBackend(job, result.error ?? "the clip failed");
    if (moved) return moved;
    return saveJob({ ...job, status: "error", error: result.error ?? "the clip failed" });
  }

  // The callback and a poll can both get here; only one may collect.
  const fresh = await getJob(job.id);
  if (fresh && (fresh.status === "done" || fresh.status === "error")) return fresh;
  const lockKey = `job:${job.id}:collecting`;
  const redis = getRedis();
  if (redis) {
    const owned = await redis.set(lockKey, String(Date.now()), { nx: true, ex: 180 });
    if (owned !== "OK") return fresh ?? job;
  }
  try {
    return await collectClip(fresh ?? job, result);
  } finally {
    await kvDel(lockKey).catch(() => false);
  }
}

async function collectClip(job: Job, result: ClipResult): Promise<Job> {
  const done: Job = {
    ...job,
    status: "done",
    stage: "done",
    progress: 100,
    duration: result.duration,
    genSeconds: result.gen_seconds,
    videoBytes: result.bytes,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    clip: { ...job.clip!, ...(result.settings ? { settings: result.settings } : {}) },
  };
  const backendCopy = `${job.backendUrl}/render/${job.id}/video?token=${await callbackToken(job.id)}`;
  if ((result.bytes ?? 0) > MAX_COLLECT_BYTES) return saveJob({ ...done, videoUrl: backendCopy });

  try {
    const res = await fetch(`${job.backendUrl}/render/${job.id}/video`, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(45_000),
    });
    if (!res.ok) throw new Error(`backend returned ${res.status}`);
    const stored = await putBlob(`clips/${job.id}.mp4`, await res.arrayBuffer(), "video/mp4", { jobId: job.id });
    // Collected; the backend can drop its copy.
    void fetch(`${job.backendUrl}/render/${job.id}`, {
      method: "DELETE",
      headers: backendHeaders(),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
    return saveJob({ ...done, videoUrl: stored.url });
  } catch (e) {
    // The clip is made; point at the backend's copy rather than lose it.
    console.warn("[voiceforge] clip not copied to storage:", e);
    return saveJob({ ...done, videoUrl: backendCopy });
  }
}

/** Offer a failed clip to the next backend that can make it. Null if none. */
async function moveToNextBackend(job: Job, why: string): Promise<Job | null> {
  if (!job.clip || !job.backend) return null;
  const failedOn = [...new Set([...(job.clip.failedOn ?? []), job.backend])];
  try {
    const targets = (await requireTargets()).filter((t) => !failedOn.includes(t.provider));
    if (!targets.length) return null;
    console.warn(`[voiceforge] clip ${job.id} failed on ${job.backend} (${why.slice(0, 120)}); trying ${targets[0].provider}`);
    return await dispatchClip({ ...job, clip: { ...job.clip, failedOn }, error: undefined }, targets);
  } catch {
    return null;
  }
}

/** Send a clip its backend lost (scaled down, redeployed) once more. */
async function restartLostClip(job: Job): Promise<Job | null> {
  if (!job.clip || (job.clip.restarts ?? 0) >= MAX_CLIP_RESTARTS) return null;
  try {
    const targets = await requireTargets();
    return await dispatchClip({ ...job, clip: { ...job.clip, restarts: (job.clip.restarts ?? 0) + 1 } }, targets);
  } catch {
    return null;
  }
}

/** Ask the backend how a clip is doing — the lost-callback safety net. */
export async function reconcileClip(job: Job): Promise<Job> {
  if (job.status === "done" || job.status === "error" || !job.backendUrl) return job;

  if (Date.now() - job.createdAt > CLIP_STALE_AFTER_MS) {
    return saveJob({ ...job, status: "error", error: "the clip never reported back within 100 minutes" });
  }

  try {
    const res = await fetch(`${job.backendUrl}/render/${job.id}`, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      // A collector drops the backend copy just before it records "done".
      const redis = getRedis();
      if (redis && (await redis.exists(`job:${job.id}:collecting`).catch(() => 0)) === 1) return job;
      const latest = await getJob(job.id);
      if (latest && (latest.status === "done" || latest.status === "error")) return latest;
      const restarted = await restartLostClip(job);
      if (restarted) return restarted;
      return saveJob({ ...job, status: "error", error: "the backend restarted before this clip finished" });
    }
    if (!res.ok) return job;
    const r = (await res.json()) as ClipResult & {
      progress?: number;
      stage?: string;
      gpu?: string;
      load_seconds?: number;
      oom?: boolean;
    };
    if (r.status === "done" || r.status === "error") {
      // The callback groups these as `diagnostics`; a status read has them flat.
      const diagnostics =
        r.diagnostics ??
        Object.fromEntries(
          Object.entries({ gpu: r.gpu, load_seconds: r.load_seconds, oom: r.oom }).filter(
            ([, v]) => v !== undefined && v !== null
          )
        );
      return completeClip(job, { ...r, diagnostics });
    }
    if (r.progress !== job.progress || r.stage !== job.stage) {
      return saveJob({ ...job, progress: r.progress, stage: r.stage });
    }
    return job;
  } catch {
    return job;
  }
}
