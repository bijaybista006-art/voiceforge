/**
 * GET /api/v1/presenters — the presenters this key can use, so a workflow can
 * pick one by id instead of relying on the default.
 */

import { NextResponse } from "next/server";
import { authenticate } from "@/lib/server/apiauth";
import { listBackends } from "@/lib/server/backends";
import { discoverMissingPresenters, reloadNotebookPresenters } from "@/lib/server/presenterjobs";
import { listPresenters, presenterReadiness } from "@/lib/server/presenters";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;

  await discoverMissingPresenters(12_000);
  const [presenters, backends] = await Promise.all([listPresenters(), listBackends()]);
  return NextResponse.json({
    // Whether each kind can be rendered right now, where, and what any other
    // backend is still doing — the same facts the Presenters page shows.
    ready: {
      recording: presenterReadiness(backends, "recording"),
      image: presenterReadiness(backends, "image"),
    },
    presenters: presenters.map((p) => ({
      id: p.id,
      name: p.name,
      kind: p.kind,
      duration: p.durationSec,
      default: p.isDefault,
    })),
  });
}

/**
 * POST /api/v1/presenters { "action": "reload" } — have every running
 * notebook load the presenter service's current code, without a restart.
 */
export async function POST(req: Request) {
  const auth = await authenticate(req);
  if (!auth.ok) return auth.response;
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "reload") {
    return NextResponse.json({ error: 'The only action is "reload".' }, { status: 400 });
  }
  return NextResponse.json({ reloaded: await reloadNotebookPresenters() });
}
