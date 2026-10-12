/**
 * Auth, rate limiting and quota for /api/v1.
 *
 * One helper so every endpoint enforces the same three things in the same
 * order, and none of them can quietly forget one:
 *   1. a valid, unrevoked key
 *   2. the per-minute rate limit
 *   3. the monthly character quota, checked BEFORE work starts
 */

import { NextResponse } from "next/server";
import {
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  quotaError,
  resolveApiKey,
  type ApiKeyRecord,
} from "./apikeys";
import { isRedisConfigured } from "./redis";
import { rateLimit } from "../storage";

export interface AuthOk {
  ok: true;
  key: ApiKeyRecord;
}
export interface AuthFail {
  ok: false;
  response: NextResponse;
}
export type AuthResult = AuthOk | AuthFail;

export function apiError(message: string, status: number, code: string): NextResponse {
  return NextResponse.json({ error: { message, code, type: "voiceforge_error" } }, { status });
}

/**
 * A separate, slower bucket for creating uploads.
 *
 * A five-minute video asks for ~30 of these in a burst, which would trip the
 * per-minute request limit even though the work involved is trivial — we only
 * mint a token. Counting them per hour fits how they actually arrive.
 */
export async function checkUploadLimit(keyId: string): Promise<NextResponse | null> {
  const { success, reset } = await rateLimit(`vf:rl:upload:${keyId}`, 300, 3600);
  if (success) return null;
  const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
  const response = apiError(
    `Upload limit exceeded: 300 per hour. Retry in ${retryAfter}s.`,
    429,
    "rate_limit_exceeded"
  );
  response.headers.set("Retry-After", String(retryAfter));
  return response;
}

/**
 * Quota check, split out so endpoints can authenticate BEFORE parsing a body.
 * Returns null when the key is within quota, or a response when it isn't.
 */
export async function checkQuota(
  key: ApiKeyRecord,
  chars: number
): Promise<NextResponse | null> {
  if (chars <= 0) return null;
  const overQuota = await quotaError(key, chars);
  return overQuota ? apiError(overQuota, 429, "quota_exceeded") : null;
}

/**
 * @param chars characters this request would generate, for the quota check.
 *   Pass 0 when the body hasn't been read yet and call checkQuota after.
 */
export async function authenticate(req: Request, chars = 0): Promise<AuthResult> {
  if (!isRedisConfigured()) {
    return {
      ok: false,
      response: apiError(
        "Storage isn't connected, so API keys can't be verified. Add the Supabase env vars in Vercel.",
        503,
        "storage_unavailable"
      ),
    };
  }

  const key = await resolveApiKey(req.headers.get("authorization"));
  if (!key) {
    return {
      ok: false,
      response: apiError(
        "Missing or invalid API key. Send `Authorization: Bearer vf_live_…`.",
        401,
        "invalid_api_key"
      ),
    };
  }

  const perMinute = key.rateLimitPerMinute || DEFAULT_RATE_LIMIT_PER_MINUTE;
  {
    // The limit is part of the name, so changing a key's limit starts a
    // fresh count instead of judging it by the old window.
    const { success, reset } = await rateLimit(`vf:rl:${key.id}:${perMinute}`, perMinute, 60);
    if (!success) {
      const retryAfter = Math.max(1, Math.ceil((reset - Date.now()) / 1000));
      const response = apiError(
        `Rate limit exceeded: ${perMinute} requests per minute. Retry in ${retryAfter}s.`,
        429,
        "rate_limit_exceeded"
      );
      response.headers.set("Retry-After", String(retryAfter));
      return { ok: false, response };
    }
  }

  if (chars > 0) {
    const overQuota = await quotaError(key, chars);
    if (overQuota) {
      return { ok: false, response: apiError(overQuota, 429, "quota_exceeded") };
    }
  }

  return { ok: true, key };
}

/**
 * This deployment's own public URL, for building callback and status URLs.
 * Prefers the explicit env var, then Vercel's, then the request — so it is
 * correct on localhost, previews and production without configuration.
 */
export function appUrlFrom(req: Request): string {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  const proto = host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}
