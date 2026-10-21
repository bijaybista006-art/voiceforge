/** One training clip: fix its transcript or description, or delete it. Admin session only. */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { TrainingError, deleteSample, updateSample } from "@/lib/server/training";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({ text: z.string().max(2000).optional(), description: z.string().max(1000).optional() })
  .refine((b) => b.text !== undefined || b.description !== undefined);

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Send { text } and/or { description }." }, { status: 400 });
  }
  try {
    const sample = await updateSample(id, body);
    if (!sample) return NextResponse.json({ error: "No clip with that id." }, { status: 404 });
    return NextResponse.json({ ok: true, sample });
  } catch (e) {
    if (e instanceof TrainingError) return NextResponse.json({ error: e.message }, { status: e.status });
    return NextResponse.json({ error: "Couldn't save the change." }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const { id } = await ctx.params;
  const ok = await deleteSample(id);
  if (!ok) return NextResponse.json({ error: "No clip with that id." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
