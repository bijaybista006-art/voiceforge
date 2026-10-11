import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { deletePresenter, renamePresenter, setDefaultPresenter } from "@/lib/server/presenters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    default: z.literal(true).optional(),
  })
  .strict();

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (body.name !== undefined && !(await renamePresenter(id, body.name))) {
    return NextResponse.json({ error: "Unknown presenter." }, { status: 404 });
  }
  if (body.default && !(await setDefaultPresenter(id))) {
    return NextResponse.json({ error: "Unknown presenter." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!(await deletePresenter(id))) {
    return NextResponse.json({ error: "Unknown presenter." }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
