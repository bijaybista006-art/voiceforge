/**
 * Direct-to-storage uploads for API clients.
 *
 * The file never passes through a Vercel function: anything over 4.5 MB is
 * rejected with FUNCTION_PAYLOAD_TOO_LARGE before a handler runs, which rules
 * out video clips and most decent images. Instead we hand back a signed URL
 * for one exact path and the client PUTs straight to Supabase Storage.
 *
 * A signed upload URL pins the path and nothing else, so:
 *  - the declared type and size are checked when the client calls
 *    "complete", and a file that does not match is deleted there
 *  - the bucket itself refuses anything over 50 MB or of a type it does not
 *    hold, whatever the client claims
 *  - expiry is swept by the daily cron, driven by the rows written here
 */

import { deleteBlob, isBlobConfigured } from "./blob";
import { isRedisConfigured, kvDel, kvGet, kvScan, kvSet } from "./redis";
import { createSignedUpload, fileInfo, recordFile } from "../storage";

const KEY = (id: string) => `vf:upload:${id}`;
const INDEX = "vf:uploads";
/** Bounded: the sweep only needs recent uploads, not an archive. */
const INDEX_LIMIT = 2000;

export const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
export const SCENE_RETENTION_DAYS = 7;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export const UPLOAD_CONTENT_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "video/mp4",
] as const;

export type UploadContentType = (typeof UPLOAD_CONTENT_TYPES)[number];
export type UploadPurpose = "scene" | "brand";

export interface UploadRow {
  id: string;
  keyId: string;
  pathname: string;
  publicUrl: string;
  contentType: UploadContentType;
  bytes: number;
  purpose: UploadPurpose;
  createdAt: number;
  /** null for "brand" — those are kept until deleted by hand. */
  expiresAt: number | null;
}

export class UploadError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 400, code = "invalid_request") {
    super(message);
    this.name = "UploadError";
    this.status = status;
    this.code = code;
  }
}

// --- pure helpers (unit-tested) ------------------------------------------

/**
 * Reduce a client-supplied filename to something safe to put in a URL.
 * Everything outside [a-z0-9._-] goes, because the name ends up in a path
 * that ffmpeg, urllib and a browser all have to agree on.
 */
export function sanitiseFilename(name: string): string {
  const cleaned = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return cleaned || "file";
}

export function maxBytesFor(contentType: UploadContentType): number {
  return contentType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
}

/** uploads/<key>/<yyyy-mm-dd>/<uuid>-<filename> */
export function uploadPathname(
  keyId: string,
  filename: string,
  id: string,
  now = new Date()
): string {
  const day = now.toISOString().slice(0, 10);
  return `uploads/${keyId}/${day}/${id}-${sanitiseFilename(filename)}`;
}

export function expiryFor(purpose: UploadPurpose, now = Date.now()): number | null {
  return purpose === "brand" ? null : now + SCENE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

// --- create ---------------------------------------------------------------

export interface CreateUploadInput {
  keyId: string;
  filename: string;
  contentType: UploadContentType;
  bytes: number;
  purpose: UploadPurpose;
}

export interface CreatedUpload {
  upload_id: string;
  upload_url: string;
  method: "PUT";
  headers: Record<string, string>;
  public_url: string;
  expires_at: string | null;
}

export async function createUpload(input: CreateUploadInput): Promise<CreatedUpload> {
  if (!isBlobConfigured() || !isRedisConfigured()) {
    throw new UploadError(
      "Storage isn't connected. Add the Supabase env vars in Vercel.",
      503,
      "storage_unavailable"
    );
  }

  const limit = maxBytesFor(input.contentType);
  if (input.bytes > limit) {
    throw new UploadError(
      `${input.contentType} is limited to ${Math.round(limit / 1024 / 1024)} MB.`,
      413,
      "file_too_large"
    );
  }

  const id = crypto.randomUUID();
  const pathname = uploadPathname(input.keyId, input.filename, id);
  // The path contains a UUID we generated, so the only thing a repeat PUT
  // can overwrite is the caller's own half-finished upload. That is what
  // lets an HTTP client that retries a timeout recover.
  const signed = await createSignedUpload(pathname);

  const row: UploadRow = {
    id,
    keyId: input.keyId,
    pathname,
    publicUrl: signed.publicUrl,
    contentType: input.contentType,
    bytes: input.bytes,
    purpose: input.purpose,
    createdAt: Date.now(),
    expiresAt: expiryFor(input.purpose),
  };

  await kvSet(KEY(id), row);
  await kvSet(INDEX, [id, ...((await kvGet<string[]>(INDEX)) ?? [])].slice(0, INDEX_LIMIT));

  return {
    upload_id: id,
    upload_url: signed.uploadUrl,
    method: "PUT",
    headers: {
      // The signature is in the URL. The type is what the file is stored
      // and later served as, so it has to be sent.
      "content-type": input.contentType,
      "x-upsert": "true",
    },
    public_url: row.publicUrl,
    expires_at: row.expiresAt ? new Date(row.expiresAt).toISOString() : null,
  };
}

// --- complete -------------------------------------------------------------

export async function getUpload(id: string): Promise<UploadRow | null> {
  return kvGet<UploadRow>(KEY(id));
}

export async function completeUpload(
  id: string,
  keyId: string
): Promise<{ public_url: string; bytes: number }> {
  const row = await getUpload(id);
  if (!row || row.keyId !== keyId) {
    throw new UploadError("No upload with that id.", 404, "unknown_upload");
  }

  const info = await fileInfo(row.pathname);
  if (!info) {
    throw new UploadError(
      "That file hasn't been uploaded yet.",
      409,
      "upload_incomplete"
    );
  }

  // The signed URL could not enforce what was declared, so this is where it
  // is enforced: a file that is not what the caller said is removed, not
  // left behind under a public URL.
  if (info.contentType && info.contentType !== row.contentType) {
    await deleteBlob(row.pathname);
    throw new UploadError(
      `Stored file is ${info.contentType}, not the declared ${row.contentType}.`,
      409,
      "content_type_mismatch"
    );
  }
  if (info.size > row.bytes) {
    await deleteBlob(row.pathname);
    throw new UploadError("Stored file is larger than declared.", 409, "size_mismatch");
  }

  await recordFile(row.pathname, row.contentType, { kind: "upload", sizeBytes: info.size });
  return { public_url: row.publicUrl, bytes: info.size };
}

// --- retention ------------------------------------------------------------

/**
 * Deletes expired "scene" uploads. "brand" rows have no expiry and are kept.
 *
 * Walks every upload record rather than the index: a video asks for thirty
 * uploads at once, and thirty read-then-write updates to one list lose most
 * of each other's ids. Records that fell out of the list were never swept.
 */
export async function purgeExpiredUploads(now = Date.now()): Promise<number> {
  const rows = await kvScan<UploadRow>("vf:upload:");
  let deleted = 0;
  const gone = new Set<string>();

  for (const row of rows) {
    if (!row?.id || row.expiresAt === null || row.expiresAt >= now) continue;
    await deleteBlob(row.pathname ?? row.publicUrl);
    await kvDel(KEY(row.id));
    gone.add(row.id);
    deleted++;
  }

  if (deleted) {
    await kvSet(INDEX, ((await kvGet<string[]>(INDEX)) ?? []).filter((id) => !gone.has(id)));
  }
  return deleted;
}
