/**
 * The central voice library.
 *
 * Metadata in Redis, reference clips in Vercel Blob. Backends never receive a
 * clip in a request body — they get its public Blob URL and fetch it once,
 * which keeps every gateway request small and lets a restarted Colab re-cache
 * a voice with no help from the browser.
 *
 * Same graceful-degradation rule as the rest of lib/server: with storage
 * unconfigured, reads return empty and writes report why instead of throwing
 * past the route handler.
 */

import { VOICE_REF_SLOTS, type LibraryVoice, type LibraryVoiceView, type VoiceRefs } from "@/lib/types";
import { deleteBlob, isBlobConfigured, putBlob } from "./blob";
import { isRedisConfigured, kvDel, kvGet, kvMGet, kvSet, redisFailure } from "./redis";

const KEY = (id: string) => `vf:voice:${id}`;
const INDEX_KEY = "vf:voices";
const DEFAULT_KEY = "vf:voice:default";

/** Clips are short reference samples, not narration. 15–20 s is ideal. */
export const MAX_CLIP_BYTES = 8 * 1024 * 1024;
export const MIN_CLIP_SECONDS = 4;
export const MAX_CLIP_SECONDS = 90;

export class VoiceStorageError extends Error {
  status: number;
  constructor(message: string, status = 503) {
    super(message);
    this.name = "VoiceStorageError";
    this.status = status;
  }
}

export function isVoiceStorageReady(): boolean {
  return isRedisConfigured() && isBlobConfigured();
}

/** Why it isn't ready, phrased as the next thing to do. */
export function voiceStorageHint(): string | null {
  // A failed read returns empty, so without this an outage or a blown quota
  // reads as "you have no voices" — which is how a working library once
  // looked permanently deleted.
  const failed = redisFailure();
  if (failed) {
    return (
      `Storage isn't responding (${failed.message}). Your data is still there — ` +
      "this is a read failure, not a deletion. On the Supabase free plan, check " +
      "whether the project has been paused for inactivity."
    );
  }
  if (isRedisConfigured() && isBlobConfigured()) return null;
  return "Add the Supabase env vars in Vercel (see docs/supabase-setup.md), then redeploy.";
}

// --- pure helpers (unit-tested) ------------------------------------------

/** Readable, URL-safe blob paths: "Bijay Narration" -> "bijay-narration". */
export function slugifyVoiceName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "voice";
}

/**
 * Slug plus a short random tail. The tail means renaming never has to move a
 * blob, and two voices called "Me" can coexist.
 */
export function newVoiceId(name: string, rand = randomTail): string {
  return `${slugifyVoiceName(name)}-${rand()}`;
}

function randomTail(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface WavMeta {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationSec: number;
}

/**
 * Read a WAV header without decoding the samples.
 *
 * We insist on WAV because the backends read clips with soundfile, whose MP3
 * support depends on the libsndfile build on whichever GPU host is running.
 * The browser converts uploads to PCM WAV before they get here.
 */
export function readWavMeta(buf: ArrayBuffer): WavMeta {
  const view = new DataView(buf);
  const tag = (off: number) =>
    String.fromCharCode(
      view.getUint8(off),
      view.getUint8(off + 1),
      view.getUint8(off + 2),
      view.getUint8(off + 3)
    );

  if (buf.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new VoiceStorageError("That isn't a WAV file.", 400);
  }

  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;
  let off = 12;

  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    if (id === "fmt ") {
      channels = view.getUint16(off + 10, true);
      sampleRate = view.getUint32(off + 12, true);
      bitsPerSample = view.getUint16(off + 22, true);
    } else if (id === "data") {
      // A streamed WAV can declare size 0; fall back to what actually arrived.
      dataBytes = size > 0 ? Math.min(size, buf.byteLength - off - 8) : buf.byteLength - off - 8;
      break;
    }
    off += 8 + size + (size % 2); // chunks are word-aligned
  }

  const bytesPerFrame = (channels * bitsPerSample) / 8;
  if (!sampleRate || !bytesPerFrame || !dataBytes) {
    throw new VoiceStorageError("That WAV file is missing its audio data.", 400);
  }

  return {
    sampleRate,
    channels,
    bitsPerSample,
    durationSec: dataBytes / bytesPerFrame / sampleRate,
  };
}

// --- store ---------------------------------------------------------------

async function readIndex(): Promise<string[]> {
  return (await kvGet<string[]>(INDEX_KEY)) ?? [];
}

async function writeIndex(ids: string[]): Promise<void> {
  await kvSet(INDEX_KEY, ids);
}

export async function getDefaultVoiceId(): Promise<string | null> {
  return await kvGet<string>(DEFAULT_KEY);
}

