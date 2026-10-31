/**
 * "Which backend is serving right now?" — for the admin pages.
 *
 * The server decides with usableBackends() / pickPresenterBackends() /
 * pickClipBackends() in lib/server. Those modules import the storage client,
 * so they can't run in the browser; this file mirrors their rule for display
 * only, and lib/__tests__/routingView.test.ts checks it against the real
 * server predicates so the two can never disagree.
 *
 * The rule: walk the fixed order Colab → Kaggle → Custom URL → Modal (the
 * order listBackends() already returns) and take the first backend that is
 * usable (online, busy or not-yet-verified) and has that feature switched on.
 */

import type { BackendHealthKind, BackendProvider, BackendView } from "./types";

export const ROUTING_ORDER: readonly BackendProvider[] = ["colab", "kaggle", "custom", "modal"];

export const PROVIDER_LABEL: Record<BackendProvider, string> = {
  colab: "Google Colab",
  kaggle: "Kaggle",
  custom: "Custom URL",
  modal: "Modal",
};

/** Same predicate as isUsableHealth() in lib/server/backends.ts. */
export function usableHealth(h: BackendHealthKind): boolean {
  return h === "online" || h === "busy" || h === "unverified";
}

type Row = Pick<
  BackendView,
  | "provider"
  | "health"
  | "voiceEnabled"
  | "videoEnabled"
  | "clipsEnabled"
  | "capabilities"
  | "presenterCapabilities"
  | "wanUrl"
  | "wanCapabilities"
>;

function sorted<T extends Row>(rows: T[]): T[] {
  return [...rows].sort((a, b) => ROUTING_ORDER.indexOf(a.provider) - ROUTING_ORDER.indexOf(b.provider));
}

/** The backend voice requests go to now, or null. Mirrors resolveBackend(). */
export function servingVoice<T extends Row>(rows: T[]): T | null {
  return sorted(rows).find((b) => usableHealth(b.health) && b.voiceEnabled !== false) ?? null;
}

/** Where a recording-presenter clip would go now. Mirrors pickPresenterBackends(_, "recording"). */
export function servingPresenter<T extends Row>(rows: T[]): T | null {
  const need = "presenter-relip";
  return (
    sorted(rows).find(
      (b) =>
        usableHealth(b.health) &&
        b.videoEnabled !== false &&
        ((b.capabilities ?? []).includes(need) || (b.presenterCapabilities ?? []).includes(need))
    ) ?? null
  );
}

/** Where an AI video clip would go now. Mirrors pickClipBackends(). */
export function servingClips<T extends Row>(rows: T[]): T | null {
  return (
    sorted(rows).find(
      (b) =>
        usableHealth(b.health) &&
        b.clipsEnabled !== false &&
        Boolean(b.wanUrl) &&
        (b.wanCapabilities ?? []).includes("text-to-video")
    ) ?? null
  );
}
