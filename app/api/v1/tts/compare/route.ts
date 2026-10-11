/**
 * POST /api/v1/tts/compare — the same line, both ways.
 *
 * Narrates one piece of text twice: once on the language profile's own engine
 * and once on its fallback, so the two can be judged by ear rather than by
 * argument. Useful mainly for Nepali, where the fallback is a different
 * language's phonology and "good enough" is a listening decision.
 *
 * Two jobs, not two files: synthesis is asynchronous everywhere else here and
 * a cold backend can take a minute, so this returns what to poll.
 */

import { getSettings } from "@/lib/server/redis";
import { NextResponse } from "next/server";
import { z } from "zod";
import { MAX_CHARS } from "@/lib/config";
import { chunkScript } from "@/lib/chunker";
import {
  DEFAULT_ENGINE,
  profileFor,
  resolveSynthesis,
} from "@/lib/languageProfiles";
import { apiError, appUrlFrom, authenticate, checkQuota } from "@/lib/server/apiauth";
import { recordKeyUsage } from "@/lib/server/apikeys";
import { JobError, createAndDispatchJob } from "@/lib/server/jobs";
import { resolveVoice } from "@/lib/server/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Short on purpose: this is an A/B of one line, not a narration endpoint. */
const COMPARE_MAX_CHARS = 1_000;

const schema = z.object({
  text: z.string().min(1).max(COMPARE_MAX_CHARS),
  voice_id: z.string().max(120).optional(),
  language: z.string().min(2).max(12).optional(),
  format: z.enum(["mp3", "wav"]).optional(),
});

export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch (e) {
    const issue = e instanceof z.ZodError ? e.issues[0] : null;
    return apiError(
      issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "Invalid request body.",
      400,
      "invalid_request"
    );
  }

  // Both renders together, so a comparison can't quietly eat twice the quota
  // the caller thought they were spending.
  const overQuota = await checkQuota(auth.key, body.text.length * 2);
  if (overQuota) return overQuota;

  const voice = await resolveVoice(body.voice_id ?? null);
  if (!voice) {
    return apiError(
      body.voice_id
        ? `No voice with id "${body.voice_id}". GET /api/v1/voices lists them.`
        : "No voice_id given and no default voice is set.",
      body.voice_id ? 404 : 400,
      "unknown_voice"
    );
  }

  const language = body.language ?? voice.language;
  const profile = profileFor(language);
  if (!profile?.fallback) {
    return apiError(
      `"${language}" has no alternative engine to compare against — it runs on ${DEFAULT_ENGINE} either way.`,
      400,
      "nothing_to_compare"
    );
  }

  const drafts = chunkScript(body.text, undefined, language, {
    pronunciations: (await getSettings()).pronunciations,
  });
  if (!drafts.length) {
    return apiError("That text has nothing to say once normalized.", 400, "empty_text");
  }
  if (drafts.length > MAX_CHARS) {
    return apiError("That text is too long to compare.", 400, "invalid_request");
  }

  const primary = resolveSynthesis({ language });
  const fb = profile.fallback;

  const start = (params: Record<string, unknown>) =>
    createAndDispatchJob(
      {
        chunks: drafts.map((d) => d.text),
        paragraphBreaks: drafts.map((d) => d.isParagraphEnd),
        voiceId: voice.id,
        mode: "stitch",
        format: body.format ?? "mp3",
        source: auth.key.id,
        params,
      },
      appUrlFrom(req)
    );

  try {
    // Sequential, not parallel: one GPU, and two jobs racing for it only
    // makes both slower while doubling peak memory.
    const a = await start({
      language,
      engine: primary.engine,
      exaggeration: primary.exaggeration,
      cfg: primary.cfg,
      temperature: primary.temperature,
    });
    const b = await start({
      language: fb.modelLanguage,
      engine: fb.engine,
      exaggeration: fb.exaggeration ?? primary.exaggeration,
      cfg: fb.cfg ?? primary.cfg,
      temperature: fb.temperature ?? primary.temperature,
    });

    void recordKeyUsage(auth.key.id, a.chars + b.chars);

    const url = (id: string) => `${appUrlFrom(req).replace(/\/+$/, "")}/api/v1/jobs/${id}`;
    return NextResponse.json({
      language,
      // Poll both; each reports engine_used, so a primary that silently fell
      // back is visible rather than looking like a duplicate of the other.
      candidates: [
        { label: profile.engine, engine: primary.engine, job_id: a.id, status_url: url(a.id) },
        {
          label: `fallback-${fb.modelLanguage}`,
          engine: fb.engine,
          model_language: fb.modelLanguage,
          job_id: b.id,
          status_url: url(b.id),
        },
      ],
    });
  } catch (e) {
    if (e instanceof JobError) return apiError(e.message, e.status, e.code);
    throw e;
  }
}
