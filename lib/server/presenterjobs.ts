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

import { chunkScript } from "@/lib/chunker";
import { DEFAULT_PARAMS } from "@/lib/config";
import type { BackendProvider, BackendView, LibraryVoice, Presenter } from "@/lib/types";
import { backendHeaders, getBackend, listBackends, updateBackend } from "./backends";
import { putBlob } from "./blob";
import {
  JobError,
  callbackToken,
  createAndDispatchJob,
  getJob,
  reconcileJob,
  saveJob,
  type Job,
} from "./jobs";
import { presenterCapability, resolvePresenter, usablePresenterBackends } from "./presenters";
import { getSettings, getRedis, kvDel, kvGet, kvSet } from "./redis";
import { resolveVoice } from "./voices";

const INDEX = "vf:jobs";
const INDEX_LIMIT = 200;

/** How long a narration is left to its own callback before it is asked about. */
const NARRATION_RECONCILE_AFTER_MS = 8_000;

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

/**
 * Ask every backend that could have a presenter address but has never been
 * asked. Returns true if anything new was learned.
 *
 * This is what makes presenter support appear without anyone pressing Test:
 * the first time it matters — the Presenters page loading, or a clip being
 * requested — the question gets asked, and the answer is stored, so it is
 * asked once and not on every page view.
 */
export async function discoverMissingPresenters(timeoutMs = 15_000): Promise<boolean> {
  const unknown = (await listBackends()).filter(
    (b) =>
      b.enabled &&
      b.presenterCapabilities === undefined &&
      presenterCandidateUrl(b.url) !== null
  );
  if (!unknown.length) return false;
  const found = await Promise.all(unknown.map((b) => discoverPresenter(b.provider, timeoutMs)));
  return found.some((caps) => caps.length > 0);
}

export interface PresenterOptions {
  steps?: number;
  guidance?: number;
  seed?: number;
}

export interface PresenterJobInput extends PresenterOptions {
  /** Omit to use the default presenter. */
  presenterId?: string | null;
  /** The narration the presenter should speak. */
  audioUrl: string;
  source: string;
  callbackUrl?: string;
}

export interface PresenterTextInput extends PresenterOptions {
  presenterId?: string | null;
  /** What the presenter should say. Narrated first, then lip-synced. */
  text: string;
  /** Omit to use the default voice. */
  voiceId?: string | null;
  /** Omit to use the voice's own language. */
  language?: string;
  source: string;
  callbackUrl?: string;
}

/**
 * A presenter line is an intro or an outro. The engine refuses audio past 90
 * seconds; this keeps the text comfortably inside that, so the limit is met
 * here with a clear message rather than on a billed GPU four minutes in.
 */
export const MAX_PRESENTER_TEXT_CHARS = 900;

async function requirePresenter(presenterId?: string | null): Promise<Presenter> {
  const presenter = await resolvePresenter(presenterId ?? null);
  if (!presenter) {
    throw new JobError(
      presenterId
        ? `No presenter with id "${presenterId}". GET /api/v1/presenters lists them.`
        : "No presenter_id given and no default presenter is set. Add one in Admin → Presenters.",
      presenterId ? 404 : 400,
      "unknown_presenter"
    );
  }
  return presenter;
}

async function requireTargets(presenter: Presenter): Promise<BackendView[]> {
  let targets = await usablePresenterBackends(presenter.kind);
  if (!targets.length && (await discoverMissingPresenters(25_000))) {
    targets = await usablePresenterBackends(presenter.kind);
  }
  if (!targets.length) {
    throw new JobError(
      presenter.kind === "recording"
        ? "No backend can lip-sync a recording right now. Check Admin → Presenters for what is missing."
        : "No backend can animate a still image yet. Use a recording presenter, or see Admin → Presenters.",
      503,
      "no_presenter_backend"
    );
  }
  return targets;
}

async function newPresenterJob(
  first: BackendView,
  source: string,
  callbackUrl: string | undefined,
  extra: Partial<Job>
): Promise<Job> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const job: Job = {
    id,
    status: "queued",
    kind: "presenter",
    mode: "stitch",
    format: "mp3",
    voiceId: "",
    source,
    chars: 0,
    chunks: 1,
    createdAt: now,
    updatedAt: now,
    backend: first.provider,
    callbackUrl,
    ...extra,
  };
  await saveJob(job);
  await kvSet(
    INDEX,
    [id, ...((await kvGet<string[]>(INDEX)) ?? []).filter((x) => x !== id)].slice(0, INDEX_LIMIT)
  );
  return job;
}

