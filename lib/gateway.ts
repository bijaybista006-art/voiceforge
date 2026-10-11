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
  };

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
