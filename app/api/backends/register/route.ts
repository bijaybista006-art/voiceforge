/**
 * Backend self-registration + heartbeat.
 *
 * A Colab/Kaggle notebook POSTs here once its tunnel is up, then re-POSTs
 * every 60 s. This is the endpoint that removes URL-pasting entirely.
 *
 * Machine endpoint: authed by REGISTRATION_TOKEN, NOT the admin session
 * (middleware excludes this path). Without the token a stranger could point
 * your app at their machine, so the check is constant-time and mandatory.
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import {
  HEARTBEAT_SECONDS,
  backendFeatures,
  isValidRegistrationToken,
  registerBackend,
} from "@/lib/server/backends";
import { heartbeatFields } from "@/lib/server/clipjobs";
import { getSettings, isRedisConfigured } from "@/lib/server/redis";

export const runtime = "nodejs";

const schema = z.object({
  provider: z.enum(["modal", "colab", "kaggle", "custom"]),
  // Must be a real absolute https URL — a backend URL is something we will
  // later send audio to, so don't accept anything loose here.
  url: z.string().url().max(500),
  gpu: z.string().max(120).optional(),
  models: z.array(z.string().max(60)).max(20).optional(),
  version: z.string().max(40).optional(),
  // Newer notebooks: AI video install state, free disk and GPU memory, sent
  // with every heartbeat (backend_status in backend/voiceforge_server.py).
  status: z
    .object({
      wan: z
        .object({
          state: z.string().max(40).optional(),
          capabilities: z.array(z.string().max(60)).max(10).optional(),
          install: z
            .object({ state: z.string().max(40).optional(), stage: z.string().max(200).optional(), error: z.string().max(1000).optional() })
            .nullable()
            .optional(),
          limits: z.record(z.unknown()).nullable().optional(),
        })
        .optional(),
      system: z
        .object({
          idle_seconds: z.number().optional(),
          disk_free_gb: z.number().optional(),
          disk_total_gb: z.number().optional(),
          gpus: z
            .array(z.object({ name: z.string().max(80), used_mb: z.number(), total_mb: z.number() }))
            .max(8)
            .optional(),
        })
        .optional(),
      // The notebook is stopping itself after sitting idle: show it Offline now.
      stopping: z.boolean().optional(),
    })
    .optional(),
});

function token(req: NextRequest): string | null {
  const header = req.headers.get("x-registration-token");
  if (header) return header;
  const auth = req.headers.get("authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

export async function POST(req: NextRequest) {
  if (!(await isValidRegistrationToken(token(req)))) {
    // Deliberately terse: never hint at whether a token exists server-side.
    return NextResponse.json({ error: "invalid registration token" }, { status: 401 });
  }

  if (!isRedisConfigured()) {
    return NextResponse.json(
      {
        error:
          "storage not connected — add the Supabase env vars in Vercel, then redeploy",
      },
      { status: 503 }
    );
  }

  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "invalid registration body" }, { status: 400 });
  }

  if (!body.url.startsWith("https://")) {
    return NextResponse.json({ error: "backend url must be https" }, { status: 400 });
  }

  const { status, ...registration } = body;
  const [row, settings] = await Promise.all([
    registerBackend(registration, { extra: heartbeatFields(registration.url, status) }),
    getSettings(),
  ]);
  return NextResponse.json({
    ok: true,
    provider: row.provider,
    heartbeat_seconds: HEARTBEAT_SECONDS,
    // The Admin → Backends switches for this backend. Sent on every
    // heartbeat, so a notebook learns of a change within one beat; it uses
    // `clips` to decide whether to install AI video at all.
    features: backendFeatures(row),
    // A notebook stops itself after this many idle minutes (0 = never), so a
    // forgotten tab stops spending the free GPU allowance.
    idle_stop_minutes: settings.notebookIdleStopMinutes ?? 30,
  });
}
