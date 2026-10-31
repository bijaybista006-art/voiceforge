/**
 * GPU backend registry.
 *
 * Backends register THEMSELVES (a Colab notebook POSTs its tunnel URL once
 * the tunnel is up, then heartbeats), so nobody copies URLs by hand. One row
 * per provider: a fresh Colab session replaces the previous Colab row.
 *
 * Liveness is computed on READ from the last heartbeat — no cron job, which
 * matters because Vercel's free tier has no always-on worker.
 */

import type {
  ActiveBackend,
  BackendHealthKind,
  BackendProvider,
  BackendRegistration,
  BackendView,
  RegisteredBackend,
} from "@/lib/types";
import { BACKEND_PROVIDERS } from "@/lib/types";
import { getRedis, kvDel, kvGet, kvMGet, kvSet } from "./redis";

const KEY = (p: BackendProvider) => `vf:backend:${p}`;
const ACTIVE_KEY = "vf:backend:active";

/**
 * Three missed heartbeats marks a backend offline.
 *
 * 150s rather than 60s because each beat is two Redis commands, and on the
 * Upstash free tier a notebook left running overnight spent ~2,900 commands
 * a day doing nothing but saying it was alive. The cost is noticing a dead
 * notebook in 7 minutes instead of 3 — acceptable now that dispatch fails
 * over to the next backend by itself.
 */
export const HEARTBEAT_SECONDS = 150;
export const OFFLINE_AFTER_SECONDS = HEARTBEAT_SECONDS * 3;

/**
 * Lower wins under "auto". Free GPUs first, paid last: Modal bills per second,
 * so it should only pick up work when the free backends are actually down.
 * Reorder it per backend in Admin → Backends if you'd rather it led.
 */
const DEFAULT_PRIORITY: Record<BackendProvider, number> = {
  colab: 0,
  kaggle: 1,
  custom: 2,
  modal: 3,
};

/**
 * The standard routing order, fixed on purpose: free notebooks first (Colab,
 * then Kaggle), then a custom URL, and Modal last because it bills per second.
 * Every job walks this list and takes the first backend that accepts it, so
 * Modal only ever runs when Colab and Kaggle are both down or refuse the job.
 */
export const STANDARD_ORDER: readonly BackendProvider[] = ["colab", "kaggle", "custom", "modal"];
const rank = (p: BackendProvider) => {
  const i = STANDARD_ORDER.indexOf(p);
  return i < 0 ? STANDARD_ORDER.length : i;
};

export function computeHealth(b: RegisteredBackend, now = Date.now()): BackendHealthKind {
  if (!b.enabled) return "disabled";

  // Only heartbeating backends can be aged out. Modal and custom URLs are
  // permanent endpoints that never check in — Modal in particular scales to
  // zero, so "quiet" is its normal state. Expiring them would silently remove
  // the fallback you added precisely for when the notebooks are down.
  if (b.selfRegistered !== false) {
    const age = (now - b.lastHeartbeat) / 1000;
    if (age > OFFLINE_AFTER_SECONDS) return "offline";
    return b.busy ? "busy" : "online";
  }

  // Busy first: something reported that, so the address clearly answers.
  if (b.busy) return "busy";

  // A hand-added URL that has never answered is a claim, not a backend.
  // Saying "online" here is how a disabled Modal workspace came to look
  // healthy right up until a job was handed to it and hung. It stays
  // *usable* — see usableBackends — because an unproven fallback is still
  // better than no fallback when the notebooks are down.
  if (!b.lastReachedAt) return "unverified";

  return "online";
}

function toView(b: RegisteredBackend, now = Date.now()): BackendView {
  return {
    ...b,
    health: computeHealth(b, now),
    secondsSinceHeartbeat: Math.max(0, Math.round((now - b.lastHeartbeat) / 1000)),
    secondsSinceReached: b.lastReachedAt
      ? Math.max(0, Math.round((now - b.lastReachedAt) / 1000))
      : null,
  };
}

export async function getBackend(provider: BackendProvider): Promise<BackendView | null> {
  const row = await kvGet<RegisteredBackend>(KEY(provider));
  return row ? toView(row) : null;
}

export async function listBackends(): Promise<BackendView[]> {
  const now = Date.now();
  const rows = await kvMGet<RegisteredBackend>(BACKEND_PROVIDERS.map(KEY));
  return rows
    .filter((r): r is RegisteredBackend => Boolean(r))
    .map((r) => toView(r, now))
    .sort((a, b) => rank(a.provider) - rank(b.provider));
}

/**
 * Upsert from a registration/heartbeat. Operator choices (enabled, priority)
 * survive re-registration, so a Colab restart can't silently re-enable a
 * backend the admin turned off.
 */
