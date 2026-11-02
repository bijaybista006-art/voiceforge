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
  kvScan,
  kvSet,
  storageFailure,
  type AtomicStore,
} from "../storage";

export { kvDel, kvGet, kvMGet, kvScan, kvSet };

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

/**
 * A model file name in the owner's repo (letters, digits, dots, dashes,
 * underscores), optionally "@0.6": that share of it blended with the original
 * multilingual model (backend ne_split_mix).
 */
export const NEPALI_MODEL_FILE = /^[\w.-]+\.safetensors(@(0?\.\d{1,2}|1(\.0+)?))?$/;

export interface PlatformSettings {
  /** Days before generated audio is purged from Blob. */
  retentionDays: number;
  /** Your saved Kaggle notebook ("Open my Kaggle notebook" on Admin → Backends). */
  kaggleNotebookUrl: string;
  /** Your saved Colab notebook, usually https://colab.research.google.com/drive/<id>. */
  colabNotebookUrl: string;
  /** The dedicated Google account the Colab buttons open in (Google's `authuser`). */
  googleAccount: string;
  /**
   * Minutes a Colab/Kaggle notebook may sit with nothing to do before it
   * stops itself (and, on Colab, gives the GPU back). 0 = never.
   */
  notebookIdleStopMinutes: number;
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
  /**
   * Which trained version of the Nepali model speaks: a file in the owner's
   * model repo (e.g. "v3.safetensors"), or "" for the backend's default.
   * A training run that beats the current model sets this itself.
   */
  nepaliModel: string;
  /** What the current Nepali model is, in a line, for the Settings page. */
  nepaliModelNote: string;
  /**
   * Where every training run starts, in the same form as nepaliModel; ""
   * for the backend's default. Kept apart from nepaliModel so each run starts
   * from the chosen base on all recordings, not from the last run.
   */
  nepaliBaseModel: string;
}

export const DEFAULT_SETTINGS: PlatformSettings = {
  retentionDays: 7,
  kaggleNotebookUrl: "",
  colabNotebookUrl: "",
  googleAccount: "",
  notebookIdleStopMinutes: 30,
  defaultModel: "chatterbox",
  defaultLanguage: "en",
  pronunciations: {},
  nepaliPronunciations: {},
  // The model's own pace. 0.92 was tried and measured (Oct 2026): it made
  // narration 8% slower than the speaker's own recordings of the same lines.
  nepaliSpeed: 1,
  // Frames the last letter may sound before the take ends. 6 stopped most
  // takes while the last word was still sounding; 12 (with 8 frames after
  // the closing punctuation) let it finish — measured Oct 2026.
  nepaliEnding: 12,
  nepaliModel: "",
  nepaliModelNote: "",
  nepaliBaseModel: "",
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
