/**
 * The presenter library — the faces used for lip-synced intro and outro clips.
 *
 * Built beside the voice library, not on top of it: a presenter never changes
 * how a voice is stored, chosen or generated. The only thing the two share is
 * the pattern — metadata in Redis, the file in Blob at a public URL that
 * whichever backend is running downloads for itself.
 *
 * This module is the library and the routing rule. Nothing here generates
 * video; that is a backend's job, and a backend says it can do it by listing
 * a presenter capability when it registers.
 */

import {
  PRESENTER_KINDS,
  PRESENTER_SOURCES,
  type BackendView,
  type Presenter,
  type PresenterKind,
  type PresenterSource,
  type PresenterView,
} from "@/lib/types";
import { isUsableHealth, listBackends } from "./backends";
import { deleteBlob, isBlobConfigured } from "./blob";
import { isRedisConfigured, kvDel, kvGet, kvMGet, kvSet, redisFailure } from "./redis";

const KEY = (id: string) => `vf:presenter:${id}`;
const INDEX = "vf:presenters";
const DEFAULT_KEY = "vf:presenter:default";

/** A recording is a few seconds of one person talking, not a film. */
export const MAX_RECORDING_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/**
 * Long enough to hold natural movement, short enough to upload from a phone.
 * The re-lip engine loops the recording to cover the audio, so more footage
 * buys variety, not length.
 */
export const MIN_RECORDING_SECONDS = 5;
export const MAX_RECORDING_SECONDS = 60;

const ALLOWED: Record<PresenterKind, RegExp> = {
  recording: /^video\/(mp4|quicktime|webm)$/,
  // Raster only, for the same reason banners are: nothing downstream reads SVG.
  image: /^image\/(png|jpeg|jpg|webp)$/,
};

export class PresenterError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PresenterError";
    this.status = status;
  }
}

export function isPresenterStorageReady(): boolean {
  return isRedisConfigured() && isBlobConfigured();
}

export function presenterStorageHint(): string | null {
  // A failed read returns empty, and an empty library looks exactly like a
  // deleted one. Say which it is.
  const failed = redisFailure();
  if (failed) {
    return (
      `Storage isn't responding (${failed.message}). Your presenters are still there — ` +
      "this is a read failure, not a deletion."
    );
  }
  const missing: string[] = [];
  if (!isRedisConfigured()) missing.push("Upstash Redis");
  if (!isBlobConfigured()) missing.push("Blob");
  if (!missing.length) return null;
  return `Add ${missing.join(" and ")} in Vercel → Storage → Marketplace (free), then redeploy.`;
}

// --- pure helpers (unit-tested) ------------------------------------------

export function isPresenterKind(value: string): value is PresenterKind {
  return (PRESENTER_KINDS as readonly string[]).includes(value);
}

export function isPresenterSource(value: string): value is PresenterSource {
  return (PRESENTER_SOURCES as readonly string[]).includes(value);
}

export function slugifyPresenterName(name: string): string {
  const slug = name
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "presenter";
}

export function maxBytesFor(kind: PresenterKind): number {
  return kind === "recording" ? MAX_RECORDING_BYTES : MAX_IMAGE_BYTES;
}

export function assertPresenterFile(
  kind: PresenterKind,
  mime: string,
  sizeBytes: number,
  durationSec?: number
): void {
  if (!ALLOWED[kind].test(mime)) {
    throw new PresenterError(
      kind === "recording"
        ? `A recording must be an MP4, MOV or WebM video, not "${mime}".`
        : `An image must be a PNG, JPEG or WebP, not "${mime}".`
    );
  }
  const max = maxBytesFor(kind);
  if (sizeBytes > max) {
    throw new PresenterError(
      `That file is over ${Math.round(max / 1024 / 1024)} MB.`,
      413
    );
  }
  if (kind === "recording" && durationSec !== undefined) {
    if (durationSec < MIN_RECORDING_SECONDS) {
      throw new PresenterError(
        `That recording is ${durationSec.toFixed(1)}s. Use at least ${MIN_RECORDING_SECONDS}s — around 15s is ideal.`
      );
    }
    if (durationSec > MAX_RECORDING_SECONDS) {
      throw new PresenterError(
        `That recording is ${Math.round(durationSec)}s. Trim it to ${MAX_RECORDING_SECONDS}s or less.`
      );
    }
  }
}

