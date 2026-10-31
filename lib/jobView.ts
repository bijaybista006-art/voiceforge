/**
 * How a job is described to people, shared by the admin Dashboard, the admin
 * Jobs list and the studio's My Library. Pure.
 */

export type JobKind = "tts" | "video" | "presenter" | "clip";

export const JOB_KIND_LABEL: Record<JobKind, string> = {
  tts: "Narration",
  presenter: "Presenter clip",
  clip: "AI video clip",
  video: "Video render (old)",
};

export function jobKind(kind: string | undefined): JobKind {
  return kind === "presenter" || kind === "clip" || kind === "video" ? kind : "tts";
}

/** "3 min ago", "2 h ago", "4 d ago", or a date for anything older than a week. */
export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "5.0 s", "2:12", "1:02:03". */
export function formatSeconds(sec: number | undefined): string | null {
  if (sec === undefined || sec === null || !Number.isFinite(sec)) return null;
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
