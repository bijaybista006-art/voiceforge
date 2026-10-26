/**
 * Switch on a newly trained Nepali model, from the training job
 * (modal/train_nepali.py) once it has beaten the current one on held-out
 * clips. Authenticated like the manifest: X-Backend-Secret.
 *
 *   POST { file: "v3.safetensors", version, before, after, minutes, clips }
 *
 * Sets Settings -> Nepali model, which every Nepali job then sends as
 * ne_source. Switching back is the same setting, from the Settings page.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isValidBackendSecret } from "@/lib/server/backends";
import { NEPALI_MODEL_FILE, saveSettings } from "@/lib/server/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({
  file: z.string().max(120).regex(NEPALI_MODEL_FILE),
  version: z.string().max(40),
  before: z.number(),
  after: z.number(),
  minutes: z.number(),
  clips: z.number().int(),
});

export async function POST(req: NextRequest) {
  if (!(await isValidBackendSecret(req.headers.get("x-backend-secret")))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "bad request" }, { status: 400 });
  }
  const b = parsed.data;
  const day = new Date().toISOString().slice(0, 10);
  const settings = await saveSettings({
    nepaliModel: b.file,
    nepaliModelNote: `${b.version}, trained ${day} on ${b.minutes} min (${b.clips} clips); held-out loss ${b.before.toFixed(3)} -> ${b.after.toFixed(3)}`,
  });
  return NextResponse.json({ ok: true, nepaliModel: settings.nepaliModel });
}
