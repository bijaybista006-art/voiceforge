/**
 * The asset library — music, sound effects, motion overlays, banners, stock
 * clips.
 *
 * Deliberately central rather than a folder on each machine: Colab and Kaggle
 * get a fresh disk every session, so anything stored on the backend would have
 * to be re-uploaded constantly. Here it's uploaded once and every backend sees
 * it, because the gateway picks the assets and passes URLs.
 *
 * Random selection also happens HERE, not on the backend, so a render looks
 * the same whichever GPU answered.
 */

import type { Asset, AssetKind } from "@/lib/types";
import { ASSET_KINDS } from "@/lib/types";
import { deleteBlob, isBlobConfigured } from "./blob";
import { isOurFileUrl, pathFromUrl } from "../storage";
import { isRedisConfigured, kvDel, kvGet, kvMGet, kvSet } from "./redis";

const KEY = (id: string) => `vf:asset:${id}`;
const INDEX = "vf:assets";

/** Motion loops are the big ones; everything else is far smaller. */
export const MAX_ASSET_BYTES = 50 * 1024 * 1024;

/** What each kind is allowed to be, so a banner can't arrive as an MP3. */
const ALLOWED: Record<AssetKind, RegExp> = {
  music: /^audio\//,
  sfx: /^audio\//,
  motion: /^video\//,
  banner: /^image\/(png|jpeg|jpg|webp)$/,
  intro: /^video\//,
  outro: /^video\//,
  clip: /^video\//,
};

export class AssetError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "AssetError";
    this.status = status;
  }
}

export function isAssetStorageReady(): boolean {
  return isRedisConfigured() && isBlobConfigured();
}

export function assetStorageHint(): string | null {
  if (isRedisConfigured() && isBlobConfigured()) return null;
  return "Add the Supabase env vars in Vercel (see docs/supabase-setup.md), then redeploy.";
}

// --- pure helpers (unit-tested) ------------------------------------------

export function isAssetKind(value: string): value is AssetKind {
  return (ASSET_KINDS as readonly string[]).includes(value);
}

/** Keeps Blob paths readable: "Epic Drums.mp3" -> "epic-drums". */
export function slugifyAssetName(name: string): string {
  const slug = name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "asset";
}

/**
 * Pick a file extension we're willing to serve.
 *
 * Taken from the original filename when it looks sane, since that's more
 * reliable than guessing from a MIME type a browser may have invented, and
 * ffmpeg on the backend cares about the container.
 */
export function assetExtension(fileName: string, mime: string): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(fileName)?.[1]?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  const fromMime = mime.split("/")[1]?.split(";")[0]?.toLowerCase();
  return fromMime && /^[a-z0-9]{2,5}$/.test(fromMime) ? fromMime : "bin";
}

export function assertAllowed(kind: AssetKind, mime: string): void {
  if (ALLOWED[kind].test(mime)) return;

  if (kind === "banner" && mime === "image/svg+xml") {
    throw new AssetError(
      "ffmpeg can't read SVG. Convert the logo to a PNG with transparency first."
    );
  }
  const want =
    kind === "banner" ? "a PNG, JPEG or WebP" : ALLOWED[kind].source.replace(/[^a-z]/g, "");
  throw new AssetError(`A ${kind} asset must be ${want}, not "${mime}".`);
}

/**
 * Deterministic-ish random choice.
 *
 * `rand` is injectable so tests can pin the result; production just uses
 * Math.random. Picking without replacement matters for motion overlays — the
 * same loop twice in one video is noticeable.
 */
export function sample<T>(items: T[], count: number, rand: () => number = Math.random): T[] {
  if (count >= items.length) return [...items];
  const pool = [...items];
  const out: T[] = [];
  while (out.length < count && pool.length) {
    out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  }
  return out;
}

// --- store ---------------------------------------------------------------

async function readIndex(): Promise<string[]> {
  return (await kvGet<string[]>(INDEX)) ?? [];
}

export async function listAssets(kind?: AssetKind): Promise<Asset[]> {
  const ids = await readIndex();
  if (!ids.length) return [];
  const rows = await kvMGet<Asset>(ids.map(KEY));
  return rows
    .filter((r): r is Asset => Boolean(r) && (!kind || r!.kind === kind))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function getAsset(id: string): Promise<Asset | null> {
  return kvGet<Asset>(KEY(id));
}

export interface RegisterAssetInput {
  kind: AssetKind;
  name: string;
  tag?: string;
  /** Blob URL the browser just wrote to, verified below. */
  url: string;
  mime: string;
  sizeBytes: number;
  durationSec?: number;
}

/**
 * A URL is only accepted if it looks like our own Blob store and sits under
 * assets/<kind>/. The upload token already restricts where the browser can
 * write; this stops a crafted metadata call pointing a row at someone else's
 * file.
 */
export function assertOurBlobUrl(url: string, kind: AssetKind): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AssetError("That isn't a valid URL.");
  }
  if (parsed.protocol !== "https:" || !isOurFileUrl(url)) {
    throw new AssetError("That file isn't in this project's storage.");
  }
  if (!(pathFromUrl(url) ?? "").startsWith(`assets/${kind}/`)) {
    throw new AssetError("That file isn't stored under this asset kind.");
  }
}

export async function registerAsset(input: RegisterAssetInput): Promise<Asset> {
  if (!isAssetStorageReady()) {
    throw new AssetError(assetStorageHint() ?? "Storage isn't connected.", 503);
  }
  if (input.sizeBytes > MAX_ASSET_BYTES) {
    throw new AssetError("That file is over 50 MB.", 413);
  }
  assertAllowed(input.kind, input.mime);
  assertOurBlobUrl(input.url, input.kind);

  const id = `${slugifyAssetName(input.name)}-${crypto.randomUUID().slice(0, 8)}`;

  const asset: Asset = {
    id,
    kind: input.kind,
    name: input.name.trim().slice(0, 80) || "Untitled",
    tag: input.tag?.trim().slice(0, 40) || undefined,
    url: input.url,
    mime: input.mime,
    sizeBytes: input.sizeBytes,
    durationSec: input.durationSec,
    createdAt: Date.now(),
  };

  await kvSet(KEY(id), asset);
  await kvSet(INDEX, [id, ...(await readIndex()).filter((x) => x !== id)]);
  return asset;
}

export async function deleteAsset(id: string): Promise<boolean> {
  const existing = await getAsset(id);
  if (!existing) return false;
  await deleteBlob(existing.url);
  await kvDel(KEY(id));
  await kvSet(INDEX, (await readIndex()).filter((x) => x !== id));
  return true;
}

/**
 * Choose assets for a render. Returns [] rather than throwing when the
 * library is empty — a missing music track should mean "no music", never a
 * failed video.
 */
export async function pickAssets(
  kind: AssetKind,
  count = 1,
  tag?: string
): Promise<Asset[]> {
  const all = await listAssets(kind);
  const pool = tag ? all.filter((a) => a.tag === tag) : all;
  return sample(pool, count);
}