/**
 * Only our own Blob store, and only under presenters/<kind>/. The upload
 * token already limits where the browser can write; this stops a crafted
 * metadata call pointing a presenter at someone else's file.
 */
export function assertOurPresenterUrl(url: string, kind: PresenterKind): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PresenterError("That isn't a valid URL.");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".vercel-storage.com")) {
    throw new PresenterError("That file isn't in this project's Blob store.");
  }
  if (!parsed.pathname.includes(`presenters/${kind}/`)) {
    throw new PresenterError("That file isn't stored under this presenter kind.");
  }
}

// --- routing -------------------------------------------------------------

/**
 * The capability a backend must report to voice each kind.
 *
 * Two capabilities, not one, because the engines are not interchangeable:
 * re-lipping a recording fits a free 16 GB GPU, while animating a still needs
 * a model several times larger. A backend that can do one is not assumed to
 * manage the other.
 */
export function presenterCapability(kind: PresenterKind): string {
  return kind === "recording" ? "presenter-relip" : "presenter-animate";
}

/**
 * Which of `backends` may voice this kind of presenter, in the order given.
 *
 * `backends` is expected in the standard order (listBackends sorts it), so
 * the result is too: free notebooks before paid GPUs, exactly as for voice.
 * Pure, so the rule is tested without a registry.
 */
export function pickPresenterBackends(
  backends: BackendView[],
  kind: PresenterKind
): BackendView[] {
  const need = presenterCapability(kind);
  return backends.filter(
    (b) => isUsableHealth(b.health) && b.videoEnabled !== false && canPresent(b, need)
  );
}

/**
 * A notebook reports presenter capabilities alongside its others; Modal's
 * presenter function is a separate address, so its answer is stored apart.
 * Either counts.
 */
function canPresent(b: BackendView, need: string): boolean {
  return (b.capabilities ?? []).includes(need) || (b.presenterCapabilities ?? []).includes(need);
}

export interface PresenterReadiness {
  ready: boolean;
  /** The backend that would take the job, when there is one. */
  provider?: string;
  /** Why not, phrased as the next thing to do. */
  reason?: string;
}

/**
 * Can this kind be rendered right now — and if not, which of the three
 * possible reasons is it? "No backend can", "one can but is switched off for
 * video" and "one can but is offline" each need a different fix, and a bare
 * "unavailable" would send someone looking in the wrong place.
 */
export function presenterReadiness(
  backends: BackendView[],
  kind: PresenterKind
): PresenterReadiness {
  const usable = pickPresenterBackends(backends, kind);
  if (usable.length) return { ready: true, provider: usable[0].provider };

  const need = presenterCapability(kind);
  const capable = backends.filter((b) => canPresent(b, need));
  const what = kind === "recording" ? "re-lip a recording" : "animate a still image";

  if (!capable.length) {
    return {
      ready: false,
      reason: `No connected backend can ${what} yet. A backend offers this once its presenter engine is installed.`,
    };
  }
  const switchedOff = capable.filter((b) => b.videoEnabled === false);
  if (switchedOff.length === capable.length) {
    return {
      ready: false,
      reason: `${switchedOff.map((b) => b.provider).join(", ")} can ${what}, but video is switched off there. Turn it on in Admin → Backends.`,
    };
  }
  return {
    ready: false,
    reason: `${capable.map((b) => b.provider).join(", ")} can ${what} but is not online right now.`,
  };
}

export async function usablePresenterBackends(kind: PresenterKind): Promise<BackendView[]> {
  return pickPresenterBackends(await listBackends(), kind);
}

// --- store ---------------------------------------------------------------

async function readIndex(): Promise<string[]> {
  return (await kvGet<string[]>(INDEX)) ?? [];
}

export async function getDefaultPresenterId(): Promise<string | null> {
  return await kvGet<string>(DEFAULT_KEY);
}

