/**
 * Rename / retag / set-default / delete one library voice.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { deleteVoice, getVoice, setDefaultVoice, updateVoice } from "@/lib/server/voices";
import { isRedisConfigured } from "@/lib/server/redis";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  language: z.string().trim().min(2).max(12).optional(),
  transcript: z.string().trim().max(2000).optional(),
  makeDefault: z.literal(true).optional(),
  /** Link other voices of the same speaker (null unlinks a slot). */
  refs: z
    .object({
      en: z.string().max(120).nullable().optional(),
      calm: z.string().max(120).nullable().optional(),
      excited: z.string().max(120).nullable().optional(),
      serious: z.string().max(120).nullable().optional(),
    })
    .optional(),
});

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!isRedisConfigured()) {
    return NextResponse.json({ error: "Storage isn't connected." }, { status: 503 });
  }
  const { id } = await ctx.params;

  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (body.makeDefault) {
    if (!(await setDefaultVoice(id))) {
      return NextResponse.json({ error: "Unknown voice." }, { status: 404 });
    }
  }

  // A link to a voice that doesn't exist would fail every job that uses it.
  for (const [slot, ref] of Object.entries(body.refs ?? {})) {
    if (ref && !(await getVoice(ref))) {
      return NextResponse.json({ error: `Unknown voice for ${slot}: ${ref}` }, { status: 400 });
    }
  }

  const { makeDefault: _ignored, ...patch } = body;
  if (Object.keys(patch).length > 0) {
    const updated = await updateVoice(id, patch);
    if (!updated) return NextResponse.json({ error: "Unknown voice." }, { status: 404 });
    return NextResponse.json({ ok: true, voice: updated });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // ?replaceWith=<voice id>: requests for this voice go to that one from now on.
  const replaceWith = req.nextUrl.searchParams.get("replaceWith") || undefined;
  if (replaceWith && (replaceWith === id || !(await getVoice(replaceWith)))) {
    return NextResponse.json({ error: "Unknown replacement voice." }, { status: 400 });
  }
  if (!(await deleteVoice(id, replaceWith))) {
    return NextResponse.json({ error: "Unknown voice." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
