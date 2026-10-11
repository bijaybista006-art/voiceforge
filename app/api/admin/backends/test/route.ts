/**
 * "Test" button — proves a backend is genuinely reachable and can speak,
 * not merely that a row exists in Redis.
 *
 * Two steps: /health (fast, must not wake Modal's GPU) and optionally a
 * one-line generation. Kept well under Vercel's 60 s function ceiling.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  backendHeaders,
  getBackend,
  recordHealthFacts,
  recordUnreachable,
} from "@/lib/server/backends";
import { discoverPresenter } from "@/lib/server/presenterjobs";

export const runtime = "nodejs";
export const maxDuration = 60;

const schema = z.object({
  provider: z.enum(["modal", "colab", "kaggle", "custom"]),
  /** Health only by default — generation needs a cached voice. */
  generate: z.boolean().optional(),
  voiceId: z.string().max(80).optional(),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const backend = await getBackend(body.provider);
  if (!backend) {
    return NextResponse.json({ error: "That backend isn't registered." }, { status: 404 });
  }

  const started = Date.now();
  // Started alongside the health check, not after it: both have to fit
  // inside this route's 60s. It asks the backend's presenter address what it
  // can do and stores the answer; it never throws and never affects the
  // result of the test itself.
  const presenter = discoverPresenter(body.provider, 50_000);
  let health: unknown;
  try {
    const res = await fetch(`${backend.url}/health`, {
      headers: backendHeaders(),
      // A notebook answers /health instantly, but Modal scales to zero and a
      // cold GPU container spends ~50s loading models before it replies. At
      // 15s this test could never pass against a cold Modal, and reported a
      // perfectly healthy backend as unreachable. Kept under the route's own
      // 60s ceiling so the failure is ours to word, not Vercel's.
      signal: AbortSignal.timeout(55_000),
    });
    if (!res.ok) {
      const why = `Health check returned ${res.status}.`;
      await recordUnreachable(body.provider, why).catch(() => {});
      return NextResponse.json({ ok: false, error: why }, { status: 200 });
    }
    health = await res.json();
    // Keep the card honest: refresh GPU, models and version from what it just
    // told us, rather than discarding it.
    await recordHealthFacts(
      body.provider,
      health as { gpu?: string; models?: string[]; version?: string; voices_cached?: string[] }
    );
  } catch (e) {
    const timedOut = e instanceof Error && e.name === "TimeoutError";
    const error = timedOut
      ? "Health check timed out after 55s. A notebook that long gone has stopped; a cold Modal container can need about a minute on its first wake, so try once more."
      : "Couldn't reach the backend. Is the notebook still running?";
    // Remembered on the row, so the next person to look at the card sees it
    // without having to press Test themselves.
    await recordUnreachable(body.provider, error).catch(() => {});
    return NextResponse.json({ ok: false, error }, { status: 200 });
  }

  if (!body.generate || !body.voiceId) {
    return NextResponse.json({
      ok: true,
      latencyMs: Date.now() - started,
      health,
      presenter: await presenter,
    });
  }

  try {
    const res = await fetch(`${backend.url}/generate`, {
      method: "POST",
      headers: backendHeaders(),
      body: JSON.stringify({
        text: "VoiceForge backend test. One, two, three.",
        voice_id: body.voiceId,
        model: "chatterbox",
        seed: 1,
        language: "en",
      }),
      signal: AbortSignal.timeout(45_000),
    });
    const data = (await res.json()) as { audio_b64?: string; error?: string };
    if (!res.ok || data.error) {
      return NextResponse.json({ ok: false, error: data.error ?? `Error ${res.status}` });
    }
    return NextResponse.json({
      ok: true,
      latencyMs: Date.now() - started,
      health,
      audioB64: data.audio_b64,
    });
  } catch {
    return NextResponse.json({
      ok: false,
      error: "Generation timed out. The GPU may be cold or busy.",
    });
  }
}
