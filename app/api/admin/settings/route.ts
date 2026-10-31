/**
 * Admin settings read/write. Behind the admin session via middleware.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { NEPALI_MODEL_FILE, getSettings, isRedisConfigured, saveSettings } from "@/lib/server/redis";
import { isColabNotebookUrl, isEmail, isKaggleNotebookUrl } from "@/lib/notebookLinks";

export const runtime = "nodejs";

const schema = z.object({
  retentionDays: z.number().int().min(1).max(365).optional(),
  // Empty clears it. Otherwise it must be the right kind of link, so a typo
  // fails here instead of as a dead button on Admin → Backends.
  kaggleNotebookUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || isKaggleNotebookUrl(v), "must be a https://www.kaggle.com/code/… notebook link")
    .optional(),
  colabNotebookUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => v === "" || isColabNotebookUrl(v), "must be a https://colab.research.google.com/… notebook link")
    .optional(),
  googleAccount: z
    .string()
    .trim()
    .max(200)
    .refine((v) => v === "" || isEmail(v), "must be an email address")
    .optional(),
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
  nepaliBaseModel: z.string().max(120).regex(NEPALI_MODEL_FILE).or(z.literal("")).optional(),
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
  } catch (e) {
    // Name the field, so "Invalid settings." never leaves you guessing which.
    const issue = e instanceof z.ZodError ? e.issues[0] : null;
    return NextResponse.json(
      { error: issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid settings." },
      { status: 400 }
    );
  }
  return NextResponse.json(await saveSettings(patch));
}
