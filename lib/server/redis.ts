/**
 * Upstash Redis — the platform's data store (config, API keys, jobs, usage).
 *
 * Degrades gracefully on purpose: if the Upstash env vars aren't connected
 * yet, every call returns empty instead of throwing, so the app still builds,
 * deploys and runs. The admin UI surfaces "storage not connected" rather than
 * crashing. Storage is a feature, not a startup requirement.
 */

import { Redis } from "@upstash/redis";

let client: Redis | null = null;

/**
 * Vercel's Upstash integration injects KV_REST_API_URL / KV_REST_API_TOKEN,
 * while Upstash's own dashboard gives you UPSTASH_REDIS_REST_*. Accept either,
 * so connecting the store from Vercel just works with nothing copied by hand.
 */
function credentials(): { url: string; token: string } | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
  return url && token ? { url, token } : null;
}

export function isRedisConfigured(): boolean {
  return credentials() !== null;
}

export function getRedis(): Redis | null {
  const creds = credentials();
  if (!creds) return null;
  if (!client) client = new Redis(creds);
  return client;
}

/**
 * Set when a Redis call fails for a reason that is not "not configured" —
 * a quota ceiling, a network fault, an outage.
 *
 * It matters because every read below swallows errors and returns null, so
 * the app keeps serving. The cost is that a failed read is indistinguishable
 * from an empty database: a quota ceiling once made VoiceForge report that
 * every voice, backend and key had been deleted when nothing had. Callers
 * can ask whether "empty" was actually a failure.
 */
let lastFailure: { at: number; message: string } | null = null;

function noteFailure(e: unknown): void {
  lastFailure = {
    at: Date.now(),
    message: e instanceof Error ? e.message.slice(0, 200) : "redis call failed",
  };
}

/** Did a Redis call fail recently? Null when storage is healthy. */
export function redisFailure(withinMs = 60_000): { at: number; message: string } | null {
  if (!lastFailure) return null;
  return Date.now() - lastFailure.at <= withinMs ? lastFailure : null;
}

// --- typed helpers -------------------------------------------------------

export async function kvGet<T>(key: string): Promise<T | null> {
  const r = getRedis();
  if (!r) return null;
  try {
    return (await r.get<T>(key)) ?? null;
  } catch (e) {
    noteFailure(e);
    console.warn("[voiceforge] redis get failed:", key, e);
    return null;
  }
}

/**
 * Read many keys in ONE command.
 *
 * Every list used to be 1 + N round trips: the index, then a GET per row.
 * The admin Jobs page polls every 10s and reads 50 rows, which is ~18,400
 * commands an hour from a tab sitting open doing nothing — enough to burn a
 * 500k/month Upstash free tier in about a day. MGET makes a list two
 * commands regardless of size.
 */
export async function kvMGet<T>(keys: string[]): Promise<(T | null)[]> {
  if (!keys.length) return [];
  const r = getRedis();
  if (!r) return keys.map(() => null);
  try {
    const rows = await r.mget<T[]>(...keys);
    return keys.map((_k, i) => (rows?.[i] ?? null) as T | null);
  } catch (e) {
    noteFailure(e);
    console.warn("[voiceforge] redis mget failed:", keys.length, e);
    return keys.map(() => null);
  }
}

export async function kvSet(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  try {
    if (ttlSeconds) await r.set(key, value, { ex: ttlSeconds });
    else await r.set(key, value);
    return true;
  } catch (e) {
    noteFailure(e);
    console.warn("[voiceforge] redis set failed:", key, e);
    return false;
  }
}

export async function kvDel(key: string): Promise<boolean> {
  const r = getRedis();
  if (!r) return false;
  try {
    await r.del(key);
    return true;
  } catch {
    return false;
  }
}

// --- settings ------------------------------------------------------------

export const SETTINGS_KEY = "vf:settings";

export interface PlatformSettings {
  /** Days before generated audio is purged from Blob. */
  retentionDays: number;
  /** Notebook URL shown in the Backends connect dialog. */
  kaggleNotebookUrl: string;
  defaultModel: "chatterbox" | "qwen3";
  defaultLanguage: string;
  /** English words and how to write them so the model says them right. */
  pronunciations: Record<string, string>;
  /** The same for Nepali: a word, and a spelling the Nepali model reads better. */
  nepaliPronunciations: Record<string, string>;
  /** Playback speed of finished Nepali audio. 1 is the model's own pace. */
  nepaliSpeed: number;
  /** How long the last word of a Nepali sentence is held, in 40 ms frames. */
  nepaliEnding: number;
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  retentionDays: 7,
  kaggleNotebookUrl: "",
  defaultModel: "chatterbox",
  defaultLanguage: "en",
  pronunciations: {},
  nepaliPronunciations: {},
  // The model reads Nepali at 13-17 characters a second, fast enough to blur
  // words. A little slower by default; pitch is unchanged.
  nepaliSpeed: 0.92,
  // Left to itself the model draws the last word of a sentence out.
  nepaliEnding: 6,
};

export async function getSettings(): Promise<PlatformSettings> {
  const stored = await kvGet<Partial<PlatformSettings>>(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
}

export async function saveSettings(patch: Partial<PlatformSettings>): Promise<PlatformSettings> {
  const next = { ...(await getSettings()), ...patch };
  await kvSet(SETTINGS_KEY, next);
  return next;
}
