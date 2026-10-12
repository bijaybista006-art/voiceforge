/**
 * File storage — voice reference clips and generated audio.
 *
 * Files live in Supabase Storage now; see lib/storage.ts. This module keeps
 * the names the job and voice code import. Same rule as redis.ts:
 * unconfigured means "feature unavailable", never a crash.
 */

import {
  deleteAudio,
  isStorageConfigured,
  StorageNotConfiguredError,
  uploadAudio,
  type FileMeta,
} from "../storage";

export function isBlobConfigured(): boolean {
  return isStorageConfigured();
}

export { StorageNotConfiguredError as BlobNotConfiguredError };

/**
 * Paths are already namespaced (voices/<id>, jobs/<id>) and the URL for an
 * id is stable: writing the same path again replaces the file.
 */
export async function putBlob(
  pathname: string,
  body: Blob | ArrayBuffer | Buffer | string,
  contentType?: string,
  meta?: FileMeta
): Promise<{ url: string; pathname: string }> {
  const stored = await uploadAudio(pathname, body, contentType, meta);
  return { url: stored.url, pathname: stored.path };
}

export async function deleteBlob(url: string): Promise<void> {
  await deleteAudio(url);
}