export async function listVoices(): Promise<LibraryVoiceView[]> {
  const ids = await readIndex();
  if (!ids.length) return [];
  const [rows, defaultId] = await Promise.all([
    kvMGet<LibraryVoice>(ids.map(KEY)),
    getDefaultVoiceId(),
  ]);
  return rows
    .filter((r): r is LibraryVoice => Boolean(r))
    .map((r) => ({ ...r, isDefault: r.id === defaultId }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.createdAt - a.createdAt);
}

export async function getVoice(id: string): Promise<LibraryVoice | null> {
  return await kvGet<LibraryVoice>(KEY(id));
}

/**
 * Resolve the voice a request should use.
 *
 * An explicit id wins; otherwise the default; otherwise, if exactly one voice
 * exists, that one — so a first API call works before anything is marked
 * default.
 */
export async function resolveVoice(requested?: string | null): Promise<LibraryVoice | null> {
  if (requested) return getVoice(requested);
  const defaultId = await getDefaultVoiceId();
  if (defaultId) {
    const row = await getVoice(defaultId);
    if (row) return row;
  }
  const all = await listVoices();
  return all.length === 1 ? all[0] : null;
}

export interface CreateVoiceInput {
  name: string;
  language: string;
  transcript: string;
  wav: ArrayBuffer;
}

export async function createVoice(input: CreateVoiceInput): Promise<LibraryVoice> {
  if (!isVoiceStorageReady()) {
    throw new VoiceStorageError(voiceStorageHint() ?? "Storage isn't connected.");
  }
  if (input.wav.byteLength > MAX_CLIP_BYTES) {
    throw new VoiceStorageError("That clip is too large — keep it under 8 MB.", 413);
  }

  const meta = readWavMeta(input.wav);
  if (meta.durationSec < MIN_CLIP_SECONDS) {
    throw new VoiceStorageError(
      `That clip is ${meta.durationSec.toFixed(1)}s. Use at least ${MIN_CLIP_SECONDS}s — 15–20s clones best.`,
      400
    );
  }
  if (meta.durationSec > MAX_CLIP_SECONDS) {
    throw new VoiceStorageError(
      `That clip is ${Math.round(meta.durationSec)}s. Trim it to ${MAX_CLIP_SECONDS}s or less.`,
      400
    );
  }

  const id = newVoiceId(input.name);
  const blob = await putBlob(`voices/${id}.wav`, input.wav, "audio/wav", {
    voice: id,
    language: input.language || "en",
    duration: meta.durationSec,
    text: input.transcript.trim(),
  });
  const now = Date.now();
  const row: LibraryVoice = {
    id,
    name: input.name.trim().slice(0, 80) || "Untitled voice",
    language: input.language || "en",
    transcript: input.transcript.trim(),
    audioUrl: blob.url,
    durationSec: Math.round(meta.durationSec * 10) / 10,
    sizeBytes: input.wav.byteLength,
    createdAt: now,
    updatedAt: now,
  };

  // kvSet swallows its errors and returns false, so an unreachable Redis
  // used to produce a cheerful 201 with nothing stored — the clip landed in
  // Blob, the voice did not exist, and the list stayed empty with no error
  // anywhere. A write that did not land is a failure and must say so.
  if (!(await kvSet(KEY(id), row))) {
    throw new VoiceStorageError(
      "Saved the clip but couldn't record the voice — storage rejected the write.",
      503
    );
  }
  await writeIndex([id, ...(await readIndex()).filter((x) => x !== id)]);
  // First voice becomes the default, so the API works without another step.
  if (!(await getDefaultVoiceId())) await kvSet(DEFAULT_KEY, id);
  return row;
}

export type VoicePatch = Partial<Pick<LibraryVoice, "name" | "language" | "transcript">> & {
  /** Per slot: a voice id to link, or null to unlink. */
  refs?: Partial<Record<keyof VoiceRefs, string | null>>;
};

/**
 * Apply a refs patch: null unlinks, a voice can't reference itself, and
 * unknown slots are ignored. Pure, so it is tested without storage.
 */
export function mergeRefs(
  selfId: string,
  current: VoiceRefs | undefined,
  patch: VoicePatch["refs"]
): VoiceRefs | undefined {
  if (!patch) return current;
  const next: VoiceRefs = { ...(current ?? {}) };
  for (const slot of VOICE_REF_SLOTS) {
    if (!(slot in patch)) continue;
    const v = patch[slot];
    if (!v || v === selfId) delete next[slot];
    else next[slot] = v;
  }
  return Object.keys(next).length ? next : undefined;
}

export async function updateVoice(id: string, patch: VoicePatch): Promise<LibraryVoice | null> {
  const existing = await getVoice(id);
  if (!existing) return null;
  const next: LibraryVoice = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 80) || existing.name } : {}),
    ...(patch.language !== undefined ? { language: patch.language } : {}),
    ...(patch.transcript !== undefined ? { transcript: patch.transcript.trim() } : {}),
    updatedAt: Date.now(),
  };
  if (patch.refs !== undefined) {
    const refs = mergeRefs(id, existing.refs, patch.refs);
    if (refs) next.refs = refs;
    else delete next.refs;
  }
  await kvSet(KEY(id), next);
  return next;
}

export async function setDefaultVoice(id: string): Promise<boolean> {
  if (!(await getVoice(id))) return false;
  await kvSet(DEFAULT_KEY, id);
  return true;
}

export async function deleteVoice(id: string): Promise<boolean> {
  const existing = await getVoice(id);
  if (!existing) return false;
  await deleteBlob(existing.audioUrl);
  await kvDel(KEY(id));
  await writeIndex((await readIndex()).filter((x) => x !== id));
  if ((await getDefaultVoiceId()) === id) {
    // Promote whatever is left rather than leaving a dangling default.
    const rest = await listVoices();
    if (rest[0]) await kvSet(DEFAULT_KEY, rest[0].id);
    else await kvDel(DEFAULT_KEY);
  }
  return true;
}