export async function registerBackend(
  reg: BackendRegistration,
  opts: { selfRegistered?: boolean } = {}
): Promise<RegisteredBackend> {
  const existing = await kvGet<RegisteredBackend>(KEY(reg.provider));
  const now = Date.now();
  const row: RegisteredBackend = {
    provider: reg.provider,
    url: reg.url.replace(/\/+$/, ""),
    gpu: reg.gpu ?? existing?.gpu,
    models: reg.models ?? existing?.models ?? [],
    version: reg.version ?? existing?.version,
    renderUrl: reg.renderUrl ?? existing?.renderUrl,
    capabilities: reg.capabilities ?? existing?.capabilities ?? ["tts"],
    // What a presenter address reported belongs to that address. A notebook
    // gets a new tunnel every session, and the new session starts with no
    // engine installed, so a changed url forgets everything learned about
    // the old one instead of routing clips to a claim that is no longer true.
    ...(existing && existing.url === reg.url.replace(/\/+$/, "")
      ? {
          ...(existing.presenterUrl ? { presenterUrl: existing.presenterUrl } : {}),
          ...(existing.presenterCapabilities
            ? { presenterCapabilities: existing.presenterCapabilities }
            : {}),
          ...(existing.presenterProbedAt ? { presenterProbedAt: existing.presenterProbedAt } : {}),
          ...(existing.presenterProbedUrl
            ? { presenterProbedUrl: existing.presenterProbedUrl }
            : {}),
          ...(existing.presenterNote ? { presenterNote: existing.presenterNote } : {}),
          // AI video: same rule as the presenter fields above.
          ...(existing.wanUrl ? { wanUrl: existing.wanUrl } : {}),
          ...(existing.wanCapabilities ? { wanCapabilities: existing.wanCapabilities } : {}),
          ...(existing.wanProbedAt ? { wanProbedAt: existing.wanProbedAt } : {}),
          ...(existing.wanProbedUrl ? { wanProbedUrl: existing.wanProbedUrl } : {}),
          ...(existing.wanNote ? { wanNote: existing.wanNote } : {}),
          ...(existing.wanLimits ? { wanLimits: existing.wanLimits } : {}),
        }
      : {}),
    registeredAt: existing?.registeredAt ?? now,
    lastHeartbeat: now,
    enabled: existing?.enabled ?? true,
    // An operator choice, like `enabled`: a restarted notebook must not
    // quietly switch video back on.
    ...(existing?.videoEnabled !== undefined ? { videoEnabled: existing.videoEnabled } : {}),
    priority: existing?.priority ?? DEFAULT_PRIORITY[reg.provider],
    selfRegistered: opts.selfRegistered ?? true,
    busy: false,
    voicesCached: existing?.voicesCached ?? [],
    gpuSecondsMonth: existing?.gpuSecondsMonth ?? 0,
    jobsToday: existing?.jobsToday ?? 0,
    lastError: undefined,
  };
  await kvSet(KEY(reg.provider), row);
  return row;
}

export async function updateBackend(
  provider: BackendProvider,
  patch: Partial<RegisteredBackend>
): Promise<RegisteredBackend | null> {
  const existing = await kvGet<RegisteredBackend>(KEY(provider));
  if (!existing) return null;
  const next = { ...existing, ...patch, provider };
  await kvSet(KEY(provider), next);
  return next;
}

export async function forgetBackend(provider: BackendProvider): Promise<void> {
  await kvDel(KEY(provider));
}

// --- active selection ----------------------------------------------------

export async function getActiveSelection(): Promise<ActiveBackend> {
  return (await kvGet<ActiveBackend>(ACTIVE_KEY)) ?? "auto";
}

export async function setActiveSelection(value: ActiveBackend): Promise<void> {
  await kvSet(ACTIVE_KEY, value);
}

/** The backend a request goes to first: the head of the standard order. */
export async function resolveBackend(): Promise<BackendView | null> {
  return (await usableBackends())[0] ?? null;
}

/**
 * Whether a backend in this state should be sent work.
 *
 * Exported so the tests use the real predicate rather than a copy of it —
 * a duplicated copy is how "unverified" came to be routable in production
 * and unroutable in the test on the same commit.
 */
export function isUsableHealth(h: BackendHealthKind): boolean {
  return h === "online" || h === "busy" || h === "unverified";
}

/** Every usable backend in the standard order; dispatch tries them in turn. */
export async function usableBackends(): Promise<BackendView[]> {
  // Always the standard order (Colab -> Kaggle -> custom -> Modal), whatever
  // is selected in Admin, so a stale pin can never put Modal first.
  const all = await listBackends();
  // "unverified" is included deliberately. It means nothing has answered
  // there *yet*, not that it is broken — and excluding it would delete the
  // paid fallback exactly when the free notebooks are down, which is the one
  // moment it exists for. Dispatch tries each in turn and records why any of
  // them refused.
  return all.filter((b) => isUsableHealth(b.health));
}

// --- auth for machine endpoints ------------------------------------------

