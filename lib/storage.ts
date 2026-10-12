/**
 * Supabase — the platform's only storage. Server-side only.
 *
 * Two things live here:
 *  - files, in one public bucket, with a row per file in `audio_files`
 *  - the key store (`kv` table) that holds settings, voices, keys, jobs and
 *    the backend registry under the same key names they have always had
 *
 * Degrades gracefully on purpose: with no Supabase env vars every read
 * returns empty and every write reports failure instead of throwing, so the
 * app still builds, deploys and runs, and the admin UI says "storage not
 * connected". Storage is a feature, not a startup requirement.
 *
 * The service-role key bypasses row level security, so nothing in this file
 * may ever be imported by a client component.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const BUCKET = "voiceforge-audio";

function credentials(): { url: string; key: string } | null {
  const url = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "").replace(
    /\/+$/,
    ""
  );
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return url && key ? { url, key } : null;
}

export function isStorageConfigured(): boolean {
  return credentials() !== null;
}

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  const creds = credentials();
  if (!creds) return null;
  if (!client) {
    client = createClient(creds.url, creds.key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export class StorageNotConfiguredError extends Error {
  constructor() {
    super("Supabase is not connected. Add the Supabase env vars in Vercel.");
    this.name = "StorageNotConfiguredError";
  }
}

// --- files ----------------------------------------------------------------

export type FileKind =
  | "voice"
  | "job"
  | "presenter-clip"
  | "presenter"
  | "asset"
  | "upload"
  | "other";

/** What a file is, from where it sits. Paths are namespaced by purpose. */
export function kindOfPath(path: string): FileKind {
  if (path.startsWith("voices/")) return "voice";
  if (path.startsWith("jobs/")) return "job";
  if (path.startsWith("presenter-clips/")) return "presenter-clip";
  if (path.startsWith("presenters/")) return "presenter";
  if (path.startsWith("assets/")) return "asset";
  if (path.startsWith("uploads/")) return "upload";
  return "other";
}

/** Where the bucket's files are served from. Empty when not configured. */
export function publicBaseUrl(): string {
  const creds = credentials();
  return creds ? `${creds.url}/storage/v1/object/public/${BUCKET}` : "";
}

export function getAudioUrl(path: string): string {
  return `${publicBaseUrl()}/${path.replace(/^\/+/, "")}`;
}

/**
 * The bucket path a stored URL points at, or null when it is not ours.
 *
 * A link written before the move to Supabase still names the old store; its
 * path is the same in the bucket, so it resolves too.
 */
export function pathFromUrl(urlOrPath: string): string | null {
  if (!/^https?:\/\//i.test(urlOrPath)) return urlOrPath.replace(/^\/+/, "") || null;
  const base = publicBaseUrl();
  if (base && urlOrPath.startsWith(`${base}/`)) {
    return decodeURIComponent(urlOrPath.slice(base.length + 1).split("?")[0]);
  }
  try {
    const u = new URL(urlOrPath);
    if (u.hostname.endsWith(".blob.vercel-storage.com")) {
      return decodeURIComponent(u.pathname.replace(/^\/+/, ""));
    }
  } catch {
    /* not a URL we can read */
  }
  return null;
}

/** Is this an https link into our own bucket? */
export function isOurFileUrl(url: string): boolean {
  const base = publicBaseUrl();
  return Boolean(base) && base.startsWith("https://") && url.startsWith(`${base}/`);
}

export interface FileMeta {
  kind?: FileKind;
  sizeBytes?: number;
  duration?: number;
  voice?: string;
  text?: string;
  language?: string;
  jobId?: string;
}

export interface AudioFileRow {
  id: string;
  path: string;
  public_url: string;
  kind: FileKind;
  content_type: string | null;
  size_bytes: number | null;
  duration: number | null;
  voice: string | null;
  text: string | null;
  language: string | null;
  job_id: string | null;
  created_at: string;
}

/**
 * Note a file in the ledger. Never fatal: the file itself is what matters,
 * and a missing row only makes one list a row short.
 */
export async function recordFile(
  path: string,
  contentType: string | undefined,
  meta: FileMeta = {}
): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const { error } = await db.from("audio_files").upsert(
    {
      path,
      public_url: getAudioUrl(path),
      kind: meta.kind ?? kindOfPath(path),
      content_type: contentType ?? null,
      size_bytes: meta.sizeBytes ?? null,
      duration: meta.duration ?? null,
      voice: meta.voice ?? null,
      text: meta.text?.slice(0, 2000) ?? null,
      language: meta.language ?? null,
      job_id: meta.jobId ?? null,
    },
    { onConflict: "path" }
  );
  if (error) console.warn("[voiceforge] file not recorded:", path, error.message);
}

