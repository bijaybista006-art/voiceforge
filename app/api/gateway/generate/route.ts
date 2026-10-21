/**
 * One chunk of speech, for the studio.
 *
 * The browser no longer knows a backend URL or the backend secret — it posts
 * text plus a library voice id here, and the gateway picks the backend,
 * caches the voice if needed, and returns the audio. Behind the admin session
 * (middleware).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { GatewayError, gatewayGenerate } from "@/lib/server/gateway";
import { appUrlFrom } from "@/lib/server/apiauth";
import { JobError, createAndDispatchJob } from "@/lib/server/jobs";
import { resolveVoice } from "@/lib/server/voices";
import { languageForText } from "@/lib/languageProfiles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Generation is the one route that legitimately runs for tens of seconds.
export const maxDuration = 60;

const schema = z.object({
  text: z.string().trim().min(1).max(1000),
  voiceId: z.string().trim().max(120).optional(),
  model: z.enum(["chatterbox", "qwen3"]).optional(),
  seed: z.number().int().min(0).max(2 ** 31).optional(),
  language: z.string().trim().min(2).max(12).optional(),
  exaggeration: z.number().min(0).max(2).optional(),
  cfg: z.number().min(0).max(1).optional(),
  temperature: z.number().min(0).max(2).optional(),
  stylePrompt: z.string().trim().max(400).optional(),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  // Nepali goes through a background job, the same path the API uses. A
  // Nepali chunk can take most of a minute on a free T4 (each sentence may
  // need extra takes to stop babble), and far longer while a notebook loads
  // the Nepali model for the first time — past what one request may wait.
  // The studio saw that as "the GPU went offline". A job has no such limit
  // and falls back to the next backend; the browser polls it instead.
  // English keeps the direct path below, unchanged.
  const voice = await resolveVoice(body.voiceId ?? null);
  if (voice && languageForText(body.text, body.language, voice.language) === "ne") {
    try {
      const studio = Object.fromEntries(
        (["model", "seed", "exaggeration", "cfg", "temperature"] as const)
          .map((k) => [k, body[k]])
          .filter(([, v]) => v !== undefined)
      );
      const job = await createAndDispatchJob(
        {
          chunks: [body.text],
          paragraphBreaks: [false],
          voiceId: voice.id,
          mode: "stitch",
          format: "wav",
          source: "studio",
          params: { ...studio, language: "ne" },
        },
        appUrlFrom(req)
      );
      return NextResponse.json(
        { job_id: job.id, status: job.status, backend: job.backend, voice_id: voice.id },
        { status: 202 }
      );
    } catch (e) {
      if (e instanceof JobError) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
      }
      console.warn("[voiceforge] studio Nepali job failed to start:", e);
      return NextResponse.json({ error: "Generation failed." }, { status: 500 });
    }
  }

  try {
    const result = await gatewayGenerate(body);
    return NextResponse.json({
      audio_b64: result.audioB64,
      sample_rate: result.sampleRate,
      duration: result.durationSec,
      gen_seconds: result.genSeconds,
      backend: result.provider,
      voice_id: result.voiceId,
    });
  } catch (e) {
    if (e instanceof GatewayError) {
      return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
    }
    console.warn("[voiceforge] gateway generate failed:", e);
    return NextResponse.json({ error: "Generation failed." }, { status: 500 });
  }
}
