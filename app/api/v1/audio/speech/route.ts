/**
 * POST /api/v1/audio/speech — OpenAI-compatible, synchronous.
 *
 * Point any OpenAI TTS client at this base URL and it works: same request
 * shape, same response (raw audio bytes, not JSON). That's the whole purpose —
 * dropping VoiceForge into tools that already speak OpenAI.
 *
 * Synchronous means it lives inside Vercel's 60-second budget, so the input is
 * capped short. Anything longer belongs on /api/v1/tts, which is asynchronous.
 */

import { getSettings } from "@/lib/server/redis";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  decodeWav,
  encodeMp3,
  encodeWavPcm16,
  peakNormalize,
  stitchChunks,
} from "@/lib/audio";
import { chunkScript } from "@/lib/chunker";
import { apiError, authenticate, checkQuota } from "@/lib/server/apiauth";
import { recordKeyUsage } from "@/lib/server/apikeys";
import { GatewayError, gatewayGenerate } from "@/lib/server/gateway";
import { resolveVoice } from "@/lib/server/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Enough for a sentence or three. Past this, a cold GPU blows the budget. */
const MAX_SPEECH_CHARS = 600;

const schema = z.object({
  // Accepted and ignored: OpenAI clients always send it. Our model choice
  // comes from the voice library and the backend that's online.
  model: z.string().max(80).optional(),
  input: z.string().min(1).max(MAX_SPEECH_CHARS),
  /** A VoiceForge voice id. Unknown names fall back to the default voice. */
  voice: z.string().max(120).optional(),
  response_format: z.enum(["mp3", "wav"]).optional(),
  speed: z.number().min(0.25).max(4).optional(),
  language: z.string().min(2).max(12).optional(),
});

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (e) {
    const issue = e instanceof z.ZodError ? e.issues[0] : null;
    const tooLong = issue?.code === "too_big";
    return apiError(
      tooLong
        ? `input is limited to ${MAX_SPEECH_CHARS} characters here — use POST /api/v1/tts for longer text.`
        : issue
          ? `${issue.path.join(".") || "body"}: ${issue.message}`
          : "Invalid request body.",
      400,
      tooLong ? "input_too_long" : "invalid_request"
    );
  }

  const overQuota = await checkQuota(auth.key, body.input.length);
  if (overQuota) return overQuota;

  // An OpenAI client sends names like "alloy", which we have no way to honour.
  // Treat an unknown voice as "use the default" rather than failing the call.
  const voice = (await resolveVoice(body.voice ?? null)) ?? (await resolveVoice(null));
  if (!voice) {
    return apiError(
      "No voice available. Add one in Admin → Voices.",
      400,
      "unknown_voice"
    );
  }

  const language = body.language ?? voice.language;
  const drafts = chunkScript(body.input, undefined, language, {
    pronunciations: (await getSettings()).pronunciations,
  });
  if (!drafts.length) {
    return apiError("That input has nothing to say once normalized.", 400, "empty_text");
  }

  try {
    // Sequential on purpose: one GPU, and parallel calls would just queue
    // behind each other on the backend anyway.
    const parts = [];
    for (const [i, draft] of drafts.entries()) {
      const result = await gatewayGenerate({
        text: draft.text,
        voiceId: voice.id,
        language,
        seed: i,
      });
      parts.push({
        audio: decodeWav(Buffer.from(result.audioB64, "base64").buffer as ArrayBuffer),
        isParagraphEnd: draft.isParagraphEnd,
      });
    }

    // Same stitching and normalization as the studio — the tuned gaps and the
    // −1 dBFS ceiling apply here too, so output matches the UI.
    const stitched = peakNormalize(stitchChunks(parts));
    const format = body.response_format ?? "mp3";
    const blob = format === "wav" ? encodeWavPcm16(stitched) : encodeMp3(stitched);
    const bytes = await blob.arrayBuffer();

    void recordKeyUsage(auth.key.id, body.input.length);

    return new NextResponse(bytes, {
      headers: {
        "Content-Type": format === "wav" ? "audio/wav" : "audio/mpeg",
        "Content-Length": String(bytes.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    if (e instanceof GatewayError) return apiError(e.message, e.status, e.code);
    console.warn("[voiceforge] speech failed:", e);
    return apiError("Speech generation failed.", 500, "internal_error");
  }
}
