/**
 * The gateway: the one place server-side code talks to a GPU backend.
 *
 * Two things live here that nothing else should duplicate:
 *  - the backend secret. It never reaches a browser, so every studio and API
 *    generation goes through this module rather than fetching a tunnel URL
 *    from client code.
 *  - lazy voice sync. A backend that doesn't know a voice answers 409
 *    voice_not_cached; we PUT the clip's Blob URL and retry exactly once. That
 *    single rule is what makes "clone once, works on every backend, survives a
 *    Colab restart" true, with no re-cloning anywhere in the UI.
 */

import { languageForText, resolveSynthesis } from "@/lib/languageProfiles";
import { prepareNepali } from "@/lib/nepaliLoanwords";
import type { LibraryVoice, ModelId } from "@/lib/types";
import { backendHeaders, recordJobUsage, resolveBackend, updateBackend } from "./backends";
import { getSettings } from "./redis";
import { resolveVoice } from "./voices";

/** Vercel caps a function at 60 s; stay inside it with room to answer. */
const GENERATE_TIMEOUT_MS = 52_000;
const SYNC_TIMEOUT_MS = 30_000;

export class GatewayError extends Error {
  status: number;
  /** Machine-readable so API clients can branch without parsing prose. */
  code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
  }
}

export const NO_BACKEND = new GatewayError(
  "No GPU backend is online. Start your Colab or Kaggle notebook, or pick another backend in Admin → Backends.",
  503,
  "no_backend"
);

export const NO_VOICE = new GatewayError(
  "No voice selected, and the library has no default. Add one in Admin → Voices.",
  400,
  "no_voice"
);

/** Push a library voice onto a backend so it can be used by id from now on. */
export async function syncVoiceToBackend(
  backendUrl: string,
  voice: LibraryVoice
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${backendUrl}/voices/${encodeURIComponent(voice.id)}`, {
      method: "PUT",
      headers: backendHeaders(),
      body: JSON.stringify({
        audio_url: voice.audioUrl,
        transcript: voice.transcript,
        language: voice.language,
      }),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    });
  } catch {
    throw new GatewayError("The backend didn't answer while caching the voice.", 504, "sync_failed");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GatewayError(
      `The backend refused the voice clip (${res.status}). ${detail.slice(0, 200)}`.trim(),
      502,
      "sync_failed"
    );
  }
}

export interface GatewayGenerateInput {
  text: string;
  voiceId?: string | null;
  model?: ModelId;
  seed?: number;
  language?: string;
  exaggeration?: number;
  cfg?: number;
  temperature?: number;
  stylePrompt?: string;
}

export interface GatewayGenerateResult {
  audioB64: string;
  sampleRate: number;
  durationSec: number;
  genSeconds: number;
  provider: string;
  voiceId: string;
}

interface BackendGenerateResponse {
  audio_b64: string;
  sample_rate: number;
  duration: number;
  gen_seconds: number;
}

/** One chunk of speech. Chunking itself stays in lib/chunker.ts, as always. */
export async function gatewayGenerate(
  input: GatewayGenerateInput
): Promise<GatewayGenerateResult> {
  const [backend, voice] = await Promise.all([
    resolveBackend(),
    resolveVoice(input.voiceId ?? null),
  ]);
  if (!backend) throw NO_BACKEND;
  if (!voice) {
    // Say which of the two it is — "unknown id" and "nothing selected" need
    // different fixes.
    throw input.voiceId
      ? new GatewayError(`No voice with id "${input.voiceId}".`, 404, "unknown_voice")
      : NO_VOICE;
  }

  // The same resolution the job path uses. The studio used to build its own
  // payload and skip this, so a Nepali voice worked through a job and failed
  // here with "Unsupported language_id" — the one model that can say it was
  // never asked for.
  // The script of the text outranks the Language setting — see
  // languageForText. Without this an English script narrated while the studio
  // was still set to Nepali went through the Nepali checkpoint and came back
  // mostly silent, with no error anywhere.
  const synth = resolveSynthesis({
    language: languageForText(input.text, input.language, voice.language),
    voice: voice.synth,
    request: {
      exaggeration: input.exaggeration,
      cfg: input.cfg,
      temperature: input.temperature,
    },
  });

  // English words inside a Nepali line are respelled in Devanagari, so one
  // model reads the whole sentence once. See lib/nepaliLoanwords.ts for why
  // this replaced splicing two models together.
  const isNepali = synth.modelLanguage === "ne";
  const settings = isNepali ? await getSettings() : null;
  const text = isNepali
    ? prepareNepali(input.text, { pronunciations: settings?.nepaliPronunciations })
    : input.text;

  const payload = {
    text,
    voice_id: voice.id,
    model: input.model ?? "chatterbox",
    seed: input.seed ?? 0,
    language: synth.modelLanguage,
    ...(isNepali
      ? { pace: settings?.nepaliSpeed ?? 1, ending_frames: settings?.nepaliEnding ?? 12 }
      : {}),
    engine: synth.engine,
    fallback: synth.fallback,
    exaggeration: synth.exaggeration,
    cfg: synth.cfg,
    temperature: synth.temperature,
    ...(input.stylePrompt ? { style_prompt: input.stylePrompt } : {}),
  };

  const post = () =>
    fetch(`${backend.url}/generate`, {
      method: "POST",
      headers: backendHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(GENERATE_TIMEOUT_MS),
    });

  let res: Response;
  try {
    res = await post();
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    await updateBackend(backend.provider, {
      lastError: timedOut ? "generate timed out" : "unreachable",
    });
    throw new GatewayError(
      timedOut
        ? "The backend took too long. If it just started, the model may still be loading — try again."
        : `${backend.provider} is unreachable. It may have shut down; check Admin → Backends.`,
      timedOut ? 504 : 502,
      timedOut ? "backend_timeout" : "backend_unreachable"
    );
  }

  // The voice isn't cached there yet (fresh backend, or a restarted Colab).
  // Push it and try once more — the caller never has to know.
  if (res.status === 409) {
    await syncVoiceToBackend(backend.url, voice);
    try {
      res = await post();
    } catch {
      throw new GatewayError(
        "The backend cached the voice but then stopped answering.",
        502,
        "backend_unreachable"
      );
    }
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new GatewayError(
      `Generation failed on ${backend.provider} (${res.status}). ${detail.slice(0, 300)}`.trim(),
      502,
      "generate_failed"
    );
  }

  const data = (await res.json()) as BackendGenerateResponse;
  await recordJobUsage(backend.provider, data.gen_seconds ?? 0);

  return {
    audioB64: data.audio_b64,
    sampleRate: data.sample_rate,
    durationSec: data.duration,
    genSeconds: data.gen_seconds,
    provider: backend.provider,
    voiceId: voice.id,
  };
}