/** Hand a presenter job to the first backend that accepts it. */
async function dispatchPresenter(
  job: Job,
  presenter: Presenter,
  targets: BackendView[],
  audioUrl: string,
  appUrl: string,
  opts: PresenterOptions
): Promise<Job> {
  const body = {
    job_id: job.id,
    kind: presenter.kind,
    capability: presenterCapability(presenter.kind),
    video_url: presenter.kind === "recording" ? presenter.url : undefined,
    image_url: presenter.kind === "image" ? presenter.url : undefined,
    audio_url: audioUrl,
    steps: opts.steps,
    guidance: opts.guidance,
    seed: opts.seed,
    callback_url: `${appUrl.replace(/\/+$/, "")}/api/internal/jobs/${job.id}/complete`,
    callback_token: await callbackToken(job.id),
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
      return saveJob({
        ...job,
        backend: t.provider,
        backendUrl: url,
        status: "running",
        stage: "lip-syncing",
      });
    } catch (e) {
      failures.push(
        `${t.provider}: ${e instanceof Error ? e.message : "could not reach the presenter backend"}`
      );
    }
  }
  const failed = await saveJob({ ...job, status: "error", error: failures.join("; ") });
  throw new JobError(`Couldn't start the presenter clip on ${failed.error}`, 502, "dispatch_failed");
}

/** A presenter speaking audio that already exists. */
export async function createAndDispatchPresenter(
  input: PresenterJobInput,
  appUrl: string
): Promise<{ job: Job; presenter: Presenter }> {
  const presenter = await requirePresenter(input.presenterId);
  const targets = await requireTargets(presenter);
  const job = await newPresenterJob(targets[0], input.source, input.callbackUrl, {
    // Kept with the job so the clip can be started again if a backend loses it.
    audioUrl: input.audioUrl,
    presenter: {
      id: presenter.id,
      kind: presenter.kind,
      appUrl,
      steps: input.steps,
      guidance: input.guidance,
      seed: input.seed,
    },
  });
  const running = await dispatchPresenter(job, presenter, targets, input.audioUrl, appUrl, input);
  return { job: running, presenter };
}

/**
 * A presenter speaking text: narrate it, then lip-sync the result.
 *
 * Two GPU steps that cannot share one request, so this starts the narration
 * and records what should happen next. The second step is taken the first
 * time the job is polled after the narration finishes — see
 * reconcilePresenter. Nothing has to stay running in between, which is what a
 * platform with no always-on worker needs.
 *
 * The presenter and a backend able to render it are both checked up front, so
 * a request that could never finish fails now instead of after a narration
 * has been paid for.
 */
export async function createPresenterFromText(
  input: PresenterTextInput,
  appUrl: string
): Promise<{ job: Job; presenter: Presenter; voice: LibraryVoice }> {
  const text = input.text.trim();
  if (!text) throw new JobError("There is no text to speak.", 400, "empty_text");
  if (text.length > MAX_PRESENTER_TEXT_CHARS) {
    throw new JobError(
      `That text is ${text.length} characters. A presenter clip is an intro or outro — keep it under ${MAX_PRESENTER_TEXT_CHARS}.`,
      400,
      "text_too_long"
    );
  }

  const presenter = await requirePresenter(input.presenterId);
  const targets = await requireTargets(presenter);

  const voice = await resolveVoice(input.voiceId ?? null);
  if (!voice) {
    throw new JobError(
      input.voiceId
        ? `No voice with id "${input.voiceId}". GET /api/v1/voices lists them.`
        : "No voice_id given and no default voice is set. Add one in Admin → Voices.",
      input.voiceId ? 404 : 400,
      "unknown_voice"
    );
  }

  const language = input.language ?? voice.language;
  const drafts = chunkScript(text, undefined, language, {
    pronunciations: (await getSettings()).pronunciations,
  });
  if (!drafts.length) {
    throw new JobError("That text has nothing to say once normalized.", 400, "empty_text");
  }

  // The narration is an ordinary TTS job, made exactly as /api/v1/tts makes
  // one. WAV, because it is about to be encoded again inside a video.
  const audio = await createAndDispatchJob(
    {
      chunks: drafts.map((d) => d.text),
      paragraphBreaks: drafts.map((d) => d.isParagraphEnd),
      voiceId: voice.id,
      mode: "stitch",
      format: "wav",
      source: input.source,
      params: { ...DEFAULT_PARAMS, language },
    },
    appUrl
  );

  const job = await newPresenterJob(targets[0], input.source, input.callbackUrl, {
    stage: "narrating",
    voiceId: voice.id,
    chars: text.length,
    presenter: {
      id: presenter.id,
      kind: presenter.kind,
      audioJobId: audio.id,
      appUrl,
      steps: input.steps,
      guidance: input.guidance,
      seed: input.seed,
    },
  });
  return { job, presenter, voice };
}

/**
 * Take the second step of a text job once its narration is ready.
 *
 * Returns the job unchanged while the narration is still running, an errored
 * job if the narration failed, and a dispatched job once it has finished.
 */
