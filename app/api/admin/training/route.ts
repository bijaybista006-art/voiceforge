/**
 * Training clips, admin side. Behind the admin session (middleware).
 *
 * GET lists clips (optionally ?language=ne) with per-language totals.
 * POST takes one clip as multipart: the browser has already decoded,
 * trimmed, checked and re-encoded it to 24 kHz mono 16-bit WAV. A clip is
 * under 1 MB, well inside Vercel's 4.5 MB request limit.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  MAX_SAMPLE_BYTES,
  TrainingError,
  addSample,
  isTrainingStorageReady,
  listSamples,
  sameSpeaker,
  speakerOf,
  speakersOf,
  summarize,
  trainingStorageHint,
} from "@/lib/server/training";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const language = req.nextUrl.searchParams.get("language") ?? undefined;
  const speaker = req.nextUrl.searchParams.get("speaker") || undefined;
  const everyone = await listSamples();
  const all = speaker ? everyone.filter((s) => sameSpeaker(speakerOf(s), speaker)) : everyone;
  return NextResponse.json({
    samples: language ? all.filter((s) => s.language === language) : all,
    summary: summarize(all),
    speakers: speakersOf(everyone),
    storageReady: isTrainingStorageReady(),
    hint: trainingStorageHint(),
  });
}

const fieldsSchema = z.object({
  language: z.string().trim().min(2).max(12),
  speaker: z.string().max(80),
  text: z.string().max(2000),
  description: z.string().max(1000).optional(),
  source: z.enum(["prompt", "free"]),
  promptId: z.string().trim().max(40).optional(),
});

const checksSchema = z
  .object({
    peakDb: z.number(),
    speechDb: z.number(),
    longestPauseSec: z.number(),
    warnings: z.array(z.string().max(40)).max(20),
  })
  .optional();

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected a multipart upload." }, { status: 400 });
  }

  const file = form.get("audio");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "No clip attached." }, { status: 400 });
  }
  if (file.size > MAX_SAMPLE_BYTES) {
    return NextResponse.json({ error: "That clip is too large." }, { status: 413 });
  }

  const parsed = fieldsSchema.safeParse({
    language: form.get("language") ?? "",
    speaker: form.get("speaker") ?? "",
    text: form.get("text") ?? "",
    description: form.get("description") ?? undefined,
    source: form.get("source") ?? "free",
    promptId: form.get("promptId") || undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "Choose a language and type the transcript." }, { status: 400 });
  }

  let checks: z.infer<typeof checksSchema>;
  try {
    const raw = form.get("checks");
    checks = checksSchema.parse(typeof raw === "string" && raw ? JSON.parse(raw) : undefined);
  } catch {
    checks = undefined;
  }

  try {
    const sample = await addSample({ ...parsed.data, checks, wav: await file.arrayBuffer() });
    return NextResponse.json({ ok: true, sample }, { status: 201 });
  } catch (e) {
    if (e instanceof TrainingError) return NextResponse.json({ error: e.message }, { status: e.status });
    console.warn("[voiceforge] training clip upload failed:", e);
    return NextResponse.json({ error: "Couldn't save that clip." }, { status: 500 });
  }
}
