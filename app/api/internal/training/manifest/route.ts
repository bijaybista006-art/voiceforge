/**
 * The training dataset, for a training job (modal/train_nepali.py).
 *
 * The admin manifest needs a browser session; a training job running on a
 * GPU has none. It proves itself with BACKEND_SECRET instead — the same
 * secret every backend already holds — sent as X-Backend-Secret.
 *
 *   ?language=ne&speaker=Bijay&voice=<voice id>
 *
 * Returns the clips (oldest first) and, when `voice` is given, that voice's
 * reference clip: the model is trained with it as the conditioning, exactly
 * as it will be used when generating.
 */

import { NextResponse, type NextRequest } from "next/server";
import { isTrainingLanguage } from "@/lib/trainingChecks";
import { isValidBackendSecret } from "@/lib/server/backends";
import { listSamples, speakerOf } from "@/lib/server/training";
import { getVoice } from "@/lib/server/voices";
import { getSettings } from "@/lib/server/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!(await isValidBackendSecret(req.headers.get("x-backend-secret")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const language = req.nextUrl.searchParams.get("language") ?? "";
  if (!isTrainingLanguage(language)) {
    return NextResponse.json({ error: "Choose ?language=ne or ?language=en." }, { status: 400 });
  }
  const speaker = req.nextUrl.searchParams.get("speaker") || undefined;
  const voiceId = req.nextUrl.searchParams.get("voice") || "";
  const voice = voiceId ? await getVoice(voiceId) : null;
  if (voiceId && !voice) {
    return NextResponse.json({ error: `Unknown voice: ${voiceId}` }, { status: 404 });
  }

  const samples = (await listSamples(language, speaker)).reverse();
  const settings = await getSettings();
  return NextResponse.json({
    // Where training starts: the base picked in Settings (a blend, usually).
    base: language === "ne" ? settings.nepaliBaseModel || null : null,
    language,
    speaker: speaker ?? null,
    clips: samples.length,
    seconds: Math.round(samples.reduce((n, s) => n + s.durationSec, 0)),
    voice: voice ? { id: voice.id, audio_url: voice.audioUrl, transcript: voice.transcript } : null,
    samples: samples.map((s) => ({
      id: s.id,
      audio_url: s.url,
      speaker: speakerOf(s),
      text: s.text,
      duration: s.durationSec,
      warnings: s.checks?.warnings ?? [],
    })),
  });
}