function sizeOf(body: Blob | ArrayBuffer | Buffer | string): number {
  if (typeof body === "string") return Buffer.byteLength(body);
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  return (body as Buffer).length;
}

/** Store a file at a fixed path and return its public URL. */
export async function uploadAudio(
  path: string,
  body: Blob | ArrayBuffer | Buffer | string,
  contentType?: string,
  meta: FileMeta = {}
): Promise<{ url: string; path: string }> {
  const db = getSupabase();
  if (!db) throw new StorageNotConfiguredError();
  const { error } = await db.storage.from(BUCKET).upload(path, body, {
    contentType,
    // A retried collection writes the same bytes to the same path; refusing
    // the second write is how a finished job once ended up marked failed.
    upsert: true,
  });
  if (error) throw new Error(`storage upload failed for ${path}: ${error.message}`);
  await recordFile(path, contentType, { sizeBytes: sizeOf(body), ...meta });
  return { url: getAudioUrl(path), path };
}

/** A page of the ledger, newest first. Reads Postgres, never the bucket. */
export async function listAudio(
  opts: { kind?: FileKind; limit?: number; offset?: number } = {}
): Promise<{ rows: AudioFileRow[]; total: number }> {
  const db = getSupabase();
  if (!db) return { rows: [], total: 0 };
  const limit = Math.min(200, Math.max(1, opts.limit ?? 50));
  const offset = Math.max(0, opts.offset ?? 0);
  let query = db
    .from("audio_files")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (opts.kind) query = query.eq("kind", opts.kind);
  const { data, count, error } = await query;
  if (error) {
    console.warn("[voiceforge] file list failed:", error.message);
    return { rows: [], total: 0 };
  }
  return { rows: (data ?? []) as AudioFileRow[], total: count ?? 0 };
}

/** Remove a file and its ledger row. Quiet when it is already gone. */
export async function deleteAudio(urlOrPath: string): Promise<void> {
  const db = getSupabase();
  if (!db) return;
  const path = pathFromUrl(urlOrPath);
  if (!path) return;
  try {
    const { error } = await db.storage.from(BUCKET).remove([path]);
    if (error) console.warn("[voiceforge] file delete failed:", path, error.message);
    await db.from("audio_files").delete().eq("path", path);
  } catch (e) {
    console.warn("[voiceforge] file delete failed:", path, e);
  }
}

/**
 * A URL a client can PUT one file to, at exactly this path, with no other
 * credential. The file goes straight to the bucket and never through a
 * Vercel function, whose request bodies are capped at 4.5 MB.
 *
 * Unlike the store this replaced, the link cannot carry a size or type
 * limit. The bucket enforces 50 MB and a list of media types; anything
 * narrower is checked after the upload, by whoever asked for the link.
 */
export async function createSignedUpload(
  path: string
): Promise<{ uploadUrl: string; publicUrl: string; path: string }> {
  const db = getSupabase();
  if (!db) throw new StorageNotConfiguredError();
  const { data, error } = await db.storage
    .from(BUCKET)
    // A client that retries a timed-out PUT must be able to finish.
    .createSignedUploadUrl(path, { upsert: true });
  if (error || !data) {
    throw new Error(`could not authorise an upload to ${path}: ${error?.message ?? "no link"}`);
  }
  return { uploadUrl: data.signedUrl, publicUrl: getAudioUrl(path), path };
}

/** Size and type of a stored file, or null when there is no such file. */
export async function fileInfo(
  urlOrPath: string
): Promise<{ size: number; contentType?: string } | null> {
  const db = getSupabase();
  const path = pathFromUrl(urlOrPath);
  if (!db || !path) return null;
  const { data, error } = await db.storage.from(BUCKET).info(path);
  if (error || !data) return null;
  return { size: Number(data.size ?? 0), contentType: data.contentType ?? undefined };
}

// --- key store ------------------------------------------------------------

/**
 * Set when a call fails for a reason that is not "not configured" — a paused
 * project, a network fault, an outage.
 *
 * It matters because every read below swallows errors and returns null, so
 * the app keeps serving. The cost is that a failed read is indistinguishable
 * from an empty database: a quota ceiling once made VoiceForge report that
 * every voice, backend and key had been deleted when nothing had. Callers
 * can ask whether "empty" was actually a failure.
 */
let lastFailure: { at: number; message: string } | null = null;

