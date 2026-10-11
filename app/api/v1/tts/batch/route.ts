/**
 * POST /api/v1/tts/batch — many short lines, one clip each.
 *
 * The difference from /tts is that nothing is stitched: 7 lines in gives 7
 * separate files out. That's what a reel or short-form generator needs, where
 * each scene gets its own audio track.
 *
 * Each item is still normalized and chunked by the shared code, so a long
 * item is rendered as several chunks and joined into that item's single file.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { chunkScript } from "@/lib/chunker";
import { DEFAULT_PARAMS } from "@/lib/config";
import { apiError, appUrlFrom, authenticate, checkQuota } from "@/lib/server/apiauth";
import { recordKeyUsage } from "@/lib/server/apikeys";
import { JobError, createAndDispatchJob } from "@/lib/server/jobs";
import { getSettings } from "@/lib/server/redis";
import { resolveVoice } from "@/lib/server/voices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// A 20-minute video is roughly 100 scenes; 50 was sized for a Short.
const MAX_ITEMS = 250;
const MAX_ITEM_CHARS = 2000;

/** Same overrides the single-shot endpoint accepts, so both behave alike. */
const paramsSchema = z
  .object({
    seed: z.number().int().min(0).max(2 ** 31).optional(),
    exaggeration: z.number().min(0).max(2).optional(),
    cfg: z.number().min(0).max(1).optional(),
    /** Alias: Chatterbox calls it cfg_weight, so accept both spellings. */
    cfg_weight: z.number().min(0).max(1).optional(),
    temperature: z.number().min(0).max(2).optional(),
    model: z.enum(["chatterbox", "qwen3"]).optional(),
    /** Overrides the language profile's engine for this one request. */
    engine: z.string().min(1).max(40).optional(),
    /** Nepali only: playback speed of the finished audio, pitch unchanged. */
    pace: z.number().min(0.75).max(1.25).optional(),
    /** Nepali only: how long a sentence's last word is held, 3 (short) to 12. */
    ending_frames: z.number().int().min(3).max(12).optional(),
    /** Run on this backend only, instead of the first one available. */
    backend: z.enum(["colab", "kaggle", "custom", "modal"]).optional(),
  })
  .optional();

const schema = z.object({
  items: z
    .array(z.object({ text: z.string().min(1).max(MAX_ITEM_CHARS) }))
    .min(1)
    .max(MAX_ITEMS),
  voice_id: z.string().max(120).optional(),
  language: z.string().min(2).max(12).optional(),
  format: z.enum(["mp3", "wav"]).optional(),
  params: paramsSchema,
  callback_url: z.string().url().max(2000).optional(),
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

  const overQuota = await checkQuota(
    auth.key,
    body.items.reduce((n, i) => n + i.text.length, 0)
  );
  if (overQuota) return overQuota;

  const voice = await resolveVoice(body.voice_id ?? null);
  if (!voice) {
    return apiError(
      body.voice_id
        ? `No voice with id "${body.voice_id}".`
        : "No voice_id given and no default voice is set.",
      body.voice_id ? 404 : 400,
      "unknown_voice"
    );
  }

  const language = body.language ?? voice.language;
  const { pronunciations } = await getSettings();

  // One chunk per item keeps the item boundaries intact — the backend writes
  // one file per chunk in "items" mode, so an item must not be split.
  const chunks = body.items.map((item) => {
    const drafts = chunkScript(item.text, undefined, language, { pronunciations });
    return drafts.map((d) => d.text).join(" ");
  });
  if (chunks.some((c) => !c.trim())) {
    return apiError("One of the items is empty once normalized.", 400, "empty_text");
  }

  try {
    const job = await createAndDispatchJob(
      {
        chunks,
        paragraphBreaks: chunks.map(() => false),
        voiceId: voice.id,
        mode: "items",
        format: body.format ?? "mp3",
        source: auth.key.id,
        callbackUrl: body.callback_url,
        params: { ...DEFAULT_PARAMS, ...body.params, language },
      },
      appUrlFrom(req)
    );

    void recordKeyUsage(auth.key.id, job.chars);

    return NextResponse.json(
      {
        job_id: job.id,
        status: job.status,
        status_url: `${appUrlFrom(req)}/api/v1/jobs/${job.id}`,
        items: chunks.length,
        chars: job.chars,
        backend: job.backend,
      },
      { status: 202 }
    );
  } catch (e) {
    if (e instanceof JobError) return apiError(e.message, e.status, e.code);
    console.warn("[voiceforge] batch failed:", e);
    return apiError("Couldn't start that job.", 500, "internal_error");
  }
}