async function constantTimeEquals(a: string, b: string): Promise<boolean> {
  const enc = (s: string) => {
    const u8 = new TextEncoder().encode(s);
    const out = new ArrayBuffer(u8.byteLength);
    new Uint8Array(out).set(u8);
    return out;
  };
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc(a)),
    crypto.subtle.digest("SHA-256", enc(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export async function isValidRegistrationToken(token: string | null): Promise<boolean> {
  const expected = process.env.REGISTRATION_TOKEN;
  if (!expected || !token) return false;
  return constantTimeEquals(token, expected);
}

export function backendSecret(): string | undefined {
  return process.env.BACKEND_SECRET;
}

/** A machine caller (a GPU backend or a training job) proving it holds BACKEND_SECRET. */
export async function isValidBackendSecret(header: string | null): Promise<boolean> {
  const expected = backendSecret();
  if (!expected || !header) return false;
  return constantTimeEquals(header, expected);
}

/** Every gateway -> backend call carries this. */
export function backendHeaders(): Record<string, string> {
  const secret = backendSecret();
  return {
    "Content-Type": "application/json",
    ...(secret ? { "X-Backend-Secret": secret } : {}),
  };
}

/**
 * Fold what a /health response told us back into the registry row.
 *
 * A self-registering notebook reports its GPU and models on every heartbeat,
 * but a backend added by URL has nobody doing that — and if it happened to be
 * asleep when it was added, its row stays blank and the studio greys out the
 * model picker. Any successful health call now refreshes those facts, so the
 * row corrects itself the first time the backend is actually reachable.
 */
/**
 * Note that this address did not answer.
 *
 * Deliberately does not change health: Modal scales to zero and a single
 * failed probe is not proof of death. It makes the reason visible on the card
 * instead, which is what was missing when a disabled workspace sat there
 * showing "online".
 */
/**
 * Note that this address answered.
 *
 * A /health probe records this through recordHealthFacts, but a backend can
 * go a long time without being probed while happily accepting jobs — which
 * left Modal reading "never reached" immediately after it had served one.
 */
export async function recordReached(provider: BackendProvider): Promise<void> {
  const existing = await kvGet<RegisteredBackend>(KEY(provider));
  if (!existing) return;
  // Throttled: a 100-scene batch should not rewrite this row 100 times.
  if (existing.lastReachedAt && Date.now() - existing.lastReachedAt < 60_000) {
    if (!existing.lastReachError) return;
  }
  await kvSet(KEY(provider), {
    ...existing,
    lastReachedAt: Date.now(),
    lastReachError: undefined,
  } satisfies RegisteredBackend);
}

export async function recordUnreachable(
  provider: BackendProvider,
  error: string
): Promise<void> {
  const existing = await kvGet<RegisteredBackend>(KEY(provider));
  if (!existing) return;
  await kvSet(KEY(provider), {
    ...existing,
    lastReachError: error.slice(0, 200),
  } satisfies RegisteredBackend);
}

export async function recordHealthFacts(
  provider: BackendProvider,
  health: {
    gpu?: string;
    models?: string[];
    version?: string;
    voices_cached?: string[];
    capabilities?: string[];
  }
): Promise<void> {
  const existing = await kvGet<RegisteredBackend>(KEY(provider));
  if (!existing) return;

  const next: RegisteredBackend = {
    ...existing,
    gpu: health.gpu ?? existing.gpu,
    models: health.models?.length ? health.models : existing.models,
    version: health.version ?? existing.version,
    voicesCached: health.voices_cached ?? existing.voicesCached,
    capabilities: health.capabilities?.length ? health.capabilities : existing.capabilities,
    // Proof of life. For Modal and custom URLs this is the only liveness
    // evidence there is, so it is recorded even when nothing else changed.
    lastReachedAt: Date.now(),
    lastReachError: undefined,
  };

  // Throttled: the admin page polls, and rewriting the row every few seconds
  // to move a timestamp is not worth the round trip.
  const reachedRecently =
    !!existing.lastReachedAt && Date.now() - existing.lastReachedAt < 60_000;
  const unchanged =
    next.gpu === existing.gpu &&
    next.version === existing.version &&
    next.models.join() === existing.models.join() &&
    (next.capabilities ?? []).join() === (existing.capabilities ?? []).join() &&
    (next.voicesCached ?? []).join() === (existing.voicesCached ?? []).join();
  if (unchanged && reachedRecently && !existing.lastReachError) return;

  await kvSet(KEY(provider), next);
}

// --- usage counters ------------------------------------------------------

export async function recordJobUsage(
  provider: BackendProvider,
  genSeconds: number
): Promise<void> {
  if (!getRedis()) return;
  const existing = await kvGet<RegisteredBackend>(KEY(provider));
  if (!existing) return;
  await kvSet(KEY(provider), {
    ...existing,
    gpuSecondsMonth: Math.round((existing.gpuSecondsMonth ?? 0) + genSeconds),
    jobsToday: (existing.jobsToday ?? 0) + 1,
  });
}
