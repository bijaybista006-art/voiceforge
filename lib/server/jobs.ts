/**
 * TTS jobs — the asynchronous path used by the public API.
 *
 * Why jobs at all: a Vercel function is capped at 60 seconds and a Modal cold
 * start alone can take most of a minute, so no API request may wait for a
 * render. The client gets a job id immediately and either polls or is called
 * back.
 *
 * Lifecycle:
 *   queued  -> dispatched to a backend
 *   running -> the GPU is rendering
 *   done    -> audio collected into Blob, audio_url set
 *   error   -> something failed; `error` says what, in words
 *
 * Completion is driven by the backend's callback, but never *depends* on it:
 * a poll of a stale running job reconciles against the backend directly. A
 * dropped callback therefore costs a delay, not the render.
 */

import { after } from "next/server";
import { resolveSynthesis } from "@/lib/languageProfiles";
import { transliterateForNepali } from "@/lib/nepaliLoanwords";
import type { BackendProvider, LibraryVoice, VideoChapterSpan } from "@/lib/types";
import {
  backendHeaders,
  recordHealthFacts,
  recordReached,
  recordUnreachable,
  usableBackends,
} from "./backends";
import { syncVoiceToBackend } from "./gateway";
import { deleteBlob, putBlob } from "./blob";
import { getRedis, kvDel, kvGet, kvMGet, kvSet } from "./redis";
import { getVoice } from "./voices";
import { getSettings } from "./redis";

const KEY = (id: string) => `vf:job:${id}`;
const INDEX = "vf:jobs";
/** Keep the recent-jobs list bounded — it's an admin view, not an archive. */
const INDEX_LIMIT = 200;

export type JobStatus = "queued" | "running" | "done" | "error";
export type JobMode = "stitch" | "items";

export interface JobItem {
  index: number;
  duration: number;
  audioUrl?: string;
  bytes?: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  /** "tts" by default; video renders share this record but finish differently. */
  kind?: "tts" | "video" | "presenter";
  mode: JobMode;
  format: "mp3" | "wav";
  voiceId: string;
  /** Which API key created it, or "studio". Used for the admin Jobs list. */
  source: string;
  chars: number;
  chunks: number;
  createdAt: number;
  updatedAt: number;
  backend?: BackendProvider;
  backendUrl?: string;
  duration?: number;
  genSeconds?: number;
  audioUrl?: string;
  items?: JobItem[];
  error?: string;
  /** Where to POST the finished job, if the caller asked for a callback. */
  callbackUrl?: string;
  /** Set once we've delivered the callback, so a retry can't double-fire. */
  callbackSentAt?: number;

  // --- video renders only ---
  /** Served by the render backend, not Blob — see lib/server/videojobs.ts. */
  videoUrl?: string;
  videoBytes?: number;
  /**
   * Which engine actually produced the audio — the profile's own, or its
   * fallback. Recorded so a silently substituted model is visible rather
   * than something you only notice by ear.
   */
  engineUsed?: string;
  /** Per-chunk facts from the backend, for diagnosing a bad render. */
  diagnostics?: Record<string, unknown>;
  /**
   * Presenter clips only: which presenter, and — for a clip made from text —
   * the narration job it is waiting on and how to continue once that is done.
   */
  presenter?: {
    id: string;
    kind: "recording" | "image";
    audioJobId?: string;
    appUrl?: string;
    steps?: number;
    guidance?: number;
    seed?: number;
  };
  /** 0-100 while rendering, so a long job isn't a black box. */
  progress?: number;
  stage?: string;
  /** Real start/end seconds of every scene in the finished MP4. */
  timeline?: VideoChapterSpan[];
  /** Expressive narration only: what the backend actually applied. */
  paramsUsed?: Record<string, unknown>;
  /** Expressive narration only: per sentence tone, runs, engines, times. */
  segments?: Record<string, unknown>[];
}

export async function getJob(id: string): Promise<Job | null> {
  return kvGet<Job>(KEY(id));
}

export async function saveJob(job: Job): Promise<Job> {
  const next = { ...job, updatedAt: Date.now() };
  await kvSet(KEY(job.id), next);
  return next;
}

export async function listJobs(limit = 50): Promise<Job[]> {
  const ids = ((await kvGet<string[]>(INDEX)) ?? []).slice(0, limit);
  const rows = await kvMGet<Job>(ids.map(KEY));
  return rows.filter((r): r is Job => Boolean(r));
}

