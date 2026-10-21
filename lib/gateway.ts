/**
 * Browser-side client for our own gateway.
 *
 * The studio used to hold a tunnel URL and call the GPU directly. It no longer
 * does: the backend secret must never reach a browser, and the active backend
 * can change between two chunks. So the browser posts text plus a voice id to
 * /api/gateway/* and the server decides where it runs.
 *
 * Errors come back as BackendError so the generation queue's existing
 * "network = pause and keep everything" handling still applies unchanged.
 */

import { base64ToBlob } from "./audio";
import { BackendError } from "./backend";
import type { ActiveBackend, GenerateResult, ModelId } from "./types";

export interface StudioVoice {
  id: string;
  name: string;
  language: string;
  durationSec: number;
  isDefault: boolean;
  /** Stored clip, for preview. Already a public Blob URL. */
  audioUrl: string;
}

export interface GatewayBackendInfo {
  provider: string;
  gpu: string | null;
  models: string[];
  health: string;
  secondsSinceHeartbeat: number;
}

export interface GatewayStatus {
  active: ActiveBackend;
  backend: GatewayBackendInfo | null;
  voices: StudioVoice[];
  /** Admin → Settings pronunciation list; absent on an older deployment. */
  pronunciations?: Record<string, string>;
  storageReady: boolean;
  hint: string | null;
}

export async function fetchGatewayStatus(): Promise<GatewayStatus> {
  const res = await fetch("/api/gateway/status", { cache: "no-store" });
  if (!res.ok) throw new BackendError("Couldn't read platform status", "network", res.status);
  return (await res.json()) as GatewayStatus;
}

export interface GatewayGenerateBody {
  text: string;
  voiceId: string;
  model: ModelId;
  seed: number;
  language?: string;
  exaggeration?: number;
  cfg?: number;
  temperature?: number;
  stylePrompt?: string;
}

/**
 * Codes that mean "the GPU isn't there right now" rather than "this request was
 * wrong". The queue treats these as network failures: it pauses, keeps every
 * finished chunk, and shows the offline banner instead of burning retries.
 */
const OFFLINE_CODES = new Set([
  "no_backend",
  "backend_unreachable",
  "backend_timeout",
  "sync_failed",
]);

export async function gatewayGenerate(body: GatewayGenerateBody): Promise<GenerateResult> {
  let res: Response;
  try {
    res = await fetch("/api/gateway/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // The route itself is capped at 60s; allow a little more so we read its
      // error rather than aborting first.
      signal: AbortSignal.timeout(70_000),
    });
  } catch (e) {
    throw new BackendError(
      e instanceof Error && e.name === "TimeoutError"
        ? "The request timed out."
        : "Couldn't reach the server.",
      "network"
    );
  }

  const data = (await res.json().catch(() => ({}))) as {
    audio_b64?: string;
    sample_rate?: number;
    duration?: number;
    gen_seconds?: number;
    error?: string;
    code?: string;
    job_id?: string;
  };

  // Nepali chunks come back as a background job (see the generate route).
  if (res.status === 202 && data.job_id) return waitForStudioJob(data.job_id);

  if (!res.ok || !data.audio_b64) {
    const kind = OFFLINE_CODES.has(data.code ?? "") ? "network" : "api";
    throw new BackendError(data.error ?? `Generation failed (${res.status})`, kind, res.status);
  }

  return {
    audioBlob: base64ToBlob(data.audio_b64, "audio/wav"),
    sampleRate: data.sample_rate ?? 24000,
    durationSec: data.duration ?? 0,
    genSeconds: data.gen_seconds ?? 0,
  };
}

/** Add a voice to the central library from the studio. */
interface StudioJobStatus {
  status?: string;
  audio_url?: string | null;
  duration?: number | null;
  gen_seconds?: number | null;
  error?: string | null;
}

/** How long a studio chunk may run as a job before the queue gives up on it. */
export const STUDIO_JOB_LIMIT_MS = 15 * 60 * 1000;

/**
 * Follow a background job to its audio. A dropped poll is not a failed
 * chunk — the job keeps running on the GPU — so only a run of failed polls,
 * or the overall limit, is reported as the backend being unreachable.
 */
export async function waitForStudioJob(
  jobId: string,
  opts: { fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void>; intervalMs?: number; limitMs?: number } = {}
): Promise<GenerateResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.intervalMs ?? 2500;
  const limit = opts.limitMs ?? STUDIO_JOB_LIMIT_MS;
  const started = Date.now();
  let misses = 0;

  for (let waited = 0; waited < limit && Date.now() - started < limit; waited += interval) {
    await sleep(interval);
    let job: StudioJobStatus;
    try {
      const res = await doFetch(`/api/gateway/jobs/${encodeURIComponent(jobId)}`, { cache: "no-store" });
      if (res.status === 404) throw new BackendError("The chunk's job disappeared. Generate it again.", "api", 404);
      if (!res.ok) throw new Error(`poll returned ${res.status}`);
      job = (await res.json()) as StudioJobStatus;
      misses = 0;
    } catch (e) {
      if (e instanceof BackendError) throw e;
      if (++misses >= 6) throw new BackendError("Lost contact with the server while the chunk was generating.", "network");
      continue;
    }

    if (job.status === "error") {
      throw new BackendError(job.error || "Generation failed.", "api");
    }
    if (job.status === "done" && job.audio_url) {
      let audio: Response;
      try {
        audio = await doFetch(job.audio_url);
      } catch {
        throw new BackendError("Couldn't download the finished chunk.", "network");
      }
      if (!audio.ok) throw new BackendError(`Couldn't download the finished chunk (${audio.status}).`, "api", audio.status);
      // Re-typed so playback and the WAV export treat it like every other chunk.
      const blob = new Blob([await audio.arrayBuffer()], { type: "audio/wav" });
      return {
        audioBlob: blob,
        sampleRate: 24000,
        durationSec: job.duration ?? 0,
        genSeconds: job.gen_seconds ?? 0,
      };
    }
  }
  throw new BackendError("The chunk is taking far longer than usual. The GPU may have stopped.", "network");
}

export async function uploadLibraryVoice(input: {
  wav: Blob;
  name: string;
  language: string;
  transcript: string;
}): Promise<StudioVoice> {
  const form = new FormData();
  form.append("audio", input.wav, "reference.wav");
  form.append("name", input.name);
  form.append("language", input.language);
  form.append("transcript", input.transcript);

  const res = await fetch("/api/admin/voices", { method: "POST", body: form });
  const data = (await res.json().catch(() => ({}))) as {
    voice?: {
      id: string;
      name: string;
      language: string;
      durationSec: number;
      audioUrl: string;
    };
    error?: string;
  };
  if (!res.ok || !data.voice) {
    throw new BackendError(data.error ?? "Couldn't save that voice.", "api", res.status);
  }
  return { ...data.voice, isDefault: false };
}

export async function deleteLibraryVoice(id: string): Promise<void> {
  const res = await fetch(`/api/admin/voices/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw new BackendError("Couldn't delete that voice.", "api", res.status);
}