async function advanceFromNarration(job: Job): Promise<Job> {
  const plan = job.presenter;
  if (!plan?.audioJobId) return job;

  let audio = await getJob(plan.audioJobId);
  if (!audio) {
    return saveJob({ ...job, status: "error", error: "the narration job disappeared" });
  }
  // Leave a narration alone until it has had a few seconds: the completion
  // callback normally finishes it, and asking the backend on every poll only
  // adds traffic.
  if (
    (audio.status === "running" || audio.status === "queued") &&
    Date.now() - audio.updatedAt > NARRATION_RECONCILE_AFTER_MS
  ) {
    audio = await reconcileJob(audio);
  }
  if (audio.status === "error") {
    return saveJob({
      ...job,
      status: "error",
      error: `the narration failed: ${audio.error ?? "unknown error"}`,
    });
  }
  if (audio.status !== "done" || !audio.audioUrl) return job;

  try {
    const presenter = await requirePresenter(plan.id);
    const targets = await requireTargets(presenter);
    return await dispatchPresenter(
      { ...job, audioUrl: audio.audioUrl },
      presenter,
      targets,
      audio.audioUrl,
      plan.appUrl ?? "",
      plan
    );
  } catch (e) {
    // dispatchPresenter has already recorded its own failure; anything else
    // (the presenter was deleted meanwhile, no backend left) is recorded here.
    const latest = await getJob(job.id);
    if (latest?.status === "error") return latest;
    return saveJob({
      ...job,
      status: "error",
      error: e instanceof Error ? e.message : "could not start the lip-sync",
    });
  }
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

  // Two requests can arrive here for the same clip: the backend's completion
  // callback and a status poll. Both used to copy the file into Blob; the
  // second copy was refused because the file already existed, and that
  // caller then overwrote the stored link with the backend's temporary one.
  // Only one may collect. The other returns what is stored and is polled again.
  const fresh = await getJob(job.id);
  if (fresh && (fresh.status === "done" || fresh.status === "error")) return fresh;
  const lockKey = `job:${job.id}:collecting`;
  const redis = getRedis();
  if (redis) {
    const owned = await redis.set(lockKey, String(Date.now()), { nx: true, ex: 180 });
    if (owned !== "OK") return fresh ?? job;
  }
  try {
    return await collectPresenter(job, result);
  } finally {
    await kvDel(lockKey).catch(() => false);
  }
}

async function collectPresenter(job: Job, result: PresenterResult): Promise<Job> {

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

const MAX_CLIP_RESTARTS = 1;

/** Hand a lost clip to a backend again. Null when that is not possible. */
async function restartLostClip(job: Job): Promise<Job | null> {
  const plan = job.presenter;
  if (!plan || !job.audioUrl || !plan.appUrl) return null;
  if ((plan.restarts ?? 0) >= MAX_CLIP_RESTARTS) return null;
  try {
    const presenter = await requirePresenter(plan.id);
    const targets = await requireTargets(presenter);
    return await dispatchPresenter(
      { ...job, presenter: { ...plan, restarts: (plan.restarts ?? 0) + 1 } },
      presenter,
      targets,
      job.audioUrl,
      plan.appUrl,
      plan
    );
  } catch {
    return null;
  }
}

/** Ask the backend how a clip is doing — the lost-callback safety net. */
export async function reconcilePresenter(job: Job): Promise<Job> {
  if (job.status === "done" || job.status === "error") return job;
  // A text job that has not reached a backend yet is still on its first
  // step: waiting for its narration.
  if (!job.backendUrl) return advanceFromNarration(job);

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
      // A collector drops the backend copy just before it records "done".
      // Do not read that gap as a lost clip.
      const redis = getRedis();
      if (redis && (await redis.exists(`job:${job.id}:collecting`).catch(() => 0)) === 1) return job;
      const latest = await getJob(job.id);
      if (latest && (latest.status === "done" || latest.status === "error")) return latest;
      // The backend really has lost it. A presenter backend scales to zero
      // and is replaced on every deploy, and a clip takes minutes, so this
      // is an ordinary event, not an exotic one. Everything needed to make
      // the clip again is on the job, so start it again — once. A second
      // loss is reported, so a backend that keeps dying cannot loop forever.
      const restarted = await restartLostClip(job);
      if (restarted) return restarted;
      return saveJob({
        ...job,
        status: "error",
        error: "the backend restarted before this clip finished",
      });
    }
    if (!res.ok) return job;
    const result = (await res.json()) as PresenterResult & {
      progress?: number;
      stage?: string;
      engine?: string;
      engine_seconds?: number;
      audio_seconds?: number;
      gpu?: string;
      steps?: number;
      guidance?: number;
      sync?: Record<string, unknown>;
    };
    if (result.status === "done" || result.status === "error") {
      // The callback sends these grouped as `diagnostics`; a status read has
      // them flat. Group them here so a clip finished by a poll reports the
      // same facts as one finished by its callback.
      const diagnostics =
        result.diagnostics ??
        Object.fromEntries(
          Object.entries({
            engine: result.engine,
            engine_seconds: result.engine_seconds,
            audio_seconds: result.audio_seconds,
            gpu: result.gpu,
            steps: result.steps,
            guidance: result.guidance,
            sync: result.sync && Object.keys(result.sync).length ? result.sync : undefined,
          }).filter(([, v]) => v !== undefined && v !== null)
        );
      return completePresenter(job, { ...result, diagnostics });
    }
    if (result.progress !== undefined && result.progress !== job.progress) {
      return saveJob({ ...job, progress: result.progress, stage: result.stage });
    }
    return job;
  } catch {
    return job;
  }
}