function noteFailure(e: unknown): void {
  const message =
    e instanceof Error
      ? e.message
      : typeof e === "object" && e && "message" in e
        ? String((e as { message: unknown }).message)
        : "storage call failed";
  lastFailure = { at: Date.now(), message: message.slice(0, 200) };
}

/** Did a storage call fail recently? Null when storage is healthy. */
export function storageFailure(withinMs = 60_000): { at: number; message: string } | null {
  if (!lastFailure) return null;
  return Date.now() - lastFailure.at <= withinMs ? lastFailure : null;
}

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const db = getSupabase();
  if (!db) throw new StorageNotConfiguredError();
  const { data, error } = await db.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

/** Read many keys in ONE round trip, in the order asked. */
export async function kvMGet<T>(keys: string[]): Promise<(T | null)[]> {
  if (!keys.length) return [];
  if (!isStorageConfigured()) return keys.map(() => null);
  try {
    const rows = await call<{ key: string; value: T }[]>("kv_get", { p_keys: keys });
    const found = new Map((rows ?? []).map((r) => [r.key, r.value]));
    return keys.map((k) => (found.has(k) ? (found.get(k) as T) : null));
  } catch (e) {
    noteFailure(e);
    console.warn("[voiceforge] storage read failed:", keys.length, e);
    return keys.map(() => null);
  }
}

export async function kvGet<T>(key: string): Promise<T | null> {
  return (await kvMGet<T>([key]))[0] ?? null;
}

export async function kvSet(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
  if (!isStorageConfigured()) return false;
  try {
    await call("kv_set", { p_key: key, p_value: value ?? null, p_ttl: ttlSeconds ?? null });
    return true;
  } catch (e) {
    noteFailure(e);
    console.warn("[voiceforge] storage write failed:", key, e);
    return false;
  }
}

export async function kvDel(key: string): Promise<boolean> {
  if (!isStorageConfigured()) return false;
  try {
    await call("kv_del", { p_key: key });
    return true;
  } catch {
    return false;
  }
}

/**
 * The few operations that have to be atomic, in the shape their callers
 * already use. Each is one SQL statement on the server, so two requests
 * arriving together cannot both win a lock or lose a count.
 */
export interface AtomicStore {
  incr(key: string): Promise<number>;
  incrby(key: string, by: number): Promise<number>;
  expire(key: string, seconds: number): Promise<void>;
  /** With `nx`, "OK" when the key was absent and is now ours, else null. */
  set(key: string, value: unknown, opts?: { nx?: boolean; ex?: number }): Promise<"OK" | null>;
  exists(key: string): Promise<number>;
}

const atomic: AtomicStore = {
  incr: (key) => atomic.incrby(key, 1),
  incrby: async (key, by) => Number(await call<number>("kv_incr", { p_key: key, p_by: by })),
  expire: async (key, seconds) => {
    await call("kv_expire", { p_key: key, p_ttl: seconds });
  },
  set: async (key, value, opts = {}) => {
    if (opts.nx) {
      const won = await call<boolean>("kv_set_nx", {
        p_key: key,
        p_value: value ?? null,
        p_ttl: opts.ex ?? null,
      });
      return won ? "OK" : null;
    }
    await call("kv_set", { p_key: key, p_value: value ?? null, p_ttl: opts.ex ?? null });
    return "OK";
  },
  exists: async (key) => {
    const rows = await call<{ key: string }[]>("kv_get", { p_keys: [key] });
    return rows?.length ? 1 : 0;
  },
};

/** Null when storage is not connected; callers treat that as "no limits". */
export function getAtomicStore(): AtomicStore | null {
  return isStorageConfigured() ? atomic : null;
}

/**
 * Count one request against a sliding window.
 *
 * Fails open: a storage fault must not turn into every API call being
 * refused. `reset` is when the current window ends, in ms.
 */
export async function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ success: boolean; reset: number }> {
  if (!isStorageConfigured()) return { success: true, reset: Date.now() };
  try {
    const rows = await call<{ allowed: boolean; reset_at: string }[]>("rate_limit", {
      p_key: key,
      p_limit: limit,
      p_window: windowSeconds,
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    return {
      success: row?.allowed !== false,
      reset: row?.reset_at ? Date.parse(row.reset_at) : Date.now() + windowSeconds * 1000,
    };
  } catch (e) {
    noteFailure(e);
    return { success: true, reset: Date.now() };
  }
}

/** Drop expired keys. Called by the daily sweep. */
export async function purgeExpiredKeys(): Promise<number> {
  if (!isStorageConfigured()) return 0;
  try {
    return Number(await call<number>("kv_purge_expired", {}));
  } catch {
    return 0;
  }
}
