/**
 * The training dataset for one language, for a training run to download.
 * Admin session only.
 *
 *   ?language=ne&format=txt   audio_url|transcript, one clip per line
 *   ?language=ne&format=json  the full records, with speaker and description
 *   &speaker=Bijay            only that speaker's clips
 */

import { NextResponse, type NextRequest } from "next/server";
import { isTrainingLanguage } from "@/lib/trainingChecks";
import { listSamples, speakerOf, toPipeList } from "@/lib/server/training";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const language = req.nextUrl.searchParams.get("language") ?? "";
  const format = req.nextUrl.searchParams.get("format") === "json" ? "json" : "txt";
  if (!isTrainingLanguage(language)) {
    return NextResponse.json({ error: "Choose ?language=ne or ?language=en." }, { status: 400 });
  }
  // One speaker per training run; without ?speaker= every speaker is included.
  const speaker = req.nextUrl.searchParams.get("speaker") || undefined;
  // Oldest first, so a dataset grows by appending and diffs stay readable.
  const samples = (await listSamples(language, speaker)).reverse();
  const stamp = new Date().toISOString().slice(0, 10);
  const who = speaker ? `-${speaker.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "speaker"}` : "";
  const name = `voiceforge-${language}${who}-${stamp}.${format === "json" ? "json" : "txt"}`;

  if (format === "json") {
    return new NextResponse(
      JSON.stringify(
        {
          language,
          speaker: speaker ?? null,
          clips: samples.length,
          seconds: Math.round(samples.reduce((n, s) => n + s.durationSec, 0)),
          sampleRate: 24000,
          samples: samples.map((s) => ({
            id: s.id,
            audio_url: s.url,
            speaker: speakerOf(s),
            text: s.text,
            description: s.description ?? null,
            duration: s.durationSec,
            source: s.source,
            prompt_id: s.promptId ?? null,
          })),
        },
        null,
        1
      ),
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="${name}"`,
        },
      }
    );
  }
  return new NextResponse(toPipeList(samples) + "\n", {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
