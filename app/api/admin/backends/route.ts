/**
 * Admin view of the backend registry. Behind the admin session (middleware).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  backendHeaders,
  forgetBackend,
  getActiveSelection,
  listBackends,
  registerBackend,
  setActiveSelection,
  updateBackend,
} from "@/lib/server/backends";
import { isRedisConfigured } from "@/lib/server/redis";
import { backendPatchSchema, providerSchema } from "@/lib/server/backendPatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";


export async function GET() {
  const [backends, active] = await Promise.all([listBackends(), getActiveSelection()]);
  return NextResponse.json({
    backends,
    active,
    storageConnected: isRedisConfigured(),
    registrationTokenSet: Boolean(process.env.REGISTRATION_TOKEN),
    backendSecretSet: Boolean(process.env.BACKEND_SECRET),
  });
}


export async function PATCH(req: NextRequest) {
  if (!isRedisConfigured()) {
    return NextResponse.json({ error: "Storage isn't connected." }, { status: 503 });
  }
  let body: z.infer<typeof backendPatchSchema>;
  try {
    body = backendPatchSchema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if ("active" in body) {
    await setActiveSelection(body.active);
    return NextResponse.json({ ok: true, active: body.active });
  }

  if ("url" in body) {
    const url = body.url.replace(/[/]+$/, "");

    // Modal serves TTS and rendering from two separate functions, which means
    // two URLs that differ only in the trailing function name. Derive the
    // render one and prove it answers, rather than asking for it in the UI —
    // a field nobody can fill in correctly is worse than no field.
    const MODAL_API = "-api.modal.run";
    const renderCandidate = url.endsWith(MODAL_API)
      ? url.slice(0, -MODAL_API.length) + "-render.modal.run"
      : url;

    // Ask what it is. A self-registering notebook sends its GPU and models
    // when it checks in; a URL typed in here has nobody to do that, so the
    // card would otherwise show no GPU and no models — which also greys out
    // the model picker in the studio. Best-effort: an unreachable backend is
    // still worth registering, since Modal may simply be asleep.
    let probed: { gpu?: string; models?: string[]; version?: string; capabilities?: string[] } = {};
    try {
      const res = await fetch(`${url}/health`, {
        headers: backendHeaders(),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const h = (await res.json()) as {
          gpu?: string;
          models?: string[];
          version?: string;
          capabilities?: string[];
        };
        probed = {
          gpu: h.gpu,
          models: h.models,
          version: h.version,
          capabilities: h.capabilities,
        };
      }
    } catch {
      /* asleep or unreachable — register it anyway */
    }

    let renderUrl: string | undefined;
    let capabilities = probed.capabilities;
    if (renderCandidate !== url) {
      try {
        const res = await fetch(`${renderCandidate}/health`, {
          headers: backendHeaders(),
          signal: AbortSignal.timeout(20_000),
        });
        if (res.ok) {
          const h = (await res.json()) as { capabilities?: string[] };
          if ((h.capabilities ?? []).includes("render")) {
            renderUrl = renderCandidate;
            capabilities = Array.from(new Set([...(capabilities ?? ["tts"]), "render"]));
          }
        }
      } catch {
        /* no render function deployed yet — TTS still works on its own */
      }
    }

    // Registering by hand still goes through the same path as
    // self-registration, so there's one code path for liveness.
    const row = await registerBackend(
      { provider: body.provider, url, ...probed, renderUrl, capabilities },
      // Typed in by hand: there's no notebook to heartbeat, so this row must
      // not be aged out like a Colab tunnel.
      { selfRegistered: false }
    );
    return NextResponse.json({ ok: true, backend: row });
  }

  const updated = await updateBackend(body.provider, {
    ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
    ...(body.videoEnabled !== undefined ? { videoEnabled: body.videoEnabled } : {}),
    ...(body.priority !== undefined ? { priority: body.priority } : {}),
  });
  if (!updated) return NextResponse.json({ error: "Unknown backend." }, { status: 404 });
  return NextResponse.json({ ok: true, backend: updated });
}

export async function DELETE(req: NextRequest) {
  const provider = req.nextUrl.searchParams.get("provider");
  const parsed = providerSchema.safeParse(provider);
  if (!parsed.success) {
    return NextResponse.json({ error: "Unknown backend." }, { status: 400 });
  }
  await forgetBackend(parsed.data);
  return NextResponse.json({ ok: true });
}