async function indexJob(id: string): Promise<void> {
  const ids = (await kvGet<string[]>(INDEX)) ?? [];
  await kvSet(INDEX, [id, ...ids.filter((x) => x !== id)].slice(0, INDEX_LIMIT));
}

export async function deleteJob(id: string): Promise<void> {
  const job = await getJob(id);
  for (const url of [job?.audioUrl, ...(job?.items ?? []).map((i) => i.audioUrl)]) {
    if (url) await deleteBlob(url);
  }
  await kvDel(KEY(id));
  await kvSet(INDEX, ((await kvGet<string[]>(INDEX)) ?? []).filter((x) => x !== id));
}

// --- callback auth --------------------------------------------------------

/**
 * The token a backend presents when calling us back. Derived from the job id
 * and BACKEND_SECRET, so it needs no storage and is useless for any other job.
 */
export async function callbackToken(jobId: string): Promise<string> {
  const secret = process.env.BACKEND_SECRET ?? "";
  const bytes = new TextEncoder().encode(`${jobId}:${secret}`);
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function isValidCallbackToken(
  jobId: string,
  presented: string | null
): Promise<boolean> {
  if (!presented) return false;
  const expected = await callbackToken(jobId);
  if (presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}

// --- dispatch -------------------------------------------------------------

export interface CreateJobInput {
  chunks: string[];
  paragraphBreaks: boolean[];
  voiceId: string;
  mode: JobMode;
  format: "mp3" | "wav";
  source: string;
  callbackUrl?: string;
  params: Record<string, unknown>;
}

export class JobError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * Make sure the chosen backend actually holds this voice before we hand it a
 * job.
 *
 * The one-chunk path can recover from a cold backend by reacting to a 409 and
 * retrying, but a job renders in a background worker where there is nothing to
 * retry into — an unknown voice just fails the whole render with
 * "voice_not_cached". So the sync happens up front, here.
 *
 * /health lists what's already cached, so a warm backend costs one cheap GET
 * rather than re-uploading the clip on every job.
 */
/**
 * Work that has to finish, but that the caller must not wait for.
 *
 * The task starts immediately; `after` only asks the platform to keep the
 * invocation alive until it settles. Outside a request context — tests, a
 * script — `after` throws and the task simply runs on its own, which is why
 * `flushPending` exists.
 */
const PENDING = new Set<Promise<void>>();

function background(task: () => Promise<void>): void {
  const done = task().catch(() => {});
  PENDING.add(done);
  void done.finally(() => PENDING.delete(done));
  try {
    after(() => done);
  } catch {
    // No request to extend. Nothing else to do: the task is already running.
  }
}

/** Settle any work scheduled by `background`. For tests and scripts. */
export async function flushPending(): Promise<void> {
  while (PENDING.size) await Promise.all([...PENDING]);
}

async function ensureVoiceCached(
  backendUrl: string,
  voiceId: string,
  provider?: BackendProvider
): Promise<void> {
  const voice = await getVoice(voiceId);
  if (!voice) {
    throw new JobError(`No voice with id "${voiceId}".`, 404, "unknown_voice");
  }

  let cached: string[] = [];
  try {
    const res = await fetch(`${backendUrl}/health`, {
      headers: backendHeaders(),
      // Short on purpose: this only tells us whether to skip the upload. A
      // cold backend won't answer, and waiting 15s for that costs budget the
      // dispatch itself needs.
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const health = (await res.json()) as {
        gpu?: string;
        models?: string[];
        version?: string;
        voices_cached?: string[];
      };
      cached = health.voices_cached ?? [];
      if (provider) await recordHealthFacts(provider, health);
    }
  } catch {
    // Couldn't ask — fall through and push the voice anyway. Caching twice is
    // harmless; dispatching a job for a voice the GPU lacks is not.
  }

  if (cached.includes(voiceId)) return;

  try {
    await syncVoiceToBackend(backendUrl, voice);
  } catch {
    // Not fatal: the job payload carries the clip, so the worker will cache
    // it on arrival. Failing here would turn a slow cold start into a dead
    // job, which is exactly what it used to do.
  }
}

/**
 * Create the job, then hand it to a backend.
 *
 * The record is written BEFORE dispatch on purpose: if the backend call fails
 * we still have a job to report the error against, rather than a request that
 * vanished.
 */
export async function createAndDispatchJob(
  input: CreateJobInput,
  appUrl: string
): Promise<Job> {
  const candidates = await usableBackends();
  const backend = candidates[0];
  if (!backend) {
    throw new JobError(
      "No GPU backend is online. Start a notebook, or pick another backend in Admin → Backends.",
      503,
      "no_backend"
    );
  }

  // An unknown voice is the caller's mistake, so it has to come back as a 404
  // from this request — not as a job that quietly fails a minute later. The
  // read is a single Redis GET, which costs nothing against the budget.
  const voice = await getVoice(input.voiceId);
  if (!voice) {
    throw new JobError(`No voice with id "${input.voiceId}".`, 404, "unknown_voice");
  }

  const id = crypto.randomUUID();
  const now = Date.now();
  let job: Job = {
    id,
    status: "queued",
    mode: input.mode,
    format: input.format,
    voiceId: input.voiceId,
    source: input.source,
    chars: input.chunks.reduce((n, c) => n + c.length, 0),
    chunks: input.chunks.length,
    createdAt: now,
    updatedAt: now,
    backend: backend.provider,
    backendUrl: backend.url,
    callbackUrl: input.callbackUrl,
  };
  await saveJob(job);
  await indexJob(id);

  // Request params beat the voice's own overrides, which beat the language
  // profile, which beats the tuned defaults. A language with no profile comes
  // out of this exactly as it went in.
  // params is a loose bag on the way through, so each field is narrowed
  // here rather than trusted — a caller sending cfg: "loud" must not reach
  // the model as a string.
  const p = input.params ?? {};
  const num = (v: unknown) => (typeof v === "number" ? v : undefined);
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const synth = resolveSynthesis({
    language: str(p.language) ?? voice.language,
    voice: voice.synth,
    request: {
      engine: str(p.engine),
      exaggeration: num(p.exaggeration),
      // cfg_weight is the name Chatterbox uses; both spellings accepted.
      cfg: num(p.cfg) ?? num(p.cfg_weight),
      temperature: num(p.temperature),
    },
  });

  // Linked voices (English / tone references) travel with the job only when
  // the request opted into expressive narration — nobody else pays for them.
  const wantsRefs = p.code_switch === true || p.prosody_tags === true;
  const voiceRefs = wantsRefs ? await resolveVoiceRefs(voice) : undefined;

  const body = {
    job_id: id,
    voice_id: input.voiceId,
    ...(voiceRefs ? { voice_refs: voiceRefs } : {}),
    // The backend picks between these two: it is the only place that knows
    // whether the primary model actually loaded, and it reports which it used.
    engine: synth.engine,
    fallback: synth.fallback,
    // Carry the clip with the job so the backend can cache it ITSELF inside
    // its background worker. That worker has no deadline; this request does
    // (Vercel kills it at 60s), and a cold Modal container can eat 30s before
    // it answers at all. Pre-caching from here used to blow that budget and
    // fail the whole job with voice_not_cached / sync_failed.
    voice: voice
      ? {
          audio_url: voice.audioUrl,
          transcript: voice.transcript,
          language: voice.language,
        }
      : undefined,
    // English words inside Nepali text are respelled in Devanagari so one
    // model reads each sentence whole. A request that explicitly asked for
    // code_switch keeps its Latin: that path voices English with the English
    // model, and needs to see it.
    chunks:
      synth.modelLanguage === "ne" && p.code_switch !== true
        ? input.chunks.map((c) =>
            transliterateForNepali(c, p.lexicon as Record<string, string> | undefined)
          )
        : input.chunks,
    paragraph_breaks: input.paragraphBreaks,
    params: {
      ...input.params,
      language: synth.modelLanguage,
      exaggeration: synth.exaggeration,
      cfg: synth.cfg,
      temperature: synth.temperature,
    },
    format: input.format,
    mode: input.mode,
    callback_url: `${appUrl.replace(/\/+$/, "")}/api/internal/jobs/${id}/complete`,
    callback_token: await callbackToken(id),
  };

  // Everything above was Redis. Everything below talks to a GPU that may be
  // cold, and this route is killed at 60 seconds — so it happens AFTER the
  // response. The caller already polls status_url, so it loses nothing by
  // being told "queued" a second from now instead of "running" a minute from
  // now, and a boot slower than the budget no longer fails a job the backend
  // went on to accept anyway.
  background(async () => {
    // Under "auto" every usable backend is a candidate, best first. One that
    // refuses the job (a disabled Modal workspace, a dead tunnel) is skipped,
    // and the job only fails when none of them will take it.
    const failures: string[] = [];
    for (const target of candidates) {
      const attempt: Job = { ...job, backend: target.provider, backendUrl: target.url };
      try {
        // Best-effort warm-up. If the backend is awake this saves it a
        // download; if it's cold it gives up quietly, because the payload
        // carries the clip and the worker caches it with no deadline.
        await ensureVoiceCached(target.url, input.voiceId, target.provider);
      } catch {
        // Already non-fatal by design; the job below still carries the voice.
      }
      try {
        const res = await fetch(`${target.url}/jobs`, {
          method: "POST",
          headers: backendHeaders(),
          body: JSON.stringify(body),
          // Room for a cold container to boot, measured around 30s on Modal.
          signal: AbortSignal.timeout(45_000),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`backend returned ${res.status} ${detail.slice(0, 200)}`);
        }
        // It answered, so the card should stop saying it never has.
        await recordReached(target.provider).catch(() => {});
        await saveJob({ ...attempt, status: "running" });
        return;
      } catch (e) {
        const why = e instanceof Error ? e.message : "could not reach the backend";
        // Put the reason on the backend card too. A hand-added URL never
        // heartbeats, so without this a dead Modal workspace looks healthy
        // right up to the moment a job is handed to it.
        await recordUnreachable(target.provider, why).catch(() => {});
        failures.push(`${target.provider}: ${why}`);
      }
    }
    // The caller is no longer listening, so the job record is the only
    // place this can be reported. Pollers surface it as a failed job.
    await saveJob({
      ...job,
      status: "error",
      error: `Couldn't start the render on ${failures.join("; ")}`,
    });
  });

  return job;
}

export interface VoiceRefPayload {
  voice_id: string;
  audio_url: string;
  transcript: string;
  language: string;
}

/** Turn a voice's linked ids into what the backend needs to cache them. */
export async function resolveVoiceRefs(
  voice: Pick<LibraryVoice, "id" | "refs">
): Promise<Record<string, VoiceRefPayload> | undefined> {
  const out: Record<string, VoiceRefPayload> = {};
  for (const [slot, refId] of Object.entries(voice.refs ?? {})) {
    if (!refId || refId === voice.id) continue;
    const ref = await getVoice(refId);
    // A deleted linked voice just stops being used; it never fails the job.
    if (ref) {
      out[slot] = {
        voice_id: ref.id,
        audio_url: ref.audioUrl,
        transcript: ref.transcript,
        language: ref.language,
      };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

// --- collection -----------------------------------------------------------

interface BackendItem {
  index: number;
  duration: number;
  bytes?: number;
}

export interface BackendResult {
  status: string;
  /** Which engine the backend actually ran, after any fallback. */
  engine_used?: string;
  diagnostics?: Record<string, unknown>;
  mode?: JobMode;
  format?: "mp3" | "wav";
  duration?: number;
  gen_seconds?: number;
  items?: BackendItem[];
  error?: string;
  params_used?: Record<string, unknown>;
  segments?: Record<string, unknown>[];
}

/**
 * Pull every rendered file off the backend and into Blob.
 *
 * This is the step that keeps audio out of request bodies: we GET each file
 * (a response, so no 4.5 MB cap) and stream it straight to storage.
 */
export async function collectJob(job: Job, result: BackendResult): Promise<Job> {
  if (result.status === "error") {
    return saveJob({ ...job, status: "error", error: result.error ?? "render failed" });
  }
  if (!job.backendUrl) {
    return saveJob({ ...job, status: "error", error: "job has no backend to collect from" });
  }

  // Two requests can arrive here for the same job: the backend's completion
  // callback and a status poll (reconcileJob). Whichever finished first used
  // to DELETE the backend copy while the other was still mid-loop, so the
  // slower one died on "couldn't collect item N (404)" - reliably once a job
  // had ~30+ items. Only one collector may run; the other returns what is
  // stored and the caller simply polls again.
  const fresh = await getJob(job.id);
  if (fresh && (fresh.status === "done" || fresh.status === "error")) return fresh;
  const lockKey = `job:${job.id}:collecting`;
  if (!(await acquireLock(lockKey, COLLECT_LOCK_SECONDS))) return fresh ?? job;
  try {
    return await collectLocked(job, result);
  } finally {
    await kvDel(lockKey).catch(() => false);
  }
}

const COLLECT_LOCK_SECONDS = 180;

/** SET NX EX - true when this caller now owns the lock (or there is no Redis). */
async function acquireLock(key: string, ttlSeconds: number): Promise<boolean> {
  const r = getRedis();
  if (!r) return true;
  const ok = await r.set(key, String(Date.now()), { nx: true, ex: ttlSeconds });
  return ok === "OK";
}

async function collectLocked(job: Job, result: BackendResult): Promise<Job> {
  const format = result.format ?? job.format;
  const contentType = format === "mp3" ? "audio/mpeg" : "audio/wav";
  const backendItems = result.items ?? [];
  const items: JobItem[] = [];

  for (const item of backendItems) {
    const res = await fetch(`${job.backendUrl}/jobs/${job.id}/audio/${item.index}`, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(50_000),
    });
    if (!res.ok) {
      // A collector that slipped past the lock may already have finished.
      const now = await getJob(job.id);
      if (now?.status === "done") return now;
      return saveJob({
        ...job,
        status: "error",
        error: `couldn't collect item ${item.index} (${res.status})`,
      });
    }
    const bytes = await res.arrayBuffer();
    const suffix = backendItems.length > 1 ? `-${item.index}` : "";
    const blob = await putBlob(`jobs/${job.id}${suffix}.${format}`, bytes, contentType);
    items.push({
      index: item.index,
      duration: item.duration,
      bytes: bytes.byteLength,
      audioUrl: blob.url,
    });
  }

  // The backend can drop its copy now that we hold everything.
  void fetch(`${job.backendUrl}/jobs/${job.id}`, {
    method: "DELETE",
    headers: backendHeaders(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {});

  return saveJob({
    ...job,
    status: "done",
    format,
    duration: result.duration,
    genSeconds: result.gen_seconds,
    engineUsed: result.engine_used,
    ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    ...(result.params_used ? { paramsUsed: result.params_used } : {}),
    ...(result.segments ? { segments: result.segments } : {}),
    items,
    // A stitched job has exactly one file; expose it directly so the common
    // case is `audio_url` and callers never index into a list of one.
    audioUrl: job.mode === "stitch" ? items[0]?.audioUrl : undefined,
  });
}

/**
 * Ask the backend how a job is doing, and finish it if it's ready.
 *
 * This is the safety net for a lost callback — a tunnel that died between the
 * render finishing and the POST arriving would otherwise strand the job as
 * "running" forever.
 */
/**
 * A job can't outlive the backend's own render timeout (30 minutes on Modal).
 * Past that it is certainly dead, and continuing to ask would wake a paid GPU
 * on every poll for a job that will never finish.
 */
export const JOB_STALE_AFTER_MS = 35 * 60 * 1000;

export async function reconcileJob(job: Job): Promise<Job> {
  if (job.status === "done" || job.status === "error" || !job.backendUrl) return job;

  if (Date.now() - job.createdAt > JOB_STALE_AFTER_MS) {
    // Give up locally. Never contact the backend for this one again.
    return saveJob({
      ...job,
      status: "error",
      error: "the render never reported back and has passed the backend's timeout",
    });
  }

  let result: BackendResult;
  try {
    const res = await fetch(`${job.backendUrl}/jobs/${job.id}`, {
      headers: backendHeaders(),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      // A job still "queued" has not been dispatched yet — the POST that
      // hands it to the backend runs after the response, and on a cold
      // container it can take most of a minute. A 404 then means "not yet",
      // not "gone", and killing it here raced our own dispatch. Only a job
      // the backend once acknowledged can have been forgotten by a restart.
      if (job.status === "queued") return job;
      return saveJob({
        ...job,
        status: "error",
        error: "the backend restarted before this job finished",
      });
    }
    if (!res.ok) return job;
    result = (await res.json()) as BackendResult;
  } catch {
    return job; // transient; the next poll tries again
  }

  if (result.status === "done") return collectJob(job, result);
  if (result.status === "error") {
    return saveJob({ ...job, status: "error", error: result.error ?? "render failed" });
  }
  return job;
}

// --- retention ------------------------------------------------------------

/** Jobs older than the retention window, oldest first. */
export async function expiredJobs(now = Date.now()): Promise<Job[]> {
  const { retentionDays } = await getSettings();
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return (await listJobs(INDEX_LIMIT)).filter((j) => j.createdAt < cutoff);
}

export async function purgeExpiredJobs(): Promise<number> {
  const expired = await expiredJobs();
  for (const job of expired) await deleteJob(job.id);
  return expired.length;
}