export async function listPresenters(): Promise<PresenterView[]> {
  const ids = await readIndex();
  if (!ids.length) return [];
  const [rows, defaultId] = await Promise.all([
    kvMGet<Presenter>(ids.map(KEY)),
    getDefaultPresenterId(),
  ]);
  return rows
    .filter((r): r is Presenter => Boolean(r))
    .map((r) => ({ ...r, isDefault: r.id === defaultId }))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.createdAt - a.createdAt);
}

export async function getPresenter(id: string): Promise<Presenter | null> {
  return await kvGet<Presenter>(KEY(id));
}

/**
 * The presenter a request should use: the one it named, otherwise the
 * default. Unlike voices there is no "only one exists, use that" shortcut —
 * putting a face on a video should always be something somebody chose.
 */
export async function resolvePresenter(requested?: string | null): Promise<Presenter | null> {
  if (requested) return getPresenter(requested);
  const defaultId = await getDefaultPresenterId();
  return defaultId ? getPresenter(defaultId) : null;
}

export interface RegisterPresenterInput {
  name: string;
  kind: PresenterKind;
  /** Blob URL the browser just wrote to, verified below. */
  url: string;
  mime: string;
  sizeBytes: number;
  durationSec?: number;
  source: PresenterSource;
  /** Required for every source: the uploader confirms the right to use it. */
  confirmed: boolean;
}

export async function registerPresenter(input: RegisterPresenterInput): Promise<Presenter> {
  if (!isPresenterStorageReady()) {
    throw new PresenterError(presenterStorageHint() ?? "Storage isn't connected.", 503);
  }
  if (!input.confirmed) {
    throw new PresenterError(
      "Confirm that this is your own face, a generated one, or one you have permission to use."
    );
  }
  assertPresenterFile(input.kind, input.mime, input.sizeBytes, input.durationSec);
  assertOurPresenterUrl(input.url, input.kind);

  const id = `${slugifyPresenterName(input.name)}-${crypto.randomUUID().slice(0, 8)}`;
  const now = Date.now();
  const row: Presenter = {
    id,
    name: input.name.trim().slice(0, 80) || "Untitled presenter",
    kind: input.kind,
    url: input.url,
    mime: input.mime,
    sizeBytes: input.sizeBytes,
    ...(input.durationSec !== undefined
      ? { durationSec: Math.round(input.durationSec * 10) / 10 }
      : {}),
    source: input.source,
    createdAt: now,
    updatedAt: now,
  };

  // kvSet reports failure by returning false. Ignoring that is how a voice
  // once "saved" with a 201 and never appeared; a write that did not land is
  // an error and must read as one.
  if (!(await kvSet(KEY(id), row))) {
    throw new PresenterError(
      "Uploaded the file but couldn't record the presenter — storage rejected the write.",
      503
    );
  }
  await kvSet(INDEX, [id, ...(await readIndex()).filter((x) => x !== id)]);
  if (!(await getDefaultPresenterId())) await kvSet(DEFAULT_KEY, id);
  return row;
}

export async function renamePresenter(id: string, name: string): Promise<Presenter | null> {
  const existing = await getPresenter(id);
  if (!existing) return null;
  const next: Presenter = {
    ...existing,
    name: name.trim().slice(0, 80) || existing.name,
    updatedAt: Date.now(),
  };
  await kvSet(KEY(id), next);
  return next;
}

export async function setDefaultPresenter(id: string): Promise<boolean> {
  if (!(await getPresenter(id))) return false;
  await kvSet(DEFAULT_KEY, id);
  return true;
}

export async function deletePresenter(id: string): Promise<boolean> {
  const existing = await getPresenter(id);
  if (!existing) return false;
  await deleteBlob(existing.url);
  await kvDel(KEY(id));
  await kvSet(INDEX, (await readIndex()).filter((x) => x !== id));
  if ((await getDefaultPresenterId()) === id) {
    // Promote whatever is left rather than leaving a dangling default.
    const rest = await listPresenters();
    if (rest[0]) await kvSet(DEFAULT_KEY, rest[0].id);
    else await kvDel(DEFAULT_KEY);
  }
  return true;
}
