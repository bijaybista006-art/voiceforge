/**
 * Admin settings read/write. Behind the admin session via middleware.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { NEPALI_MODEL_FILE, getSettings, isRedisConfigured, saveSettings } from "@/lib/server/redis";

export const runtime = "nodejs";

const schema = z.object({
  retentionDays: z.number().int().min(1).max(365).optional(),
  kaggleNotebookUrl: z.string().max(500).optional(),
  defaultModel: z.enum(["chatterbox", "qwen3"]).optional(),
  defaultLanguage: z.string().min(2).max(8).optional(),
  pronunciations: z
    .record(z.string().min(1).max(40), z.string().min(1).max(80))
    .refine((m) => Object.keys(m).length <= 200, "at most 200 entries")
    .optional(),
  nepaliPronunciations: z
    .record(z.string().min(1).max(40), z.string().min(1).max(80))
    .refine((m) => Object.keys(m).length <= 200, "at most 200 entries")
    .optional(),
  nepaliSpeed: z.number().min(0.75).max(1.25).optional(),
  nepaliEnding: z.number().int().min(3).max(12).optional(),
  nepaliModel: z.string().max(120).regex(NEPALI_MODEL_FILE).or(z.literal("")).optional(),
});

export async function GET() {
  return NextResponse.json(await getSettings());
}

export async function PUT(req: NextRequest) {
  if (!isRedisConfigured()) {
    return NextResponse.json(
      { error: "Storage isn't connected. Add the Supabase env vars in Vercel." },
      { status: 503 }
    );
  }
  let patch: z.infer<typeof schema>;
  try {
    patch = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid settings." }, { status: 400 });
  }
  return NextResponse.json(await saveSettings(patch));
}
