/**
 * Retention sweep — deletes generated audio older than the configured window.
 *
 * Driven by the daily Vercel cron in vercel.json. It's also safe to call by
 * hand. Authenticated by CRON_SECRET when set (Vercel sends it automatically
 * for its own cron invocations); without that variable the route only answers
 * to Vercel's own cron user agent, and otherwise refuses.
 */

import { NextResponse } from "next/server";
import { purgeExpiredJobs } from "@/lib/server/jobs";
import { purgeExpiredUploads } from "@/lib/server/uploads";
import { getSettings, isRedisConfigured } from "@/lib/server/redis";
import { purgeExpiredKeys } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) return req.headers.get("authorization") === `Bearer ${secret}`;
  // No secret configured: accept Vercel's own scheduler and nothing else.
  return (req.headers.get("user-agent") ?? "").includes("vercel-cron");
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!isRedisConfigured()) {
    return NextResponse.json({ ok: true, skipped: "storage not connected" });
  }

  const { retentionDays } = await getSettings();
  const deleted = await purgeExpiredJobs();
  // Scene uploads expire on their own schedule; brand ones never do.
  const uploads = await purgeExpiredUploads();
  // Expired locks, counters and rate-limit windows. Reads already ignore
  // them; this only stops them piling up.
  const keys = await purgeExpiredKeys();
  return NextResponse.json({ ok: true, deleted, uploads, keys, retentionDays });
}
