/**
 * Reading a presenter clip's progress, for the studio. Pure.
 *
 * The backend reports 15 when the lip-sync engine starts and climbs to 94 as
 * it works (backend/voiceforge_presenter.py, EngineProgress): about the first
 * 12% of that span is finding the face in each frame, the next 80% redrawing
 * the mouth, the rest putting the face back.
 */

export const LIPSYNC_START = 15;
export const LIPSYNC_END = 94;

/** What the engine is doing at this progress, in plain words. */
export function lipSyncStep(progress: number | null | undefined): string {
  const p = progress ?? 0;
  if (p <= LIPSYNC_START) return "Starting the lip-sync engine";
  if (p < 25) return "Finding the face in each frame";
  if (p < 88) return "Redrawing the mouth";
  if (p < LIPSYNC_END) return "Putting the face back into each frame";
  return "Finishing";
}

export interface ProgressMark {
  at: number; // ms
  progress: number;
}

/**
 * Minutes left, from how fast progress has moved since `first` was seen.
 * Null until there is enough movement to judge (3 points and 30 seconds),
 * so the first guess is not wild. Never says zero.
 */
export function lipSyncMinutesLeft(first: ProgressMark | null, latest: ProgressMark): number | null {
  if (!first) return null;
  const moved = latest.progress - first.progress;
  const took = latest.at - first.at;
  if (moved < 3 || took < 30_000 || latest.progress >= LIPSYNC_END) return null;
  const msLeft = ((LIPSYNC_END - latest.progress) * took) / moved;
  return Math.max(1, Math.round(msLeft / 60_000));
}
