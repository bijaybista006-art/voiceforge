/**
 * GET /api/v1/presenters — the presenters this key can use, so a workflow can
 * pick one by id instead of relying on the default.
 */

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/server/apiauth";
import { listPresenters } from "@/lib/server/presenters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  const presenters = await listPresenters();
  return NextResponse.json({
    presenters: presenters.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      duration: p.durationSec,
      default: p.isDefault,
    })),
  });
}
