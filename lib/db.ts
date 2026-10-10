/**
 * IndexedDB persistence (idb wrapper). Three stores:
 * - voices:      Voice records including the reference sample blob
 * - projects:    Project metadata + chunk list (WITHOUT audio blobs)
 * - chunkAudio:  one record per generated chunk, written the instant a chunk
 *                returns so a disconnect never loses completed work
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Chunk, Project, Voice } from "./types";

interface StoredChunkAudio {
  key: string; // `${projectId}:${chunkId}`
  projectId: string;
  chunkId: string;
  blob: Blob;
  durationSec: number;
  sampleRate: number;
}

/** Talking-head assets: the source portrait and the last rendered video. */
interface StoredVideoAsset {
  key: "sourcePhoto" | "resultVideo";
  blob: Blob;
  mime: string;
  durationSec?: number;
}

interface VoiceForgeDB extends DBSchema {
  voices: { key: string; value: Voice };
  projects: { key: string; value: Project };
  chunkAudio: {
    key: string;
    value: StoredChunkAudio;
    indexes: { byProject: string };
  };
  videoAssets: { key: string; value: StoredVideoAsset };
}

let dbPromise: Promise<IDBPDatabase<VoiceForgeDB>> | null = null;
let openConn: IDBPDatabase<VoiceForgeDB> | null = null;

/**
 * Opening must never hang the app. A version upgrade is BLOCKED for as long as
 * another tab still holds the old version open — without a timeout that promise
 * simply never settles, and every caller awaiting it waits forever. Storage is
 * a nice-to-have; the UI is not allowed to depend on it starting up.
 */
const OPEN_TIMEOUT_MS = 4000;

function getDb(): Promise<IDBPDatabase<VoiceForgeDB>> {
  if (!dbPromise) {
    const open = openDB<VoiceForgeDB>("voiceforge", 2, {
      upgrade(db, oldVersion) {
        // v1 — original stores. Guard each so re-runs and upgrades are safe.
        if (oldVersion < 1) {
          db.createObjectStore("voices", { keyPath: "id" });
          db.createObjectStore("projects", { keyPath: "id" });
          const audio = db.createObjectStore("chunkAudio", { keyPath: "key" });
          audio.createIndex("byProject", "projectId");
        }
        // v2 — talking-head video assets
        if (oldVersion < 2) {
          db.createObjectStore("videoAssets", { keyPath: "key" });
        }
      },
      blocked() {
        console.warn(
          "[voiceforge] IndexedDB upgrade blocked — close other VoiceForge tabs."
        );
      },
      // Another tab is trying to upgrade: step aside so it isn't blocked too.
      blocking() {
        openConn?.close();
        openConn = null;
        dbPromise = null;
      },
      terminated() {
        openConn = null;
        dbPromise = null;
      },
    }).then((db) => {
      openConn = db;
      return db;
    });

    dbPromise = Promise.race([
      open,
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                "IndexedDB did not open in time — another tab may be holding an older version open."
              )
            ),
          OPEN_TIMEOUT_MS
        )
      ),
    ]).catch((err) => {
      dbPromise = null; // let a later call retry
      throw err;
    });
  }
  return dbPromise;
}

// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------

/** Persist the project. Audio blobs live in chunkAudio, so strip them here. */
export async function putProject(project: Project): Promise<void> {
  const db = await getDb();
  const lean: Project = {
    ...project,
    chunks: project.chunks.map(({ audioBlob: _drop, ...rest }) => rest as Chunk),
  };
  await db.put("projects", lean);
}

export async function getFirstProject(): Promise<Project | undefined> {
  const db = await getDb();
  const all = await db.getAll("projects");
  return all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

// ---------------------------------------------------------------------------
// chunk audio
// ---------------------------------------------------------------------------

export async function saveChunkAudio(
  projectId: string,
  chunkId: string,
  blob: Blob,
  durationSec: number,
  sampleRate: number
): Promise<void> {
  const db = await getDb();
  await db.put("chunkAudio", {
    key: `${projectId}:${chunkId}`,
    projectId,
    chunkId,
    blob,
    durationSec,
    sampleRate,
  });
}

/** All stored audio for a project, keyed by chunkId. */
export async function loadAllChunkAudio(
  projectId: string
): Promise<Map<string, StoredChunkAudio>> {
  const db = await getDb();
  const rows = await db.getAllFromIndex("chunkAudio", "byProject", projectId);
  return new Map(rows.map((r) => [r.chunkId, r]));
}

export async function deleteChunkAudio(projectId: string, chunkId: string): Promise<void> {
  const db = await getDb();
  await db.delete("chunkAudio", `${projectId}:${chunkId}`);
}

export async function clearProjectAudio(projectId: string): Promise<void> {
  const db = await getDb();
  const keys = await db.getAllKeysFromIndex("chunkAudio", "byProject", projectId);
  const tx = db.transaction("chunkAudio", "readwrite");
  await Promise.all(keys.map((k) => tx.store.delete(k)));
  await tx.done;
}

// ---------------------------------------------------------------------------
// video assets (source photo + last rendered video)
// ---------------------------------------------------------------------------

export async function saveVideoAsset(
  key: "sourcePhoto" | "resultVideo",
  blob: Blob,
  durationSec?: number
): Promise<void> {
  const db = await getDb();
  await db.put("videoAssets", { key, blob, mime: blob.type, durationSec });
}

export async function loadVideoAsset(
  key: "sourcePhoto" | "resultVideo"
): Promise<{ blob: Blob; durationSec?: number } | undefined> {
  const db = await getDb();
  const row = await db.get("videoAssets", key);
  return row ? { blob: row.blob, durationSec: row.durationSec } : undefined;
}

export async function deleteVideoAsset(
  key: "sourcePhoto" | "resultVideo"
): Promise<void> {
  const db = await getDb();
  await db.delete("videoAssets", key);
}
