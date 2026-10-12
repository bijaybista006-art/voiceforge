/**
 * The platform's data store (config, API keys, jobs, usage).
 *
 * The data lives in Supabase now; see lib/storage.ts. This module keeps the
 * names the rest of the server has always imported, so moving the store did
 * not mean touching the voice, job or backend code that reads through it.
 *
 * Still degrades gracefully: with storage not connected every call returns
 * empty instead of throwing, and the admin UI says so rather than crashing.
 */

import {
  getAtomicStore,
  isStorageConfigured,
  kvDel,
  kvGet,
  kvMGet,
  kvSet,
  storageFailure,
  type AtomicStore,
} from "../storage";

export { kvDel, kvGet, kvMGet, kvSet };

export function isRedisConfigured(): boolean {
  return isStorageConfigured();
}

/** Counters and locks. Null when storage is not connected. */
export function getRedis(): AtomicStore | null {
  return getAtomicStore();
}

/** Did a storage call fail recently? Null when storage is healthy. */
export function redisFailure(withinMs = 60_000): { at: number; message: string } | null {
  return storageFailure(withinMs);
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
